// Pure Rothermel-style surface-fire spread kernel.
//
// Primary references:
// - Rothermel (1972), USDA INT-115:
//   https://research.fs.usda.gov/treesearch/32533
// - Andrews (2018), USDA RMRS-GTR-371, especially Tables 2 and 6:
//   https://research.fs.usda.gov/treesearch/55928
//
// The published empirical constants are defined in US customary units. Fuel
// inputs and public outputs remain SI; conversion into the equation's source
// units is explicit and isolated below. This avoids silently treating the
// empirical constants as dimensionless SI constants.

import {
  calculateLiveMoistureOfExtinction,
  characteristicFuelMoisture,
  moistureDamping
} from './moistureModel.js';

const METERS_PER_FOOT = 0.3048;
const KG_PER_M2_TO_LB_PER_FT2 = 0.2048161436;
const KG_PER_M3_TO_LB_PER_FT3 = 0.0624279606;
const KJ_PER_KG_TO_BTU_PER_LB = 0.429922614;
const BTU_PER_FT2_TO_KJ_PER_M2 = 11.356526;
const BTU_PER_LB_TO_KJ_PER_KG = 2.326;
const RESIDENCE_TIME_CONSTANT_FT_MIN = 384;
const KMH_TO_M_PER_MIN = 1000 / 60;

export const SURFACE_SPREAD_VERSION = 'phase3-rothermel-0.3.0';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function requireFinite(name, value) {
  if (!Number.isFinite(value)) {
    throw new RangeError(`surfaceSpread: ${name} must be finite, got ${value}`);
  }
  return value;
}

function requireNonNegative(name, value) {
  requireFinite(name, value);
  if (value < 0) throw new RangeError(`surfaceSpread: ${name} must be >= 0, got ${value}`);
  return value;
}

function unitVector(east, north, name) {
  requireFinite(`${name}.east`, east);
  requireFinite(`${name}.north`, north);
  const length = Math.hypot(east, north);
  if (length === 0) throw new RangeError(`surfaceSpread: ${name} must not be zero`);
  return { east: east / length, north: north / length };
}

function rowsWithClassMoisture(rows, moistureByClass, fallback, maximum, category) {
  return rows.map((row) => {
    const supplied = moistureByClass?.[row.className];
    const moisture = supplied === undefined ? fallback : supplied;
    requireNonNegative(`${category}.${row.className}MoistureFraction`, moisture);
    if (moisture > maximum) {
      throw new RangeError(
        `surfaceSpread: ${category}.${row.className} moisture must be <= ${maximum}, got ${moisture}`
      );
    }
    return { ...row, moistureFraction: moisture };
  });
}

function dot(a, b) {
  return a.east * b.east + a.north * b.north;
}

