import * as Cesium from 'cesium';

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org';
const SEARCH_DEBOUNCE_MS = 300;
const REQUEST_INTERVAL_MS = 1_000;
const PIN_LIFETIME_MS = 5_000;
const MAX_RESULTS = 5;
const REVERSE_CACHE_LIMIT = 300;

let requestGate = Promise.resolve();
let lastRequestStartedAt = 0;
const reverseCache = new Map();

function abortError() {
  return new DOMException('Request aborted', 'AbortError');
}

function delay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

// One shared gate covers both search and reverse lookups. Browser fetch sends
// its normal User-Agent and a strict-origin Referer; both identify this demo
// without attempting to set forbidden request headers in client JavaScript.
async function fetchNominatim(url, { signal } = {}) {
  const task = requestGate.then(async () => {
    if (signal?.aborted) throw abortError();
    const waitMs = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - lastRequestStartedAt));
    await delay(waitMs, signal);
    lastRequestStartedAt = Date.now();
    const response = await fetch(url, {
      signal,
      credentials: 'omit',
      referrerPolicy: 'strict-origin-when-cross-origin',
      headers: {
        Accept: 'application/json',
        'Accept-Language': navigator.languages?.join(',') || navigator.language || 'en'
      }
    });
    if (!response.ok) throw new Error(`Place lookup failed (${response.status})`);
    return response.json();
  });
  requestGate = task.catch(() => undefined);
  return task;
}

