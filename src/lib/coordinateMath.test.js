import test from 'node:test';
import assert from 'node:assert/strict';
import { cartesianToLatitudeLongitude, latitudeLongitudeToCartesian } from './coordinateMath.js';

test('round-trips latitude and longitude through the Earth mesh adapter', () => {
  const point = latitudeLongitudeToCartesian({ latitude: -33.86, longitude: 151.21, radius: 4.5 });
  const coordinates = cartesianToLatitudeLongitude(point);
  assert.ok(Math.abs(coordinates.latitude + 33.86) < 0.000001);
  assert.ok(Math.abs(coordinates.longitude - 151.21) < 0.000001);
  assert.ok(Math.abs(Math.hypot(point.x, point.y, point.z) - 4.5) < 0.000001);
});