function weightedFuelBed(fuelModel) {
  const deadRows = (fuelModel.deadFuel ?? [])
    .filter((row) => row && row.loadKgPerM2 > 0 && row.savRatioPerMeter > 0);
  const liveRows = (fuelModel.liveFuel ?? [])
    .filter((row) => row && row.loadKgPerM2 > 0 && row.savRatioPerMeter > 0);
  const rows = [...deadRows, ...liveRows]
    .filter((row) => row && row.loadKgPerM2 > 0 && row.savRatioPerMeter > 0);
  if (rows.length === 0 || !(fuelModel.fuelBedDepthMeters > 0)) return null;

  const surfaceArea = rows.map((row) => row.loadKgPerM2 * row.savRatioPerMeter);
  const totalSurfaceArea = surfaceArea.reduce((sum, value) => sum + value, 0);
  const deadSurfaceArea = deadRows.reduce((sum, row) => sum + row.loadKgPerM2 * row.savRatioPerMeter, 0);
  const liveSurfaceArea = liveRows.reduce((sum, row) => sum + row.loadKgPerM2 * row.savRatioPerMeter, 0);
  const deadSurfaceAreaFractions = deadRows.map((row) => (
    deadSurfaceArea > 0 ? row.loadKgPerM2 * row.savRatioPerMeter / deadSurfaceArea : 0
  ));
  const liveSurfaceAreaFractions = liveRows.map((row) => (
    liveSurfaceArea > 0 ? row.loadKgPerM2 * row.savRatioPerMeter / liveSurfaceArea : 0
  ));
  const totalDryLoadKgPerM2 = rows.reduce((sum, row) => sum + row.loadKgPerM2, 0);
  const sigmaMeters = rows.reduce(
    (sum, row, index) => sum + surfaceArea[index] * row.savRatioPerMeter,
    0
  ) / totalSurfaceArea;
  const extinctionMoisture = Number.isFinite(fuelModel.moistureOfExtinctionFraction)
    ? fuelModel.moistureOfExtinctionFraction
    : 0.30;
  const heatContentKjPerKg = Number.isFinite(fuelModel.heatContentKjPerKg)
    ? fuelModel.heatContentKjPerKg
    : 18608;

  return {
    totalDryLoadKgPerM2,
    netFuelLoadKgPerM2: totalDryLoadKgPerM2 * (1 - fuelModel.totalMineralContentFraction),
    // BehavePlus weights dead reaction load by dead-fuel surface-area
    // fractions. Live load is summed across live classes below.
    deadNetFuelLoadKgPerM2: deadRows.reduce((sum, row, index) => (
      sum + row.loadKgPerM2 * deadSurfaceAreaFractions[index]
    ), 0) * (1 - fuelModel.totalMineralContentFraction),
    liveNetFuelLoadKgPerM2: liveRows.reduce((sum, row) => sum + row.loadKgPerM2, 0)
      * (1 - fuelModel.totalMineralContentFraction),
    deadSurfaceAreaFractions,
    liveSurfaceAreaFractions,
    deadFuelFraction: deadSurfaceArea / totalSurfaceArea,
    liveFuelFraction: liveSurfaceArea / totalSurfaceArea,
    deadRows,
    liveRows,
    fuelBedDepthMeters: fuelModel.fuelBedDepthMeters,
    sigmaMeters,
    sigmaPerFoot: sigmaMeters * METERS_PER_FOOT,
    extinctionMoisture,
    heatContentKjPerKg,
    heatContentBtuPerLb: heatContentKjPerKg * KJ_PER_KG_TO_BTU_PER_LB,
    particleDensityKgPerM3: fuelModel.particleDensityKgPerM3,
    totalMineralContentFraction: fuelModel.totalMineralContentFraction,
    effectiveMineralContentFraction: fuelModel.effectiveMineralContentFraction
  };
}

function scaleFuelModelLoads(fuelModel, fuelLoadScale) {
  if (fuelLoadScale === 1) return fuelModel;
  const scaleRows = (rows = []) => rows.map((row) => ({
    ...row,
    loadKgPerM2: row.loadKgPerM2 * fuelLoadScale
  }));
  return {
    ...fuelModel,
    deadFuel: scaleRows(fuelModel.deadFuel),
    liveFuel: scaleRows(fuelModel.liveFuel)
  };
}

function zeroResult(fuelModel, warning, fuelLoadScale = 1) {
  return {
    version: SURFACE_SPREAD_VERSION,
    rateMPerMin: 0,
    headRateMPerMin: 0,
    flankRateMPerMin: 0,
    backingRateMPerMin: 0,
    noWindNoSlopeRateMPerMin: 0,
    reactionIntensityKjPerM2Min: 0,
    firelineIntensityKwPerM: 0,
    propagatingFluxRatio: 0,
    factors: { wind: 0, slope: 0, moisture: 0, mineral: 0 },
    effectiveForcing: { east: 0, north: 0, magnitude: 0, directionRadians: 0 },
    fuelModel: fuelModel?.code ?? null,
    fuelLoadScale,
    units: {
      rate: 'm/min',
      reactionIntensity: 'kJ/m²/min',
      heatPerUnitArea: 'kJ/m²',
      firelineIntensity: 'kW/m'
    },
    warnings: [warning]
  };
}

