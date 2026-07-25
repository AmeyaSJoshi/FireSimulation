import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWorldCoverFineField } from './read-worldcover-fine-field.mjs';

test('fine WorldCover reader groups samples by tile and restores raster positions', async () => {
  const grid = {
    gridSize: 2,
    cellCenterLatLon(row, col) {
      return {
        latitude: row < 0.5 ? 44.95 : 44.94,
        longitude: col < 0.5 ? -115.04 : -113.99
      };
    }
  };
  const requests = [];
  const result = await readWorldCoverFineField({
    grid,
    fromUrlImpl: async (url) => {
      requests.push(url);
      const classCode = url.includes('N42W114') ? 80 : 10;
      return {
        getImage: async () => ({
          readRasters: async ({ window, width, height }) => {
            assert.equal(window[2] - window[0], width);
            assert.equal(window[3] - window[1], height);
            return [new Uint8Array(width * height).fill(classCode)];
          }
        })
      };
    }
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(result.classCodes, new Uint8Array([10, 80, 10, 80]));
  assert.equal(result.sampleClassCodes.length, 64);
  assert.deepEqual(result.classifications.map((entry) => entry.classCode), [10, 80, 10, 80]);
  assert.deepEqual(
    result.tileSummaries.map(({ tileId, sampleCount }) => ({ tileId, sampleCount })),
    [
      { tileId: 'N42W117', sampleCount: 32 },
      { tileId: 'N42W114', sampleCount: 32 }
    ]
  );
});
