import { fetchElevationField } from '../lib/elevationField.js';
import { getFuelModel } from '../lib/fuelModels.js';
import { fetchCurrentWind, fetchWeatherInputs } from '../lib/weatherInputs.js';

const CACHE_LIMIT = 24;
const SUCCESS_TTL_MS = Object.freeze({ terrain: 60 * 60_000, wind: 10 * 60_000, weather: 10 * 60_000, osm: 10 * 60_000 });
const FAILURE_TTL_MS = 60_000;
const OSM_TIMEOUT_MS = 6_000;
const requestCache = new Map();

function cachedRequest(key, successTtlMs, load) {
  const now = Date.now();
  const cached = requestCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const entry = { expiresAt: now + FAILURE_TTL_MS, promise: null };
  entry.promise = Promise.resolve().then(load).then(
    (value) => {
      entry.expiresAt = Date.now() + successTtlMs;
      return value;
    },
    (error) => {
      entry.expiresAt = Date.now() + FAILURE_TTL_MS;
      throw error;
    }
  );
  requestCache.set(key, entry);
  while (requestCache.size > CACHE_LIMIT) requestCache.delete(requestCache.keys().next().value);
  return entry.promise;
}

function coordinateKey({ latitude, longitude }) {
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

export function clearEnvironmentalRequestCache() {
  requestCache.clear();
}

function fieldWidthKm(grid) {
  return (grid.gridSize * grid.cellSizeMeters) / 1_000;
}

function coordinates(geometry) {
  return Array.isArray(geometry)
    ? geometry.map(({ lat, lon }) => [lon, lat]).filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
    : [];
}

function buildingHeight(tags) {
  const height = Number.parseFloat(tags?.height);
  if (Number.isFinite(height) && height >= 0) return height;
  const levels = Number.parseFloat(tags?.['building:levels']);
  return Number.isFinite(levels) && levels >= 0 ? levels * 3 : 0;
}

export async function fetchOsmFeatures({
  bbox, fetchImpl = globalThis.fetch, signal, endpoint = '/api/osm/features'
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('OSM fetch is unavailable');
  const timeoutSignal = typeof globalThis.AbortSignal?.timeout === 'function'
    ? globalThis.AbortSignal.timeout(OSM_TIMEOUT_MS)
    : null;
  const requestSignal = signal && timeoutSignal && typeof globalThis.AbortSignal.any === 'function'
    ? globalThis.AbortSignal.any([signal, timeoutSignal])
    : (signal ?? timeoutSignal ?? undefined);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bbox }),
    signal: requestSignal
  });
  if (!response.ok) throw new Error(`OSM request failed with HTTP ${response.status}`);
  const payload = await response.json();
  const buildings = [];
  const roads = [];
  for (const element of payload?.elements ?? []) {
    const line = coordinates(element.geometry);
    if (element.tags?.building && line.length >= 3) {
      const ring = [...line];
      if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push([...ring[0]]);
      buildings.push({ ring, height: buildingHeight(element.tags) });
    } else if (element.tags?.highway && line.length >= 2) {
      roads.push({ polygon: line, kind: element.tags.highway });
    }
  }
  return { buildings, roads, source: 'OpenStreetMap via Overpass API' };
}

export async function loadEnvironmentalContext({
  grid, bbox, fuelCodes, fetchImpl, signal, osmEndpoint, includeWeatherMoisture = true,
  cache = fetchImpl === globalThis.fetch
} = {}) {
  const centerIndex = Math.floor(grid.gridSize / 2) * grid.gridSize + Math.floor(grid.gridSize / 2);
  const fuelModel = getFuelModel(fuelCodes[centerIndex]);
  const useCache = cache;
  const loadTerrain = () => fetchElevationField({
    latitude: grid.origin.latitude, longitude: grid.origin.longitude,
    // Open-Meteo limits elevation requests to 100 points.  A 10 × 10 field
    // keeps this block-scale request to one call, avoiding rate limits while
    // retaining terrain detail far finer than the GLO-90 source resolution.
    sampleSize: Math.min(10, grid.gridSize), targetSize: grid.gridSize,
    spanKm: fieldWidthKm(grid), fetchImpl
  });
  const loadWeather = () => fetchWeatherInputs({
    latitude: grid.origin.latitude, longitude: grid.origin.longitude,
    fuelModel, fuelBedDepthMeters: fuelModel.fuelBedDepthMeters, fetchImpl
  });
  const loadWind = () => fetchCurrentWind({
    latitude: grid.origin.latitude, longitude: grid.origin.longitude, fetchImpl
  });
  const terrainTask = useCache
    ? cachedRequest(`terrain:${coordinateKey(grid.origin)}:${grid.cellSizeMeters}:${grid.gridSize}`, SUCCESS_TTL_MS.terrain, loadTerrain)
    : loadTerrain();
  const weatherTask = includeWeatherMoisture
    ? (useCache
      ? cachedRequest(`weather:${coordinateKey(grid.origin)}:${fuelModel.code}`, SUCCESS_TTL_MS.weather, loadWeather)
      : loadWeather())
    : Promise.resolve(null);
  const windTask = useCache
    ? cachedRequest(`wind:${coordinateKey(grid.origin)}`, SUCCESS_TTL_MS.wind, loadWind)
    : loadWind();
  const loadOsm = () => fetchOsmFeatures({ bbox, fetchImpl, signal, endpoint: osmEndpoint });
  const osmTask = grid.cellSizeMeters <= 10
    ? (useCache
      ? cachedRequest(`osm:${bbox.map((value) => Number(value).toFixed(4)).join(',')}`, SUCCESS_TTL_MS.osm, loadOsm)
      : loadOsm())
    : Promise.resolve(null);
  const [terrain, wind, weather, osm] = await Promise.allSettled([terrainTask, windTask, weatherTask, osmTask]);
  const sources = [];
  const fallbacks = [];
  if (terrain.status === 'fulfilled') {
    sources.push({ name: terrain.value.source, resolutionMeters: null });
  } else {
    fallbacks.push(`terrain: ${terrain.reason.message}`);
  }
  if (wind.status === 'fulfilled') {
    sources.push({ name: wind.value.source, resolutionMeters: null });
  } else {
    fallbacks.push(`wind: ${wind.reason.message}`);
  }
  if (weather.status === 'fulfilled' && weather.value) {
    sources.push({ name: weather.value.source, resolutionMeters: null });
  } else if (includeWeatherMoisture) {
    fallbacks.push(`weather: ${weather.reason.message}`);
  }
  if (osmTask && osm.status === 'fulfilled' && osm.value) {
    sources.push({ name: osm.value.source, resolutionMeters: null });
  } else if (grid.cellSizeMeters <= 10 && osm.status === 'rejected') {
    fallbacks.push(`OSM: ${osm.reason.message}`);
  }
  return {
    terrainHeights: terrain.status === 'fulfilled' ? terrain.value.heights : null,
    wind: wind.status === 'fulfilled' ? wind.value : null,
    weather: weather.status === 'fulfilled' ? weather.value : null,
    buildings: osm.status === 'fulfilled' && osm.value ? osm.value.buildings : [],
    roads: osm.status === 'fulfilled' && osm.value ? osm.value.roads : [],
    evidence: { sources, fallbacks }
  };
}