export function calculateSurfaceSpread({
  fuelModel,
  moistureFraction = 0.08,
  deadMoistureFraction = null,
  liveMoistureFraction = null,
  deadMoistureByClass = null,
  liveMoistureByClass = null,
  fuelLoadScale = 1,
  midflameWindKmh = 0,
  windDirectionRadians = 0,
  slopeRadians = 0,
  slopeAspectEast = 0,
  slopeAspectNorth = 0,
  travelDirectionEast = null,
  travelDirectionNorth = null
} = {}) {
  if (!fuelModel || typeof fuelModel !== 'object') {
    throw new TypeError('surfaceSpread: fuelModel is required');
  }
  const resolvedDeadMoisture = deadMoistureFraction === null
    ? moistureFraction
    : deadMoistureFraction;
  const resolvedLiveMoisture = liveMoistureFraction === null
    ? moistureFraction
    : liveMoistureFraction;
  requireNonNegative('moistureFraction', moistureFraction);
  requireNonNegative('deadMoistureFraction', resolvedDeadMoisture);
  requireNonNegative('liveMoistureFraction', resolvedLiveMoisture);
  requireFinite('fuelLoadScale', fuelLoadScale);
  if (fuelLoadScale < 0 || fuelLoadScale > 1) {
    throw new RangeError(`surfaceSpread: fuelLoadScale must be in [0, 1], got ${fuelLoadScale}`);
  }
  requireNonNegative('midflameWindKmh', midflameWindKmh);
  requireFinite('windDirectionRadians', windDirectionRadians);
  requireFinite('slopeRadians', slopeRadians);
  if (slopeRadians < 0 || slopeRadians >= Math.PI / 2) {
    throw new RangeError(`surfaceSpread: slopeRadians must be in [0, π/2), got ${slopeRadians}`);
  }
  if (moistureFraction > 1) {
    throw new RangeError(`surfaceSpread: moistureFraction must be <= 1, got ${moistureFraction}`);
  }
  if (resolvedDeadMoisture > 1) {
    throw new RangeError(`surfaceSpread: deadMoistureFraction must be <= 1, got ${resolvedDeadMoisture}`);
  }
  if (resolvedLiveMoisture > 2) {
    throw new RangeError(`surfaceSpread: liveMoistureFraction must be <= 2, got ${resolvedLiveMoisture}`);
  }
  if (!fuelModel.burnable) return zeroResult(fuelModel, 'non-burnable fuel', fuelLoadScale);
  if (fuelLoadScale === 0) return zeroResult(fuelModel, 'fuel availability scale is zero', fuelLoadScale);

  const fuel = weightedFuelBed(scaleFuelModelLoads(fuelModel, fuelLoadScale));
  if (!fuel) return zeroResult(fuelModel, 'fuel model has no burnable load', fuelLoadScale);

  const warnings = [];
  const deadRows = rowsWithClassMoisture(
    fuel.deadRows,
    deadMoistureByClass,
    resolvedDeadMoisture,
    1,
    'dead'
  );
  const liveRows = rowsWithClassMoisture(
    fuel.liveRows,
    liveMoistureByClass,
    resolvedLiveMoisture,
    2,
    'live'
  );
  const deadMoisture = characteristicFuelMoisture(deadRows, resolvedDeadMoisture, 138);
  const liveMoisture = characteristicFuelMoisture(liveRows, resolvedLiveMoisture, 500);
  const liveExtinctionMoisture = calculateLiveMoistureOfExtinction({
    deadRows,
    liveRows,
    deadMoistureFraction: deadMoisture.fraction,
    deadExtinctionFraction: fuel.extinctionMoisture
  });
  const deadMoistureDamping = moistureDamping(deadMoisture.fraction, fuel.extinctionMoisture);
  const liveMoistureDamping = moistureDamping(liveMoisture.fraction, liveExtinctionMoisture);
  if (deadMoisture.fraction >= fuel.extinctionMoisture) {
    return zeroResult(fuelModel, 'dead fuel moisture at or above extinction', fuelLoadScale);
  }
  const sigma = fuel.sigmaPerFoot;
  const bulkDensityLbPerFt3 = (fuel.totalDryLoadKgPerM2 * KG_PER_M2_TO_LB_PER_FT2)
    / (fuel.fuelBedDepthMeters / METERS_PER_FOOT);
  const particleDensityLbPerFt3 = fuel.particleDensityKgPerM3 * KG_PER_M3_TO_LB_PER_FT3;
  const packingRatio = bulkDensityLbPerFt3 / particleDensityLbPerFt3;
  const optimumPackingRatio = 3.348 * sigma ** -0.8189;
  const packingRatioRatio = packingRatio / optimumPackingRatio;
  const reactionCoefficientA = 133 * sigma ** -0.7913;
  const maximumReactionVelocity = sigma ** 1.5 / (495 + 0.0594 * sigma ** 1.5);
  const reactionVelocity = maximumReactionVelocity
    * packingRatioRatio ** reactionCoefficientA
    * Math.exp(reactionCoefficientA * (1 - packingRatioRatio));

  const mineralDamping = Math.min(
    1,
    0.174 * fuel.effectiveMineralContentFraction ** -0.19
  );
  const heatSinkBtuPerLb = (
    fuel.deadFuelFraction * deadRows.reduce((sum, row, index) => {
      const moisture = Number.isFinite(row.moistureFraction)
        ? row.moistureFraction
        : resolvedDeadMoisture;
      const sigmaPerFoot = row.savRatioPerMeter * METERS_PER_FOOT;
      const heatOfPreignition = 250 + 1116 * moisture;
      return sum + fuel.deadSurfaceAreaFractions[index]
        * heatOfPreignition * Math.exp(-138 / sigmaPerFoot);
    }, 0)
    + fuel.liveFuelFraction * liveRows.reduce((sum, row, index) => {
      const moisture = Number.isFinite(row.moistureFraction)
        ? row.moistureFraction
        : resolvedLiveMoisture;
      const sigmaPerFoot = row.savRatioPerMeter * METERS_PER_FOOT;
      const heatOfPreignition = 250 + 1116 * moisture;
      return sum + fuel.liveSurfaceAreaFractions[index]
        * heatOfPreignition * Math.exp(-138 / sigmaPerFoot);
    }, 0)
  );
  const deadNetFuelLoadLbPerFt2 = fuel.deadNetFuelLoadKgPerM2 * KG_PER_M2_TO_LB_PER_FT2;
  const liveNetFuelLoadLbPerFt2 = fuel.liveNetFuelLoadKgPerM2 * KG_PER_M2_TO_LB_PER_FT2;
  const heatContentBtuPerLb = fuel.heatContentBtuPerLb;
  const reactionIntensityBtuPerFt2Min = reactionVelocity
    * (
      deadNetFuelLoadLbPerFt2 * heatContentBtuPerLb * deadMoistureDamping
      + liveNetFuelLoadLbPerFt2 * heatContentBtuPerLb * liveMoistureDamping
    )
    * mineralDamping;
  const reactionIntensityKjPerM2Min = reactionIntensityBtuPerFt2Min * BTU_PER_FT2_TO_KJ_PER_M2;

  const propagatingFluxRatio = Math.exp(
    (0.792 + 0.681 * Math.sqrt(sigma)) * (packingRatio + 0.1)
  ) / (192 + 0.2595 * sigma);
  const effectiveHeatingNumber = Math.exp(-138 / sigma);
  const heatOfPreignitionKjPerKg = (250 + 1116 * deadMoisture.fraction) * BTU_PER_LB_TO_KJ_PER_KG;
  const bulkDensityKgPerM3 = fuel.totalDryLoadKgPerM2 / fuel.fuelBedDepthMeters;
  const noWindNoSlopeRateMPerMin = reactionIntensityBtuPerFt2Min * propagatingFluxRatio
    / (bulkDensityLbPerFt3 * heatSinkBtuPerLb) * METERS_PER_FOOT;

  const windUnit = {
    east: Math.cos(windDirectionRadians),
    north: Math.sin(windDirectionRadians)
  };
  const slopeUnit = Math.hypot(slopeAspectEast, slopeAspectNorth) > 0
    ? unitVector(slopeAspectEast, slopeAspectNorth, 'slopeAspect')
    : { east: 0, north: 0 };
  const windSpeedMPerMin = midflameWindKmh * KMH_TO_M_PER_MIN;
  const fullWindPhi = calculateWindFactor({
    windSpeedMPerMin,
    alignment: 1,
    sigma,
    packingRatioRatio,
    reactionIntensityBtuPerFt2Min,
    warnings
  });
  const fullSlopePhi = calculateSlopeFactor({
    slopeRadians,
    alignment: 1,
    packingRatio
  });
  const forcingEast = fullWindPhi * windUnit.east + fullSlopePhi * slopeUnit.east;
  const forcingNorth = fullWindPhi * windUnit.north + fullSlopePhi * slopeUnit.north;
  const forcingMagnitude = Math.hypot(forcingEast, forcingNorth);
  const forcingDirection = forcingMagnitude > 0
    ? { east: forcingEast / forcingMagnitude, north: forcingNorth / forcingMagnitude }
    : { east: 1, north: 0 };
  const requestedDirection = travelDirectionEast === null || travelDirectionNorth === null
    ? forcingDirection
    : unitVector(travelDirectionEast, travelDirectionNorth, 'travelDirection');

  const rateForDirection = (direction) => {
    const windAlignment = Math.max(0, dot(direction, windUnit));
    const slopeAlignment = Math.max(0, dot(direction, slopeUnit));
    const windPhi = calculateWindFactor({
      windSpeedMPerMin,
      alignment: windAlignment,
      sigma,
      packingRatioRatio,
      reactionIntensityBtuPerFt2Min,
      warnings
    });
    const slopePhi = calculateSlopeFactor({
      slopeRadians,
      alignment: slopeAlignment,
      packingRatio
    });
    return {
      rateMPerMin: noWindNoSlopeRateMPerMin * (1 + windPhi + slopePhi),
      windPhi,
      slopePhi
    };
  };

  const flankDirection = { east: -forcingDirection.north, north: forcingDirection.east };
  const flank = rateForDirection(flankDirection);
  // forcingDirection is a linear vector-sum heuristic for the combined
  // wind+slope direction, but calculateWindFactor responds sub-linearly to
  // alignment while calculateSlopeFactor responds quadratically. When wind
  // and slope pull in different directions, that mismatch can make the
  // heuristic's direction slightly under-estimate the true fastest-spread
  // rate relative to its exact opposite. The elliptical transform (Andrews
  // 2018) requires head to be the maximum of the two by definition -- guard
  // that invariant here at the source rather than downstream in
  // fireEllipse.js, which only validates, it cannot correct.
  const forcingDirectionRate = rateForDirection(forcingDirection);
  const oppositeDirectionRate = rateForDirection({ east: -forcingDirection.east, north: -forcingDirection.north });
  const [head, backing] = oppositeDirectionRate.rateMPerMin > forcingDirectionRate.rateMPerMin
    ? [oppositeDirectionRate, forcingDirectionRate]
    : [forcingDirectionRate, oppositeDirectionRate];
  const requested = rateForDirection(requestedDirection);
  // Byram fireline intensity uses Rothermel reaction intensity and the
  // Anderson residence-time approximation tau = 384 / sigma (minutes),
  // rather than the entire fuel-bed load. See Andrews (2018), Table 6.
  const residenceTimeMinutes = RESIDENCE_TIME_CONSTANT_FT_MIN / fuel.sigmaPerFoot;
  const heatPerUnitAreaKjPerM2 = reactionIntensityKjPerM2Min * residenceTimeMinutes;
  // Keep the final Byram relationship in SI so rounded imperial conversion
  // constants cannot introduce a discrepancy between intensity and rate.
  const firelineIntensityKwPerM = heatPerUnitAreaKjPerM2
    * requested.rateMPerMin / 60;

  return {
    version: SURFACE_SPREAD_VERSION,
    rateMPerMin: requested.rateMPerMin,
    headRateMPerMin: head.rateMPerMin,
    flankRateMPerMin: flank.rateMPerMin,
    backingRateMPerMin: backing.rateMPerMin,
    noWindNoSlopeRateMPerMin,
    reactionIntensityKjPerM2Min,
    heatPerUnitAreaKjPerM2,
    firelineIntensityKwPerM,
    propagatingFluxRatio,
    factors: {
      wind: requested.windPhi,
      slope: requested.slopePhi,
      moisture: deadMoistureDamping,
      moistureDead: deadMoistureDamping,
      moistureLive: liveMoistureDamping,
      mineral: mineralDamping
    },
    effectiveForcing: {
      east: forcingEast,
      north: forcingNorth,
      magnitude: forcingMagnitude,
      directionRadians: Math.atan2(forcingNorth, forcingEast)
    },
    intermediate: {
      sigmaPerFoot: sigma,
      bulkDensityKgPerM3,
      packingRatio,
      optimumPackingRatio,
      reactionVelocityPerMin: reactionVelocity,
      effectiveHeatingNumber,
      heatOfPreignitionKjPerKg,
      heatSinkBtuPerLb,
      heatSinkKjPerKg: heatSinkBtuPerLb * BTU_PER_LB_TO_KJ_PER_KG,
      characteristicDeadMoistureFraction: deadMoisture.fraction,
      characteristicLiveMoistureFraction: liveMoisture.fraction,
      liveMoistureOfExtinctionFraction: liveExtinctionMoisture,
      deadMoistureDamping,
      liveMoistureDamping,
      deadSurfaceAreaWeight: deadMoisture.surfaceAreaWeight,
      liveSurfaceAreaWeight: liveMoisture.surfaceAreaWeight,
      deadReactionContribution: reactionVelocity
        * deadNetFuelLoadLbPerFt2 * heatContentBtuPerLb * deadMoistureDamping * mineralDamping,
      liveReactionContribution: reactionVelocity
        * liveNetFuelLoadLbPerFt2 * heatContentBtuPerLb * liveMoistureDamping * mineralDamping,
      residenceTimeMinutes,
      windSpeedMPerMin,
      maxReliableWindFtPerMin: 0.9 * reactionIntensityBtuPerFt2Min
    },
    fuelModel: fuelModel.code ?? null,
    fuelLoadScale,
    units: {
      rate: 'm/min',
      reactionIntensity: 'kJ/m²/min',
      heatPerUnitArea: 'kJ/m²',
      firelineIntensity: 'kW/m'
    },
    warnings: [...new Set(warnings)]
  };
}

