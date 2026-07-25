import fs from 'node:fs';
import { PNG } from 'pngjs';
import { createRateBasedFireSimulation } from '../src/lib/firePropagation.js';
import { buildFuelModelCodeField } from '../src/lib/fireFieldInputs.js';
import { getFuelModel } from '../src/lib/fuelModels.js';
import { createLandCoverSource } from '../src/lib/landCoverSource.js';
import { crosswalkLandCoverToFuel } from '../src/lib/landCoverToFuel.js';
import { RUSH_CREEK_PROGRESSION } from '../src/lib/historicalProgressionFixtures.js';
import {
  buildHistoricalWeatherTimeline,
  fetchHistoricalWeatherInputs,
  normalizeHistoricalHourlyWeather
} from '../src/lib/historicalWeather.js';
import {
  rasterizePerimeterGeometry,
  validateArrivalAgainstPerimeterSeries
} from '../src/lib/perimeterValidation.js';
import { createSpatialGrid } from '../src/lib/spatialGrid.js';
import { createPerimeterContainmentBarriers } from '../src/lib/suppressionConstraints.js';
import { estimateValidationGridSize } from '../src/lib/validationDomain.js';
import { nearestWorldCoverFineSample } from '../src/lib/worldCoverFine.js';

const useArchivedWeather = process.argv.includes('--archive');
const useFineMappedFuels = process.argv.includes('--fine-mapped');
const useMappedFuels = process.argv.includes('--mapped-fuels') || useFineMappedFuels;
const useObservedContainment = process.argv.includes('--observed-containment');
const useGlobalFuelbeds = process.argv.includes('--global-fuelbeds');
const weatherFileArgumentIndex = process.argv.indexOf('--weather-file');
const weatherFile = weatherFileArgumentIndex >= 0 ? process.argv[weatherFileArgumentIndex + 1] : null;
const globalFuelbedEndpoint = process.argv.includes('--global-fuelbed-endpoint')
  ? process.argv[process.argv.indexOf('--global-fuelbed-endpoint') + 1]
  : 'http://127.0.0.1:5186/api/fuelbed/global-field';
const useAdaptiveSize = process.argv.includes('--auto-size');
const HISTORICAL_WEATHER_SPIN_UP_DAYS = 7;

function weatherStartDateBefore(ignitionTime, days) {
  const ignitionMs = Date.parse(ignitionTime);
  if (!Number.isFinite(ignitionMs)) throw new RangeError('historical progression ignition time must be valid');
  return new Date(ignitionMs - days * 86_400_000).toISOString();
}

function numericArgument(name, fallback, { integer = false, minimum = 0 } = {}) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${name} must be ${integer ? 'an integer' : 'a number'} >= ${minimum}`);
  }
  return value;
}

async function fetchGlobalFuelbedField(grid) {
  if (typeof fetch !== 'function') throw new Error('global fuelbed validation requires fetch');
  const samples = [];
  for (let row = 0; row < grid.gridSize; row += 1) {
    for (let col = 0; col < grid.gridSize; col += 1) {
      const { latitude, longitude } = grid.cellCenterLatLon(row, col);
      samples.push({ row, col, latitude, longitude });
    }
  }
  const fuelbeds = new Array(samples.length).fill(null);
  const batchSize = 4096;
  for (let start = 0; start < samples.length; start += batchSize) {
    const batch = samples.slice(start, start + batchSize);
    const response = await fetch(globalFuelbedEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ samples: batch })
    });
    if (!response.ok) throw new Error(`global fuelbed validation endpoint returned HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.fuelbeds) || payload.fuelbeds.length !== batch.length) {
      throw new Error('global fuelbed validation endpoint returned an unexpected sample count');
    }
    payload.fuelbeds.forEach((fuelbed, offset) => {
      fuelbeds[start + offset] = fuelbed;
    });
  }
  return fuelbeds;
}

// The original 128 x 128 / 100 m window is retained as the reproducible
// baseline. Long-running validation can opt into a larger domain so the
// perimeter does not hit the artificial field boundary.
const cellSizeMeters = numericArgument('--cell-meters', 100, { minimum: 1 });
const requestedSize = numericArgument('--size', 128, { integer: true, minimum: 3 });
const marginCells = numericArgument('--margin-cells', 16, { integer: true, minimum: 0 });
const size = useAdaptiveSize
  ? estimateValidationGridSize({
    center: RUSH_CREEK_PROGRESSION.ignition,
    geometries: RUSH_CREEK_PROGRESSION.observations.map((observation) => observation.geometry),
    cellSizeMeters,
    minimumSize: requestedSize,
    marginCells
  })
  : requestedSize;
