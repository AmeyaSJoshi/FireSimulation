import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlopeAspect } from './terrainDerivatives.js';

function flatField(size, height) {
  const field = new Float32Array(size * size);
  field.fill(height);
  return field;
}

function planarField(size, cellSizeMeters, slope, direction) {
  // direction is a unit vector (east, north) pointing UPHILL
  const field = new Float32Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const east = col * cellSizeMeters;
      const north = (size - 1 - row) * cellSizeMeters;
      field[row * size + col] = slope * (direction.east * east + direction.north * north);
    }
  }
  return field;
}

test('flat terrain produces zero slope at every interior cell', () => {
  const size = 10;
  const field = flatField(size, 500);
  const { slopeRadians } = computeSlopeAspect(field, { cellSizeMeters: 1000, gridSize: size });
  for (let row = 1; row < size - 1; row += 1) {
    for (let col = 1; col < size - 1; col += 1) {
      assert.ok(Math.abs(slopeRadians[row * size + col]) < 1e-6,
        `flat cell (${row},${col}) slope=${slopeRadians[row * size + col]} should be ~0`);
    }
  }
});

test('planar terrain rising to the east produces uniform slope with aspect pointing east', () => {
  const size = 12;
  const cellSize = 1000;
  const slope = 0.1; // 10% grade
  const field = planarField(size, cellSize, slope, { east: 1, north: 0 });
  const { slopeRadians, aspectEast, aspectNorth } = computeSlopeAspect(field, {
    cellSizeMeters: cellSize, gridSize: size
  });
  const centerIndex = 6 * size + 6;
  const expectedSlopeRad = Math.atan(slope);
  assert.ok(Math.abs(slopeRadians[centerIndex] - expectedSlopeRad) < 1e-4,
    `center slope ${slopeRadians[centerIndex]} should be ~${expectedSlopeRad}`);
  assert.ok(aspectEast[centerIndex] > 0.99,
    `aspect east component ${aspectEast[centerIndex]} should be ~1 (pointing uphill east)`);
  assert.ok(Math.abs(aspectNorth[centerIndex]) < 0.01,
    `aspect north component ${aspectNorth[centerIndex]} should be ~0`);
});

test('planar terrain rising to the north produces aspect pointing north', () => {
  const size = 12;
  const cellSize = 1000;
  const field = planarField(size, cellSize, 0.1, { east: 0, north: 1 });
  const { aspectEast, aspectNorth } = computeSlopeAspect(field, {
    cellSizeMeters: cellSize, gridSize: size
  });
  const centerIndex = 6 * size + 6;
  assert.ok(aspectNorth[centerIndex] > 0.99,
    `aspect north component ${aspectNorth[centerIndex]} should be ~1`);
  assert.ok(Math.abs(aspectEast[centerIndex]) < 0.01,
    `aspect east component ${aspectEast[centerIndex]} should be ~0`);
});

test('planar terrain rising southwest produces aspect pointing southwest', () => {
  const size = 12;
  const cellSize = 1000;
  const invSqrt2 = 1 / Math.SQRT2;
  const field = planarField(size, cellSize, 0.1, { east: -invSqrt2, north: -invSqrt2 });
  const { aspectEast, aspectNorth } = computeSlopeAspect(field, {
    cellSizeMeters: cellSize, gridSize: size
  });
  const centerIndex = 6 * size + 6;
  assert.ok(aspectEast[centerIndex] < -0.6 && aspectEast[centerIndex] > -0.8,
    `aspect east ${aspectEast[centerIndex]} should be ~-0.707`);
  assert.ok(aspectNorth[centerIndex] < -0.6 && aspectNorth[centerIndex] > -0.8,
    `aspect north ${aspectNorth[centerIndex]} should be ~-0.707`);
});

test('slope magnitude tracks the grade of the terrain', () => {
  const size = 10;
  const cellSize = 1000;
  const easy = computeSlopeAspect(planarField(size, cellSize, 0.05, { east: 1, north: 0 }), {
    cellSizeMeters: cellSize, gridSize: size
  });
  const steep = computeSlopeAspect(planarField(size, cellSize, 0.5, { east: 1, north: 0 }), {
    cellSizeMeters: cellSize, gridSize: size
  });
  const idx = 5 * size + 5;
  assert.ok(steep.slopeRadians[idx] > easy.slopeRadians[idx] * 5,
    `steep ${steep.slopeRadians[idx]} should be much larger than easy ${easy.slopeRadians[idx]}`);
});

test('a cell adjacent to a NaN elevation is marked no-data', () => {
  const size = 6;
  const field = flatField(size, 100);
  field[2 * size + 2] = NaN; // corrupt one cell
  const { slopeRadians, noData } = computeSlopeAspect(field, {
    cellSizeMeters: 1000, gridSize: size
  });
  const idx = 2 * size + 3; // east neighbor of the NaN
  assert.equal(noData[idx], 1, `neighbor of NaN cell should be flagged no-data`);
  assert.ok(Number.isNaN(slopeRadians[idx]),
    `neighbor slope should be NaN, got ${slopeRadians[idx]}`);
});

test('a fully clean field has zero no-data cells', () => {
  const size = 10;
  const { noData } = computeSlopeAspect(flatField(size, 500), {
    cellSizeMeters: 1000, gridSize: size
  });
  const flagged = Array.from(noData).reduce((a, b) => a + b, 0);
  assert.equal(flagged, 0);
});

test('aspect vector is unit-length on any sloped cell', () => {
  const size = 10;
  const field = planarField(size, 1000, 0.1, { east: 0.6, north: 0.8 });
  const { aspectEast, aspectNorth } = computeSlopeAspect(field, {
    cellSizeMeters: 1000, gridSize: size
  });
  const idx = 5 * size + 5;
  const length = Math.hypot(aspectEast[idx], aspectNorth[idx]);
  assert.ok(Math.abs(length - 1) < 1e-4, `aspect vector length ${length} should be 1`);
});

test('rejects invalid inputs', () => {
  assert.throws(() => computeSlopeAspect(new Float32Array(9), { cellSizeMeters: 1000, gridSize: 10 }),
    /length/);
  assert.throws(() => computeSlopeAspect(new Float32Array(100), { cellSizeMeters: 0, gridSize: 10 }),
    /cellSize/);
});
