import { runScenario } from './runScenario.js';
import { runScenarioEnsemble } from './scenarioEnsemble.js';

export const DEFAULT_SCENARIO_RESULT_CACHE_TTL_MS = 5 * 60_000;

function finite(value, name, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`scenarioGateway: ${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function abortError() {
  const error = new Error('Scenario request was superseded by a newer request');
  error.name = 'AbortError';
  return error;
}

function assertArrivalField(value) {
  if (!(value instanceof Float32Array) || value.length === 0) {
    throw new TypeError('scenarioGateway: result must contain a Float32Array arrivalField');
  }
  for (const arrival of value) {
    if (!Number.isFinite(arrival) || arrival < -1) {
      throw new RangeError('scenarioGateway: arrivalField values must be -1 or non-negative finite minutes');
    }
  }
  return value;
}

function assertResultRegion(region, fieldLength) {
  const gridSize = region?.gridSize;
  if (!Number.isInteger(gridSize) || gridSize < 1 || gridSize ** 2 !== fieldLength) {
    throw new RangeError('scenarioGateway: region.gridSize must match the result field');
  }
  finite(region?.cellSizeMeters, 'region.cellSizeMeters', 0.01, 1_000_000);
  const { west, south, east, north } = region?.bbox ?? {};
  finite(west, 'region.bbox.west', -180, 180);
  finite(east, 'region.bbox.east', -180, 180);
  finite(south, 'region.bbox.south', -90, 90);
  finite(north, 'region.bbox.north', -90, 90);
  if (west >= east || south >= north) {
    throw new RangeError('scenarioGateway: region.bbox must have west < east and south < north');
  }
  return region;
}

function assertBurnProbability(value, fieldLength) {
  if (!(value instanceof Float32Array) || value.length !== fieldLength) {
    throw new TypeError('scenarioGateway: result must contain a matching Float32Array burnProbability');
  }
  for (const probability of value) {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError('scenarioGateway: burnProbability values must be finite values from 0 through 1');
    }
  }
  return value;
}

function normalizedOverrides(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('scenarioGateway: overrides must be an object');
  }
  const optional = (key, minimum, maximum) => (
    overrides[key] === undefined || overrides[key] === null
      ? null
      : finite(overrides[key], `overrides.${key}`, minimum, maximum)
  );
  return {
    windSpeedKmh: optional('windSpeedKmh', 0, 200),
    windDirectionDeg: optional('windDirectionDeg', 0, 360),
    moistureFraction: optional('moistureFraction', 0, 1),
    horizonMinutes: optional('horizonMinutes', 1, 10_080)
  };
}

// The only request shape a renderer needs to construct. It contains WGS84
// values only; renderer objects and screen coordinates never cross this seam.
export function normalizeScenarioRequest({ ignition, viewHint = {}, overrides = {} } = {}) {
  if (!viewHint || typeof viewHint !== 'object' || Array.isArray(viewHint)) {
    throw new TypeError('scenarioGateway: viewHint must be an object');
  }
  return {
    ignition: {
      latitude: finite(ignition?.latitude, 'ignition.latitude', -90, 90),
      longitude: finite(ignition?.longitude, 'ignition.longitude', -180, 180)
    },
    viewHint: {
      altitudeMeters: viewHint.altitudeMeters === undefined || viewHint.altitudeMeters === null
        ? null
        : finite(viewHint.altitudeMeters, 'viewHint.altitudeMeters', 0, 100_000_000)
    },
    overrides: normalizedOverrides(overrides)
  };
}

function burnProbabilityFromArrivals(arrivalField) {
  return Float32Array.from(arrivalField, (arrival) => arrival >= 0 ? 1 : 0);
}

function normalizedScenarioResult(result, request) {
  const arrivalField = assertArrivalField(result?.arrivalField);
  const region = assertResultRegion(result?.region, arrivalField.length);
  return {
    kind: 'scenario',
    request,
    ignition: result.ignition,
    region,
    arrivalField,
    burnProbability: burnProbabilityFromArrivals(arrivalField),
    fuelCodes: result.context?.fuelCodes ?? [],
    features: {
      buildings: result.context?.buildings ?? [],
      roads: result.context?.roads ?? []
    },
    provenance: result.evidence ?? { sources: [], fallbacks: [] },
    confidence: result.confidence ?? 'fallback',
    simulation: result.simulation ?? {}
  };
}

function normalizedEnsembleResult(result, request) {
  const arrivalField = assertArrivalField(result?.consensusArrivalMinutes);
  const region = assertResultRegion(result?.region, arrivalField.length);
  const burnProbability = assertBurnProbability(result?.burnFraction, arrivalField.length);
  const engines = [...new Set((result.members ?? [])
    .map(({ scenario }) => scenario?.simulation?.engine)
    .filter(Boolean))];
  return {
    kind: 'ensemble',
    request,
    ignition: result.ignition,
    region,
    arrivalField,
    burnProbability,
    features: {
      buildings: result.context?.buildings ?? [],
      roads: result.context?.roads ?? []
    },
    provenance: result.evidence ?? { sources: [], fallbacks: [] },
    confidence: result.confidence ?? 'fallback',
    simulation: {
      engine: engines.length === 1 ? engines[0] : engines,
      memberCount: result.memberCount,
      likelyThreshold: result.likelyThreshold,
      requiredBurns: result.requiredBurns
    }
  };
}

// Use this only at an HTTP boundary. Keep typed arrays in-process for Cesium
// and canvas rendering; JSON uses -1 as the unreachable sentinel.
export function serializeScenarioResult(result) {
  const arrivalField = assertArrivalField(result?.arrivalField);
  const region = assertResultRegion(result?.region, arrivalField.length);
  const burnProbability = assertBurnProbability(result?.burnProbability, arrivalField.length);
  return {
    kind: result.kind,
    ignition: result.ignition,
    region,
    arrivalMinutes: Array.from(arrivalField, (arrival) => Number.isFinite(arrival) ? arrival : -1),
    burnProbability: Array.from(burnProbability),
    features: result.features,
    provenance: result.provenance,
    confidence: result.confidence,
    simulation: result.simulation
  };
}

function resultCacheKey(request, mode, likelyThreshold) {
  return JSON.stringify({ request, mode, likelyThreshold });
}

// Stateful application-facing runner. A future Cesium bridge calls submit()
// with the canonical request; it never needs to know about data providers.
export function createScenarioGateway({
  adapters = undefined,
  mode = 'ensemble',
  scenarioOptions = { propagation: 'rothermel' },
  ensembleOptions = {},
  runScenarioImpl = runScenario,
  runEnsembleImpl = runScenarioEnsemble,
  cacheTtlMs = DEFAULT_SCENARIO_RESULT_CACHE_TTL_MS,
  now = () => Date.now()
} = {}) {
  if (!['scenario', 'ensemble'].includes(mode)) {
    throw new RangeError('scenarioGateway: mode must be scenario or ensemble');
  }
  if (typeof runScenarioImpl !== 'function' || typeof runEnsembleImpl !== 'function') {
    throw new TypeError('scenarioGateway: runners must be functions');
  }
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) {
    throw new RangeError('scenarioGateway: cacheTtlMs must be positive');
  }
  const completed = new Map();
  let active = null;
  let latest = null;

  function clearCache() {
    completed.clear();
  }

  function cancel() {
    active?.controller.abort();
  }

  async function submit(input) {
    const request = normalizeScenarioRequest(input);
    const likelyThreshold = ensembleOptions.likelyThreshold ?? 0.5;
    const key = resultCacheKey(request, mode, likelyThreshold);
    const cached = completed.get(key);
    if (cached && cached.expiresAt > now()) {
      latest = cached.result;
      return cached.result;
    }
    cancel();
    const controller = new AbortController();
    const token = Symbol('scenario-request');
    active = { controller, token };
    const singleScenarioOptions = {
      ...scenarioOptions,
      signal: controller.signal,
      ...(adapters ? { adapters } : {})
    };
    const ensembleRunOptions = {
      ...ensembleOptions,
      scenarioOptions: { ...ensembleOptions.scenarioOptions, ...scenarioOptions },
      signal: controller.signal,
      cache: false,
      ...(adapters ? { adapters } : {})
    };
    try {
      const raw = mode === 'ensemble'
        ? await runEnsembleImpl(request, ensembleRunOptions)
        : await runScenarioImpl(request, singleScenarioOptions);
      if (controller.signal.aborted || active?.token !== token) throw abortError();
      const result = mode === 'ensemble'
        ? normalizedEnsembleResult(raw, request)
        : normalizedScenarioResult(raw, request);
      latest = result;
      completed.set(key, { result, expiresAt: now() + cacheTtlMs });
      while (completed.size > 24) completed.delete(completed.keys().next().value);
      return result;
    } finally {
      if (active?.token === token) active = null;
    }
  }

  return {
    submit,
    cancel,
    clearCache,
    getLatest: () => latest
  };
}
