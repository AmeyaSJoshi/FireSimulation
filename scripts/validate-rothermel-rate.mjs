import { getFuelModel } from '../src/lib/fuelModels.js';
import { calculateSurfaceSpread } from '../src/lib/surfaceSpread.js';

// This is intentionally a small, independent Rothermel oracle. It uses the
// published TU2 parameters in US customary units instead of importing the
// production fuel-table rows or any production equation helper. The oracle
// is an equation regression gate, not a claim that the graph in Andrews
// (2014) publishes these exact rate-of-spread values.
const TU2 = Object.freeze({
  depthFt: 1,
  particleDensityLbPerFt3: 32,
  totalMineralFraction: 0.0555,
  effectiveMineralFraction: 0.01,
  heatContentBtuPerLb: 8000,
  deadMoistureFraction: 0.05,
  liveMoistureFraction: 0.50,
  moistureOfExtinctionFraction: 0.30,
  dead: Object.freeze([
    { loadLbPerFt2: 0.22420 * 0.2048161436, sigmaPerFt: 2000 },
    { loadLbPerFt2: 0.40356 * 0.2048161436, sigmaPerFt: 109 },
    { loadLbPerFt2: 0.29146 * 0.2048161436, sigmaPerFt: 30 }
  ]),
  live: Object.freeze([
    { loadLbPerFt2: 0.04484 * 0.2048161436, sigmaPerFt: 1600 }
  ])
});

const METERS_PER_FOOT = 0.3048;
const KMH_TO_FT_PER_MIN = (1000 / 60) / METERS_PER_FOOT;
const BTU_PER_FT2_TO_KJ_PER_M2 = 11.356526;
const RESIDENCE_TIME_MIN = 384;

function sum(rows, selector) {
  return rows.reduce((total, row, index) => total + selector(row, index), 0);
}

function moistureDamping(moistureFraction, extinctionFraction) {
  const ratio = Math.min(1, Math.max(0, moistureFraction / extinctionFraction));
  return 1 - 2.59 * ratio + 5.11 * ratio ** 2 - 3.52 * ratio ** 3;
}

function runOracle(midflameWindKmh) {
  const rows = [...TU2.dead, ...TU2.live];
  const totalSurfaceArea = sum(rows, (row) => row.loadLbPerFt2 * row.sigmaPerFt);
  const deadSurfaceArea = sum(TU2.dead, (row) => row.loadLbPerFt2 * row.sigmaPerFt);
  const liveSurfaceArea = sum(TU2.live, (row) => row.loadLbPerFt2 * row.sigmaPerFt);
  const deadSurfaceFractions = TU2.dead.map(
    (row) => row.loadLbPerFt2 * row.sigmaPerFt / deadSurfaceArea
  );
  const liveSurfaceFractions = TU2.live.map(
    (row) => row.loadLbPerFt2 * row.sigmaPerFt / liveSurfaceArea
  );
  const totalLoad = sum(rows, (row) => row.loadLbPerFt2);
  const sigma = sum(rows, (row) => row.loadLbPerFt2 * row.sigmaPerFt ** 2) / totalSurfaceArea;
  const deadFraction = deadSurfaceArea / totalSurfaceArea;
  const liveFraction = liveSurfaceArea / totalSurfaceArea;
  const deadNetLoad = sum(TU2.dead, (row, index) => row.loadLbPerFt2 * deadSurfaceFractions[index])
    * (1 - TU2.totalMineralFraction);
  const liveNetLoad = sum(TU2.live, (row) => row.loadLbPerFt2)
    * (1 - TU2.totalMineralFraction);
  const bulkDensity = totalLoad / TU2.depthFt;
  const packingRatio = bulkDensity / TU2.particleDensityLbPerFt3;
  const optimumPackingRatio = 3.348 * sigma ** -0.8189;
  const packingRatioRatio = packingRatio / optimumPackingRatio;
  const reactionCoefficientA = 133 * sigma ** -0.7913;
  const maximumReactionVelocity = sigma ** 1.5 / (495 + 0.0594 * sigma ** 1.5);
  const reactionVelocity = maximumReactionVelocity
    * packingRatioRatio ** reactionCoefficientA
    * Math.exp(reactionCoefficientA * (1 - packingRatioRatio));
  const mineralDamping = Math.min(
    1,
    0.174 * TU2.effectiveMineralFraction ** -0.19
  );
  const deadHeatingNumber = sum(TU2.dead, (row) => (
    row.loadLbPerFt2 * Math.exp(-138 / row.sigmaPerFt)
  ));
  const liveHeatingNumber = sum(TU2.live, (row) => (
    row.loadLbPerFt2 * Math.exp(-500 / row.sigmaPerFt)
  ));
  const liveMoistureOfExtinction = Math.max(
    TU2.moistureOfExtinctionFraction,
    2.9 * (deadHeatingNumber / liveHeatingNumber)
      * (1 - TU2.deadMoistureFraction / TU2.moistureOfExtinctionFraction)
      - 0.226
  );
  const deadDamping = moistureDamping(
    TU2.deadMoistureFraction,
    TU2.moistureOfExtinctionFraction
  );
  const liveDamping = moistureDamping(
    TU2.liveMoistureFraction,
    liveMoistureOfExtinction
  );
  const heatSink = deadFraction * sum(TU2.dead, (row, index) => (
    deadSurfaceFractions[index]
      * (250 + 1116 * TU2.deadMoistureFraction)
      * Math.exp(-138 / row.sigmaPerFt)
  )) + liveFraction * sum(TU2.live, (row, index) => (
    liveSurfaceFractions[index]
      * (250 + 1116 * TU2.liveMoistureFraction)
      * Math.exp(-138 / row.sigmaPerFt)
  ));
  const reactionIntensity = reactionVelocity
    * (deadNetLoad * TU2.heatContentBtuPerLb * deadDamping
      + liveNetLoad * TU2.heatContentBtuPerLb * liveDamping)
    * mineralDamping;
  const propagatingFluxRatio = Math.exp(
    (0.792 + 0.681 * Math.sqrt(sigma)) * (packingRatio + 0.1)
  ) / (192 + 0.2595 * sigma);
  const noWindNoSlopeRate = reactionIntensity * propagatingFluxRatio
    / (bulkDensity * heatSink) * METERS_PER_FOOT;
  const windFtPerMin = Math.min(
    midflameWindKmh * KMH_TO_FT_PER_MIN,
    0.9 * reactionIntensity
  );
  const windCoefficient = 7.47 * Math.exp(-0.133 * sigma ** 0.55);
  const windExponent = 0.02526 * sigma ** 0.54;
  const windPower = 0.715 * Math.exp(-3.59e-4 * sigma);
  const windFactor = midflameWindKmh <= 0
    ? 0
    : windCoefficient * windFtPerMin ** windExponent * packingRatioRatio ** -windPower;
  const slopeFactor = 5.275 * packingRatio ** -0.3 * 0.1 ** 2;
  const rateMPerMin = noWindNoSlopeRate * (1 + windFactor + slopeFactor);
  const reactionIntensityKjPerM2Min = reactionIntensity * BTU_PER_FT2_TO_KJ_PER_M2;
  const heatPerUnitAreaKjPerM2 = reactionIntensityKjPerM2Min * (RESIDENCE_TIME_MIN / sigma);

  return {
    rateMPerMin,
    reactionIntensityKjPerM2Min,
    heatPerUnitAreaKjPerM2,
    firelineIntensityKwPerM: heatPerUnitAreaKjPerM2 * rateMPerMin / 60
  };
}