const historicalWeather = useArchivedWeather
  ? weatherFile
    ? buildHistoricalWeatherTimeline({
      hours: normalizeHistoricalHourlyWeather(JSON.parse(fs.readFileSync(weatherFile, 'utf8'))),
      ignitionTime: RUSH_CREEK_PROGRESSION.discoveryTime,
      latitude: RUSH_CREEK_PROGRESSION.ignition.latitude,
      fuelBedDepthMeters: getFuelModel('TU2').fuelBedDepthMeters
    })
    : await fetchHistoricalWeatherInputs({
    latitude: RUSH_CREEK_PROGRESSION.ignition.latitude,
    longitude: RUSH_CREEK_PROGRESSION.ignition.longitude,
    startDate: weatherStartDateBefore(
      RUSH_CREEK_PROGRESSION.discoveryTime,
      HISTORICAL_WEATHER_SPIN_UP_DAYS
    ),
    endDate: RUSH_CREEK_PROGRESSION.observations.at(-1).capturedAt,
    ignitionTime: RUSH_CREEK_PROGRESSION.discoveryTime,
    fuelBedDepthMeters: getFuelModel('TU2').fuelBedDepthMeters
    })
  : null;

const grid = createSpatialGrid({
  latitude: RUSH_CREEK_PROGRESSION.ignition.latitude,
  longitude: RUSH_CREEK_PROGRESSION.ignition.longitude,
  cellSizeMeters,
  gridSize: size
});
const globalFuelbeds = useGlobalFuelbeds ? await fetchGlobalFuelbedField(grid) : null;
const globalFuelbedAtCell = (row, col) => {
  if (!globalFuelbeds || row < 0 || row >= size || col < 0 || col >= size) return null;
  return globalFuelbeds[row * size + col] ?? null;
};
const globalFuelbedAtLatLon = (latitude, longitude) => {
  const cell = grid.latLonToCell(latitude, longitude);
  return globalFuelbedAtCell(Math.round(cell.row), Math.round(cell.col));
};
const ignitionCell = grid.latLonToCell(
  RUSH_CREEK_PROGRESSION.ignition.latitude,
  RUSH_CREEK_PROGRESSION.ignition.longitude
);
const ignition = {
  ...ignitionCell,
  x: ignitionCell.col,
  y: ignitionCell.row
};
let fuelField = null;
let clickedLandCover = null;
if (useMappedFuels) {
  if (useFineMappedFuels) {
    const { readWorldCoverFineField } = await import('./read-worldcover-fine-field.mjs');
    const fineField = await readWorldCoverFineField({ grid });
    const ignitionRow = Math.round(ignition.y);
    const ignitionCol = Math.round(ignition.x);
    const ignitionIndex = ignitionRow * size + ignitionCol;
    clickedLandCover = {
      ...fineField.classifications[ignitionIndex],
      globalFuelbed: globalFuelbeds?.[ignitionIndex] ?? null
    };
    const isFineWaterAtLatLon = (latitude, longitude, context = null) => {
      const cell = grid.latLonToCell(latitude, longitude);
      const row = Math.round(cell.row);
      const col = Math.round(cell.col);
      const fineClassification = context?.kind === 'cell-edge'
        ? nearestWorldCoverFineSample(fineField.sampleClassifications, {
          gridSize: size,
          cellRow: cell.row,
          cellCol: cell.col
        })
        : (row >= 0 && row < size && col >= 0 && col < size
          ? fineField.classifications[row * size + col]
          : null);
      return fineClassification?.classCode === 80;
    };
    const clickedFuelDecision = crosswalkLandCoverToFuel(clickedLandCover);
    fuelField = buildFuelModelCodeField({
      grid,
      classifyAtCell: (row, col) => ({
        ...fineField.classifications[row * size + col],
        globalFuelbed: globalFuelbedAtCell(row, col)
      }),
      crosswalk: crosswalkLandCoverToFuel,
      isWaterAtLatLon: isFineWaterAtLatLon,
      ignition,
      ignitionFuelCode: clickedFuelDecision.fuelCode,
      ignitionFuelLoadScale: clickedFuelDecision.fuelLoadScale,
      allowExperimental: false
    });
  } else {
    const landCoverMeta = JSON.parse(fs.readFileSync(new URL('../public/landcover-coarse.json', import.meta.url), 'utf8'));
    const landCoverPng = PNG.sync.read(
      fs.readFileSync(new URL('../public/landcover-coarse.png', import.meta.url))
    );
    const landCoverSource = await createLandCoverSource({
      meta: landCoverMeta,
      imageReader: async () => ({
        readPixel(col, row) {
          const offset = (row * landCoverPng.width + col) * 4;
          return [
            landCoverPng.data[offset],
            landCoverPng.data[offset + 1],
            landCoverPng.data[offset + 2],
            landCoverPng.data[offset + 3]
          ];
        }
      })
    });
    clickedLandCover = {
      ...landCoverSource.classifyAtLatLon(
        RUSH_CREEK_PROGRESSION.ignition.latitude,
        RUSH_CREEK_PROGRESSION.ignition.longitude
      ),
      globalFuelbed: globalFuelbedAtCell(Math.round(ignition.y), Math.round(ignition.x))
    };
    const clickedFuelDecision = crosswalkLandCoverToFuel(clickedLandCover);
    fuelField = buildFuelModelCodeField({
      grid,
      classifyAtLatLon: (latitude, longitude) => ({
        ...landCoverSource.classifyAtLatLon(latitude, longitude),
        globalFuelbed: globalFuelbedAtLatLon(latitude, longitude)
      }),
      crosswalk: crosswalkLandCoverToFuel,
      isWaterAtLatLon: landCoverSource.isWaterAtLatLon,
      ignition,
      ignitionFuelCode: clickedFuelDecision.fuelCode,
      ignitionFuelLoadScale: clickedFuelDecision.fuelLoadScale,
      allowExperimental: false
    });
  }
}
const simulationConfig = {
  size,
  cellSizeMeters,
  ignition,
  fuelModel: useMappedFuels ? null : getFuelModel('TU2'),
  fuelModelCodes: fuelField?.fuelModelCodes ?? null,
  fuelModelDefinitionsByCode: fuelField?.fuelModelDefinitionsByCode ?? null,
  fuelLoadScaleByCell: fuelField?.fuelLoadScaleByCell ?? null,
  fuelPersistenceMinutesByCell: fuelField?.fuelPersistenceMinutesByCell ?? null,
  deadMoistureFraction: 0.05,
  midflameWindKmh: 0,
  terrainHeights: new Float32Array(size * size),
  timestepMinutes: 1,
  burnDurationMinutes: 30,
  maxPropagationMinutes: Infinity,
  weatherTimeline: historicalWeather?.windTimeline ?? null,
  waterBarrierEdges: fuelField?.waterBarrierEdges ?? null,
  canopyShelteredByCell: fuelField?.canopyShelteredByCell ?? null,
  canopyCrownAvailableByCell: fuelField?.canopyCrownAvailableByCell ?? null,
  canopyHeightByCell: fuelField?.canopyHeightByCell ?? null,
  canopyCoverFractionByCell: fuelField?.canopyCoverFractionByCell ?? null,
  canopyBaseHeightByCell: fuelField?.canopyBaseHeightByCell ?? null,
  canopyBulkDensityByCell: fuelField?.canopyBulkDensityByCell ?? null,
  liveMoistureByClass: historicalWeather?.liveFuelMoisture?.byClass ?? null,
  liveMoistureFraction: historicalWeather?.liveFuelMoisture?.byClass?.woody ?? 0.5
};
const simulation = createRateBasedFireSimulation(simulationConfig);
const result = validateArrivalAgainstPerimeterSeries({
  arrivalTimes: simulation.getState().arrivalTimes,
  observations: RUSH_CREEK_PROGRESSION.observations,
  grid,
  size,
  modelStartTime: RUSH_CREEK_PROGRESSION.discoveryTime,
  cellSizeMeters
});
const modelState = simulation.getState();

