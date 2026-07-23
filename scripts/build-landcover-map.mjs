#!/usr/bin/env node
// One-time preprocessing: build a global coarse land-cover mosaic PNG
// from ESA WorldCover 2021 v200 for use by the browser runtime.
//
// Why this exists:
//   The full 10 m WorldCover product is ~500 GB of COGs spread across
//   2,651 3° x 3° tiles on S3. Direct browser access is blocked by CORS
//   and the file sizes are prohibitive anyway. This script downloads
//   the SMALLEST pyramid overview (562 x 562 covering each 3° tile,
//   ~530 m/pixel), downsamples with modal-class aggregation to ~4 km,
//   and composites into a single 10800 x 5400 paletted PNG plus a
//   small JSON metadata sidecar.
//
// Runtime cost of this preprocessing is a one-time few minutes; the
// result ships in public/ and never runs again unless WorldCover
// publishes a new version.
//
// Usage:
//   npm run build:landcover                # full globe
//   npm run build:landcover -- --limit=20  # dry run, first 20 tiles

import { fromUrl } from 'geotiff';
import { PNG } from 'pngjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────
const S3_BASE = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021';
const GRID_URL = `${S3_BASE}/esa_worldcover_grid.geojson`;
const TILE_URL = (id) => `${S3_BASE}/map/ESA_WorldCover_10m_2021_v200_${id}_Map.tif`;

const MOSAIC_WIDTH = 10800;   // 360° * 30 px/deg = ~4 km/px at equator
const MOSAIC_HEIGHT = 5400;   // 180° * 30 px/deg
const TILE_MOSAIC_PX = 90;    // each 3° tile becomes 90 x 90 px in the mosaic (~3.7 km/px)
const CONCURRENCY = 10;       // parallel S3 fetches
const NO_DATA_VALUE = 0;      // WorldCover uses 0 for "no data" already

// Valid WorldCover class codes (used as palette indices in the PNG).
const CLASS_CODES = new Set([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100]);

// ─────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const LIMIT = args.get('limit') ? Number(args.get('limit')) : Infinity;

// ─────────────────────────────────────────────────────────────
// Tile id parsing:  N54W123  ->  { lat0: 54, lon0: -123 }
// The southwest corner of the 3° x 3° tile.
// ─────────────────────────────────────────────────────────────
function parseTileId(id) {
  const match = /^([NS])(\d+)([EW])(\d+)$/.exec(id);
  if (!match) throw new Error(`bad tile id: ${id}`);
  const lat = Number(match[2]) * (match[1] === 'N' ? 1 : -1);
  const lon = Number(match[4]) * (match[3] === 'E' ? 1 : -1);
  return { lat0: lat, lon0: lon };
}

