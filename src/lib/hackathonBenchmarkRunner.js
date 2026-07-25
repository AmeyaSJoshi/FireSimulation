import { readFileSync } from 'node:fs';
import { createRateBasedFireSimulation } from './firePropagation.js';
import {
  DEER_FIRE_2016,
  RESERVOIR_FIRE_2016
} from './historicalPerimeterFixtures.js';
import { OFFICIAL_BENCHMARK_FIXTURES } from './officialBenchmarkFixtures.js';
import { getFuelModel } from './fuelModels.js';
import {
  HACKATHON_VALIDATION_REGION,
  summarizeHackathonBenchmarks
} from './hackathonValidation.js';
import {
  rasterizePerimeterGeometry,
  validateArrivalAgainstPerimeter
} from './perimeterValidation.js';
import { createSpatialGrid } from './spatialGrid.js';
import { hasUsableCrownStructure } from './landfireCanopy.js';

// Real per-case terrain/fuel/weather, frozen by
// scripts/build-regional-benchmark-fields.mjs from live Open-Meteo and
// WorldCover sources (see that script for provenance). Each of the three
// fields reports its own {available, ...} state independently -- one
// exhausted upstream quota does not discard fields that did succeed. A
// missing fixture file (never generated) falls back to the fully-synthetic
// path for every case, same as before this change existed.
function loadRegionalBenchmarkFields() {
  try {
    const path = new URL('./regionalBenchmarkFields.generated.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return new Map(parsed.map((entry) => [entry.id, entry]));
  } catch {
    return new Map();
  }
}
const REGIONAL_BENCHMARK_FIELDS_BY_ID = loadRegionalBenchmarkFields();

export const HACKATHON_BENCHMARK_DEFINITIONS = Object.freeze([
  {
    fixture: RESERVOIR_FIRE_2016,
    id: 'reservoir-2016',
    center: { latitude: 39.152745, longitude: -122.571182 },
    // RESERVOIR_FIRE_2016.alarmDate 2016-06-26 -> containmentDate 2016-06-30
    // is a real 4-day span; the previous 1300 min (~0.9 days) gave the model
    // under a quarter of the real fire's time to reach the perimeter.
    modelTimeMinutes: 5760,
    ignition: { x: 63.5, y: 63.5 },
    ignitionAssumption: 'documented local-window center; source row does not publish a verified ignition point',
    split: 'calibration',
    inputProfile: 'homogeneous TU2; flat terrain; calm synthetic weather; no archived weather',
    dataQuality: {
      perimeter: 'repository fixture',
      fuel: 'synthetic_tu2',
      terrain: 'flat_synthetic',
      weather: 'calm_synthetic',
      ignition: 'documented_local_window_center',
      suppression: 'unavailable'
    }
  },
  {
    fixture: DEER_FIRE_2016,
    id: 'deer-2016',
    center: DEER_FIRE_2016.ignition,
    modelTimeMinutes: 4320,
    ignition: null,
    ignitionAssumption: 'fixture ignition coordinate from the public record',
    split: 'holdout',
    inputProfile: 'homogeneous TU2; flat terrain; calm synthetic weather; no archived weather',
    dataQuality: {
      perimeter: 'repository fixture',
      fuel: 'synthetic_tu2',
      terrain: 'flat_synthetic',
      weather: 'calm_synthetic',
      ignition: 'public_fixture_coordinate',
      suppression: 'unavailable'
    }
  },
  ...OFFICIAL_BENCHMARK_FIXTURES.map((fixture) => ({
    fixture,
    id: fixture.id,
    center: fixture.center,
    size: fixture.size,
    cellSizeMeters: fixture.cellSizeMeters,
    modelTimeMinutes: fixture.modelTimeMinutes,
    ignition: {
      x: (fixture.size - 1) / 2,
      y: (fixture.size - 1) / 2
    },
    ignitionAssumption: 'perimeter extent center; public layer does not publish a verified ignition point',
    split: fixture.split,
    inputProfile: 'official perimeter; homogeneous TU2; flat terrain; calm synthetic weather; no archived weather',
    dataQuality: fixture.inputQuality
  }))
]);

function requireFiniteInRange(name, value, minimum, maximum = Infinity) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`hackathonBenchmarkRunner: ${name} must be in [${minimum}, ${maximum}]`);
  }
}