function dedupe(parts) {
  const seen = new Set();
  return parts.filter((part) => {
    const value = String(part ?? '').trim();
    if (!value) return false;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function localityParts(address = {}) {
  return dedupe([
    address.city || address.town || address.village || address.hamlet || address.municipality,
    address.county,
    address.state,
    address.country
  ]);
}

function normalizeSearchResult(item) {
  const address = item.address ?? {};
  const name = item.name || item.display_name?.split(',')[0] || 'Unnamed place';
  const region = localityParts(address).filter((part) => part !== name).slice(0, 3).join(', ');
  const bbox = Array.isArray(item.boundingbox) ? item.boundingbox.map(Number) : null;
  return {
    latitude: Number(item.lat),
    longitude: Number(item.lon),
    name,
    region,
    label: dedupe([name, ...localityParts(address)]).slice(0, 4).join(', '),
    bbox: bbox?.every(Number.isFinite) ? bbox : null
  };
}

function normalizeReverseResult(item) {
  const address = item?.address ?? {};
  const feature = item?.name
    || address.amenity
    || address.tourism
    || address.leisure
    || address.building
    || address.road
    || address.neighbourhood
    || address.suburb;
  const parts = dedupe([feature, ...localityParts(address)]).slice(0, 4);
  return parts.length ? { label: parts.join(', '), address } : null;
}

// Swappable endpoint functions: replace these with Google/Mapbox later while
// leaving the UI, cache, camera flight, and ignition integration unchanged.
export async function searchNominatim(query, { signal } = {}) {
  const url = new URL('/search', NOMINATIM_BASE_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(MAX_RESULTS));
  url.searchParams.set('addressdetails', '1');
  const payload = await fetchNominatim(url, { signal });
  return payload
    .map(normalizeSearchResult)
    .filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
    .slice(0, MAX_RESULTS);
}

export async function reverseNominatim(latitude, longitude, { signal } = {}) {
  const url = new URL('/reverse', NOMINATIM_BASE_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(latitude));
  url.searchParams.set('lon', String(longitude));
  url.searchParams.set('zoom', '18');
  url.searchParams.set('addressdetails', '1');
  return normalizeReverseResult(await fetchNominatim(url, { signal }));
}

function reverseCacheKey(latitude, longitude) {
  const latKm = latitude * 111.32;
  const lonKm = longitude * 111.32 * Math.max(0.1, Math.cos(Cesium.Math.toRadians(latitude)));
  return `${Math.floor(latKm)}:${Math.floor(lonKm)}`;
}

function trimReverseCache() {
  while (reverseCache.size > REVERSE_CACHE_LIMIT) {
    reverseCache.delete(reverseCache.keys().next().value);
  }
}

function createReverseLookup(reverseEndpoint) {
  return (latitude, longitude, options = {}) => {
    const key = reverseCacheKey(latitude, longitude);
    if (reverseCache.has(key)) return reverseCache.get(key);
    const request = Promise.resolve(reverseEndpoint(latitude, longitude, options))
      .catch((error) => {
        reverseCache.delete(key);
        throw error;
      });
    reverseCache.set(key, request);
    trimReverseCache();
    return request;
  };
}

function estimateRangeMeters(result, mode) {
  if (!result.bbox) return mode === '2d' ? 4_000 : 2_000;
  const [south, north, west, east] = result.bbox;
  const latSpan = Math.abs(north - south) * 111_320;
  const lonSpan = Math.abs(east - west) * 111_320
    * Math.max(0.1, Math.cos(Cesium.Math.toRadians(result.latitude)));
  const span = Math.max(latSpan, lonSpan);
  return mode === '2d'
    ? Cesium.Math.clamp(span * 1.8, 3_500, 18_000)
    : Cesium.Math.clamp(span * 1.3, 1_600, 9_000);
}

function flyToResult(viewer, viewMode, result) {
  const mode = viewMode.mode;
  const pitch = mode === '2d' ? Cesium.Math.toRadians(-90) : Cesium.Math.toRadians(-55);
  const heading = mode === '2d' ? 0 : Cesium.Math.toRadians(30);
  const rangeMeters = estimateRangeMeters(result, mode);
  const height = Math.max(250, rangeMeters * Math.sin(-pitch));
  const ground = rangeMeters * Math.cos(-pitch);
  const metresPerDegreeLon = 111_320
    * Math.max(0.1, Math.cos(Cesium.Math.toRadians(result.latitude)));
  const destination = Cesium.Cartesian3.fromDegrees(
    result.longitude - (ground * Math.sin(heading)) / metresPerDegreeLon,
    result.latitude - (ground * Math.cos(heading)) / 111_320,
    height
  );
  viewer.camera.flyTo({
    destination,
    orientation: { heading, pitch, roll: 0 },
    duration: 1.35
  });
}

function createPinController(viewer) {
  let entity = null;
  let fadeTimer = null;

  function clear() {
    if (fadeTimer) clearInterval(fadeTimer);
    fadeTimer = null;
    if (entity) viewer.entities.remove(entity);
    entity = null;
  }

  function show(result) {
    clear();
    const startedAt = performance.now();
    entity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(result.longitude, result.latitude, 12),
      point: {
        pixelSize: 15,
        color: Cesium.Color.fromCssColorString('#ff9430'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: {
        text: result.name,
        font: '500 13px Inter, sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: new Cesium.Color(0.03, 0.04, 0.06, 0.82),
        pixelOffset: new Cesium.Cartesian2(0, -28),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 40_000),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
    fadeTimer = setInterval(() => {
      if (!entity) return;
      const progress = (performance.now() - startedAt) / PIN_LIFETIME_MS;
      if (progress >= 1) {
        clear();
        return;
      }
      const alpha = progress < 0.72 ? 1 : 1 - ((progress - 0.72) / 0.28);
      entity.point.color = Cesium.Color.fromCssColorString('#ff9430').withAlpha(alpha);
      entity.point.outlineColor = Cesium.Color.WHITE.withAlpha(alpha);
      entity.label.fillColor = Cesium.Color.WHITE.withAlpha(alpha);
      entity.label.backgroundColor = new Cesium.Color(0.03, 0.04, 0.06, 0.82 * alpha);
      viewer.scene.requestRender();
    }, 100);
  }

  return { show, clear };
}

function addLabelLayer(viewer, viewMode) {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: 'https://basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png',
    maximumLevel: 20,
    credit: new Cesium.Credit(
      '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a> · <a href="https://carto.com/attributions" target="_blank">© CARTO</a>'
    )
  });
  const layer = viewer.imageryLayers.addImageryProvider(provider);
  layer.alpha = 0.96;

  const sync = (mode) => {
    layer.show = mode === '2d';
    viewer.imageryLayers.raiseToTop(layer);
    viewer.scene.requestRender();
  };
  sync(viewMode.mode);
  const removeListener = viewMode.onChange(sync);
  return {
    layer,
    destroy() {
      removeListener();
      viewer.imageryLayers.remove(layer, true);
    }
  };
}

function renderResults(list, results, activeIndex) {
  list.replaceChildren();
  results.forEach((result, index) => {
    const item = document.createElement('li');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === activeIndex));
    item.dataset.index = String(index);
    const name = document.createElement('span');
    name.className = 'geocoder-result-name';
    name.textContent = result.name;
    const region = document.createElement('span');
    region.className = 'geocoder-result-region';
    region.textContent = result.region || 'Location result';
    item.append(name, region);
    list.append(item);
  });
  list.hidden = results.length === 0;
}

export function initGeocoder({
  viewer,
  viewMode,
  searchEndpoint = searchNominatim,
  reverseEndpoint = reverseNominatim,
  onSelect,
  onPlaceResolved
}) {
  const panel = document.querySelector('#geocoder-panel');
  const form = document.querySelector('#geocoder-form');
  const input = document.querySelector('#geocoder-input');
  const clearButton = document.querySelector('#geocoder-clear');
  const list = document.querySelector('#geocoder-results');
  const status = document.querySelector('#geocoder-status');
  if (!panel || !form || !input || !clearButton || !list || !status) {
    throw new Error('Geocoder UI is incomplete');
  }

  const labels = addLabelLayer(viewer, viewMode);
  const pin = createPinController(viewer);
  const reverse = createReverseLookup(reverseEndpoint);
  let results = [];
  let activeIndex = -1;
  let debounceTimer = null;
  let searchController = null;
  let searchVersion = 0;

  function setOpen(open) {
    const visible = open && results.length > 0;
    list.hidden = !visible;
    input.setAttribute('aria-expanded', String(visible));
  }

  function resetResults() {
    results = [];
    activeIndex = -1;
    renderResults(list, results, activeIndex);
    setOpen(false);
  }

  async function runSearch({ selectFirst = false } = {}) {
    const query = input.value.trim();
    if (query.length < 2) {
      status.textContent = '';
      resetResults();
      return [];
    }
    const version = ++searchVersion;
    searchController?.abort();
    searchController = new AbortController();
    status.textContent = 'Searching…';
    input.setAttribute('aria-busy', 'true');
    try {
      const nextResults = await searchEndpoint(query, { signal: searchController.signal });
      if (version !== searchVersion) return [];
      results = nextResults.slice(0, MAX_RESULTS);
      activeIndex = results.length ? 0 : -1;
      renderResults(list, results, activeIndex);
      setOpen(true);
      status.textContent = results.length ? '' : 'No places found';
      if (selectFirst && results[0]) selectResult(results[0]);
      return results;
    } catch (error) {
      if (error?.name !== 'AbortError' && version === searchVersion) {
        status.textContent = 'Place search unavailable';
        resetResults();
      }
      return [];
    } finally {
      if (version === searchVersion) input.removeAttribute('aria-busy');
    }
  }

  function selectResult(result) {
    input.value = result.name;
    clearButton.hidden = false;
    status.textContent = '';
    resetResults();
    flyToResult(viewer, viewMode, result);
    pin.show(result);
    onSelect?.(result);
    reverse(result.latitude, result.longitude)
      .then((place) => {
        if (place) onPlaceResolved?.({ ...result, ...place, source: 'search' });
      })
      .catch(() => { /* Search label remains the non-blocking fallback. */ });
  }

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    clearButton.hidden = input.value.length === 0;
    debounceTimer = setTimeout(() => runSearch(), SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(debounceTimer);
      const result = results[activeIndex] ?? results[0];
      if (result) selectResult(result);
      else runSearch({ selectFirst: true });
    } else if (event.key === 'ArrowDown' && results.length) {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % results.length;
      renderResults(list, results, activeIndex);
      setOpen(true);
    } else if (event.key === 'ArrowUp' && results.length) {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + results.length) % results.length;
      renderResults(list, results, activeIndex);
      setOpen(true);
    } else if (event.key === 'Escape') {
      resetResults();
      input.blur();
    }
  });
  input.addEventListener('focus', () => setOpen(true));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(debounceTimer);
    if (results[activeIndex] ?? results[0]) {
      selectResult(results[activeIndex] ?? results[0]);
    } else {
      runSearch({ selectFirst: true });
    }
  });
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const item = event.target.closest('[data-index]');
    const result = item ? results[Number(item.dataset.index)] : null;
    if (result) selectResult(result);
  });
  clearButton.addEventListener('click', () => {
    clearTimeout(debounceTimer);
    searchController?.abort();
    input.value = '';
    clearButton.hidden = true;
    status.textContent = '';
    resetResults();
    input.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!panel.contains(event.target)) setOpen(false);
  });

  return {
    reverse,
    labels,
    destroy() {
      clearTimeout(debounceTimer);
      searchController?.abort();
      pin.clear();
      labels.destroy();
    }
  };
}
