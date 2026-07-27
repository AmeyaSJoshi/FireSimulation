import { createFallbackScenarioAdapters } from './scenarioAdapters.js';
import { runScenario } from './runScenario.js';
import { resolutionForAltitude } from './resolutionLadder.js';

export const DEFAULT_ENSEMBLE_SIZE = 9;
export const DEFAULT_ENSEMBLE_CACHE_TTL_MS = 5 * 60_000;

const DEFAULT_ADAPTERS = createFallbackScenarioAdapters();
const cacheByAdapter = new WeakMap();

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function sharedAdapter(adapter) {
  let contextPromise = null;
  return {
    loadContext(args) {
      contextPromise ??= Promise.resolve(adapter.loadContext(args));
      return contextPromise;
    }
  };
}

function cacheFor(adapter) {
  let cache = cacheByAdapter.get(adapter);
  if (!cache) {
    cache = new Map();
    cacheByAdapter.set(adapter, cache);
  }
  return cache;
}

function roundedCoordinate(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

export function ensembleCacheKey(request, { likelyThreshold, propagation } = {}) {
  const { ignition = {}, viewHint = {}, overrides = {} } = request ?? {};
  const resolution = resolutionForAltitude(viewHint.altitudeMeters ?? null);
  return JSON.stringify({
    latitude: roundedCoordinate(ignition.latitude),
    longitude: roundedCoordinate(ignition.longitude),
    resolution: resolution.label,
    windSpeedKmh: overrides.windSpeedKmh ?? null,
    windDirectionDeg: overrides.windDirectionDeg ?? null,
    moistureFraction: overrides.moistureFraction ?? null,
    horizonMinutes: overrides.horizonMinutes ?? null,
    likelyThreshold,
    propagation: propagation ?? 'rothermel'
  });
}

export function clearScenarioEnsembleCache(adapter = null) {
  if (adapter) cacheByAdapter.delete(adapter);
  else cacheByAdapter.delete(DEFAULT_ADAPTERS);
}

function overrideRequest(request, variant) {
  return {
    ...request,
    overrides: {
      ...request.overrides,
      windSpeedKmh: variant.windSpeedKmh,
      windDirectionDeg: variant.windDirectionDeg,
      moistureFraction: variant.moistureFraction,
      horizonMinutes: variant.horizonMinutes
    }
  };
}

export function defaultEnsembleVariants({
  windSpeedKmh,
  windDirectionDeg,
  moistureFraction,
  horizonMinutes
}) {
  const wind = (factor) => clamp(windSpeedKmh * factor, 0, 200);
  const moisture = (factor) => clamp(moistureFraction * factor, 0, 1);
  const direction = (offset) => (windDirectionDeg + offset + 360) % 360;
  const base = { windSpeedKmh, windDirectionDeg, moistureFraction, horizonMinutes };
  return [
    { id: 'base', ...base },
    { id: 'wind-low', ...base, windSpeedKmh: wind(0.75) },
    { id: 'wind-high', ...base, windSpeedKmh: wind(1.25) },
    { id: 'wind-left', ...base, windDirectionDeg: direction(-20) },
    { id: 'wind-right', ...base, windDirectionDeg: direction(20) },
    { id: 'fuel-dry', ...base, moistureFraction: moisture(0.75) },
    { id: 'fuel-wet', ...base, moistureFraction: moisture(1.25) },
    { id: 'dry-windy', ...base, windSpeedKmh: wind(1.25), moistureFraction: moisture(0.75) },
    { id: 'wet-calm', ...base, windSpeedKmh: wind(0.75), moistureFraction: moisture(1.25) }
  ];
}

export function aggregateScenarioMembers(members, { likelyThreshold = 0.5 } = {}) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new RangeError('scenarioEnsemble: members must not be empty');
  }
  if (!Number.isFinite(likelyThreshold) || likelyThreshold <= 0 || likelyThreshold > 1) {
    throw new RangeError('scenarioEnsemble: likelyThreshold must be in (0, 1]');
  }
  const first = members[0];
  const totalCells = first?.arrivalField?.length;
  if (!Number.isInteger(totalCells) || totalCells === 0) {
    throw new RangeError('scenarioEnsemble: each member must contain an arrival field');
  }
  for (const member of members) {
    if (!(member?.arrivalField instanceof Float32Array) || member.arrivalField.length !== totalCells) {
      throw new RangeError('scenarioEnsemble: member arrival fields must have matching lengths');
    }
  }
  const burnCount = new Uint8Array(totalCells);
  const burnFraction = new Float32Array(totalCells);
  const medianArrivalMinutes = new Float32Array(totalCells);
  const consensusArrivalMinutes = new Float32Array(totalCells);
  medianArrivalMinutes.fill(-1);
  consensusArrivalMinutes.fill(-1);
  const requiredBurns = Math.ceil(members.length * likelyThreshold);
  for (let index = 0; index < totalCells; index += 1) {
    const arrivals = [];
    for (const member of members) {
      const arrival = member.arrivalField[index];
      if (arrival >= 0) arrivals.push(arrival);
    }
    burnCount[index] = arrivals.length;
    burnFraction[index] = arrivals.length / members.length;
    if (arrivals.length === 0) continue;
    arrivals.sort((left, right) => left - right);
    const midpoint = Math.floor(arrivals.length / 2);
    const median = arrivals.length % 2 === 0
      ? (arrivals[midpoint - 1] + arrivals[midpoint]) / 2
      : arrivals[midpoint];
    medianArrivalMinutes[index] = median;
    if (arrivals.length >= requiredBurns) consensusArrivalMinutes[index] = median;
  }
  return {
    memberCount: members.length,
    likelyThreshold,
    requiredBurns,
    burnCount,
    burnFraction,
    medianArrivalMinutes,
    consensusArrivalMinutes
  };
}

