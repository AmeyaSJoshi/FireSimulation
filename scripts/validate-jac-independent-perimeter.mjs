import { createRateBasedFireSimulation } from '../src/lib/firePropagation.js';
import { getFuelModel } from '../src/lib/fuelModels.js';
import { DEER_FIRE_2016 } from '../src/lib/historicalPerimeterFixtures.js';
import { createJacFireRequest } from '../src/sim/jacFireContract.js';
import { propagateRothermelWithJac } from '../src/sim/jacPropagation.js';
import {
  rasterizePerimeterGeometry,
  validateArrivalAgainstPerimeter
} from '../src/lib/perimeterValidation.js';
import { createSpatialGrid } from '../src/lib/spatialGrid.js';

const size = 128;
const cellSizeMeters = 100;
const deadMoistureFraction = 0.05;
const liveMoistureFraction = 0.5;
const modelTimeMinutes = (
  Date.parse(DEER_FIRE_2016.containmentDate) - Date.parse(DEER_FIRE_2016.alarmDate)
) / 60_000;
const grid = createSpatialGrid({
  latitude: DEER_FIRE_2016.ignition.latitude,
  longitude: DEER_FIRE_2016.ignition.longitude,
  cellSizeMeters,
  gridSize: size
});
const ignitionCell = grid.latLonToCell(
  DEER_FIRE_2016.ignition.latitude,
  DEER_FIRE_2016.ignition.longitude
);
// Match createRateBasedFireSimulation's solver-boundary policy exactly.
const ignition = { row: Math.floor(ignitionCell.row), col: Math.floor(ignitionCell.col) };
const ignitionIndex = ignition.row * size + ignition.col;
const fuelCodes = Array(size * size).fill('TU2');
const jacRequest = createJacFireRequest({
  fuelCodes,
  terrainHeights: Array(size * size).fill(0),
  gridSize: size,
  cellSizeMeters,
  ignitionIndex,
  maxPropagationMinutes: modelTimeMinutes,
  deadMoistureFraction,
  liveMoistureFraction,
  midflameWindKmh: 0,
  windDirectionRadians: 0
});
const jac = await propagateRothermelWithJac(jacRequest, {
  endpoint: process.env.JAC_ENDPOINT ?? 'http://127.0.0.1:8010/walker/RunFire'
});
if (jac.engine !== 'jac-rothermel' || !jac.arrivalField) {
  throw new Error(`Jac perimeter benchmark requires RunFire: ${jac.fallbackReason ?? jac.engine}`);
}
// The HTTP contract serializes unreachable cells as -1; metric helpers use
// Infinity internally, where negative values would otherwise look already burned.
const jacArrivals = Float64Array.from(jac.arrivalField, (arrival) => arrival < 0 ? Infinity : arrival);

const observedMask = rasterizePerimeterGeometry({ geometry: DEER_FIRE_2016.geometry, grid });
const report = validateArrivalAgainstPerimeter({
  arrivalTimes: jacArrivals,
  observedMask,
  size,
  modelTimeMinutes,
  cellSizeMeters
});
const reference = createRateBasedFireSimulation({
  size,
  cellSizeMeters,
  ignition: { x: ignition.col, y: ignition.row },
  fuelModel: getFuelModel('TU2'),
  deadMoistureFraction,
  liveMoistureFraction,
  midflameWindKmh: 0,
  terrainHeights: new Float32Array(size * size),
  timestepMinutes: 1,
  burnDurationMinutes: 30,
  maxPropagationMinutes: modelTimeMinutes
}).getState().arrivalTimes;
let maximumJacReferenceDifferenceMinutes = 0;
for (let index = 0; index < reference.length; index += 1) {
  if (!Number.isFinite(jacArrivals[index]) && !Number.isFinite(reference[index])) continue;
  if (!Number.isFinite(jacArrivals[index]) || !Number.isFinite(reference[index])) {
    maximumJacReferenceDifferenceMinutes = Infinity;
    break;
  }
  maximumJacReferenceDifferenceMinutes = Math.max(
    maximumJacReferenceDifferenceMinutes,
    Math.abs(jacArrivals[index] - reference[index])
  );
}

console.log(JSON.stringify({
  fixture: DEER_FIRE_2016.id,
  name: DEER_FIRE_2016.name,
  engine: jac.engine,
  source: DEER_FIRE_2016.sourceUrl,
  collectionMethod: DEER_FIRE_2016.collectionMethod,
  reportedAcres: DEER_FIRE_2016.reportedAcres,
  ignitionAssumption: 'fixture center coordinate; public source row has no verified ignition point',
  scenario: 'homogeneous TU2; flat terrain; 5% dead and 50% live moisture; calm; final perimeter time',
  modelTimeMinutes,
  jacReferenceParity: { maximumDifferenceMinutes: maximumJacReferenceDifferenceMinutes },
  report,
  limitation: 'Real GPS perimeter, but diagnostic inputs are synthetic. This is not an operational hindcast.'
}, null, 2));

