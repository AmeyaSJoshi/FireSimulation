import assert from 'node:assert/strict';
import test from 'node:test';
import { runFire, FIRE_ENGINE_ID } from './fireClient.js';
import { createFireRequest } from './fireContract.js';

// These previously asserted HTTP transport details (POST body, endpoint URL,
// HTTP 503 surfacing). The solve now runs in-process, so what matters is that
// the same request contract still yields a complete, well-formed arrival
// field — not how it travelled.

function buildRequest(gridSize = 8, overrides = {}) {
  return createFireRequest({
    fuelCodes: Array(gridSize ** 2).fill('GR2'),
    gridSize,
    cellSizeMeters: 10,
    ignitionIndex: Math.floor((gridSize ** 2) / 2),
    maxPropagationMinutes: 120,
    deadMoistureFraction: 0.06,
    liveMoistureFraction: 0.6,
    midflameWindKmh: 12,
    windDirectionRadians: 0,
    ...overrides
  });
}

test('runFire solves locally and returns one arrival per cell', async () => {
  const request = buildRequest(8);
  const result = await runFire(request);

  assert.equal(result.endpoint, FIRE_ENGINE_ID);
  assert.equal(result.arrivalMinutes.length, request.grid_size ** 2);
  assert.equal(result.arrivalMinutes[request.ignition_index], 0);
  const reached = [...result.arrivalMinutes].filter((value) => Number.isFinite(value)).length;
  assert.ok(reached > 1, `expected spread beyond ignition, reached ${reached}`);
});

test('runFire marks unreachable cells as Infinity, never negative', async () => {
  const gridSize = 6;
  const fuelCodes = Array(gridSize ** 2).fill('NB');
  const ignitionIndex = 14;
  fuelCodes[ignitionIndex] = 'GR2';
  const result = await runFire(buildRequest(gridSize, { fuelCodes, ignitionIndex }));

  assert.equal(result.arrivalMinutes[ignitionIndex], 0);
  for (const value of result.arrivalMinutes) {
    assert.ok(value === Infinity || value >= 0, 'arrival must be Infinity or non-negative');
  }
});

test('runFire rejects when the solve is aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runFire(buildRequest(4), { signal: controller.signal }), /aborted/i);
});
