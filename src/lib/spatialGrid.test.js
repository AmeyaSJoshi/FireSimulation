import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpatialGrid } from './spatialGrid.js';

test('spatialGrid exposes the origin and grid dimensions', () => {
  const grid = createSpatialGrid({
    latitude: 37.5, longitude: -122.3, cellSizeMeters: 1000, gridSize: 128
  });
  assert.equal(grid.gridSize, 128);
  assert.equal(grid.cellSizeMeters, 1000);
  assert.equal(grid.origin.latitude, 37.5);
  assert.equal(grid.origin.longitude, -122.3);
});

test('the origin lat/lon lands exactly at the center of the grid (row 63.5, col 63.5 for 128)', () => {
  const grid = createSpatialGrid({
    latitude: 40, longitude: -100, cellSizeMeters: 1000, gridSize: 128
  });
  const { row, col } = grid.latLonToCell(40, -100);
  assert.ok(Math.abs(row - 63.5) < 1e-6, `row ${row} should be 63.5`);
  assert.ok(Math.abs(col - 63.5) < 1e-6, `col ${col} should be 63.5`);
});

test('cell (row, col) center round-trips through latLonToCell', () => {
  const grid = createSpatialGrid({
    latitude: 37.5, longitude: -122.3, cellSizeMeters: 1000, gridSize: 128
  });
  for (const [row, col] of [[0, 0], [64, 64], [127, 127], [63, 0], [0, 127], [32, 96]]) {
    const { latitude, longitude } = grid.cellCenterLatLon(row, col);
    const inverse = grid.latLonToCell(latitude, longitude);
    assert.ok(Math.abs(inverse.row - row) < 1e-3, `row ${row} round-tripped to ${inverse.row}`);
    assert.ok(Math.abs(inverse.col - col) < 1e-3, `col ${col} round-tripped to ${inverse.col}`);
  }
});

test('cells to the east have greater longitude than cells to the west', () => {
  const grid = createSpatialGrid({
    latitude: 0, longitude: 0, cellSizeMeters: 1000, gridSize: 128
  });
  const west = grid.cellCenterLatLon(64, 0);
  const east = grid.cellCenterLatLon(64, 127);
  assert.ok(east.longitude > west.longitude);
});

test('cells to the north have greater latitude than cells to the south', () => {
  const grid = createSpatialGrid({
    latitude: 0, longitude: 0, cellSizeMeters: 1000, gridSize: 128
  });
  const north = grid.cellCenterLatLon(0, 64);
  const south = grid.cellCenterLatLon(127, 64);
  assert.ok(north.latitude > south.latitude);
});

test('longitude spacing widens near the poles because cells there cover more degrees', () => {
  const equator = createSpatialGrid({
    latitude: 0, longitude: 0, cellSizeMeters: 1000, gridSize: 128
  });
  const highLat = createSpatialGrid({
    latitude: 60, longitude: 0, cellSizeMeters: 1000, gridSize: 128
  });
  const eqDelta = equator.cellCenterLatLon(64, 74).longitude - equator.cellCenterLatLon(64, 63).longitude;
  const hiDelta = highLat.cellCenterLatLon(64, 74).longitude - highLat.cellCenterLatLon(64, 63).longitude;
  // At 60° latitude, degrees-per-meter east is ~1/cos(60°) = 2x the equator's
  assert.ok(hiDelta > eqDelta * 1.9 && hiDelta < eqDelta * 2.1,
    `hi-lat lon delta ${hiDelta} should be ~2x equatorial ${eqDelta}`);
});

test('antimeridian: a field centered at longitude 179 has cells at negative longitudes on the east edge', () => {
  const grid = createSpatialGrid({
    latitude: 0, longitude: 179, cellSizeMeters: 10000, gridSize: 128
  });
  const eastEdge = grid.cellCenterLatLon(64, 127);
  assert.ok(eastEdge.longitude >= -180 && eastEdge.longitude <= 180,
    `longitude ${eastEdge.longitude} in valid range`);
  assert.ok(eastEdge.longitude < 0,
    `longitude ${eastEdge.longitude} should have wrapped past +180 to negative`);
});

test('antimeridian: cell centers on both sides round-trip correctly', () => {
  const grid = createSpatialGrid({
    latitude: 0, longitude: 179.5, cellSizeMeters: 10000, gridSize: 128
  });
  for (const col of [0, 32, 63, 64, 96, 127]) {
    const { latitude, longitude } = grid.cellCenterLatLon(64, col);
    const inverse = grid.latLonToCell(latitude, longitude);
    assert.ok(Math.abs(inverse.col - col) < 1e-3,
      `col ${col} at (${latitude}, ${longitude}) round-tripped to ${inverse.col}`);
  }
});

test('rejects invalid inputs', () => {
  assert.throws(() => createSpatialGrid({
    latitude: NaN, longitude: 0, cellSizeMeters: 1000, gridSize: 128
  }), /latitude/);
  assert.throws(() => createSpatialGrid({
    latitude: 91, longitude: 0, cellSizeMeters: 1000, gridSize: 128
  }), /latitude/);
  assert.throws(() => createSpatialGrid({
    latitude: 0, longitude: 181, cellSizeMeters: 1000, gridSize: 128
  }), /longitude/);
  assert.throws(() => createSpatialGrid({
    latitude: 0, longitude: 0, cellSizeMeters: 0, gridSize: 128
  }), /cellSize/);
  assert.throws(() => createSpatialGrid({
    latitude: 0, longitude: 0, cellSizeMeters: 1000, gridSize: 1
  }), /gridSize/);
});
