// OpenStreetMap buildings/roads/green space for the block-scale (640 m)
// render. Overpass, not a paid API — cache by bbox and confirm the
// endpoint responds before firing the real query; it rate-limits hard.

export const OVERPASS_INTERPRETER_URL = 'https://overpass-api.de/api/interpreter';
export const METERS_PER_DEGREE = 111320;

// Buildings/roads become non-burnable via the SAME classCode-based hard
// barrier landCoverToFuel.js already uses for WorldCover "Built-up" (50) —
// no new fuel-decision code path. Green space maps onto the existing
// WorldCover crosswalk classes so it flows through the same table too.
export const BUILT_UP_CLASS_CODE = 50;
export const GREEN_CLASS_CODE_BY_TAG = Object.freeze({
  'natural:wood': 10,
  'landuse:forest': 10,
  'natural:scrub': 20,
  'landuse:grass': 30,
  'landuse:meadow': 30,
  'natural:grassland': 30,
  'leisure:park': 30,
  'leisure:garden': 30
});

const ROAD_WIDTH_BY_HIGHWAY_METERS = Object.freeze({
  motorway: 24,
  trunk: 20,
  primary: 14,
  secondary: 10,
  tertiary: 8,
  residential: 6,
  service: 4,
  footway: 2,
  path: 2,
  track: 3,
  unclassified: 5,
  living_street: 5
});
const DEFAULT_ROAD_WIDTH_METERS = 5;
const DEFAULT_BUILDING_HEIGHT_METERS = 6;

export function buildOverpassQuery([south, west, north, east]) {
  const bbox = `${south},${west},${north},${east}`;
  return `[out:json][timeout:25];(
way["building"](${bbox});relation["building"](${bbox});
way["highway"](${bbox});
way["landuse"~"grass|forest|meadow"](${bbox});way["leisure"~"park|garden"](${bbox});way["natural"~"wood|scrub|grassland"](${bbox});
);out geom;`;
}

