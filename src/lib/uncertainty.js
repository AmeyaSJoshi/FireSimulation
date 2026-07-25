// Seeded, experimental uncertainty helpers for the deterministic arrival
// solver. This module perturbs only documented input ranges; its quantiles are
// ensemble ranges, never calibrated probabilities.

export const UNCERTAINTY_VERSION = 'phase5-uncertainty-0.2.0';

function requireFinite(name, value) {
  if (!Number.isFinite(value)) throw new RangeError(`uncertainty: ${name} must be finite`);
}

function requireNonNegative(name, value) {
  requireFinite(name, value);
  if (value < 0) throw new RangeError(`uncertainty: ${name} must be non-negative`);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function signedUnit(rng) {
  return rng() * 2 - 1;
}

export function createSeededRandom(seed = 1) {
  if (!Number.isInteger(seed)) throw new RangeError('uncertainty: seed must be an integer');
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function perturbMoistureByClass(values, rng, range, maximum) {
  if (!values || typeof values !== 'object') return values ?? null;
  return Object.fromEntries(Object.entries(values).map(([className, value]) => {
    if (!Number.isFinite(value)) return [className, value];
    return [className, clamp(value + signedUnit(rng) * range, 0, maximum)];
  }));
}

export function perturbWeatherTimeline(
  timeline,
  {
    rng = createSeededRandom(1),
    windFraction = 0,
    directionRadians = 0,
    moistureFraction = 0,
    liveMoistureFraction = 0
  } = {}
) {
  if (!Array.isArray(timeline)) return null;
  if (typeof rng !== 'function') throw new TypeError('uncertainty: rng must be a function');
  requireNonNegative('windFraction', windFraction);
  requireNonNegative('directionRadians', directionRadians);
  requireNonNegative('moistureFraction', moistureFraction);
  requireNonNegative('liveMoistureFraction', liveMoistureFraction);

  return timeline.map((entry) => {
    const next = { ...entry };
    if (Number.isFinite(entry?.midflameWindKmh)) {
      next.midflameWindKmh = Math.max(
        0,
        entry.midflameWindKmh * (1 + signedUnit(rng) * windFraction)
      );
    }
    if (Number.isFinite(entry?.windDirectionRadians)) {
      next.windDirectionRadians = entry.windDirectionRadians
        + signedUnit(rng) * directionRadians;
    }
    next.deadMoistureFraction = Number.isFinite(entry?.deadMoistureFraction)
      ? clamp(entry.deadMoistureFraction + signedUnit(rng) * moistureFraction, 0, 1)
      : entry?.deadMoistureFraction ?? null;
    next.liveMoistureFraction = Number.isFinite(entry?.liveMoistureFraction)
      ? clamp(entry.liveMoistureFraction + signedUnit(rng) * liveMoistureFraction, 0, 2)
      : entry?.liveMoistureFraction ?? null;
    next.deadMoistureByClass = perturbMoistureByClass(
      entry?.deadMoistureByClass,
      rng,
      moistureFraction,
      1
    );
    next.liveMoistureByClass = perturbMoistureByClass(
      entry?.liveMoistureByClass,
      rng,
      liveMoistureFraction,
      2
    );
    return next;
  });
}

function perturbFuelAvailability(values, rng, range) {
  if (!values) return null;
  const next = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    next[index] = Number.isFinite(value)
      ? clamp(value * (1 + signedUnit(rng) * range), 0, 1)
      : 0;
  }
  return next;
}

function chooseFuelModelAlternatives(baseCodes, alternativesByCell, rng) {
  if (!Array.isArray(alternativesByCell)) return baseCodes;
  const next = Array.isArray(baseCodes) ? [...baseCodes] : baseCodes?.slice?.();
  if (!next) return baseCodes;
  for (let index = 0; index < alternativesByCell.length; index += 1) {
    const alternatives = alternativesByCell[index];
    if (!Array.isArray(alternatives) || alternatives.length < 2) continue;
    next[index] = alternatives[Math.floor(rng() * alternatives.length)];
  }
  return next;
}

function perturbConfig(baseConfig, rng, perturbations) {
  const next = { ...baseConfig };
  if (baseConfig.weatherTimeline) {
    next.weatherTimeline = perturbWeatherTimeline(baseConfig.weatherTimeline, {
      rng,
      windFraction: perturbations.windFraction,
      directionRadians: perturbations.directionRadians,
      moistureFraction: perturbations.moistureFraction,
      liveMoistureFraction: perturbations.liveMoistureFraction
    });
  }
  if (baseConfig.fuelLoadScaleByCell) {
    next.fuelLoadScaleByCell = perturbFuelAvailability(
      baseConfig.fuelLoadScaleByCell,
      rng,
      perturbations.fuelAvailabilityFraction
    );
  }
  if (baseConfig.fuelModelAlternativesByCell && perturbations.fuelModelAlternatives !== false) {
    next.fuelModelCodes = chooseFuelModelAlternatives(
      baseConfig.fuelModelCodes,
      baseConfig.fuelModelAlternativesByCell,
      rng
    );
  }
  return next;
}

function quantile(values, probability) {
  const sortedValues = [...values].sort((left, right) => left - right);
  if (sortedValues.length === 0 || sortedValues[0] === Infinity) return Infinity;
  const index = probability * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (sortedValues[lower] === Infinity || sortedValues[upper] === Infinity) return Infinity;
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower]
    + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function quantileInteger(values, probability) {
  return Math.round(quantile(values, probability));
}

export function runSeededArrivalEnsemble({
  baseConfig,
  createSimulation,
  memberCount = 8,
  seed = 1,
  perturbations = {},
  horizonMinutes = baseConfig?.maxPropagationMinutes ?? Infinity
} = {}) {
  if (!baseConfig || typeof baseConfig !== 'object') {
    throw new TypeError('uncertainty: baseConfig is required');
  }
  if (typeof createSimulation !== 'function') {
    throw new TypeError('uncertainty: createSimulation must be a function');
  }
  if (!Number.isInteger(memberCount) || memberCount < 1) {
    throw new RangeError('uncertainty: memberCount must be a positive integer');
  }
  if (!Number.isInteger(seed)) throw new RangeError('uncertainty: seed must be an integer');
  if (horizonMinutes !== Infinity) requireNonNegative('horizonMinutes', horizonMinutes);

  const resolvedPerturbations = {
    windFraction: perturbations.windFraction ?? 0,
    directionRadians: perturbations.directionRadians ?? 0,
    moistureFraction: perturbations.moistureFraction ?? 0,
    liveMoistureFraction: perturbations.liveMoistureFraction ?? 0,
    fuelAvailabilityFraction: perturbations.fuelAvailabilityFraction ?? 0,
    fuelModelAlternatives: perturbations.fuelModelAlternatives !== false
  };
  for (const [name, value] of Object.entries(resolvedPerturbations)) {
    if (name === 'fuelModelAlternatives') continue;
    requireNonNegative(name, value);
  }

  const memberArrivalTimes = [];
  const memberFootprints = [];
  let cellCount = null;
  for (let member = 0; member < memberCount; member += 1) {
    const memberSeed = (seed + Math.imul(member, 0x9e3779b9)) | 0;
    const simulation = createSimulation(perturbConfig(
      baseConfig,
      createSeededRandom(memberSeed),
      resolvedPerturbations
    ));
    const arrivalTimes = simulation.getState?.().arrivalTimes ?? simulation.arrivalTimes;
    if (!arrivalTimes || typeof arrivalTimes.length !== 'number') {
      throw new TypeError('uncertainty: simulation must expose arrivalTimes');
    }
    if (cellCount === null) cellCount = arrivalTimes.length;
    if (arrivalTimes.length !== cellCount) throw new RangeError('uncertainty: ensemble sizes differ');
    memberArrivalTimes.push(Float64Array.from(arrivalTimes));
    memberFootprints.push(Array.from(arrivalTimes).filter((arrival) => arrival <= horizonMinutes).length);
  }

  const quantiles = {
    low: new Float64Array(cellCount),
    median: new Float64Array(cellCount),
    high: new Float64Array(cellCount)
  };
  for (let index = 0; index < cellCount; index += 1) {
    const values = memberArrivalTimes.map((arrivalTimes) => arrivalTimes[index]);
    quantiles.low[index] = quantile(values, 0.05);
    quantiles.median[index] = quantile(values, 0.5);
    quantiles.high[index] = quantile(values, 0.95);
  }

  return {
    version: UNCERTAINTY_VERSION,
    seed,
    memberCount,
    arrivalTimeQuantiles: quantiles,
    footprintAtMinutes: {
      low: quantileInteger(memberFootprints, 0.05),
      median: quantileInteger(memberFootprints, 0.5),
      high: quantileInteger(memberFootprints, 0.95)
    },
    perturbations: resolvedPerturbations,
    interpretation: {
      calibratedProbability: false,
      note: 'Quantiles summarize this seeded input ensemble; they are not calibrated probabilities.'
    }
  };
}
