import fields from '../src/lib/regionalBenchmarkFields.generated.json' with { type: 'json' };
import { createRateBasedFireSimulation } from '../src/lib/firePropagation.js';
import { getFuelModel } from '../src/lib/fuelModels.js';
import { createJacFireRequest } from '../src/sim/jacFireContract.js';
import { propagateRothermelWithJac } from '../src/sim/jacPropagation.js';

const sourceSize = 128;
const gridSize = 32;
const cellSizeMeters = 100;
const horizonMinutes = 720;
const start = (sourceSize - gridSize) / 2;
const endpoint = process.env.JAC_ENDPOINT ?? 'http://127.0.0.1:8010/walker/RunFire';

function centeredSquare(values) {
  const result = [];
  for (let row = start; row < start + gridSize; row += 1) {
    result.push(...values.slice(row * sourceSize + start, row * sourceSize + start + gridSize));
  }
  return result;
}

async function validateCase(entry) {
  const fuelCodes = centeredSquare(entry.fuel.fuelModelCodes);
  const terrainHeights = centeredSquare(entry.terrain.heights);
  const weatherTimeline = entry.weather.windTimeline;
  const ignitionIndex = Math.floor(gridSize / 2) * gridSize + Math.floor(gridSize / 2);
  const initial = weatherTimeline[0];
  const request = createJacFireRequest({
    fuelCodes,
    terrainHeights,
    gridSize,
    cellSizeMeters,
    ignitionIndex,
    maxPropagationMinutes: horizonMinutes,
    deadMoistureFraction: initial.deadMoistureByClass['1h'],
    liveMoistureFraction: initial.liveMoistureByClass.woody,
    deadMoistureByClass: initial.deadMoistureByClass,
    liveMoistureByClass: initial.liveMoistureByClass,
    weatherTimeline,
    tenMeterWindKmh: initial.tenMeterWindKmh,
    windDirectionRadians: initial.windDirectionRadians
  });
  const jac = await propagateRothermelWithJac(request, { endpoint });
  if (jac.engine !== 'jac-rothermel' || !jac.arrivalField) {
    throw new Error(`${entry.id}: Jac service unavailable (${jac.fallbackReason ?? jac.engine})`);
  }
  const reference = createRateBasedFireSimulation({
    size: gridSize,
    cellSizeMeters,
    ignition: { x: Math.floor(gridSize / 2), y: Math.floor(gridSize / 2) },
    fuelModel: getFuelModel(fuelCodes[ignitionIndex]),
    fuelModelCodes: fuelCodes,
    terrainHeights: Float32Array.from(terrainHeights),
    deadMoistureFraction: initial.deadMoistureByClass['1h'],
    liveMoistureFraction: initial.liveMoistureByClass.woody,
    deadMoistureByClass: initial.deadMoistureByClass,
    liveMoistureByClass: initial.liveMoistureByClass,
    tenMeterWindKmh: initial.tenMeterWindKmh,
    windDirectionRadians: initial.windDirectionRadians,
    weatherTimeline,
    maxPropagationMinutes: horizonMinutes
  }).getState().arrivalTimes;
  let maximumDifferenceMinutes = 0;
  let reachabilityMismatchCells = 0;
  for (let index = 0; index < reference.length; index += 1) {
    const actual = jac.arrivalField[index] < 0 ? Infinity : jac.arrivalField[index];
    if (Number.isFinite(actual) !== Number.isFinite(reference[index])) {
      reachabilityMismatchCells += 1;
    } else if (Number.isFinite(actual)) {
      maximumDifferenceMinutes = Math.max(maximumDifferenceMinutes, Math.abs(actual - reference[index]));
    }
  }
  return { id: entry.id, maximumDifferenceMinutes, reachabilityMismatchCells };
}

const selected = fields.filter((entry) => ['reservoir-2016', 'deer-2016'].includes(entry.id));
const results = [];
for (const entry of selected) results.push(await validateCase(entry));
const toleranceMinutes = 0.5;
const pass = results.every((result) => (
  result.reachabilityMismatchCells === 0 && result.maximumDifferenceMinutes <= toleranceMinutes
));
console.log(JSON.stringify({
  endpoint,
  pass,
  grid: `${gridSize}x${gridSize} at ${cellSizeMeters}m`,
  horizonMinutes,
  toleranceMinutes,
  results,
  note: 'Frozen real terrain/fuel/weather parity only; not an observed-perimeter accuracy score.'
}, null, 2));
if (!pass) process.exitCode = 1;