export async function probeOverpassAvailable({ signal, timeoutMs = 5000 } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(`${OVERPASS_INTERPRETER_URL}?data=${encodeURIComponent('[out:json];out count;')}`, {
      signal: signal ?? controller?.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchOverpassRaw(bbox, { signal, timeoutMs = 20000 } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(OVERPASS_INTERPRETER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(buildOverpassQuery(bbox))}`,
      signal: signal ?? controller?.signal
    });
    if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
    return await response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function parseOverpassElements(json) {
  const buildings = [];
  const roads = [];
  const green = [];
  for (const element of json?.elements ?? []) {
    const rings = elementRings(element);
    if (rings.length === 0) continue;
    const tags = element.tags ?? {};
    if (tags.building) {
      buildings.push({ tags, rings });
    } else if (tags.highway) {
      roads.push({ tags, line: rings[0] });
    } else {
      const classCode = classifyGreenTags(tags);
      if (classCode) green.push({ tags, rings, classCode });
    }
  }
  return { buildings, roads, green };
}

function elementRings(element) {
  if (Array.isArray(element.geometry)) {
    return element.geometry.length >= 2 ? [element.geometry] : [];
  }
  if (Array.isArray(element.members)) {
    return element.members
      .map((member) => member.geometry)
      .filter((geometry) => Array.isArray(geometry) && geometry.length >= 2);
  }
  return [];
}

export function classifyGreenTags(tags) {
  for (const key of ['natural', 'landuse', 'leisure']) {
    const value = tags?.[key];
    if (value && GREEN_CLASS_CODE_BY_TAG[`${key}:${value}`]) {
      return GREEN_CLASS_CODE_BY_TAG[`${key}:${value}`];
    }
  }
  return null;
}

export function resolveBuildingHeightMeters(tags) {
  const height = parseMeters(tags?.height);
  if (height != null) return { heightMeters: height, isDefault: false };
  const levels = Number(tags?.['building:levels']);
  if (Number.isFinite(levels) && levels > 0) return { heightMeters: levels * 3, isDefault: false };
  return { heightMeters: DEFAULT_BUILDING_HEIGHT_METERS, isDefault: true };
}

export function resolveRoadWidthMeters(tags) {
  const width = parseMeters(tags?.width);
  if (width != null) return { widthMeters: width, isDefault: false };
  const lanes = Number(tags?.lanes);
  if (Number.isFinite(lanes) && lanes > 0) return { widthMeters: lanes * 3.5, isDefault: false };
  const byType = ROAD_WIDTH_BY_HIGHWAY_METERS[tags?.highway];
  if (byType) return { widthMeters: byType, isDefault: true };
  return { widthMeters: DEFAULT_ROAD_WIDTH_METERS, isDefault: true };
}

function parseMeters(value) {
  if (value == null) return null;
  const match = /^(-?\d+(?:\.\d+)?)/.exec(String(value).trim());
  return match ? Number(match[1]) : null;
}

// Local tangent-plane meters, consistent with spatialGrid.js's row/col
// convention: x = east (+col), z = -north (+row). Matches the formula in
// the task spec exactly so blockScene's ground plane and this raster
// agree pixel-for-pixel.
export function projectLonLatToLocalMeters(lon, lat, lon0, lat0) {
  const x = (lon - lon0) * METERS_PER_DEGREE * Math.cos(lat0 * Math.PI / 180);
  const z = -(lat - lat0) * METERS_PER_DEGREE;
  return { x, z };
}

export function projectFeaturesToLocalMeters({ buildings, roads, green }, { originLatitude, originLongitude }) {
  const project = (point) => projectLonLatToLocalMeters(point.lon, point.lat, originLongitude, originLatitude);
  return {
    buildings: buildings.map((b) => ({
      ...resolveBuildingHeightMeters(b.tags),
      rings: b.rings.map((ring) => ring.map(project))
    })),
    roads: roads.map((r) => ({
      ...resolveRoadWidthMeters(r.tags),
      line: r.line.map(project)
    })),
    green: green.map((g) => ({
      classCode: g.classCode,
      rings: g.rings.map((ring) => ring.map(project))
    }))
  };
}

// Buffers a polyline into a list of quad polygons (one per segment) rather
// than a single mitred outline — simpler, robust to self-intersection, and
// sufficient for rasterization/fill where overlapping quads at joints are
// harmless.
export function bufferLineToQuads(line, widthMeters) {
  const half = widthMeters / 2;
  const quads = [];
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const nx = (-dz / length) * half;
    const nz = (dx / length) * half;
    quads.push([
      { x: a.x + nx, z: a.z + nz },
      { x: b.x + nx, z: b.z + nz },
      { x: b.x - nx, z: b.z - nz },
      { x: a.x - nx, z: a.z - nz }
    ]);
  }
  return quads;
}

// Rasterize projected features into a gridSize x gridSize cell descriptor
// array via an offscreen canvas per spec. One pixel = one model cell (10 m
// native), so no subsampling/majority vote is needed. Building height and
// road width are encoded into the fill color and read back per pixel.
export function rasterizeUrbanFootprints({ buildings, roads, green, gridSize, cellSizeMeters, createCanvas }) {
  const half = (gridSize - 1) / 2;
  const toPixel = (m) => half + m / cellSizeMeters;

  const make = createCanvas ?? defaultCreateCanvas;
  const buildingCanvas = make(gridSize, gridSize);
  const roadCanvas = make(gridSize, gridSize);
  const greenCanvas = make(gridSize, gridSize);
  const bCtx = buildingCanvas.getContext('2d');
  const rCtx = roadCanvas.getContext('2d');
  const gCtx = greenCanvas.getContext('2d');

  for (const building of buildings) {
    const heightCode = Math.max(1, Math.min(255, Math.round(building.heightMeters * 4)));
    bCtx.fillStyle = `rgb(${heightCode},0,0)`;
    for (const ring of building.rings) fillRing(bCtx, ring, toPixel);
  }
  for (const road of roads) {
    const widthCode = Math.max(1, Math.min(255, Math.round(road.widthMeters * 4)));
    rCtx.fillStyle = `rgb(0,0,${widthCode})`;
    for (const quad of bufferLineToQuads(road.line, road.widthMeters)) fillRing(rCtx, quad, toPixel);
  }
  for (const patch of green) {
    gCtx.fillStyle = `rgb(${patch.classCode},255,0)`;
    for (const ring of patch.rings) fillRing(gCtx, ring, toPixel);
  }

  const bData = bCtx.getImageData(0, 0, gridSize, gridSize).data;
  const rData = rCtx.getImageData(0, 0, gridSize, gridSize).data;
  const gData = gCtx.getImageData(0, 0, gridSize, gridSize).data;

  const cells = new Array(gridSize * gridSize);
  let buildingCells = 0;
  let roadCells = 0;
  let greenCells = 0;
  for (let row = 0; row < gridSize; row += 1) {
    for (let col = 0; col < gridSize; col += 1) {
      const index = row * gridSize + col;
      const offset = index * 4;
      if (bData[offset + 3] > 0) {
        cells[index] = { kind: 'building', heightMeters: bData[offset] / 4, source: 'osm-building' };
        buildingCells += 1;
      } else if (rData[offset + 3] > 0) {
        cells[index] = { kind: 'road', widthMeters: rData[offset + 2] / 4, source: 'osm-road' };
        roadCells += 1;
      } else if (gData[offset + 3] > 0) {
        cells[index] = { kind: 'green', classCode: gData[offset], source: 'osm-green' };
        greenCells += 1;
      } else {
        cells[index] = null;
      }
    }
  }
  return { cells, gridSize, summary: { buildingCells, roadCells, greenCells } };
}

function fillRing(ctx, ring, toPixel) {
  if (ring.length < 3) return;
  ctx.beginPath();
  ring.forEach((point, i) => {
    const px = toPixel(point.x);
    const py = toPixel(point.z);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fill();
}

function defaultCreateCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// Cache by bbox (rounded to ~1 m) — Overpass rate-limits hard and the
// block-scale field doesn't move once armed.
const overpassCache = new Map();

export function clearOverpassCache() {
  overpassCache.clear();
}

function bboxCacheKey(bbox) {
  return bbox.map((v) => v.toFixed(5)).join(',');
}

let overpassAvailable = null;

export async function fetchUrbanFootprintsForBbox(bbox, {
  originLatitude,
  originLongitude,
  gridSize,
  cellSizeMeters,
  signal,
  createCanvas
} = {}) {
  const key = bboxCacheKey(bbox);
  if (overpassCache.has(key)) return overpassCache.get(key);

  if (overpassAvailable === null) {
    overpassAvailable = await probeOverpassAvailable({ signal });
  }
  if (!overpassAvailable) {
    const unavailable = { available: false, buildings: [], roads: [], green: [], raster: null };
    overpassCache.set(key, unavailable);
    return unavailable;
  }

  try {
    const raw = await fetchOverpassRaw(bbox, { signal });
    const parsed = parseOverpassElements(raw);
    const projected = projectFeaturesToLocalMeters(parsed, { originLatitude, originLongitude });
    const raster = rasterizeUrbanFootprints({ ...projected, gridSize, cellSizeMeters, createCanvas });
    const result = { available: true, ...projected, raster };
    overpassCache.set(key, result);
    return result;
  } catch (error) {
    const failed = { available: false, buildings: [], roads: [], green: [], raster: null, error: error?.message ?? String(error) };
    overpassCache.set(key, failed);
    return failed;
  }
}