// ─────────────────────────────────────────────────────────────
// Modal-class downsample of a src x src class raster to dst x dst.
// Ties are broken by class code order (deterministic).
// ─────────────────────────────────────────────────────────────
function downsampleModal(source, srcSize, dstSize) {
  const out = new Uint8Array(dstSize * dstSize);
  const ratio = srcSize / dstSize;
  for (let dy = 0; dy < dstSize; dy += 1) {
    const y0 = Math.floor(dy * ratio);
    const y1 = Math.min(srcSize, Math.floor((dy + 1) * ratio));
    for (let dx = 0; dx < dstSize; dx += 1) {
      const x0 = Math.floor(dx * ratio);
      const x1 = Math.min(srcSize, Math.floor((dx + 1) * ratio));
      const counts = new Map();
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const v = source[y * srcSize + x];
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
      }
      // Pick the modal class; drop NO_DATA if any other class is present
      let best = NO_DATA_VALUE;
      let bestCount = -1;
      for (const [cls, count] of counts.entries()) {
        if (cls === NO_DATA_VALUE && counts.size > 1) continue;
        if (count > bestCount || (count === bestCount && cls < best)) {
          best = cls;
          bestCount = count;
        }
      }
      out[dy * dstSize + dx] = best;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Fetch one tile's smallest overview and return { id, pixels(90x90) }
// ─────────────────────────────────────────────────────────────
async function fetchTileMosaicPatch(id) {
  const tiff = await fromUrl(TILE_URL(id));
  const count = await tiff.getImageCount();
  const smallest = await tiff.getImage(count - 1);
  const width = smallest.getWidth();
  const height = smallest.getHeight();
  const [rasterBand] = await smallest.readRasters();
  if (width !== height) throw new Error(`tile ${id}: non-square overview ${width}x${height}`);
  return {
    id,
    pixels: downsampleModal(rasterBand, width, TILE_MOSAIC_PX)
  };
}

// ─────────────────────────────────────────────────────────────
// Concurrency limiter
// ─────────────────────────────────────────────────────────────
async function mapWithConcurrency(items, limit, mapper, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { ok: true, value: await mapper(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error: error.message ?? String(error) };
      }
      done += 1;
      onProgress?.(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
console.log('[landcover-map] fetching tile grid...');
const gridResponse = await fetch(GRID_URL);
if (!gridResponse.ok) throw new Error(`grid fetch failed: ${gridResponse.status}`);
const grid = await gridResponse.json();
const allIds = grid.features.map((f) => f.properties.ll_tile);
const tileIds = allIds.slice(0, LIMIT);
console.log(`[landcover-map] grid has ${allIds.length} tiles; processing ${tileIds.length}`);

// Initialize mosaic as all NO_DATA. Palette: pixel value == WorldCover class.
const mosaic = new Uint8Array(MOSAIC_WIDTH * MOSAIC_HEIGHT);

const startedAt = Date.now();
let lastLogAt = 0;
const results = await mapWithConcurrency(tileIds, CONCURRENCY, fetchTileMosaicPatch, (done, total) => {
  const now = Date.now();
  if (now - lastLogAt > 2500 || done === total) {
    const elapsed = ((now - startedAt) / 1000).toFixed(1);
    const rate = done / ((now - startedAt) / 1000);
    const eta = ((total - done) / rate).toFixed(0);
    process.stdout.write(`\r  ${done}/${total} (${elapsed}s elapsed, ~${eta}s remaining)   `);
    lastLogAt = now;
  }
});
process.stdout.write('\n');

// Paste each tile patch into the mosaic at its correct lat/lon origin.
// Mosaic pixel (0, 0) is (lat=+90, lon=-180); rows increase southward.
let ok = 0;
let failed = 0;
for (let i = 0; i < tileIds.length; i += 1) {
  const outcome = results[i];
  if (!outcome.ok) {
    failed += 1;
    console.warn(`  tile ${tileIds[i]}: ${outcome.error}`);
    continue;
  }
  ok += 1;
  const { pixels } = outcome.value;
  const { lat0, lon0 } = parseTileId(tileIds[i]);
  // 3° tile → 90 px in the mosaic → 30 px/deg
  const pxPerDeg = TILE_MOSAIC_PX / 3;
  const startCol = Math.round((lon0 + 180) * pxPerDeg);
  const startRow = Math.round((90 - (lat0 + 3)) * pxPerDeg);
  for (let py = 0; py < TILE_MOSAIC_PX; py += 1) {
    for (let px = 0; px < TILE_MOSAIC_PX; px += 1) {
      const dst = (startRow + py) * MOSAIC_WIDTH + (startCol + px);
      const v = pixels[py * TILE_MOSAIC_PX + px];
      // Only overwrite NO_DATA cells to avoid seam issues at tile boundaries
      if (mosaic[dst] === NO_DATA_VALUE) mosaic[dst] = v;
    }
  }
}

console.log(`[landcover-map] tiles: ${ok} ok, ${failed} failed`);

// Class-code palette. Every non-listed value is treated as no-data.
// PNG palette entries: [ [r, g, b], ... ], one per index 0..255.
// For legibility (and easy debug), give each class a distinctive colour.
const CLASS_COLORS = new Map([
  [0,   [0,   0,   0  ]],   // no data
  [10,  [0,   100, 0  ]],   // tree cover
  [20,  [255, 187, 34 ]],   // shrubland
  [30,  [255, 255, 76 ]],   // grassland
  [40,  [240, 150, 255]],   // cropland
  [50,  [250, 0,   0  ]],   // built-up
  [60,  [180, 180, 180]],   // bare / sparse
  [70,  [240, 240, 240]],   // snow and ice
  [80,  [0,   100, 200]],   // water
  [90,  [0,   150, 160]],   // wetland
  [95,  [0,   207, 117]],   // mangroves
  [100, [250, 230, 160]]    // moss and lichen
]);

const png = new PNG({
  width: MOSAIC_WIDTH,
  height: MOSAIC_HEIGHT,
  colorType: 6 // RGBA
});

for (let i = 0; i < mosaic.length; i += 1) {
  const v = mosaic[i];
  const rgb = CLASS_COLORS.get(v) ?? CLASS_COLORS.get(0);
  const off = i * 4;
  png.data[off + 0] = rgb[0];
  png.data[off + 1] = rgb[1];
  png.data[off + 2] = rgb[2];
  png.data[off + 3] = v === NO_DATA_VALUE ? 0 : 255;
}

const outDir = path.join(projectRoot, 'public');
await fs.mkdir(outDir, { recursive: true });
const outPngPath = path.join(outDir, 'landcover-coarse.png');
const outMetaPath = path.join(outDir, 'landcover-coarse.json');
await new Promise((resolve, reject) => {
  const stream = png.pack();
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  stream.on('end', async () => {
    await fs.writeFile(outPngPath, Buffer.concat(chunks));
    resolve();
  });
  stream.on('error', reject);
});

// Palette / metadata sidecar consumed by src/lib/landCoverSource.js
const meta = {
  source: 'ESA WorldCover 2021 v200',
  attribution: 'ESA / Zanaga et al., CC BY 4.0',
  builtAt: new Date().toISOString(),
  mosaic: {
    width: MOSAIC_WIDTH,
    height: MOSAIC_HEIGHT,
    resolutionMetersApprox: 40075016 / MOSAIC_WIDTH, // equatorial circumference
    projection: 'equirectangular',
    latitudeRange: [-90, 90],
    longitudeRange: [-180, 180]
  },
  paletteByRgb: Object.fromEntries(
    [...CLASS_COLORS.entries()].map(([code, [r, g, b]]) => [`${r},${g},${b}`, code])
  ),
  classes: {
    0:   { code: 0,   name: 'No data',            burnable: false },
    10:  { code: 10,  name: 'Tree cover',         burnable: true  },
    20:  { code: 20,  name: 'Shrubland',          burnable: true  },
    30:  { code: 30,  name: 'Grassland',          burnable: true  },
    40:  { code: 40,  name: 'Cropland',           burnable: true  },
    50:  { code: 50,  name: 'Built-up',           burnable: false },
    60:  { code: 60,  name: 'Bare / sparse',      burnable: true  },
    70:  { code: 70,  name: 'Snow and ice',       burnable: false },
    80:  { code: 80,  name: 'Permanent water',    burnable: false },
    90:  { code: 90,  name: 'Herbaceous wetland', burnable: true  },
    95:  { code: 95,  name: 'Mangroves',          burnable: true  },
    100: { code: 100, name: 'Moss and lichen',    burnable: true  }
  },
  tileCounts: { ok, failed, requested: tileIds.length }
};
await fs.writeFile(outMetaPath, JSON.stringify(meta, null, 2));

const wallSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n[landcover-map] wrote ${outPngPath}`);
console.log(`[landcover-map] wrote ${outMetaPath}`);
console.log(`[landcover-map] total wall time: ${wallSeconds}s`);
