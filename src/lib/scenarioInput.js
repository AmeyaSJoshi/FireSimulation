// Versioned, location-dependent scenario-input object.
//
// This is the single object every downstream module reads from when a
// simulation is armed. Phase 1 populates the grid/elevation/simulation
// sections with real data; Phase 2 will fill land-cover / weather / fuel;
// Phase 3+ will consume all of it in the Rothermel kernel.
//
// The schemaVersion lets replay / history entries survive future changes
// without silently mis-reading old records. Bump the version whenever a
// field is added, removed, renamed, or its meaning changes.

export const SCENARIO_INPUT_SCHEMA_VERSION = '1.0.0';
export const MODEL_VERSION = 'phase1';
export const KNOWN_ENGINES = ['legacy', 'phase1'];

export function createScenarioInput({
  latitude,
  longitude,
  cellSizeMeters,
  gridSize,
  elevation = null,
  weather = null,
  wind = null,
  moisture = null,
  fuel = null,
  landCover = null,
  simulation = null
} = {}) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError(`scenarioInput: latitude must be finite in [-90, 90], got ${latitude}`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError(`scenarioInput: longitude must be finite in [-180, 180], got ${longitude}`);
  }
  if (!Number.isFinite(cellSizeMeters) || cellSizeMeters <= 0) {
    throw new RangeError(`scenarioInput: cellSizeMeters must be a positive finite number, got ${cellSizeMeters}`);
  }
  if (!Number.isInteger(gridSize) || gridSize < 2) {
    throw new RangeError(`scenarioInput: gridSize must be an integer ≥ 2, got ${gridSize}`);
  }

  const simulationBlock = normalizeSimulation(simulation);

  return {
    schemaVersion: SCENARIO_INPUT_SCHEMA_VERSION,
    location: { latitude, longitude },
    grid: {
      origin: { latitude, longitude },
      cellSizeMeters,
      gridSize
    },
    elevation: normalizeElevation(elevation),
    landCover, // Phase 2: crosswalk from a global land-cover source.
    weather: normalizeWeather(weather),
    wind: normalizeWind(wind),
    moisture: normalizeMoisture(moisture),
    fuel: normalizeFuel(fuel),
    simulation: simulationBlock,
    provenance: {
      createdAt: Date.now(),
      modelVersion: MODEL_VERSION
    }
  };
}

function normalizeElevation(input) {
  if (!input) {
    return { source: null, fetchedAt: null, spanKm: null, hasData: false, noDataCellCount: 0 };
  }
  return {
    source: input.source ?? null,
    fetchedAt: input.fetchedAt ?? null,
    spanKm: input.spanKm ?? null,
    hasData: Boolean(input.hasData),
    noDataCellCount: Number.isFinite(input.noDataCellCount) ? input.noDataCellCount : 0
  };
}

function normalizeWeather(input) {
  if (!input) return { source: 'scenario', fetchedAt: null, hasData: false };
  return {
    source: input.source ?? 'scenario',
    fetchedAt: input.fetchedAt ?? null,
    hasData: Boolean(input.hasData)
  };
}

function normalizeWind(input) {
  const source = input?.source ?? 'scenario';
  return {
    source,
    speedKmh: Number.isFinite(input?.speedKmh) ? input.speedKmh : 0,
    directionCompassDeg: Number.isFinite(input?.directionCompassDeg) ? input.directionCompassDeg : 0,
    measurementHeightMeters: input?.measurementHeightMeters ?? null,
    midflameAdjustment: input?.midflameAdjustment ?? null
  };
}

function normalizeMoisture(input) {
  return {
    source: input?.source ?? 'scenario',
    value: Number.isFinite(input?.value) ? input.value : 0.32
  };
}

function normalizeFuel(input) {
  return {
    source: input?.source ?? 'scenario-preset',
    code: input?.code ?? 'brush'
  };
}

function normalizeSimulation(input) {
  const engine = input?.engine ?? 'legacy';
  if (!KNOWN_ENGINES.includes(engine)) {
    throw new RangeError(`scenarioInput: unknown simulation engine ${engine}. Known: ${KNOWN_ENGINES.join(', ')}`);
  }
  return {
    engine,
    seed: Number.isFinite(input?.seed) ? input.seed : 17,
    timestepMinutes: Number.isFinite(input?.timestepMinutes) ? input.timestepMinutes : 1
  };
}
