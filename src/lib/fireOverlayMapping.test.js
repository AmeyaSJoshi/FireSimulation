import test from 'node:test';
import assert from 'node:assert/strict';
import { isLikelyWaterRgb, latitudeLongitudeToEarthUv } from './fireOverlayMapping.js';

test('maps fire overlay vertices to the same Earth UV convention as the globe texture', () => {
  assert.deepEqual(latitudeLongitudeToEarthUv(0, 0), { u: 0.5, v: 0.5 });
  assert.deepEqual(latitudeLongitudeToEarthUv(90, -180), { u: 0, v: 1 });
  assert.deepEqual(latitudeLongitudeToEarthUv(-90, 180), { u: 1, v: 0 });
});

test('identifies saturated blue water pixels for visual fire masking', () => {
  assert.equal(isLikelyWaterRgb(0, 100, 200), true);
  assert.equal(isLikelyWaterRgb(250, 230, 160), false);
  assert.equal(isLikelyWaterRgb(255, 255, 255), false);
});
