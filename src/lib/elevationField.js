import { createSpatialGrid } from './spatialGrid.js';

const ELEVATION_ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
export const MAX_ELEVATION_SAMPLES_PER_REQUEST = 100;
export const DEFAULT_ELEVATION_FIELD_SAMPLE_SIZE = 32;
const MAX_ELEVATION_FIELD_SAMPLE_SIZE = 64;
const ELEVATION_REQUEST_CONCURRENCY = 4;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function createElevationSampleRequest({
  latitude,
  longitude,
  sampleSize = 10,
  spanKm = 128
}) {
  const size = clamp(Math.floor(sampleSize), 2, 10);
  const coordinates = createElevationSampleCoordinates({ latitude, longitude, sampleSize: size, spanKm });
  return {
    url: createElevationUrl(coordinates),
    coordinates,
    sampleSize: size,
    spanKm,
    requestCount: 1
  };
}

// Open-Meteo accepts at most 100 locations per request. Keep the high-
// resolution field as one ordered raster, but split transport into bounded
// batches so the fire grid does not inherit a multi-kilometre terrain blur.
export function createElevationSampleRequests({
  latitude,
  longitude,
  sampleSize = DEFAULT_ELEVATION_FIELD_SAMPLE_SIZE,
  spanKm = 128,
  maxSamplesPerRequest = MAX_ELEVATION_SAMPLES_PER_REQUEST
} = {}) {
  const size = clamp(Math.floor(sampleSize), 2, MAX_ELEVATION_FIELD_SAMPLE_SIZE);
  if (!Number.isInteger(maxSamplesPerRequest)
    || maxSamplesPerRequest < 1
    || maxSamplesPerRequest > MAX_ELEVATION_SAMPLES_PER_REQUEST) {
    throw new RangeError(
      `elevationField: maxSamplesPerRequest must be an integer in [1, ${MAX_ELEVATION_SAMPLES_PER_REQUEST}]`
    );
  }
  const coordinates = createElevationSampleCoordinates({ latitude, longitude, sampleSize: size, spanKm });
  const requests = [];
  for (let startIndex = 0; startIndex < coordinates.length; startIndex += maxSamplesPerRequest) {
    const batch = coordinates.slice(startIndex, startIndex + maxSamplesPerRequest);
    requests.push({
      url: createElevationUrl(batch),
      coordinates: batch,
      startIndex,
      sampleSize: size,
      spanKm,
      requestCount: Math.ceil(coordinates.length / maxSamplesPerRequest)
    });
  }
  return requests;
}

function createElevationSampleCoordinates({ latitude, longitude, sampleSize, spanKm }) {
  const coordinates = [];
  const grid = createSpatialGrid({
    latitude,
    longitude,
    cellSizeMeters: (spanKm * 1000) / (sampleSize - 1),
    gridSize: sampleSize
  });

  for (let y = 0; y < sampleSize; y += 1) {
    for (let x = 0; x < sampleSize; x += 1) {
      coordinates.push(grid.cellCenterLatLon(y, x));
    }
  }
  return coordinates;
}

function createElevationUrl(coordinates) {
  const url = new URL(ELEVATION_ENDPOINT);
  url.searchParams.set('latitude', coordinates.map(({ latitude }) => latitude.toFixed(5)).join(','));
  url.searchParams.set('longitude', coordinates.map(({ longitude }) => longitude.toFixed(5)).join(','));
  return url.toString();
}

export function quantizeElevationCacheKey(latitude, longitude, spanKm = 128) {
  return `${Number(latitude).toFixed(2)}:${Number(longitude).toFixed(2)}:${spanKm}`;
}

export function interpolateElevationGrid(samples, sampleSize, targetSize) {
  if (samples.length !== sampleSize * sampleSize) {
    throw new Error(`Expected ${sampleSize * sampleSize} elevation samples, received ${samples.length}`);
  }
  const outputSize = Math.max(2, Math.floor(targetSize));
  const output = new Float32Array(outputSize * outputSize);

  for (let y = 0; y < outputSize; y += 1) {
    const sampleY = (y / (outputSize - 1)) * (sampleSize - 1);
    const y0 = Math.floor(sampleY);
    const y1 = Math.min(sampleSize - 1, y0 + 1);
    const yWeight = sampleY - y0;
    for (let x = 0; x < outputSize; x += 1) {
      const sampleX = (x / (outputSize - 1)) * (sampleSize - 1);
      const x0 = Math.floor(sampleX);
      const x1 = Math.min(sampleSize - 1, x0 + 1);
      const xWeight = sampleX - x0;
      const topLeft = Number(samples[y0 * sampleSize + x0]) || 0;
      const topRight = Number(samples[y0 * sampleSize + x1]) || 0;
      const bottomLeft = Number(samples[y1 * sampleSize + x0]) || 0;
      const bottomRight = Number(samples[y1 * sampleSize + x1]) || 0;
      const top = topLeft + (topRight - topLeft) * xWeight;
      const bottom = bottomLeft + (bottomRight - bottomLeft) * xWeight;
      output[y * outputSize + x] = top + (bottom - top) * yWeight;
    }
  }

  return output;
}

export async function fetchElevationField({
  latitude,
  longitude,
  sampleSize = DEFAULT_ELEVATION_FIELD_SAMPLE_SIZE,
  spanKm = 128,
  targetSize = 128,
  timeoutMs = 7000,
  fetchImpl = globalThis.fetch
}) {
  if (typeof fetchImpl !== 'function') throw new Error('Elevation fetch is unavailable');
  const requests = createElevationSampleRequests({ latitude, longitude, sampleSize, spanKm });
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const samples = new Array(requests[0].sampleSize ** 2);
    await mapWithConcurrency(requests, ELEVATION_REQUEST_CONCURRENCY, async (request) => {
      const response = await fetchImpl(request.url, controller ? { signal: controller.signal } : undefined);
      if (!response.ok) throw new Error(`Elevation request failed with ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.elevation) || payload.elevation.length !== request.coordinates.length) {
        throw new Error(`Elevation response did not include the expected ${request.coordinates.length}-point batch`);
      }
      if (payload.elevation.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('Elevation response contained non-finite elevation values');
      }
      for (let index = 0; index < payload.elevation.length; index += 1) {
        samples[request.startIndex + index] = payload.elevation[index];
      }
    });
    return {
      heights: interpolateElevationGrid(samples, requests[0].sampleSize, targetSize),
      sampleSize: requests[0].sampleSize,
      requestCount: requests.length,
      spanKm,
      source: 'Copernicus GLO-90 via Open-Meteo',
      fetchedAt: Date.now()
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  }));
}

// True when the cache entry is missing, has no valid timestamp, or is older
// than ttlMs. Callers may still choose to serve stale data — this helper
// only tells them the freshness state so provenance can be displayed and
// (later, in Phase 2) refetch policy can be decided honestly.
export function isElevationCacheEntryStale(entry, ttlMs) {
  if (!entry || !Number.isFinite(entry.fetchedAt)) return true;
  return (Date.now() - entry.fetchedAt) > ttlMs;
}

export { ELEVATION_ENDPOINT };