const IGNITION_NEIGHBOR_OFFSETS = Object.freeze([
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1]
]);
// A component below this size is the kind of 1-2 cell fuel speck a
// synthetic bounding-box-centroid ignition can land on by geometric chance
// (see oregon-gulch-2014 in docs/regional-model-run/THREAD.md); anything at
// or above it is treated as a normal, well-connected starting point.
const MIN_WELL_CONNECTED_IGNITION_CELLS = 25;

function burnableComponentSize(fuelModelCodes, size, startIndex, cap) {
  if (!getFuelModel(fuelModelCodes[startIndex])?.burnable) return 0;
  const visited = new Uint8Array(fuelModelCodes.length);
  const queue = [startIndex];
  visited[startIndex] = 1;
  let count = 0;
  while (queue.length > 0 && count < cap) {
    const index = queue.pop();
    count += 1;
    const row = Math.floor(index / size);
    const col = index % size;
    for (const [dx, dy] of IGNITION_NEIGHBOR_OFFSETS) {
      const nextRow = row + dy;
      const nextCol = col + dx;
      if (nextRow < 0 || nextRow >= size || nextCol < 0 || nextCol >= size) continue;
      const nextIndex = nextRow * size + nextCol;
      if (visited[nextIndex]) continue;
      visited[nextIndex] = 1;
      if (getFuelModel(fuelModelCodes[nextIndex])?.burnable) queue.push(nextIndex);
    }
  }
  return count;
}

function nearestWellConnectedIgnition({ fuelModelCodes, size, startCol, startRow }) {
  const clampedCol = Math.min(size - 1, Math.max(0, startCol));
  const clampedRow = Math.min(size - 1, Math.max(0, startRow));
  const startIndex = clampedRow * size + clampedCol;
  if (burnableComponentSize(fuelModelCodes, size, startIndex, MIN_WELL_CONNECTED_IGNITION_CELLS)
    >= MIN_WELL_CONNECTED_IGNITION_CELLS) {
    return { x: clampedCol, y: clampedRow };
  }
  for (let radius = 1; radius < size; radius += 1) {
    let best = null;
    let bestDistance = Infinity;
    for (let row = Math.max(0, clampedRow - radius); row <= Math.min(size - 1, clampedRow + radius); row += 1) {
      for (let col = Math.max(0, clampedCol - radius); col <= Math.min(size - 1, clampedCol + radius); col += 1) {
        const onRing = Math.max(Math.abs(row - clampedRow), Math.abs(col - clampedCol)) === radius;
        if (!onRing) continue;
        const index = row * size + col;
        if (burnableComponentSize(fuelModelCodes, size, index, MIN_WELL_CONNECTED_IGNITION_CELLS)
          < MIN_WELL_CONNECTED_IGNITION_CELLS) continue;
        const distance = Math.hypot(row - clampedRow, col - clampedCol);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x: col, y: row };
        }
      }
    }
    if (best) return best;
  }
  return { x: clampedCol, y: clampedRow };
}

// LANDFIRE canopy cells are legitimately null off-forest; the solver treats
// a non-finite entry as "no crown structure here", which NaN preserves.
function floatFieldOrNull(values) {
  return Array.isArray(values)
    ? Float32Array.from(values, (value) => (Number.isFinite(value) ? value : Number.NaN))
    : null;
}

function benchmarkIgnition(definition, grid) {
  if (definition.ignition) return definition.ignition;
  const cell = grid.latLonToCell(
    definition.fixture.ignition.latitude,
    definition.fixture.ignition.longitude
  );
  return { ...cell, x: cell.col, y: cell.row };
}