async function buildScenarioEnsemble(request, { adapters, runScenarioImpl, scenarioOptions, likelyThreshold }) {
  const options = { ...scenarioOptions, adapters: sharedAdapter(adapters) };
  const base = await runScenarioImpl(request, options);
  const variants = defaultEnsembleVariants({
    windSpeedKmh: base.simulation.windSpeedKmh,
    windDirectionDeg: base.simulation.windDirectionDeg,
    moistureFraction: base.simulation.moistureFraction,
    horizonMinutes: base.simulation.horizonMinutes
  });
  const additional = await Promise.all(variants.slice(1).map(async (variant) => ({
    variant,
    scenario: await runScenarioImpl(overrideRequest(request, variant), options)
  })));
  const all = [{ variant: variants[0], scenario: base }, ...additional];
  const aggregation = aggregateScenarioMembers(all.map(({ scenario }) => scenario), { likelyThreshold });
  return {
    region: base.region,
    ignition: base.ignition,
    context: base.context,
    evidence: base.evidence,
    confidence: base.confidence,
    members: all,
    ...aggregation
  };
}

export async function runScenarioEnsemble(request, {
  adapters = DEFAULT_ADAPTERS,
  runScenarioImpl = runScenario,
  scenarioOptions = { propagation: 'rothermel' },
  likelyThreshold = 0.5,
  cache = true,
  cacheTtlMs = DEFAULT_ENSEMBLE_CACHE_TTL_MS,
  signal = undefined
} = {}) {
  if (!adapters || typeof adapters.loadContext !== 'function') {
    throw new TypeError('scenarioEnsemble: adapters.loadContext must be a function');
  }
  if (typeof runScenarioImpl !== 'function') {
    throw new TypeError('scenarioEnsemble: runScenarioImpl must be a function');
  }
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) {
    throw new RangeError('scenarioEnsemble: cacheTtlMs must be positive');
  }
  if (signal?.aborted) throw new DOMException('Scenario request was aborted', 'AbortError');
  const options = { ...scenarioOptions, ...(signal ? { signal } : {}) };
  const cacheable = cache && !signal && runScenarioImpl === runScenario
    && !scenarioOptions.propagate && !scenarioOptions.propagateRothermel;
  if (!cacheable) {
    return buildScenarioEnsemble(request, { adapters, runScenarioImpl, scenarioOptions: options, likelyThreshold });
  }
  const key = ensembleCacheKey(request, { likelyThreshold, propagation: scenarioOptions.propagation });
  const entries = cacheFor(adapters);
  const now = Date.now();
  const existing = entries.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;
  const promise = buildScenarioEnsemble(request, { adapters, runScenarioImpl, scenarioOptions: options, likelyThreshold });
  entries.set(key, { promise, expiresAt: now + cacheTtlMs });
  try {
    return await promise;
  } catch (error) {
    entries.delete(key);
    throw error;
  }
}