function calculateWindFactor({
  windSpeedMPerMin,
  alignment,
  sigma,
  packingRatioRatio,
  reactionIntensityBtuPerFt2Min,
  warnings
}) {
  if (windSpeedMPerMin <= 0 || alignment <= 0) return 0;
  const coefficientC = 7.47 * Math.exp(-0.133 * sigma ** 0.55);
  const exponentB = 0.02526 * sigma ** 0.54;
  const exponentE = 0.715 * Math.exp(-3.59e-4 * sigma);
  const windFtPerMin = windSpeedMPerMin * alignment / METERS_PER_FOOT;
  // The original BEHAVE "maximum reliable wind speed" limit (0.9 x reaction
  // intensity) was an arbitrary numerical safeguard, not an empirical fit --
  // Andrews, Cruz & Rothermel (2013, IJWF 22(7):959-969) found it triggers
  // well inside the range of real wind-driven fire behavior, especially for
  // light fuels (grass/shrub), and recommended removing it. Flag when the
  // legacy limit would have engaged so unusually high wind inputs stay
  // visible in provenance, without silently throttling the computed rate.
  if (windFtPerMin > 0.9 * reactionIntensityBtuPerFt2Min) {
    warnings.push('wind exceeds the legacy Rothermel reliability limit (uncapped per Andrews/Cruz/Rothermel 2013)');
  }
  return coefficientC * windFtPerMin ** exponentB * packingRatioRatio ** -exponentE;
}

function calculateSlopeFactor({ slopeRadians, alignment, packingRatio }) {
  if (slopeRadians <= 0 || alignment <= 0) return 0;
  return 5.275 * packingRatio ** -0.3 * (Math.tan(slopeRadians) * alignment) ** 2;
}
