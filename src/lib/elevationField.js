const EARTH_KM_PER_DEGREE = 111.32;
const ELEVATION_ENDPOINT = 'https://api.open-meteo.com/v1/elevation';

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeLongitude(longitude) {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

export function createElevationSampleRequest({
  latitude,
  longitude,
  sampleSize = 10,
  spanKm = 128
}) {
  const size = clamp(Math.floor(sampleSize), 2, 10);
  const halfLatitudeSpan = spanKm / EARTH_KM_PER_DEGREE / 2;
  const longitudeScale = Math.max(0.2, Math.cos(latitude * Math.PI / 180));
  const halfLongitudeSpan = spanKm / (EARTH_KM_PER_DEGREE * longitudeScale) / 2;
  const coordinates = [];

  for (let y = 0; y < size; y += 1) {
    const latitudeOffset = halfLatitudeSpan - (y / (size - 1)) * halfLatitudeSpan * 2;
    for (let x = 0; x < size; x += 1) {
      const longitudeOffset = -halfLongitudeSpan + (x / (size - 1)) * halfLongitudeSpan * 2;
      coordinates.push({
        latitude: clamp(latitude + latitudeOffset, -90, 90),
        longitude: normalizeLongitude(longitude + longitudeOffset)
      });
    }
  }

  const url = new URL(ELEVATION_ENDPOINT);
  url.searchParams.set('latitude', coordinates.map(({ latitude: value }) => value.toFixed(5)).join(','));
  url.searchParams.set('longitude', coordinates.map(({ longitude: value }) => value.toFixed(5)).join(','));
  return { url: url.toString(), coordinates, sampleSize: size, spanKm };
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
  sampleSize = 10,
  spanKm = 128,
  targetSize = 128,
  timeoutMs = 7000,
  fetchImpl = globalThis.fetch
}) {
  if (typeof fetchImpl !== 'function') throw new Error('Elevation fetch is unavailable');
  const request = createElevationSampleRequest({ latitude, longitude, sampleSize, spanKm });
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchImpl(request.url, controller ? { signal: controller.signal } : undefined);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  if (!response.ok) throw new Error(`Elevation request failed with ${response.status}`);
  const payload = await response.json();
  const expectedSamples = request.sampleSize * request.sampleSize;
  if (!Array.isArray(payload.elevation) || payload.elevation.length !== expectedSamples) {
    throw new Error(`Elevation response did not include the expected ${expectedSamples}-point grid`);
  }
  if (payload.elevation.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Elevation response contained non-finite elevation values');
  }
  return {
    heights: interpolateElevationGrid(payload.elevation, request.sampleSize, targetSize),
    sampleSize: request.sampleSize,
    spanKm: request.spanKm,
    source: 'Copernicus GLO-90 via Open-Meteo',
    fetchedAt: Date.now()
  };
}

// True when the cache entry is missing, has no valid timestamp, or is older
// than ttlMs. Callers may still choose to serve stale data — this helper
// only tells them the freshness state so provenance can be displayed and
// (later, in Phase 2) refetch policy can be decided honestly.
export function isElevationCacheEntryStale(entry, ttlMs) {
  if (!entry || !Number.isFinite(entry.fetchedAt)) return true;
  return (Date.now() - entry.fetchedAt) > ttlMs;
}

export { EARTH_KM_PER_DEGREE, ELEVATION_ENDPOINT };
