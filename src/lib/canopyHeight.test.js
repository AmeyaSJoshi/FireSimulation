import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateCanopyHeightSamples,
  canopyHeightPixelCoordinates,
  canopyHeightTileBounds,
  canopyHeightTileId,
  canopyHeightTileUrl,
  classifyCanopyHeight
} from './canopyHeight.js';

test('builds the published 3-degree canopy-height tile URL', () => {
  assert.deepEqual(canopyHeightTileBounds(44.95, -115.04), {
    latitudeSouth: 42,
    latitudeNorth: 45,
    longitudeWest: -117,
    longitudeEast: -114
  });
  assert.equal(canopyHeightTileId(44.95, -115.04), 'N42W117');
  assert.match(canopyHeightTileUrl('N42W117'), /ETH_GlobalCanopyHeight_10m_2020_N42W117_Map\.tif$/);
  assert.deepEqual(canopyHeightPixelCoordinates(44.95, -115.04, 'N42W117'), {
    x: 23519,
    y: 599
  });
});

test('rejects invalid canopy heights rather than turning no-data into trees', () => {
  assert.equal(classifyCanopyHeight(-1), null);
  assert.equal(classifyCanopyHeight(121), null);
  assert.equal(classifyCanopyHeight('no data'), null);
  assert.equal(classifyCanopyHeight(18).heightMeters, 18);
});

test('aggregates cell samples with a deterministic median', () => {
  const result = aggregateCanopyHeightSamples([
    { heightMeters: 4 }, { heightMeters: 20 }, { heightMeters: 12 },
    { heightMeters: 8 }, { heightMeters: 10 }, { heightMeters: 6 },
    { heightMeters: 14 }, { heightMeters: 2 }, { heightMeters: 16 }
  ], { gridSize: 1, samplesPerCell: 9 });
  assert.equal(result[0].heightMeters, 10);
  assert.equal(result[0].validSampleCount, 9);
});
