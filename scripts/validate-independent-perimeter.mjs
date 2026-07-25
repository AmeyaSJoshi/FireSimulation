import fs from 'node:fs';
import { createRateBasedFireSimulation } from '../src/lib/firePropagation.js';
import { DEER_FIRE_2016 } from '../src/lib/historicalPerimeterFixtures.js';
import { getFuelModel } from '../src/lib/fuelModels.js';
import {
  buildHistoricalWeatherTimeline,
  fetchHistoricalWeatherInputs,
  normalizeHistoricalHourlyWeather
} from '../src/lib/historicalWeather.js';
import {
  rasterizePerimeterGeometry,
  validateArrivalAgainstPerimeter
} from '../src/lib/perimeterValidation.js';
import { createSpatialGrid } from '../src/lib/spatialGrid.js';

const useArchivedWeather = process.argv.includes('--archive');
const weatherFileArgumentIndex = process.argv.indexOf('--weather-file');
const weatherFile = weatherFileArgumentIndex >= 0
  ? process.argv[weatherFileArgumentIndex + 1]
  : null;
const HISTORICAL_WEATHER_SPIN_UP_DAYS = 7;

function weatherStartDateBefore(ignitionTime, days) {
  const ignitionMs = Date.parse(ignitionTime);
  if (!Number.isFinite(ignitionMs)) throw new RangeError('independent perimeter ignition time must be valid');
  return new Date(ignitionMs - days * 86_400_000).toISOString();
}

const historicalWeather = useArchivedWeather
  ? weatherFile
    ? buildHistoricalWeatherTimeline({
      hours: normalizeHistoricalHourlyWeather(JSON.parse(fs.readFileSync(weatherFile, 'utf8'))),
      ignitionTime: DEER_FIRE_2016.alarmDate,
      latitude: DEER_FIRE_2016.ignition.latitude,
      fuelBedDepthMeters: getFuelModel('TU2').fuelBedDepthMeters
    })
    : await fetchHistoricalWeatherInputs({
      latitude: DEER_FIRE_2016.ignition.latitude,
      longitude: DEER_FIRE_2016.ignition.longitude,
      startDate: weatherStartDateBefore(DEER_FIRE_2016.alarmDate, HISTORICAL_WEATHER_SPIN_UP_DAYS),
      endDate: DEER_FIRE_2016.containmentDate,
      ignitionTime: DEER_FIRE_2016.alarmDate,
      fuelBedDepthMeters: getFuelModel('TU2').fuelBedDepthMeters
    })
  : null;

const size = 128;
const cellSizeMeters = 100;
const grid = createSpatialGrid({
  latitude: DEER_FIRE_2016.ignition.latitude,
  longitude: DEER_FIRE_2016.ignition.longitude,
  cellSizeMeters,
  gridSize: size
});
const observedMask = rasterizePerimeterGeometry({
  geometry: DEER_FIRE_2016.geometry,
  grid
});
const ignitionCell = grid.latLonToCell(
  DEER_FIRE_2016.ignition.latitude,
  DEER_FIRE_2016.ignition.longitude
);
const ignition = {
  ...ignitionCell,
  x: ignitionCell.col,
  y: ignitionCell.row
};
const modelTimeMinutes = (
  Date.parse(DEER_FIRE_2016.containmentDate) - Date.parse(DEER_FIRE_2016.alarmDate)
) / 60_000;
const simulation = createRateBasedFireSimulation({
  size,
  cellSizeMeters,
  ignition,
  fuelModel: getFuelModel('TU2'),
  deadMoistureFraction: 0.05,
  liveMoistureFraction: 0.5,
  midflameWindKmh: 0,
  terrainHeights: new Float32Array(size * size),
  timestepMinutes: 1,
  burnDurationMinutes: 30,
  maxPropagationMinutes: Infinity,
  weatherTimeline: historicalWeather?.windTimeline ?? null,
  liveMoistureFraction: historicalWeather?.liveFuelMoisture?.byClass?.woody ?? 0.5
});
const report = validateArrivalAgainstPerimeter({
  arrivalTimes: simulation.getState().arrivalTimes,
  observedMask,
  size,
  modelTimeMinutes,
  cellSizeMeters
});

console.log(JSON.stringify({
  fixture: DEER_FIRE_2016.id,
  name: DEER_FIRE_2016.name,
  source: DEER_FIRE_2016.sourceUrl,
  collectionMethod: DEER_FIRE_2016.collectionMethod,
  reportedAcres: DEER_FIRE_2016.reportedAcres,
  ignitionAssumption: 'validator uses the fixture center coordinate because the source row does not publish a verified ignition point',
  scenario: historicalWeather
    ? `homogeneous TU2 - flat - archived wind and dead-moisture replay - ${modelTimeMinutes} min`
    : `homogeneous TU2 - flat - 5% dead - 50% live - calm - ${modelTimeMinutes} min`,
  weatherSource: historicalWeather?.source ?? 'none (calm diagnostic baseline)',
  weatherCache: weatherFile ?? null,
  weatherSpinUp: historicalWeather?.hourly
    ? {
      observationsUsed: historicalWeather.hourly.observationsUsed,
      preIgnitionObservationsUsed: historicalWeather.hourly.preIgnitionObservationsUsed,
      spinUpHours: historicalWeather.hourly.spinUpHours
    }
    : null,
  report
}, null, 2));
