// Freezes real terrain/weather/fuel fields for the hackathon benchmark cases
// so the benchmark stops using homogeneous flat/TU2/calm inputs, while
// staying offline-reproducible: this script is the only thing that touches
// the network, and its output is a committed JSON fixture (Phase 4.5).
//
// Reuses existing, already-tested fetchers verbatim -- no new fetch logic:
//   fetchHistoricalWeatherInputs (src/lib/historicalWeather.js)
//   readWorldCoverFineField    (scripts/read-worldcover-fine-field.mjs)
//   crosswalkLandCoverToFuel   (src/lib/landCoverToFuel.js)
//
// Terrain uses Copernicus DEM GLO-30, read directly as windowed COG tiles
// from the public, unauthenticated AWS bucket -- same windowed-GeoTIFF-read
// pattern as readWorldCoverFineField, just a different bucket/tile scheme.
// Chosen over Open-Meteo's elevation API (which itself just proxies
// Copernicus GLO-90, 3x coarser) because Open-Meteo's free tier hit a daily
// request quota; S3 static-object reads have no such quota.
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fromUrl, fromArrayBuffer } from 'geotiff';
import { createSpatialGrid } from '../src/lib/spatialGrid.js';
import { interpolateElevationGrid } from '../src/lib/elevationField.js';
import { fetchHistoricalWeatherInputs } from '../src/lib/historicalWeather.js';
import { crosswalkLandCoverToFuel } from '../src/lib/landCoverToFuel.js';
import { getFuelModel } from '../src/lib/fuelModels.js';
import {
  createLandfireFuelWcsRequest,
  normalizeLandfireFuelRaster
} from '../src/lib/landfireFuel.js';
import {
  LANDFIRE_CANOPY_COVERAGES,
  createLandfireWcsRequest,
  normalizeLandfireCanopyRaster,
  hasUsableCrownStructure
} from '../src/lib/landfireCanopy.js';
import { buildFuelModelCodeField } from '../src/lib/fireFieldInputs.js';
import { readWorldCoverFineField } from './read-worldcover-fine-field.mjs';
import { RESERVOIR_FIRE_2016, DEER_FIRE_2016 } from '../src/lib/historicalPerimeterFixtures.js';
import { OFFICIAL_BENCHMARK_FIXTURES } from '../src/lib/officialBenchmarkFixtures.js';

const execFileAsync = promisify(execFile);

const COPERNICUS_DEM_TILE_PIXELS = 3600;
const COPERNICUS_DEM_S3_BASE = 'https://copernicus-dem-30m.s3.amazonaws.com';
const COPERNICUS_DEM_SOURCE = 'Copernicus DEM GLO-30 (ESA, public AWS COG, 30m)';

function copernicusTileId(latitude, longitude) {
  const latSouth = Math.floor(latitude);
  const lonWest = Math.floor(longitude);
  const ns = latSouth >= 0 ? 'N' : 'S';
  const ew = lonWest >= 0 ? 'E' : 'W';
  return `${ns}${String(Math.abs(latSouth)).padStart(2, '0')}_00_${ew}${String(Math.abs(lonWest)).padStart(3, '0')}_00`;
}

function copernicusTileUrl(tileId) {
  return `${COPERNICUS_DEM_S3_BASE}/Copernicus_DSM_COG_10_${tileId}_DEM/Copernicus_DSM_COG_10_${tileId}_DEM.tif`;
}

function copernicusPixelCoordinates(latitude, longitude, tileId) {
  const match = /^([NS])(\d{2})_00_([EW])(\d{3})_00$/.exec(tileId);
  const latSouth = Number(match[2]) * (match[1] === 'N' ? 1 : -1);
  const lonWest = Number(match[4]) * (match[3] === 'E' ? 1 : -1);
  const x = Math.floor((longitude - lonWest) * COPERNICUS_DEM_TILE_PIXELS);
  const y = Math.floor((latSouth + 1 - latitude) * COPERNICUS_DEM_TILE_PIXELS);
  return {
    x: Math.min(Math.max(x, 0), COPERNICUS_DEM_TILE_PIXELS - 1),
    y: Math.min(Math.max(y, 0), COPERNICUS_DEM_TILE_PIXELS - 1)
  };
}

