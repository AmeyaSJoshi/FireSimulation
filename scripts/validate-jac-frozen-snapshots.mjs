import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRateBasedFireSimulation } from '../src/lib/firePropagation.js';
import { getFuelModel } from '../src/lib/fuelModels.js';
import { HACKATHON_BENCHMARK_DEFINITIONS } from '../src/lib/hackathonBenchmarkRunner.js';
import { createJacFireRequest } from '../src/sim/jacFireContract.js';
import { propagateRothermelWithJac } from '../src/sim/jacPropagation.js';

const endpoint = process.env.JAC_ENDPOINT ?? 'http://127.0.0.1:8010/walker/RunFire';
const horizonMinutes = 720;
const selectedIds = (process.env.JAC_SNAPSHOT_IDS ?? 'reservoir-2016,deer-2016,stoll-2018').split(',');
const fixtureUrl = new URL('../src/lib/regionalBenchmarkFields.generated.json', import.meta.url);
const fieldsById = new Map(JSON.parse(readFileSync(fixtureUrl, 'utf8')).map((field) => [field.id, field]));
const definitionsById = new Map(HACKATHON_BENCHMARK_DEFINITIONS.map((definition) => [definition.id, definition]));

function arrivals(field) {
  return Float32Array.from(field, (value) => Number.isFinite(value) ? value : -1);
}

async function validateSnapshot(id) {
  const field = fieldsById.get(id);
  const definition = definitionsById.get(id);
  assert.ok(field?.terrain?.available && field?.fuel?.available && field?.weather?.available, `${id}: frozen real inputs unavailable`);
  assert.ok(definition, `${id}: benchmark definition unavailable`);
  const size = Math.sqrt(field.fuel.fuelModelCodes.length);
  assert.ok(Number.isInteger(size), `${id}: fuel field is not square`);
  assert.equal(field.terrain.heights.length, size ** 2, `${id}: terrain field size mismatch`);
  const initialWeather = field.weather.windTimeline[0];
  assert.ok(initialWeather, `${id}: no frozen weather snapshot`);
  const ignition = definition.ignition ?? { x: (size - 1) / 2, y: (size - 1) / 2 };
  const ignitionIndex = Math.floor(ignition.y) * size + Math.floor(ignition.x);
  const deadMoisture = initialWeather.deadMoistureByClass['1h'];
  const liveMoisture = initialWeather.liveMoistureByClass.woody;
  const cellSizeMeters = definition.cellSizeMeters ?? 100;
  const fuelCodes = field.fuel.fuelModelCodes;
  const javascript = createRateBasedFireSimulation({
    size,
    cellSizeMeters,
    ignition,
    fuelModel: getFuelModel(fuelCodes[ignitionIndex]),
    fuelModelCodes: fuelCodes,
    terrainHeights: Float32Array.from(field.terrain.heights),
    moistureFraction: deadMoisture,
    deadMoistureFraction: deadMoisture,
    liveMoistureFraction: liveMoisture,
    deadMoistureByClass: initialWeather.deadMoistureByClass,
    liveMoistureByClass: initialWeather.liveMoistureByClass,
    tenMeterWindKmh: initialWeather.tenMeterWindKmh,
    midflameWindKmh: initialWeather.midflameWindKmh,
    windDirectionRadians: initialWeather.windDirectionRadians,
    maxPropagationMinutes: horizonMinutes
  });
  const jac = await propagateRothermelWithJac(createJacFireRequest({
    fuelCodes,
    terrainHeights: field.terrain.heights,
    gridSize: size,
    cellSizeMeters,
    ignitionIndex,
    maxPropagationMinutes: horizonMinutes,
    deadMoistureFraction: deadMoisture,
    liveMoistureFraction: liveMoisture,
    deadMoistureByClass: initialWeather.deadMoistureByClass,
    liveMoistureByClass: initialWeather.liveMoistureByClass,
    tenMeterWindKmh: initialWeather.tenMeterWindKmh,
    windDirectionRadians: initialWeather.windDirectionRadians
  }), { endpoint });
  assert.equal(jac.engine, 'jac-rothermel', `${id}: Jac fallback: ${jac.fallbackReason}`);
  const expected = arrivals(javascript.arrivalTimes);
  let maximumDifference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    maximumDifference = Math.max(maximumDifference, Math.abs(expected[index] - jac.arrivalField[index]));
  }
  assert.ok(maximumDifference <= 0.001, `${id}: maximum arrival difference ${maximumDifference} minutes`);
  return {
    id,
    cells: expected.length,
    sourceTime: initialWeather.sourceTime,
    maximumDifferenceMinutes: maximumDifference
  };
}

const results = [];
for (const id of selectedIds) results.push(await validateSnapshot(id));
console.log(JSON.stringify({
  endpoint,
  horizonMinutes,
  pass: true,
  note: 'Static frozen-input parity only; this does not validate observed fire perimeters.',
  results
}, null, 2));

