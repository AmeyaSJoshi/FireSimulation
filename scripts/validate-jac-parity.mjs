import assert from 'node:assert/strict';
import { runScenario } from '../src/sim/runScenario.js';
import { propagateRothermelWithJac } from '../src/sim/jacPropagation.js';

const GRID_SIZE = 64;
const TOTAL_CELLS = GRID_SIZE ** 2;
const endpoint = process.env.JAC_ENDPOINT ?? 'http://127.0.0.1:8010/walker/RunFire';
const request = {
  ignition: { latitude: 37, longitude: -122 },
  viewHint: { altitudeMeters: 5_000 },
  overrides: { windSpeedKmh: 12, windDirectionDeg: 45, moistureFraction: 0.06 }
};

function adapter({ fuelCodes, terrainHeights = null }) {
  return {
    async loadContext() {
      return {
        fuelCodes,
        terrainHeights,
        weather: null,
        buildings: [],
        roads: [],
        evidence: { sources: [], fallbacks: [] },
        confidence: 'synthetic'
      };
    }
  };
}

async function validateCase(name, context, scenario = request) {
  const adapters = adapter(context);
  const javascript = await runScenario(scenario, { adapters, propagation: 'physical' });
  const jac = await runScenario(scenario, {
    adapters,
    propagation: 'jac-rothermel',
    propagateRothermel: (input) => propagateRothermelWithJac(input, { endpoint })
  });
  assert.equal(jac.simulation.engine, 'jac-rothermel', `${name}: Jac fallback: ${jac.simulation.fallbackReason}`);
  let maximumDifference = 0;
  for (let index = 0; index < TOTAL_CELLS; index += 1) {
    maximumDifference = Math.max(
      maximumDifference,
      Math.abs(javascript.arrivalField[index] - jac.arrivalField[index])
    );
  }
  assert.ok(maximumDifference <= 0.001, `${name}: maximum arrival difference ${maximumDifference} minutes`);
  return { name, maximumDifferenceMinutes: maximumDifference };
}

const plane = Float32Array.from({ length: TOTAL_CELLS }, (_, index) => {
  const row = Math.floor(index / GRID_SIZE);
  const col = index % GRID_SIZE;
  return 0.18 * col * 100 + 0.09 * (GRID_SIZE - row) * 100;
});
const mixedFuel = Array.from({ length: TOTAL_CELLS }, (_, index) => {
  const row = Math.floor(index / GRID_SIZE);
  const col = index % GRID_SIZE;
  if (row === 10 || col === 10) return 'NB';
  return (row + col) % 2 === 0 ? 'GR1' : 'SH5';
});

const results = [];
results.push(await validateCase('flat uniform fuel', { fuelCodes: Array(TOTAL_CELLS).fill('SH5') }));
results.push(await validateCase('sloped uniform fuel', { fuelCodes: Array(TOTAL_CELLS).fill('GR1'), terrainHeights: plane }));
results.push(await validateCase('mixed fuel with barriers', { fuelCodes: mixedFuel }));
results.push(await validateCase('calm weather', { fuelCodes: Array(TOTAL_CELLS).fill('GR1') }, {
  ...request,
  overrides: { windSpeedKmh: 0, windDirectionDeg: 45, moistureFraction: 0.06 }
}));
results.push(await validateCase('moisture at extinction', { fuelCodes: Array(TOTAL_CELLS).fill('GR1') }, {
  ...request,
  overrides: { windSpeedKmh: 12, windDirectionDeg: 45, moistureFraction: 0.4 }
}));
console.log(JSON.stringify({ endpoint, pass: true, results }, null, 2));