// These values are pinned from the independent oracle above. They make an
// accidental shared bug in the oracle and production kernel visible.
const EXPECTED = Object.freeze([
  { wind: 0, rate: 0.425454150, reaction: 23201.577329, intensity: 35.599213 },
  { wind: 3, rate: 1.621631220, reaction: 23201.577329, intensity: 135.687465 },
  { wind: 6, rate: 3.660450209, reaction: 23201.577329, intensity: 306.282467 },
  { wind: 9, rate: 6.214718074, reaction: 23201.577329, intensity: 520.006851 },
  { wind: 12, rate: 9.174325672, reaction: 23201.577329, intensity: 767.647404 }
]);

// The production fuel table stores published US values after rounded SI
// conversions (for example, 2000 1/ft becomes 6562 1/m). Keep this small
// tolerance separate from the oracle's pinned-value tolerance.
const KERNEL_TOLERANCE = 2e-4;

const relativeError = (actual, expected) => Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
const fuelModel = getFuelModel('TU2');
const rows = EXPECTED.map((fixture) => {
  const oracle = runOracle(fixture.wind);
  const actual = calculateSurfaceSpread({
    fuelModel,
    deadMoistureFraction: TU2.deadMoistureFraction,
    liveMoistureFraction: TU2.liveMoistureFraction,
    midflameWindKmh: fixture.wind,
    windDirectionRadians: 0,
    slopeRadians: Math.atan(0.10),
    slopeAspectEast: 1,
    slopeAspectNorth: 0,
    travelDirectionEast: 1,
    travelDirectionNorth: 0
  });
  const oracleErrors = {
    rate: relativeError(oracle.rateMPerMin, fixture.rate),
    reaction: relativeError(oracle.reactionIntensityKjPerM2Min, fixture.reaction),
    intensity: relativeError(oracle.firelineIntensityKwPerM, fixture.intensity)
  };
  const kernelErrors = {
    rate: relativeError(actual.rateMPerMin, oracle.rateMPerMin),
    reaction: relativeError(actual.reactionIntensityKjPerM2Min, oracle.reactionIntensityKjPerM2Min),
    intensity: relativeError(actual.firelineIntensityKwPerM, oracle.firelineIntensityKwPerM)
  };
  return {
    midflameWindKmh: fixture.wind,
    oracle: {
      rateMPerMin: Number(oracle.rateMPerMin.toFixed(9)),
      reactionIntensityKjPerM2Min: Number(oracle.reactionIntensityKjPerM2Min.toFixed(6)),
      firelineIntensityKwPerM: Number(oracle.firelineIntensityKwPerM.toFixed(6))
    },
    actual: {
      rateMPerMin: Number(actual.rateMPerMin.toFixed(9)),
      reactionIntensityKjPerM2Min: Number(actual.reactionIntensityKjPerM2Min.toFixed(6)),
      firelineIntensityKwPerM: Number(actual.firelineIntensityKwPerM.toFixed(6))
    },
    oracleErrors,
    kernelErrors,
    pass: Object.values(oracleErrors).every((error) => error < 1e-8)
      && Object.values(kernelErrors).every((error) => error < KERNEL_TOLERANCE)
  };
});

const report = {
  fixture: 'Scott & Burgan TU2 · independent Rothermel equation oracle',
  source: 'https://research.fs.usda.gov/download/treesearch/47875.pdf',
  equationSource: 'https://research.fs.usda.gov/treesearch/32533',
  kernelTolerance: KERNEL_TOLERANCE,
  pass: rows.every((row) => row.pass),
  rows
};

console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