let observedContainmentDiagnostic = null;
if (useObservedContainment) {
  const containmentIntervalIndex = result.growthIntervals.findIndex(
    (interval) => interval.likelyContainmentOrSuppressionSignal
  );
  if (containmentIntervalIndex < 0) {
    observedContainmentDiagnostic = {
      mode: 'observed-perimeter-assimilation-diagnostic',
      applied: false,
      reason: 'no likely containment or suppression interval was detected'
    };
  } else {
    const containmentObservation = RUSH_CREEK_PROGRESSION.observations[containmentIntervalIndex];
    const containmentTimeMinutes = result.reports[containmentIntervalIndex].modelTimeMinutes;
    const observedMask = containmentObservation.observedMask ?? rasterizePerimeterGeometry({
      geometry: containmentObservation.geometry,
      grid
    });
    const suppressionBarrierTimes = createPerimeterContainmentBarriers({
      observedMask,
      size,
      blockedFromMinutes: containmentTimeMinutes
    });
    const constrainedSimulation = createRateBasedFireSimulation({
      ...simulationConfig,
      suppressionBarrierTimes
    });
    const constrainedResult = validateArrivalAgainstPerimeterSeries({
      arrivalTimes: constrainedSimulation.getState().arrivalTimes,
      observations: RUSH_CREEK_PROGRESSION.observations,
      grid,
      size,
      modelStartTime: RUSH_CREEK_PROGRESSION.discoveryTime,
      cellSizeMeters
    });
    const constrainedState = constrainedSimulation.getState();
    observedContainmentDiagnostic = {
      mode: 'observed-perimeter-assimilation-diagnostic',
      applied: true,
      warning: 'diagnostic only; observed geometry is not used by the normal click workflow',
      blockedFromMinutes: containmentTimeMinutes,
      blockedFrom: result.reports[containmentIntervalIndex].capturedAt,
      sourceObservation: containmentObservation.capturedAt,
      barrierEdgeCount: constrainedState.suppressionBarrierEdgeCount,
      terminationReason: constrainedState.terminationReason,
      result: constrainedResult
    };
  }
}

