import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateValidationGridSize } from './validationDomain.js';

test('sizes a validation grid from a polygon extent with explicit margin', () => {
  const size = estimateValidationGridSize({
    center: { latitude: 44, longitude: -115 },
    geometries: {
      type: 'Polygon',
      coordinates: [[
        [-115.02, 43.98],
        [-114.98, 43.98],
        [-114.98, 44.02],
        [-115.02, 44.02],
        [-115.02, 43.98]
      ]]
    },
    cellSizeMeters: 100,
    minimumSize: 3,
    marginCells: 2
  });

  assert.ok(size >= 59 && size <= 61, `unexpected adaptive size ${size}`);
});

test('handles antimeridian geometry and feature collections', () => {
  const size = estimateValidationGridSize({
    center: { latitude: 0, longitude: 179.9 },
    geometries: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[179.8, -0.01], [-179.8, -0.01], [-179.8, 0.01], [179.8, 0.01]]]
        }
      }]
    },
    cellSizeMeters: 1000,
    minimumSize: 3,
    marginCells: 1
  });

  assert.ok(size < 100, `antimeridian delta was treated as a full globe: ${size}`);
});

test('clamps an adaptive domain to explicit minimum and maximum sizes', () => {
  assert.equal(estimateValidationGridSize({
    center: { latitude: 0, longitude: 0 },
    geometries: [[[-0.001, -0.001], [0.001, 0.001]]],
    cellSizeMeters: 1000,
    minimumSize: 33,
    marginCells: 0
  }), 33);
  assert.equal(estimateValidationGridSize({
    center: { latitude: 0, longitude: 0 },
    geometries: [[[-20, -20], [20, 20]]],
    cellSizeMeters: 100,
    minimumSize: 3,
    maximumSize: 64,
    marginCells: 0
  }), 64);
});

test('rejects malformed geometry and coordinates', () => {
  assert.throws(
    () => estimateValidationGridSize({
      center: { latitude: 44, longitude: -115 },
      geometries: [],
      cellSizeMeters: 100
    }),
    /at least one coordinate/
  );
  assert.throws(
    () => estimateValidationGridSize({
      center: { latitude: 44, longitude: -115 },
      geometries: [[[200, 44], [200, 44]]],
      cellSizeMeters: 100
    }),
    /geometry longitude/
  );
});
