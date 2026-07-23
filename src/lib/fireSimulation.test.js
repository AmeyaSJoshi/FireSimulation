import test from 'node:test';
import assert from 'node:assert/strict';
import { createFireSimulation } from './fireSimulation.js';

function advance(simulation, steps = 80) {
  for (let step = 0; step < steps; step += 1) simulation.step();
}

function fireExtent(simulation) {
  const { size, state } = simulation.getState();
  const center = (size - 1) / 2;
  const burning = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (state[y * size + x] !== 0) burning.push({ x: x - center, y: y - center });
    }
  }
  return burning;
}

test('ignites the requested center cell', () => {
  const simulation = createFireSimulation({ size: 25, ignition: { x: 12, y: 12 } });
  const { state } = simulation.getState();
  assert.equal(state[12 * 25 + 12], 2);
});

test('calm ignition spreads beyond the seed cell', () => {
  const simulation = createFireSimulation({ size: 65, params: { windSpeed: 0, slopeStrength: 0 } });
  advance(simulation, 28);
  assert.ok(simulation.getMetrics().footprintCells > 9);
  assert.ok(simulation.getState().burnedCount > 1);
});

test('calm fire grows approximately symmetrically', () => {
  const simulation = createFireSimulation({ size: 65, params: { windSpeed: 0, slopeStrength: 0 } });
  advance(simulation, 70);
  const burning = fireExtent(simulation);
  const east = Math.max(...burning.map(({ x }) => x));
  const west = Math.min(...burning.map(({ x }) => x));
  const north = Math.max(...burning.map(({ y }) => y));
  const south = Math.min(...burning.map(({ y }) => y));
  assert.ok(Math.abs(east + west) <= 3);
  assert.ok(Math.abs(north + south) <= 6);
});

test('wind pushes the active front downwind', () => {
  const simulation = createFireSimulation({
    size: 65,
    params: { windSpeed: 42, windDirection: 0 }
  });
  advance(simulation, 90);
  const burning = fireExtent(simulation);
  const east = Math.max(...burning.map(({ x }) => x));
  const west = Math.abs(Math.min(...burning.map(({ x }) => x)));
  assert.ok(east > west + 4);
});

test('moisture reduces total burned area', () => {
  const dry = createFireSimulation({ size: 65, params: { moisture: 0.05 } });
  const wet = createFireSimulation({ size: 65, params: { moisture: 0.85 } });
  advance(dry, 100);
  advance(wet, 100);
  assert.ok(dry.getState().burnedCount > wet.getState().burnedCount);
});

test('a zero-fuel barrier blocks the fire front', () => {
  const simulation = createFireSimulation({
    size: 65,
    ignition: { x: 20, y: 32 },
    scenario: 'barrier',
    params: { windSpeed: 0 }
  });
  advance(simulation, 140);
  const { size, state, fuel } = simulation.getState();
  const barrierX = Math.floor(size * 0.58);
  for (let y = 0; y < size; y += 1) {
    assert.equal(fuel[y * size + barrierX], 0);
    assert.equal(state[y * size + barrierX + 1], 0);
  }
});

test('reports a measurable footprint and perimeter', () => {
  const simulation = createFireSimulation({ size: 41, params: { windSpeed: 0 } });
  advance(simulation, 45);
  const metrics = simulation.getMetrics(2.5);
  assert.ok(metrics.footprintCells > 0);
  assert.ok(metrics.perimeterCells > 0);
  assert.equal(metrics.footprintAreaKm2, metrics.footprintCells * 6.25);
  assert.equal(metrics.perimeterKm, metrics.perimeterCells * 2.5);
});

test('reports model time, maximum spread, average rate, and direction', () => {
  const simulation = createFireSimulation({
    size: 41,
    params: { windSpeed: 42, windDirection: 0, slopeStrength: 0 }
  });
  advance(simulation, 30);
  const metrics = simulation.getMetrics(1, 2);
  assert.equal(metrics.elapsedMinutes, 60);
  assert.ok(metrics.maxSpreadDistanceKm > 0);
  assert.ok(metrics.averageSpreadRateKmh > 0);
  assert.ok(metrics.dominantSpreadDirectionDeg <= 45 || metrics.dominantSpreadDirectionDeg >= 315);
});

test('slope scenario biases spread uphill', () => {
  const flat = createFireSimulation({ size: 65, params: { windSpeed: 0, slopeStrength: 0 } });
  const uphill = createFireSimulation({ size: 65, scenario: 'slope', params: { windSpeed: 0, slopeStrength: 1 } });
  advance(flat, 70);
  advance(uphill, 70);
  const extent = (simulation) => {
    const { size, state } = simulation.getState();
    const center = (size - 1) / 2;
    const points = [];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (state[y * size + x] !== 0) points.push(y - center);
      }
    }
    return Math.max(...points);
  };
  assert.ok(extent(uphill) > extent(flat) + 2);
});

test('real elevation field biases spread toward higher neighboring cells', () => {
  const size = 65;
  const terrainHeights = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) terrainHeights[y * size + x] = y * 20;
  }
  const flat = createFireSimulation({ size, params: { windSpeed: 0, slopeStrength: 0 } });
  const terrain = createFireSimulation({ size, terrainHeights, params: { windSpeed: 0, slopeStrength: 0 } });
  advance(flat, 70);
  advance(terrain, 70);
  const extent = (simulation) => {
    const { size: gridSize, state } = simulation.getState();
    const center = (gridSize - 1) / 2;
    const points = [];
    for (let y = 0; y < gridSize; y += 1) {
      for (let x = 0; x < gridSize; x += 1) {
        if (state[y * gridSize + x] !== 0) points.push(y - center);
      }
    }
    return Math.max(...points);
  };
  assert.ok(extent(terrain) > extent(flat) + 2);
});