console.log(JSON.stringify({
  fixture: RUSH_CREEK_PROGRESSION.id,
  fireName: RUSH_CREEK_PROGRESSION.fireName,
  source: RUSH_CREEK_PROGRESSION.sourceUrl,
    scenario: useMappedFuels
    ? `${useGlobalFuelbeds ? 'Global FCCS + WorldCover mapped fuels' : (useFineMappedFuels ? 'WorldCover 10 m mapped fuels' : 'WorldCover coarse mapped fuels')} - flat - ${useArchivedWeather ? 'archived wind and dead-moisture replay' : 'calm diagnostic'} - ${useAdaptiveSize ? 'adaptive ' : ''}${cellSizeMeters} m grid (${size} x ${size})`
    : useArchivedWeather
      ? `homogeneous TU2 - flat - archived wind and dead-moisture replay - ${useAdaptiveSize ? 'adaptive ' : ''}${cellSizeMeters} m grid (${size} x ${size})`
      : `homogeneous TU2 - flat - 5% dead - 50% live - calm - ${useAdaptiveSize ? 'adaptive ' : ''}${cellSizeMeters} m grid (${size} x ${size})`,
  domainSizing: {
    mode: useAdaptiveSize ? 'observed-geometry-plus-margin' : 'fixed',
    requestedSize,
    actualSize: size,
    marginCells: useAdaptiveSize ? marginCells : null
  },
  weatherSource: historicalWeather?.source ?? 'none (calm diagnostic baseline)',
  weatherCache: weatherFile ?? null,
  globalFuelbedEndpoint: useGlobalFuelbeds ? globalFuelbedEndpoint : null,
  ignitionFuelPersistenceMinutes: fuelField?.fuelPersistenceMinutesByCell?.[
    Math.round(ignition.y) * size + Math.round(ignition.x)
  ] ?? 0,
  weatherSpinUp: historicalWeather?.hourly
    ? {
      observationsUsed: historicalWeather.hourly.observationsUsed,
      preIgnitionObservationsUsed: historicalWeather.hourly.preIgnitionObservationsUsed,
      spinUpHours: historicalWeather.hourly.spinUpHours
    }
    : null,
  clickedLandCover,
  fuelField: fuelField?.summary ?? null,
  modelTermination: {
    reason: modelState.terminationReason,
    fieldBoundaryCellCount: modelState.fieldBoundaryCellCount,
    horizonLimitedCellCount: modelState.horizonLimitedCellCount
  },
  result,
  ...(useObservedContainment ? { observedContainmentDiagnostic } : {})
}, null, 2));