export function runConusHackathonBenchmarks({
  size = 128,
  cellSizeMeters = 100,
  deadMoistureFraction = 0.05,
  liveMoistureFraction = 0.5,
  midflameWindKmh = 0,
  fuelLoadScale = 1,
  splits = ['calibration', 'holdout']
} = {}) {
  if (!Number.isInteger(size) || size < 3) {
    throw new RangeError('hackathonBenchmarkRunner: size must be an integer >= 3');
  }
  requireFiniteInRange('cellSizeMeters', cellSizeMeters, 1);
  requireFiniteInRange('deadMoistureFraction', deadMoistureFraction, 0, 1);
  requireFiniteInRange('liveMoistureFraction', liveMoistureFraction, 0, 2);
  requireFiniteInRange('midflameWindKmh', midflameWindKmh, 0);
  requireFiniteInRange('fuelLoadScale', fuelLoadScale, 0, 1);
  if (!Array.isArray(splits) || splits.length === 0
    || splits.some((split) => split !== 'calibration' && split !== 'holdout')) {
    throw new RangeError('hackathonBenchmarkRunner: splits must contain calibration and/or holdout');
  }
  const selectedDefinitions = HACKATHON_BENCHMARK_DEFINITIONS
    .filter((definition) => splits.includes(definition.split));
  if (selectedDefinitions.length === 0) {
    throw new RangeError('hackathonBenchmarkRunner: requested splits contain no benchmark cases');
  }

  const cases = selectedDefinitions.map((definition) => {
    const caseSize = definition.size ?? size;
    const caseCellSizeMeters = definition.cellSizeMeters ?? cellSizeMeters;
    const grid = createSpatialGrid({
      ...definition.center,
      cellSizeMeters: caseCellSizeMeters,
      gridSize: caseSize
    });
    const rawIgnition = benchmarkIgnition(definition, grid);
    const observedMask = rasterizePerimeterGeometry({
      geometry: definition.fixture.geometry,
      grid
    });
    const regionalFields = REGIONAL_BENCHMARK_FIELDS_BY_ID.get(definition.id) ?? null;
    const realTerrain = regionalFields?.terrain?.available
      && regionalFields.terrain.heights.length === caseSize * caseSize
      ? regionalFields.terrain
      : null;
    const realFuel = regionalFields?.fuel?.available
      && regionalFields.fuel.fuelModelCodes.length === caseSize * caseSize
      ? regionalFields.fuel
      : null;
    const realWeather = regionalFields?.weather?.available ? regionalFields.weather : null;
    // Crown fire stays gated on real measured canopy structure: crownFire.js
    // refuses to run without both canopy base height and bulk density, and
    // LANDFIRE is the only source that supplies them. No fallback estimate.
    const realCanopy = regionalFields?.canopy?.available
      && regionalFields.canopy.canopyBaseHeightByCell?.length === caseSize * caseSize
      ? regionalFields.canopy
      : null;
    // A synthetic ignition point (bounding-box centroid, used whenever the
    // public perimeter layer does not publish a real ignition coordinate)
    // can land on fuel by geometric chance -- including a tiny, disconnected
    // patch surrounded by a different fuel model. That is a self-inflicted
    // failure independent of physics, not evidence about the fire. Nudge
    // the synthetic point to the nearest well-connected burnable component
    // when this happens; leave real (public-record) ignition coordinates
    // untouched.
    const ignition = (!definition.fixture.ignition && realFuel)
      ? nearestWellConnectedIgnition({
        fuelModelCodes: realFuel.fuelModelCodes,
        size: caseSize,
        startCol: Math.round(rawIgnition.x),
        startRow: Math.round(rawIgnition.y)
      })
      : rawIgnition;

    const simulation = createRateBasedFireSimulation({
      size: caseSize,
      cellSizeMeters: caseCellSizeMeters,
      ignition,
      deadMoistureFraction,
      liveMoistureFraction,
      midflameWindKmh,
      timestepMinutes: 1,
      burnDurationMinutes: 30,
      maxPropagationMinutes: Infinity,
      ...(realFuel
        ? {
          fuelModelCodes: realFuel.fuelModelCodes,
          // fuelLoadScale stays a live calibration knob (fuel availability
          // is source-supported per the calibration rules) even though the
          // per-cell base value now comes from real WorldCover-derived fuel.
          fuelLoadScaleByCell: Float32Array.from(realFuel.fuelLoadScaleByCell, (value) => value * fuelLoadScale),
          ...(Array.isArray(realFuel.fuelPersistenceMinutesByCell)
            ? { fuelPersistenceMinutesByCell: Float32Array.from(realFuel.fuelPersistenceMinutesByCell) }
            : {})
        }
        : {
          fuelModel: getFuelModel('TU2'),
          fuelLoadScaleByCell: new Float32Array(caseSize * caseSize).fill(fuelLoadScale)
        }),
      terrainHeights: realTerrain
        ? Float32Array.from(realTerrain.heights)
        : new Float32Array(caseSize * caseSize),
      ...(realWeather
        ? {
          weatherTimeline: realWeather.windTimeline,
          deadMoistureByClass: realWeather.fuelMoisture?.byClass ?? null
        }
        : {}),
      ...(realCanopy
        ? {
          canopyHeightByCell: floatFieldOrNull(realCanopy.canopyHeightByCell),
          canopyCoverFractionByCell: floatFieldOrNull(realCanopy.canopyCoverFractionByCell),
          canopyBaseHeightByCell: floatFieldOrNull(realCanopy.canopyBaseHeightByCell),
          canopyBulkDensityByCell: floatFieldOrNull(realCanopy.canopyBulkDensityByCell),
          // The solver gates crown fire on this flag in addition to the two
          // structure fields; a cell qualifies only where LANDFIRE actually
          // measured both canopy base height and bulk density.
          canopyCrownAvailableByCell: Uint8Array.from(
            realCanopy.canopyBaseHeightByCell,
            (baseHeight, index) => (hasUsableCrownStructure({
              canopyBaseHeightMeters: baseHeight,
              canopyBulkDensityKgPerM3: realCanopy.canopyBulkDensityByCell[index]
            }) ? 1 : 0)
          )
        }
        : {})
    });
    const report = validateArrivalAgainstPerimeter({
      arrivalTimes: simulation.getState().arrivalTimes,
      observedMask,
      size: caseSize,
      modelTimeMinutes: definition.modelTimeMinutes,
      cellSizeMeters: caseCellSizeMeters
    });
    const dataQuality = {
      ...definition.dataQuality,
      fuel: realFuel
        ? `real_worldcover_10m (${realFuel.source})`
        : `${definition.dataQuality.fuel}${regionalFields?.fuel && !realFuel ? ` (regional fetch unavailable: ${regionalFields.fuel.reason})` : ''}`,
      terrain: realTerrain
        ? `real_elevation (${realTerrain.source}); ${realTerrain.resolutionApprox}`
        : `${definition.dataQuality.terrain}${regionalFields?.terrain && !realTerrain ? ` (regional fetch unavailable: ${regionalFields.terrain.reason})` : ''}`,
      weather: realWeather
        ? `real_historical_archive (${realWeather.source})`
        : `${definition.dataQuality.weather}${regionalFields?.weather && !realWeather ? ` (regional fetch unavailable: ${regionalFields.weather.reason})` : ''}`
    };
    const inputProfile = [
      realFuel ? 'real WorldCover 10m fuel' : 'synthetic homogeneous TU2 fuel',
      realTerrain ? 'real Open-Meteo elevation terrain (approximate registration)' : 'flat synthetic terrain',
      realWeather ? 'real Open-Meteo historical weather archive' : 'calm synthetic weather'
    ].join('; ');
    return {
      id: definition.id,
      name: definition.fixture.name,
      source: definition.fixture.sourceQueryUrl ?? definition.fixture.sourceUrl,
      sourceSnapshotSha256: definition.fixture.sourceSnapshotSha256 ?? null,
      geometrySha256: definition.fixture.geometrySha256 ?? null,
      year: definition.fixture.year ?? null,
      state: definition.fixture.state ?? null,
      reportedAcres: definition.fixture.reportedAcres ?? null,
      collectionMethod: definition.fixture.collectionMethod,
      ignitionAssumption: definition.ignitionAssumption,
      split: definition.split,
      inputProfile,
      usingRealFields: {
        terrain: Boolean(realTerrain),
        fuel: Boolean(realFuel),
        weather: Boolean(realWeather),
        canopy: Boolean(realCanopy)
      },
      crownCapableCellCount: realCanopy?.crownCapableCellCount ?? 0,
      dataQuality,
      grid: { size: caseSize, cellSizeMeters: caseCellSizeMeters },
      modelTimeMinutes: definition.modelTimeMinutes,
      report
    };
  });

  return {
    region: HACKATHON_VALIDATION_REGION,
    benchmark: 'official perimeter diagnostic suite; per-case inputProfile/dataQuality states whether each case uses real regional terrain/fuel/weather or the homogeneous TU2/flat/calm fallback (see cases[].usingRegionalFields)',
    evaluatedSplits: [...splits],
    grid: { size, cellSizeMeters },
    parameters: {
      deadMoistureFraction,
      liveMoistureFraction,
      midflameWindKmh,
      fuelLoadScale
    },
    cases,
    summary: summarizeHackathonBenchmarks(cases)
  };
}
