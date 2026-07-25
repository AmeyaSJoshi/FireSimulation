import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createElevationSampleRequest,
  createElevationSampleRequests,
  fetchElevationField,
  interpolateElevationGrid,
  isElevationCacheEntryStale,
  quantizeElevationCacheKey
} from './elevationField.js';

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

test('keeps high-latitude elevation samples physically spaced', () => {
  const request = createElevationSampleRequest({
    latitude: 89.5,
    longitude: 40,
    sampleSize: 3,
    spanKm: 20
  });
  const center = request.coordinates[4];
  const east = request.coordinates[5];
  const lat1 = center.latitude * Math.PI / 180;
  const lat2 = east.latitude * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (east.longitude - center.longitude) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const distanceKm = 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  assert.ok(Math.abs(distanceKm - 10) < 0.01, `east sample distance was ${distanceKm} km`);
});

test('splits a high-resolution terrain field into documented bounded requests', () => {
  const requests = createElevationSampleRequests({
    latitude: 37.7,
    longitude: -122.4,
    sampleSize: 32,
    spanKm: 32
  });

  assert.equal(requests.length, 11);
  assert.equal(requests.reduce((sum, request) => sum + request.coordinates.length, 0), 32 * 32);
  assert.ok(requests.every((request) => request.coordinates.length <= 100));
  assert.equal(requests.at(-1).requestCount, 11);
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

test('reassembles ordered elevation batches before interpolation', async () => {
  let requestCount = 0;
  const terrain = await fetchElevationField({
    latitude: 37.7,
    longitude: -122.4,
    sampleSize: 11,
    targetSize: 11,
    spanKm: 11,
    fetchImpl: async (url) => {
      const count = Number(new URL(url).searchParams.get('latitude').split(',').length);
      const batch = requestCount++;
      return {
        ok: true,
        json: async () => ({ elevation: Array.from({ length: count }, (_, index) => batch * 100 + index) })
      };
    }
  });

  assert.equal(terrain.sampleSize, 11);
  assert.equal(terrain.requestCount, 2);
  assert.equal(terrain.heights[0], 0);
  assert.equal(terrain.heights[99], 99);
  assert.equal(terrain.heights[100], 100);
  assert.equal(terrain.heights.at(-1), 120);
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