// Mirrors readWorldCoverFineField's tile-grouping + windowed-read shape,
// simplified for a single continuous elevation band instead of class codes.
async function readCopernicusElevationField({ latitude, longitude, sampleSize, spanKm, targetSize }) {
  const grid = createSpatialGrid({
    latitude,
    longitude,
    cellSizeMeters: (spanKm * 1000) / (sampleSize - 1),
    gridSize: sampleSize
  });
  const samples = [];
  for (let row = 0; row < sampleSize; row += 1) {
    for (let col = 0; col < sampleSize; col += 1) {
      const coordinate = grid.cellCenterLatLon(row, col);
      const tileId = copernicusTileId(coordinate.latitude, coordinate.longitude);
      const pixel = copernicusPixelCoordinates(coordinate.latitude, coordinate.longitude, tileId);
      samples.push({ index: samples.length, tileId, pixel });
    }
  }
  const tileGroups = new Map();
  for (const sample of samples) {
    const group = tileGroups.get(sample.tileId)
      ?? { samples: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    group.samples.push(sample);
    group.minX = Math.min(group.minX, sample.pixel.x);
    group.minY = Math.min(group.minY, sample.pixel.y);
    group.maxX = Math.max(group.maxX, sample.pixel.x);
    group.maxY = Math.max(group.maxY, sample.pixel.y);
    tileGroups.set(sample.tileId, group);
  }
  const rawHeights = new Array(samples.length);
  for (const [tileId, group] of tileGroups) {
    const tiff = await fromUrl(copernicusTileUrl(tileId));
    const image = await tiff.getImage(0);
    const width = group.maxX - group.minX + 1;
    const height = group.maxY - group.minY + 1;
    const [raster] = await image.readRasters({
      window: [group.minX, group.minY, group.maxX + 1, group.maxY + 1],
      width,
      height
    });
    for (const sample of group.samples) {
      const offset = (sample.pixel.y - group.minY) * width + (sample.pixel.x - group.minX);
      rawHeights[sample.index] = Number(raster[offset]);
    }
  }
  return {
    heights: interpolateElevationGrid(rawHeights, sampleSize, targetSize),
    sampleSize,
    source: COPERNICUS_DEM_SOURCE,
    fetchedAt: Date.now()
  };
}

const CASES = [
  { id: 'reservoir-2016', center: { latitude: 39.152745, longitude: -122.571182 }, size: 128, cellSizeMeters: 100, startDate: RESERVOIR_FIRE_2016.alarmDate, endDate: RESERVOIR_FIRE_2016.containmentDate },
  { id: 'deer-2016', center: DEER_FIRE_2016.ignition, size: 128, cellSizeMeters: 100, startDate: DEER_FIRE_2016.alarmDate, endDate: DEER_FIRE_2016.containmentDate },
  ...OFFICIAL_BENCHMARK_FIXTURES.map((fixture) => ({
    id: fixture.id,
    center: fixture.center,
    size: fixture.size,
    cellSizeMeters: fixture.cellSizeMeters,
    startDate: fixture.alarmDate,
    endDate: fixture.containmentDate
  }))
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Each field comes from a different host (Copernicus DEM COG tiles,
// WorldCover COG tiles, Open-Meteo historical archive). One field failing
// must not discard fields that succeeded -- each reports its own
// availability rather than failing the whole case.
async function tryField(fn) {
  try {
    return { available: true, value: await fn() };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

const LANDFIRE_CANOPY_MAX_ATTEMPTS = 5;
const LANDFIRE_CANOPY_RETRY_BASE_MS = 2000;
const LANDFIRE_CANOPY_REQUEST_SPACING_MS = 1500;

// Crown-fire structure (canopy base height + bulk density) exists only in
// LANDFIRE for CONUS -- no global product supplies it, and the physics in
// crownFire.js deliberately refuses to run without both. Requested at the
// fire grid's own extent and resolution so WCS pixel (row, col) maps
// directly onto model cell (row, col); row 0 is north in both.
async function landfireGridBbox(grid, size, cellSizeMeters) {
  const northWest = grid.cellCenterLatLon(0, 0);
  const southEast = grid.cellCenterLatLon(size - 1, size - 1);
  const halfLat = (cellSizeMeters / 2) / 111_320;
  const halfLon = (cellSizeMeters / 2) / grid.metersPerDegreeLongitude;
  return [
    northWest.longitude - halfLon,
    southEast.latitude - halfLat,
    southEast.longitude + halfLon,
    northWest.latitude + halfLat
  ];
}

async function curlGeoTiff(url, label, size) {
  let lastError = null;
  for (let attempt = 0; attempt < LANDFIRE_CANOPY_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(LANDFIRE_CANOPY_RETRY_BASE_MS * 2 ** (attempt - 1));
    try {
      const { stdout } = await execFileAsync(
        'curl',
        ['-sS', '--fail', '--max-time', '90', '-H', 'Connection: close', '-o', '-', url],
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }
      );
      if (stdout.length < 512) throw new Error(`${label} returned ${stdout.length} bytes`);
      const buffer = stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength);
      const image = await (await fromArrayBuffer(buffer)).getImage();
      if (image.getWidth() !== size || image.getHeight() !== size) {
        throw new Error(`${label} returned ${image.getWidth()}x${image.getHeight()}, expected ${size}x${size}`);
      }
      await sleep(LANDFIRE_CANOPY_REQUEST_SPACING_MS);
      return (await image.readRasters())[0];
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${label}: ${lastError?.message ?? 'failed'}`);
}

// Real measured FBFM40 fuel models replace the WorldCover land-cover guess.
// This matters far more than it looks: WorldCover class 10 "tree cover" maps
// to TL1 (low-load compact litter), which tops out near 145 kW/m fireline
// intensity even at 60 km/h wind -- below the ~168-5300 kW/m needed to
// initiate crown fire at real LANDFIRE canopy base heights. A landscape
// classified entirely as TL1 therefore structurally locks out crown fire,
// while the real FBFM40 map assigns timber-understory and shrub models
// (TU5/SH7, thousands of kW/m) where they actually occur.
async function readLandfireFuelField({ grid, size, cellSizeMeters }) {
  const bbox = await landfireGridBbox(grid, size, cellSizeMeters);
  const request = createLandfireFuelWcsRequest({ bbox, width: size, height: size });
  const raster = await curlGeoTiff(request.url, 'LANDFIRE FBFM40', size);
  const codes = normalizeLandfireFuelRaster(raster);
  return { bbox, fbfm40Codes: codes, validCellCount: codes.filter((c) => c !== null).length };
}

async function readLandfireCanopyFields({ grid, size, cellSizeMeters }) {
  const northWest = grid.cellCenterLatLon(0, 0);
  const southEast = grid.cellCenterLatLon(size - 1, size - 1);
  const halfLat = (cellSizeMeters / 2) / 111_320;
  const halfLon = (cellSizeMeters / 2) / grid.metersPerDegreeLongitude;
  const bbox = [
    northWest.longitude - halfLon,
    southEast.latitude - halfLat,
    southEast.longitude + halfLon,
    northWest.latitude + halfLat
  ];
  const fields = {};
  for (const [kind, coverage] of Object.entries(LANDFIRE_CANOPY_COVERAGES)) {
    const request = createLandfireWcsRequest({ bbox, width: size, height: size, coverage });
    // The public USGS GeoServer WCS is genuinely intermittent (observed 500s
    // and connection-level failures on requests that succeed unchanged on
    // retry), so pace and retry rather than treating a flaky transport as
    // "canopy data unavailable".
    // Fetched via curl rather than global fetch: undici's keep-alive
    // connection pool is rejected by this USGS endpoint (HTTP 500 HTML error
    // pages, then UND_ERR_SOCKET "other side closed"), while identical
    // one-connection-per-request curl calls to the byte-identical URL
    // succeed every time. This is a one-time offline freeze script, so
    // shelling out to a proven-working client is preferable to fighting the
    // pool; nothing in the shipped app path changes.
    let buffer = null;
    let lastError = null;
    for (let attempt = 0; attempt < LANDFIRE_CANOPY_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(LANDFIRE_CANOPY_RETRY_BASE_MS * 2 ** (attempt - 1));
      try {
        const { stdout } = await execFileAsync(
          'curl',
          ['-sS', '--fail', '--max-time', '90', '-H', 'Connection: close', '-o', '-', request.url],
          { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }
        );
        if (stdout.length < 512) throw new Error(`LANDFIRE ${coverage} returned ${stdout.length} bytes`);
        buffer = stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!buffer) throw new Error(`LANDFIRE ${coverage}: ${lastError?.message ?? 'failed'}`);
    await sleep(LANDFIRE_CANOPY_REQUEST_SPACING_MS);
    const image = await (await fromArrayBuffer(buffer)).getImage();
    if (image.getWidth() !== size || image.getHeight() !== size) {
      throw new Error(`LANDFIRE ${coverage} returned ${image.getWidth()}x${image.getHeight()}, expected ${size}x${size}`);
    }
    const [raster] = await image.readRasters();
    fields[kind] = normalizeLandfireCanopyRaster(raster, kind);
  }
  const crownCells = fields.canopyBaseHeight.reduce((total, baseHeight, index) => (
    total + (hasUsableCrownStructure({
      canopyBaseHeightMeters: baseHeight,
      canopyBulkDensityKgPerM3: fields.canopyBulkDensity[index]
    }) ? 1 : 0)
  ), 0);
  return { ...fields, bbox, crownCapableCellCount: crownCells };
}

// Bridges only a routine diurnal moisture excursion (measured from this
// case's own archived weather, not guessed), never a genuine multi-day wet
// spell -- runs longer than the ceiling are excluded from the max so a real
// rain event still extinguishes spread as intended.
const DIURNAL_PERSISTENCE_SAFETY_MARGIN_MINUTES = 60;
const DIURNAL_PERSISTENCE_CEILING_MINUTES = 12 * 60;

function longestSubCeilingRunMinutes(windTimeline, moistureOfExtinctionFraction) {
  let longestRun = 0;
  let runStartMinutes = null;
  for (const entry of windTimeline) {
    const moisture = entry.deadMoistureByClass?.['1h'];
    const aboveExtinction = Number.isFinite(moisture) && moisture > moistureOfExtinctionFraction;
    if (!aboveExtinction) {
      runStartMinutes = null;
      continue;
    }
    runStartMinutes ??= entry.minutesFromIgnition;
    const runLength = entry.minutesFromIgnition - runStartMinutes;
    if (runLength <= DIURNAL_PERSISTENCE_CEILING_MINUTES && runLength > longestRun) {
      longestRun = runLength;
    }
  }
  return longestRun;
}

// Replaces the flat, guessed persistence floor with one measured against
// this case's own archived diurnal moisture cycle per fuel model present,
// so an actively-spreading edge survives the routine nightly humidity dip
// that would otherwise permanently kill it (see docs/regional-model-run/
// THREAD.md, oregon-gulch-2014 root cause) without inventing a single
// number applied everywhere regardless of what the real weather did.
function applyDataDrivenPersistence(fuel, weather) {
  if (!fuel.available || !weather.available) return fuel;
  const minutesByCode = new Map();
  for (const code of new Set(fuel.fuelModelCodes)) {
    const model = getFuelModel(code);
    if (!model?.burnable) continue;
    const longestRun = longestSubCeilingRunMinutes(weather.windTimeline, model.moistureOfExtinctionFraction);
    minutesByCode.set(code, longestRun > 0
      ? Math.min(DIURNAL_PERSISTENCE_CEILING_MINUTES, longestRun + DIURNAL_PERSISTENCE_SAFETY_MARGIN_MINUTES)
      : 0);
  }
  return {
    ...fuel,
    fuelPersistenceMinutesByCell: fuel.fuelModelCodes.map((code, index) => Math.max(
      fuel.fuelPersistenceMinutesByCell[index] ?? 0,
      minutesByCode.get(code) ?? 0
    )),
    persistenceMinutesByFuelCode: Object.fromEntries(minutesByCode)
  };
}

async function buildCaseFields(caseDef) {
  const grid = createSpatialGrid({ ...caseDef.center, cellSizeMeters: caseDef.cellSizeMeters, gridSize: caseDef.size });
  const spanKm = (caseDef.size * caseDef.cellSizeMeters) / 1000;

  const elevationResult = await tryField(() => readCopernicusElevationField({
    ...caseDef.center,
    // GLO-30 is 30m native resolution; a 12.8-32km span has 400-1000+ native
    // pixels across, far more than the 128-cell grid needs, so sample at the
    // grid's own resolution instead of a sparse 16x16 grid blurred up by
    // interpolation. interpolateElevationGrid is then an identity pass
    // (sampleSize === targetSize).
    sampleSize: caseDef.size,
    spanKm,
    targetSize: caseDef.size
  }));

  // Real FBFM40 is fetched independently of WorldCover so a LANDFIRE
  // transport failure degrades to the global crosswalk rather than
  // discarding fuel entirely.
  const landfireFuelResult = await tryField(() => readLandfireFuelField({
    grid,
    size: caseDef.size,
    cellSizeMeters: caseDef.cellSizeMeters
  }));

  const fuelResult = await tryField(async () => {
    const fineField = await readWorldCoverFineField({ grid });
    const fbfm40 = landfireFuelResult.available ? landfireFuelResult.value.fbfm40Codes : null;
    const fuelField = buildFuelModelCodeField({
      grid,
      // crosswalkLandCoverToFuel already prefers a direct landfireFuelModelCode
      // over every coarse/global approximation, and keeps WorldCover's
      // explicit water/built-up/snow/no-data classes authoritative.
      classifyAtCell: (row, col) => {
        const index = row * caseDef.size + col;
        const classification = fineField.classifications[index];
        const landfireCode = fbfm40?.[index] ?? null;
        return landfireCode === null ? classification : { ...classification, landfireFuelModelCode: landfireCode };
      },
      crosswalk: crosswalkLandCoverToFuel,
      allowExperimental: true
    });
    return { fineField, fuelField };
  });

  const canopyResult = await tryField(() => readLandfireCanopyFields({
    grid,
    size: caseDef.size,
    cellSizeMeters: caseDef.cellSizeMeters
  }));

  const weatherResult = await tryField(() => fetchHistoricalWeatherInputs({
    ...caseDef.center,
    startDate: caseDef.startDate,
    endDate: caseDef.endDate,
    ignitionTime: caseDef.startDate
  }));

  const terrain = elevationResult.available
    ? {
      available: true,
      source: elevationResult.value.source,
      resolutionApprox: elevationResult.value.sampleSize === caseDef.size
        ? `${spanKm.toFixed(2)} km span / one 30m Copernicus GLO-30 sample per grid cell (${caseDef.size}x${caseDef.size}) -- point-sampled per cell center, not pixel-averaged; still approximate registration to the fire grid`
        : `${spanKm.toFixed(2)} km span / ${elevationResult.value.sampleSize}x${elevationResult.value.sampleSize} samples, interpolated to ${caseDef.size}x${caseDef.size} -- approximate registration, not pixel-exact to the fire grid`,
      heights: Array.from(elevationResult.value.heights),
      heightsSha256: sha256(Buffer.from(Float32Array.from(elevationResult.value.heights).buffer))
    }
    : { available: false, reason: elevationResult.reason };

  const fuel = fuelResult.available
    ? {
      available: true,
      source: fuelResult.value.fineField.source,
      resolutionMeters: fuelResult.value.fineField.resolutionMeters,
      fuelModelCodes: fuelResult.value.fuelField.fuelModelCodes,
      fuelLoadScaleByCell: Array.from(fuelResult.value.fuelField.fuelLoadScaleByCell),
      fuelPersistenceMinutesByCell: Array.from(fuelResult.value.fuelField.fuelPersistenceMinutesByCell),
      landfireFbfm40Available: landfireFuelResult.available,
      landfireFbfm40ValidCells: landfireFuelResult.available ? landfireFuelResult.value.validCellCount : 0,
      landfireFbfm40Reason: landfireFuelResult.available ? null : landfireFuelResult.reason,
      regionalFuelCellCount: fuelResult.value.fuelField.summary.regionalFuelCellCount,
      globalFuelbedCellCount: fuelResult.value.fuelField.summary.globalFuelbedCellCount,
      tileSummaries: fuelResult.value.fineField.tileSummaries
    }
    : { available: false, reason: fuelResult.reason };

  const weather = weatherResult.available
    ? {
      available: true,
      source: weatherResult.value.source,
      attribution: weatherResult.value.attribution,
      requestUrl: weatherResult.value.requestUrl,
      archiveWindow: weatherResult.value.archiveWindow,
      windTimeline: weatherResult.value.windTimeline,
      fuelMoisture: weatherResult.value.fuelMoisture
    }
    : { available: false, reason: weatherResult.reason };

  const canopy = canopyResult.available
    ? {
      available: true,
      source: 'LANDFIRE 2024 CONUS - WCS (CH/CC/CBH/CBD)',
      bbox: canopyResult.value.bbox,
      crownCapableCellCount: canopyResult.value.crownCapableCellCount,
      canopyHeightByCell: canopyResult.value.canopyHeight,
      canopyCoverFractionByCell: canopyResult.value.canopyCover,
      canopyBaseHeightByCell: canopyResult.value.canopyBaseHeight,
      canopyBulkDensityByCell: canopyResult.value.canopyBulkDensity
    }
    : { available: false, reason: canopyResult.reason };

  return {
    id: caseDef.id,
    generatedAt: new Date().toISOString(),
    terrain,
    fuel: applyDataDrivenPersistence(fuel, weather),
    weather,
    canopy
  };
}

// --only id1,id2 restricts which cases are (re)built this run. Omitted, the
// script behaves exactly as before (builds every case, full overwrite) --
// this flag exists so new benchmark cases can be added without re-fetching
// (and risking non-identical re-fetches for) the existing frozen cases,
// since RUN history depends on those staying byte-identical.
const onlyArgIndex = process.argv.indexOf('--only');
const onlyIds = onlyArgIndex >= 0 ? process.argv[onlyArgIndex + 1].split(',') : null;
const selectedCases = onlyIds ? CASES.filter((c) => onlyIds.includes(c.id)) : CASES;

async function main() {
  const results = [];
  for (const caseDef of selectedCases) {
    process.stderr.write(`building fields for ${caseDef.id}...\n`);
    const fields = await buildCaseFields(caseDef);
    results.push(fields);
    process.stderr.write(`  terrain=${fields.terrain.available} fuel=${fields.fuel.available} weather=${fields.weather.available} fbfm40=${fields.fuel.landfireFbfm40Available ?? false} canopy=${fields.canopy.available}${fields.canopy.available ? ` (crownCells=${fields.canopy.crownCapableCellCount})` : ` (${fields.canopy.reason})`}\n`);
    await sleep(3000);
  }
  const outPath = new URL('../src/lib/regionalBenchmarkFields.generated.json', import.meta.url);
  let finalResults = results;
  if (onlyIds) {
    // Merge into the existing frozen file rather than overwrite it: keep
    // every case not in --only byte-identical, replace/add only the
    // requested ones.
    const existing = JSON.parse(readFileSync(outPath, 'utf8'));
    const keep = existing.filter((entry) => !onlyIds.includes(entry.id));
    finalResults = [...keep, ...results];
  }
  writeFileSync(outPath, JSON.stringify(finalResults, null, 2));
  const fullyAvailable = finalResults.filter((r) => r.terrain.available && r.fuel.available && r.weather.available).length;
  process.stderr.write(`wrote ${finalResults.length} case field records (${fullyAvailable} with all 3 fields real) to ${outPath.pathname}\n`);
}

main();
