import test from 'node:test';
import assert from 'node:assert/strict';
import { latLonToTerrainUv } from './terrainSampler.js';

test('maps latitude and longitude into the texture space used by the water sampler', () => {
  assert.deepEqual(latLonToTerrainUv(0, 0), { u: 0.5, v: 0.5 });
  assert.deepEqual(latLonToTerrainUv(90, -180), { u: 0, v: 1 });
  assert.deepEqual(latLonToTerrainUv(-90, 180), { u: 1, v: 0 });
});
