import { createJacFireRequest } from '../src/sim/jacFireContract.js';
import { propagateRothermelWithJac } from '../src/sim/jacPropagation.js';
import { createRateBasedFireSimulation } from '../src/lib/firePropagation.js';
import { getFuelModel } from '../src/lib/fuelModels.js';

const gridSize = 24;
const base = {
  fuelCodes: Array(gridSize ** 2).fill('GR1'),
  gridSize,
  cellSizeMeters: 25,
  ignitionIndex: 300,
  maxPropagationMinutes: 170,
  deadMoistureFraction: 0.04,
  liveMoistureFraction: 0.45,
  tenMeterWindKmh: 12,
  windDirectionRadians: 0
};
const row = {
  tenMeterWindKmh: 12, midflameWindKmh: 4, windDirectionRadians: 0,
  deadMoistureByClass: { '1h': 0.04, '10h': 0.04, '100h': 0.04 },
  liveMoistureByClass: { herbaceous: 0.45, woody: 0.45 }
};
const endpoint = process.env.JAC_ENDPOINT;
const staticResult = await propagateRothermelWithJac(createJacFireRequest(base), { endpoint });
const timelineResult = await propagateRothermelWithJac(createJacFireRequest({
  ...base,
  weatherTimeline: [{ minutesFromIgnition: 0, ...row }, { minutesFromIgnition: 180, ...row }]
}), { endpoint });
if (staticResult.engine !== 'jac-rothermel' || timelineResult.engine !== 'jac-rothermel') {
  throw new Error('Jac weather validator requires the RunFire service; fallback results are invalid');
}
let max = 0;
let staticReachable = 0;
let timelineReachable = 0;
for (let index = 0; index < staticResult.arrivalField.length; index += 1) {
  const left = staticResult.arrivalField[index];
  const right = timelineResult.arrivalField[index];
  if (left >= 0) staticReachable += 1;
  if (right >= 0) timelineReachable += 1;
  max = Math.max(max, Math.abs(left - right));
}

const dynamicTimeline = [
  { minutesFromIgnition: 0, ...row },
  {
    minutesFromIgnition: 60, tenMeterWindKmh: 28, midflameWindKmh: 9, windDirectionRadians: Math.PI / 2,
    deadMoistureByClass: { '1h': 0.06, '10h': 0.07, '100h': 0.09 },
    liveMoistureByClass: { herbaceous: 0.55, woody: 0.8 }
  },
  {
    minutesFromIgnition: 180, tenMeterWindKmh: 8, midflameWindKmh: 3, windDirectionRadians: Math.PI,
    deadMoistureByClass: { '1h': 0.09, '10h': 0.1, '100h': 0.11 },
    liveMoistureByClass: { herbaceous: 0.7, woody: 0.9 }
  }
];
const dynamicJac = await propagateRothermelWithJac(createJacFireRequest({ ...base, weatherTimeline: dynamicTimeline }), { endpoint });
if (dynamicJac.engine !== 'jac-rothermel') {
  throw new Error('Jac weather validator requires the RunFire service; fallback results are invalid');
}
const reference = createRateBasedFireSimulation({
  size: gridSize, cellSizeMeters: 25, ignition: { x: 12, y: 12 }, fuelModel: getFuelModel('GR1'),
  fuelModelCodes: base.fuelCodes, terrainHeights: new Float32Array(gridSize ** 2),
  deadMoistureFraction: 0.04, liveMoistureFraction: 0.45,
  deadMoistureByClass: dynamicTimeline[0].deadMoistureByClass,
  liveMoistureByClass: dynamicTimeline[0].liveMoistureByClass,
  tenMeterWindKmh: 12, windDirectionRadians: 0, weatherTimeline: dynamicTimeline,
  maxPropagationMinutes: 170
}).getState().arrivalTimes;
let dynamicMax = 0;
let dynamicMismatch = 0;
for (let index = 0; index < reference.length; index += 1) {
  const actual = dynamicJac.arrivalField[index] < 0 ? Infinity : dynamicJac.arrivalField[index];
  if (Number.isFinite(actual) !== Number.isFinite(reference[index])) {
    dynamicMismatch += 1;
  } else if (Number.isFinite(actual)) {
    dynamicMax = Math.max(dynamicMax, Math.abs(actual - reference[index]));
  }
}
const toleranceMinutes = 0.5;
const pass = staticReachable === timelineReachable
  && max <= toleranceMinutes
  && dynamicMismatch === 0
  && dynamicMax <= toleranceMinutes;
console.log(JSON.stringify({
  endpoint,
  pass,
  grid: `${gridSize}x${base.cellSizeMeters}m`,
  toleranceMinutes,
  staticTimeline: { reachableCells: timelineReachable, maximumDifferenceMinutes: max },
  changingTimeline: { maximumDifferenceMinutes: dynamicMax, reachabilityMismatchCells: dynamicMismatch },
  note: 'Offline solver parity only; this does not validate an observed fire perimeter.'
}, null, 2));
if (!pass) process.exitCode = 1;

