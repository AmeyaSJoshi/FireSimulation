import { createRateBasedFireSimulation } from '../src/lib/firePropagation.js';
import { getFuelModel } from '../src/lib/fuelModels.js';
import { RESERVOIR_FIRE_2016 } from '../src/lib/historicalPerimeterFixtures.js';
import {
  rasterizePerimeterGeometry,
  validateArrivalAgainstPerimeter
} from '../src/lib/perimeterValidation.js';
import { createSpatialGrid } from '../src/lib/spatialGrid.js';

const size = 128;
const cellSizeMeters = 100;
const grid = createSpatialGrid({
  latitude: 39.152745,
  longitude: -122.571182,
  cellSizeMeters,
  gridSize: size
});
const observedMask = rasterizePerimeterGeometry({
  geometry: RESERVOIR_FIRE_2016.geometry,
  grid
});
const simulation = createRateBasedFireSimulation({
  size,
  cellSizeMeters,
  ignition: { x: (size - 1) / 2, y: (size - 1) / 2 },
  fuelModel: getFuelModel('TU2'),
  deadMoistureFraction: 0.05,
  liveMoistureFraction: 0.5,
  midflameWindKmh: 0,
  terrainHeights: new Float32Array(size * size),
  timestepMinutes: 1,
  burnDurationMinutes: 30
});
const report = validateArrivalAgainstPerimeter({
  arrivalTimes: simulation.getState().arrivalTimes,
  observedMask,
  size,
  modelTimeMinutes: 1_300,
  cellSizeMeters
});

console.log(JSON.stringify({
  fixture: RESERVOIR_FIRE_2016.id,
  source: RESERVOIR_FIRE_2016.sourceUrl,
  scenario: 'homogeneous TU2 - flat - 5% dead - 50% live - calm - 1300 min',
  report
}, null, 2));
