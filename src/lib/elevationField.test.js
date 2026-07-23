import test from 'node:test';
import assert from 'node:assert/strict';
import { createElevationSampleRequest, fetchElevationField, interpolateElevationGrid, isElevationCacheEntryStale, quantizeElevationCacheKey } from './elevationField.js';

test('creates a bounded elevation request around the clicked coordinate', () => {
  const request = createElevationSampleRequest({
    latitude: 37.7749,
    longitude: -122.4194,
    sampleSize: 10,
    spanKm: 512
  });
  assert.equal(request.coordinates.length, 100);
  assert.equal(request.url.startsWith('https://api.open-meteo.com/v1/elevation?'), true);
  assert.ok(request.coordinates.every(({ latitude, longitude }) => latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180));
});

test('bilinearly expands corner elevations into a target terrain grid', () => {
  const heights = interpolateElevationGrid([0, 10, 20, 30], 2, 3);
  assert.deepEqual(Array.from(heights.slice(0, 3)), [0, 5, 10]);
  assert.equal(heights[4], 15);
  assert.deepEqual(Array.from(heights.slice(-3)), [20, 25, 30]);
});

test('parses a public elevation response into a fire-sized height field', async () => {
  const terrain = await fetchElevationField({
    latitude: 37.7,
    longitude: -122.4,
    sampleSize: 2,
    targetSize: 4,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ elevation: [0, 10, 20, 30] })
    })
  });
  assert.equal(terrain.heights.length, 16);
  assert.equal(terrain.source, 'Copernicus GLO-90 via Open-Meteo');
  assert.equal(terrain.heights[15], 30);
});

test('quantizes nearby clicks to a reusable terrain cache key', () => {
  assert.equal(
    quantizeElevationCacheKey(37.77491, -122.41941, 128),
    quantizeElevationCacheKey(37.77494, -122.41944, 128)
  );
  assert.notEqual(
    quantizeElevationCacheKey(37.77491, -122.41941, 128),
    quantizeElevationCacheKey(37.78491, -122.41941, 128)
  );
});

test('provides an abort signal for slow public elevation requests', async () => {
  let requestOptions = null;
  await fetchElevationField({
    latitude: 37.7,
    longitude: -122.4,
    sampleSize: 2,
    targetSize: 2,
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return { ok: true, json: async () => ({ elevation: [0, 0, 0, 0] }) };
    }
  });
  assert.ok(requestOptions?.signal);
});

test('stamps every fetched elevation field with a fetchedAt timestamp for cache-freshness tracking', async () => {
  const before = Date.now();
  const terrain = await fetchElevationField({
    latitude: 0, longitude: 0, sampleSize: 2, targetSize: 2,
    fetchImpl: async () => ({ ok: true, json: async () => ({ elevation: [0, 0, 0, 0] }) })
  });
  const after = Date.now();
  assert.ok(terrain.fetchedAt >= before && terrain.fetchedAt <= after,
    `fetchedAt ${terrain.fetchedAt} should fall between ${before} and ${after}`);
});

test('isElevationCacheEntryStale returns false for a fresh entry within the TTL window', () => {
  const now = Date.now();
  assert.equal(isElevationCacheEntryStale({ fetchedAt: now - 5_000 }, 60_000), false);
});

test('isElevationCacheEntryStale returns true for an entry older than the TTL', () => {
  const now = Date.now();
  assert.equal(isElevationCacheEntryStale({ fetchedAt: now - 120_000 }, 60_000), true);
});

test('isElevationCacheEntryStale treats missing entries and missing timestamps as stale', () => {
  assert.equal(isElevationCacheEntryStale(null, 60_000), true);
  assert.equal(isElevationCacheEntryStale({}, 60_000), true);
  assert.equal(isElevationCacheEntryStale({ fetchedAt: 'not a number' }, 60_000), true);
});

test('rejects malformed elevation values instead of treating them as sea level', async () => {
  await assert.rejects(
    fetchElevationField({
      latitude: 37.7,
      longitude: -122.4,
      sampleSize: 2,
      targetSize: 2,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ elevation: [0, null, 20, 30] })
      })
    }),
    /finite elevation values/
  );
});
