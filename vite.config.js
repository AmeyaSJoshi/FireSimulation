import { defineConfig } from 'vite';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fromArrayBuffer, fromFile, fromUrl } from 'geotiff';
import {
  WORLD_COVER_FINE_SOURCE,
  WORLD_COVER_FINE_TILE_PIXELS,
  classifyWorldCoverFineCode,
  worldCoverPixelCoordinates,
  worldCoverTileId,
  worldCoverTileUrl
} from './src/lib/worldCoverFine.js';
import {
  COPERNICUS_LAND_COVER_SOURCE,
  COPERNICUS_PROCESS_URL,
  COPERNICUS_TOKEN_URL,
  createCopernicusLandCoverRequest,
  createPointBbox,
  parseCopernicusLandCoverResponse
} from './src/lib/copernicusLandCover.js';
import {
  CANOPY_HEIGHT_RESOLUTION_METERS,
  CANOPY_HEIGHT_SOURCE,
  canopyHeightPixelCoordinates,
  canopyHeightTileId,
  canopyHeightTileUrl
} from './src/lib/canopyHeight.js';
import {
  LANDFIRE_CANOPY_COVERAGES,
  LANDFIRE_CANOPY_SOURCE,
  createLandfireWcsRequest,
  hasUsableCanopyWindStructure,
  hasUsableCrownStructure,
  isWithinLandfireCanopyCoverage,
  normalizeLandfireCanopyRaster
} from './src/lib/landfireCanopy.js';
import {
  LANDFIRE_FUEL_COVERAGE,
  LANDFIRE_FUEL_MIN_VALID_FRACTION,
  LANDFIRE_FUEL_RESOLUTION_METERS,
  LANDFIRE_FUEL_SOURCE,
  createLandfireFuelWcsRequest,
  isWithinLandfireFuelCoverage,
  summarizeLandfireFuelRaster,
  validateLandfireFuelRasterGeometry
} from './src/lib/landfireFuel.js';
import {
  GLOBAL_FUELBED_NODATA,
  GLOBAL_FUELBED_SOURCE,
  globalFuelbedParameterKeys,
  globalFuelbedPixelCoordinates,
  globalFuelbedTileForLocation,
  globalFuelbedTileUrl
} from './src/lib/globalFuelbed.js';
import { rasterSampleValue } from './src/lib/rasterSampling.js';

const MAX_FINE_SAMPLES = 65536;
const MAX_CACHED_TILES = 4;
const MAX_LANDFIRE_FIELD_DIMENSION = 128;
const MAX_LANDFIRE_FIELD_CACHE_ENTRIES = 8;
const MAX_GLOBAL_FUELBED_SAMPLES = 16384;
const GLOBAL_FUELBED_CACHE_DIR = path.join(os.tmpdir(), 'ignis-global-fuelbeds');
const execFileAsync = promisify(execFile);

function writeJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function parseCoordinate(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseSample(sample) {
  return {
    latitude: parseCoordinate(sample?.latitude, 'latitude', -90, 90),
    longitude: parseCoordinate(sample?.longitude, 'longitude', -180, 180)
  };
}

async function fetchLandfireWcsBytes(url) {
  let response = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(url, { headers: { Accept: 'image/tiff' } });
      if (response.ok) return await response.arrayBuffer();
      lastError = new Error(`LANDFIRE WCS request failed with HTTP ${response.status}`);
      await response.arrayBuffer().catch(() => {});
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
  }

  // The public GeoServer occasionally rejects Node/undici TLS sessions while
  // accepting the same bounded request from curl. Use argv-based execution so
  // the URL is never interpolated into a shell command, and keep the fallback
  // limited to this server-side raster adapter.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { stdout } = await execFileAsync('curl', [
        '-L',
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '30',
        '-H',
        'Accept: image/tiff',
        url
      ], {
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024
      });
      return stdout;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  const detail = lastError?.stderr?.toString?.().trim();
  throw lastError ?? new Error(detail || 'LANDFIRE WCS request failed');
}

async function fetchRemoteBytes(url) {
  let lastError = null;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/zip, application/octet-stream' } });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    lastError = new Error(`global fuelbed request failed with HTTP ${response.status}`);
    await response.arrayBuffer().catch(() => {});
  } catch (error) {
    lastError = error;
  }
  try {
    const { stdout } = await execFileAsync('curl', [
      '-L', '--fail', '--silent', '--show-error', '--max-time', '90', url
    ], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    throw error ?? lastError ?? new Error('global fuelbed download failed');
  }
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function worldCoverFinePlugin() {
  const tileCache = new Map();
  const canopyTileCache = new Map();
  const landfireFieldCache = new Map();
  const landfireFuelGeometryCache = new Map();
  const globalFuelbedTileCache = new Map();
  let globalFuelbedParametersPromise = null;
  let accessToken = null;
  let accessTokenExpiresAt = 0;

  async function getCopernicusAccessToken() {
    const clientId = process.env.COPERNICUS_CLIENT_ID;
    const clientSecret = process.env.COPERNICUS_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
    const response = await fetch(COPERNICUS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      })
    });
    if (!response.ok) {
      throw new Error('Copernicus token request failed with HTTP ' + response.status);
    }
    const payload = await response.json();
    if (!payload.access_token) throw new Error('Copernicus token response had no access_token');
    accessToken = payload.access_token;
    accessTokenExpiresAt = Date.now() + Math.max(30, Number(payload.expires_in ?? 300) - 30) * 1000;
    return accessToken;
  }

  async function readCopernicusFractions({ bbox, width = 1, height = 1 }) {
    const token = await getCopernicusAccessToken();
    if (!token) return null;
    const request = createCopernicusLandCoverRequest({
      bbox,
      width,
      height,
      processUrl: process.env.COPERNICUS_PROCESS_URL || COPERNICUS_PROCESS_URL
    });
    const response = await fetch(request.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request.body)
    });
    if (!response.ok) {
      throw new Error('Copernicus land-cover request failed with HTTP ' + response.status);
    }
    return parseCopernicusLandCoverResponse(await response.json(), { width, height });
  }

  async function getTile(tileId) {
    if (tileCache.has(tileId)) {
      const cached = tileCache.get(tileId);
      tileCache.delete(tileId);
      tileCache.set(tileId, cached);
      return cached;
    }
    const tiff = await fromUrl(worldCoverTileUrl(tileId));
    const image = await tiff.getImage(0);
    const tile = { image };
    tileCache.set(tileId, tile);
    while (tileCache.size > MAX_CACHED_TILES) {
      tileCache.delete(tileCache.keys().next().value);
    }
    return tile;
  }

  async function getCanopyHeightTile(tileId) {
    if (canopyTileCache.has(tileId)) {
      const cached = canopyTileCache.get(tileId);
      canopyTileCache.delete(tileId);
      canopyTileCache.set(tileId, cached);
      return cached;
    }
    const tiff = await fromUrl(canopyHeightTileUrl(tileId));
    const image = await tiff.getImage(0);
    const tile = { image };
    canopyTileCache.set(tileId, tile);
    while (canopyTileCache.size > MAX_CACHED_TILES) {
      canopyTileCache.delete(canopyTileCache.keys().next().value);
    }
    return tile;
  }

  async function getGlobalFuelbedParameters() {
    if (!globalFuelbedParametersPromise) {
      globalFuelbedParametersPromise = readFile(
        path.resolve('public/global-fuelbed-parameters.json'),
        'utf8'
      ).then((text) => {
        const payload = JSON.parse(text);
        const byKey = new Map();
        for (const row of payload.rows ?? []) {
          for (const key of globalFuelbedParameterKeys(row)) byKey.set(key, row);
        }
        return byKey;
      });
    }
    return globalFuelbedParametersPromise;
  }

  async function getGlobalFuelbedTile(tileId) {
    if (globalFuelbedTileCache.has(tileId)) {
      const cached = globalFuelbedTileCache.get(tileId);
      globalFuelbedTileCache.delete(tileId);
      globalFuelbedTileCache.set(tileId, cached);
      return cached;
    }
    const tileDirectory = path.join(GLOBAL_FUELBED_CACHE_DIR, `tile-${tileId}`);
    const tifPath = path.join(tileDirectory, `Global_fuelbeds_map_Tile${tileId}.tif`);
    await mkdir(tileDirectory, { recursive: true });
    if (!await fileExists(tifPath)) {
      const zipPath = path.join(tileDirectory, `Global_fuelbeds_map_Tile${tileId}.zip`);
      if (!await fileExists(zipPath)) {
        await writeFile(zipPath, await fetchRemoteBytes(globalFuelbedTileUrl(tileId)));
      }
      await execFileAsync('unzip', ['-oq', zipPath, '-d', tileDirectory], {
        maxBuffer: 2 * 1024 * 1024
      });
    }
    if (!await fileExists(tifPath)) {
      throw new Error(`global fuelbed tile ${tileId} did not contain the expected GeoTIFF`);
    }
    const image = await (await fromFile(tifPath)).getImage(0);
    const tile = { image, width: image.getWidth(), height: image.getHeight() };
    globalFuelbedTileCache.set(tileId, tile);
    while (globalFuelbedTileCache.size > MAX_CACHED_TILES) {
      globalFuelbedTileCache.delete(globalFuelbedTileCache.keys().next().value);
    }
    return tile;
  }

  async function readGlobalFuelbedSamples(samples) {
    const parameterByKey = await getGlobalFuelbedParameters();
    const groups = new Map();
    const fuelbeds = new Array(samples.length).fill(null);
    for (const [index, sample] of samples.entries()) {
      const tile = globalFuelbedTileForLocation(sample.latitude, sample.longitude);
      if (!tile) continue;
      const pixel = globalFuelbedPixelCoordinates(sample.latitude, sample.longitude, tile);
      const group = groups.get(tile.id) ?? {
        samples: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity
      };
      group.samples.push({ index, pixel });
      group.minX = Math.min(group.minX, pixel.x);
      group.minY = Math.min(group.minY, pixel.y);
      group.maxX = Math.max(group.maxX, pixel.x);
      group.maxY = Math.max(group.maxY, pixel.y);
      groups.set(tile.id, group);
    }
    for (const [tileId, group] of groups) {
      const tile = await getGlobalFuelbedTile(tileId);
      const validSamples = group.samples.filter(({ pixel }) => (
        pixel.x >= 0 && pixel.y >= 0 && pixel.x < tile.width && pixel.y < tile.height
      ));
      if (validSamples.length === 0) continue;
      const minX = Math.max(0, Math.min(...validSamples.map(({ pixel }) => pixel.x)));
      const minY = Math.max(0, Math.min(...validSamples.map(({ pixel }) => pixel.y)));
      const maxX = Math.min(tile.width - 1, Math.max(...validSamples.map(({ pixel }) => pixel.x)));
      const maxY = Math.min(tile.height - 1, Math.max(...validSamples.map(({ pixel }) => pixel.y)));
      const width = maxX - minX + 1;
      const raster = await tile.image.readRasters({
        window: [minX, minY, maxX + 1, maxY + 1],
        width,
        height: maxY - minY + 1
      });
      for (const { index, pixel } of validSamples) {
        const value = rasterSampleValue(
          raster,
          (pixel.y - minY) * width + pixel.x - minX
        );
        if (!Number.isFinite(value) || value <= 0 || value === GLOBAL_FUELBED_NODATA) continue;
        const raw = parameterByKey.get(String(value));
        if (raw) fuelbeds[index] = raw;
      }
    }
    return fuelbeds;
  }

  async function readSamples(samples) {
    const groups = new Map();
    samples.forEach((sample, index) => {
      const tileId = worldCoverTileId(sample.latitude, sample.longitude);
      const pixel = worldCoverPixelCoordinates(sample.latitude, sample.longitude, tileId);
      const group = groups.get(tileId) ?? { samples: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      group.samples.push({ index, pixel });
      group.minX = Math.min(group.minX, pixel.x);
      group.minY = Math.min(group.minY, pixel.y);
      group.maxX = Math.max(group.maxX, pixel.x);
      group.maxY = Math.max(group.maxY, pixel.y);
      groups.set(tileId, group);
    });

    const classCodes = new Array(samples.length).fill(0);
    for (const [tileId, group] of groups) {
      const { image } = await getTile(tileId);
      const width = group.maxX - group.minX + 1;
      const height = group.maxY - group.minY + 1;
      const [raster] = await image.readRasters({
        window: [group.minX, group.minY, group.maxX + 1, group.maxY + 1],
        width,
        height
      });
      for (const { index, pixel } of group.samples) {
        classCodes[index] = Number(raster[(pixel.y - group.minY) * width + pixel.x - group.minX]);
      }
    }
    return classCodes;
  }

  async function readCanopyHeightSamples(samples) {
    const groups = new Map();
    samples.forEach((sample, index) => {
      const tileId = canopyHeightTileId(sample.latitude, sample.longitude);
      const pixel = canopyHeightPixelCoordinates(sample.latitude, sample.longitude, tileId);
      const group = groups.get(tileId) ?? { samples: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      group.samples.push({ index, pixel });
      group.minX = Math.min(group.minX, pixel.x);
      group.minY = Math.min(group.minY, pixel.y);
      group.maxX = Math.max(group.maxX, pixel.x);
      group.maxY = Math.max(group.maxY, pixel.y);
      groups.set(tileId, group);
    });

    const heights = new Array(samples.length).fill(null);
    for (const [tileId, group] of groups) {
      const { image } = await getCanopyHeightTile(tileId);
      const width = group.maxX - group.minX + 1;
      const height = group.maxY - group.minY + 1;
      const [raster] = await image.readRasters({
        window: [group.minX, group.minY, group.maxX + 1, group.maxY + 1],
        width,
        height
      });
      for (const { index, pixel } of group.samples) {
        const value = Number(raster[(pixel.y - group.minY) * width + pixel.x - group.minX]);
        heights[index] = Number.isFinite(value) && value >= 0 && value <= 120 ? value : null;
      }
    }
    return heights;
  }

  async function readLandfireCoverage({ bbox, width, height, coverage }) {
    const request = coverage === LANDFIRE_FUEL_COVERAGE
      ? createLandfireFuelWcsRequest({ bbox, width, height })
      : createLandfireWcsRequest({ bbox, width, height, coverage });
    const cacheKey = request.url;
    if (landfireFieldCache.has(cacheKey)) {
      const cached = landfireFieldCache.get(cacheKey);
      landfireFieldCache.delete(cacheKey);
      landfireFieldCache.set(cacheKey, cached);
      return coverage === LANDFIRE_FUEL_COVERAGE
        ? { values: cached, geometry: landfireFuelGeometryCache.get(cacheKey) ?? null }
        : cached;
    }
    const tiff = await fromArrayBuffer(await fetchLandfireWcsBytes(request.url));
    const image = await tiff.getImage(0);
    if (image.getWidth() !== width || image.getHeight() !== height) {
      throw new Error(`LANDFIRE WCS returned ${image.getWidth()}x${image.getHeight()}, expected ${width}x${height}`);
    }
    const raster = await image.readRasters({ interleave: true });
    if (coverage === LANDFIRE_FUEL_COVERAGE) {
      const geoKeys = typeof image.getGeoKeys === 'function' ? image.getGeoKeys() : null;
      const epsg = geoKeys?.GeographicTypeGeoKey ?? geoKeys?.ProjectedCSTypeGeoKey;
      const geometry = validateLandfireFuelRasterGeometry({
        bbox: request.bbox,
        width,
        height,
        imageBoundingBox: image.getBoundingBox(),
        imageResolution: image.getResolution(),
        coordinateReferenceSystem: epsg === 4326 ? 'EPSG:4326' : (epsg ? `EPSG:${epsg}` : null),
        pixelIsArea: image.pixelIsArea()
      });
      const { values } = summarizeLandfireFuelRaster(raster);
      landfireFieldCache.set(cacheKey, values);
      landfireFuelGeometryCache.set(cacheKey, geometry);
      while (landfireFieldCache.size > MAX_LANDFIRE_FIELD_CACHE_ENTRIES) {
        const oldestKey = landfireFieldCache.keys().next().value;
        landfireFieldCache.delete(oldestKey);
        landfireFuelGeometryCache.delete(oldestKey);
      }
      return { values, geometry };
    }
    const kindByCoverage = {
      [LANDFIRE_CANOPY_COVERAGES.canopyHeight]: 'canopyHeight',
      [LANDFIRE_CANOPY_COVERAGES.canopyCover]: 'canopyCover',
      [LANDFIRE_CANOPY_COVERAGES.canopyBaseHeight]: 'canopyBaseHeight',
      [LANDFIRE_CANOPY_COVERAGES.canopyBulkDensity]: 'canopyBulkDensity'
    };
    const kind = kindByCoverage[coverage];
    if (!kind) throw new Error(`unsupported LANDFIRE canopy coverage ${coverage}`);
    const values = normalizeLandfireCanopyRaster(raster, kind);
    landfireFieldCache.set(cacheKey, values);
    while (landfireFieldCache.size > MAX_LANDFIRE_FIELD_CACHE_ENTRIES) {
      landfireFieldCache.delete(landfireFieldCache.keys().next().value);
    }
    return values;
  }

  async function readRequestBody(request) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 8_000_000) throw new RangeError('request body is too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  return {
    name: 'worldcover-fine-range-reader',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? '/', 'http://localhost');
        const isFinePoint = requestUrl.pathname === '/api/landcover/fine';
        const isFineField = requestUrl.pathname === '/api/landcover/fine-field';
        const isCanopyPoint = requestUrl.pathname === '/api/canopy/height';
        const isCanopyField = requestUrl.pathname === '/api/canopy/height-field';
        const isLandfireCanopyField = requestUrl.pathname === '/api/canopy/landfire-field';
        const isLandfireFuelField = requestUrl.pathname === '/api/fuel/landfire-field';
        const isFractionPoint = requestUrl.pathname === '/api/landcover/fractions';
        const isFractionField = requestUrl.pathname === '/api/landcover/fractions-field';
        const isGlobalFuelbedField = requestUrl.pathname === '/api/fuelbed/global-field';
        if (!isFinePoint && !isFineField && !isCanopyPoint && !isCanopyField
          && !isLandfireCanopyField
          && !isLandfireFuelField
          && !isFractionPoint && !isFractionField && !isGlobalFuelbedField) {
          next();
          return;
        }
        if (request.method !== 'GET' && request.method !== 'POST') {
          writeJson(response, 405, { error: 'method not allowed' });
          return;
        }
        try {
          if (isGlobalFuelbedField) {
            const body = await readRequestBody(request);
            const samples = body?.samples;
            if (!Array.isArray(samples) || samples.length === 0 || samples.length > MAX_GLOBAL_FUELBED_SAMPLES) {
              throw new RangeError(`samples must contain 1-${MAX_GLOBAL_FUELBED_SAMPLES} points`);
            }
            const fuelbeds = await readGlobalFuelbedSamples(samples.map(parseSample));
            writeJson(response, 200, {
              available: true,
              source: GLOBAL_FUELBED_SOURCE,
              resolutionMeters: GLOBAL_FUELBED_SOURCE.resolutionMeters,
              fuelbeds
            });
            return;
          }
          if (isCanopyPoint || isCanopyField) {
            const samples = isCanopyField
              ? (await readRequestBody(request)).samples
              : [{
                latitude: requestUrl.searchParams.get('lat'),
                longitude: requestUrl.searchParams.get('lon')
              }];
            if (!Array.isArray(samples) || samples.length === 0 || samples.length > MAX_FINE_SAMPLES) {
              throw new RangeError(`samples must contain 1-${MAX_FINE_SAMPLES} points`);
            }
            const normalizedSamples = samples.map(parseSample);
            const heights = await readCanopyHeightSamples(normalizedSamples);
            writeJson(response, 200, {
              source: CANOPY_HEIGHT_SOURCE,
              resolutionMeters: CANOPY_HEIGHT_RESOLUTION_METERS,
              heights
            });
            return;
          }
          if (isLandfireCanopyField) {
            const body = await readRequestBody(request);
            const width = Number(body?.width);
            const height = Number(body?.height);
            if (!Number.isInteger(width) || !Number.isInteger(height)
              || width < 1 || height < 1
              || width > MAX_LANDFIRE_FIELD_DIMENSION
              || height > MAX_LANDFIRE_FIELD_DIMENSION) {
              throw new RangeError(`width and height must be integers in [1, ${MAX_LANDFIRE_FIELD_DIMENSION}]`);
            }
            const bbox = body?.bbox;
            if (!isWithinLandfireCanopyCoverage(bbox)) {
              writeJson(response, 200, {
                available: false,
                source: LANDFIRE_CANOPY_SOURCE,
                reason: 'outside_conus_coverage'
              });
              return;
            }
            const [canopyHeightMeters, canopyCoverFraction, canopyBaseHeightMeters, canopyBulkDensityKgPerM3] = await Promise.all([
              readLandfireCoverage({
                bbox,
                width,
                height,
                coverage: LANDFIRE_CANOPY_COVERAGES.canopyHeight
              }),
              readLandfireCoverage({
                bbox,
                width,
                height,
                coverage: LANDFIRE_CANOPY_COVERAGES.canopyCover
              }),
              readLandfireCoverage({
                bbox,
                width,
                height,
                coverage: LANDFIRE_CANOPY_COVERAGES.canopyBaseHeight
              }),
              readLandfireCoverage({
                bbox,
                width,
                height,
                coverage: LANDFIRE_CANOPY_COVERAGES.canopyBulkDensity
              })
            ]);
            let canopyWindStructureCellCount = 0;
            let crownStructureCellCount = 0;
            for (let index = 0; index < canopyBaseHeightMeters.length; index += 1) {
              if (hasUsableCanopyWindStructure({
                canopyHeightMeters: canopyHeightMeters[index],
                canopyCoverFraction: canopyCoverFraction[index]
              })) canopyWindStructureCellCount += 1;
              if (hasUsableCrownStructure({
                canopyBaseHeightMeters: canopyBaseHeightMeters[index],
                canopyBulkDensityKgPerM3: canopyBulkDensityKgPerM3[index]
              })) crownStructureCellCount += 1;
            }
            writeJson(response, 200, {
              available: true,
              source: LANDFIRE_CANOPY_SOURCE,
              width,
              height,
              canopyHeightMeters,
              canopyCoverFraction,
              canopyBaseHeightMeters,
              canopyBulkDensityKgPerM3,
              canopyWindStructureCellCount,
              crownStructureCellCount
            });
            return;
          }
          if (isLandfireFuelField) {
            const body = await readRequestBody(request);
            const width = Number(body?.width);
            const height = Number(body?.height);
            if (!Number.isInteger(width) || !Number.isInteger(height)
              || width < 1 || height < 1
              || width > MAX_LANDFIRE_FIELD_DIMENSION
              || height > MAX_LANDFIRE_FIELD_DIMENSION) {
              throw new RangeError(`width and height must be integers in [1, ${MAX_LANDFIRE_FIELD_DIMENSION}]`);
            }
            const bbox = body?.bbox;
            if (!isWithinLandfireFuelCoverage(bbox)) {
              writeJson(response, 200, {
                available: false,
                source: LANDFIRE_FUEL_SOURCE,
                resolutionMeters: LANDFIRE_FUEL_RESOLUTION_METERS,
                reason: 'outside_conus_coverage'
              });
              return;
            }
            const regionalField = await readLandfireCoverage({
              bbox,
              width,
              height,
              coverage: LANDFIRE_FUEL_COVERAGE
            });
            const fuelModelCodes = regionalField.values;
            const { validCellCount, validCellFraction, modelCounts } = summarizeLandfireFuelRaster(fuelModelCodes);
            const available = validCellFraction >= LANDFIRE_FUEL_MIN_VALID_FRACTION;
            writeJson(response, 200, {
              available,
              source: LANDFIRE_FUEL_SOURCE,
              resolutionMeters: LANDFIRE_FUEL_RESOLUTION_METERS,
              width,
              height,
              fuelModelCodes,
              validCellCount,
              validCellFraction,
              minimumValidCellFraction: LANDFIRE_FUEL_MIN_VALID_FRACTION,
              modelCounts,
              geometry: regionalField.geometry,
              ...(available ? {} : { reason: 'insufficient_valid_coverage' })
            });
            return;
          }
          if (isFractionPoint || isFractionField) {
            if (!process.env.COPERNICUS_CLIENT_ID || !process.env.COPERNICUS_CLIENT_SECRET) {
              writeJson(response, 503, {
                available: false,
                source: COPERNICUS_LAND_COVER_SOURCE,
                reason: 'credentials_missing'
              });
              return;
            }
            if (isFractionPoint) {
              const latitude = parseCoordinate(requestUrl.searchParams.get('lat'), 'latitude', -90, 90);
              const longitude = parseCoordinate(requestUrl.searchParams.get('lon'), 'longitude', -180, 180);
              const [sample] = await readCopernicusFractions({
                bbox: createPointBbox(latitude, longitude)
              });
              writeJson(response, 200, { available: true, ...sample });
              return;
            }
            const body = await readRequestBody(request);
            const width = Number(body?.width);
            const height = Number(body?.height);
            const samples = await readCopernicusFractions({
              bbox: body?.bbox,
              width,
              height
            });
            writeJson(response, 200, {
              available: true,
              source: COPERNICUS_LAND_COVER_SOURCE,
              resolutionMeters: 100,
              width,
              height,
              samples
            });
            return;
          }
          const samples = requestUrl.pathname.endsWith('fine-field')
            ? (await readRequestBody(request)).samples
            : [{
              latitude: requestUrl.searchParams.get('lat'),
              longitude: requestUrl.searchParams.get('lon')
            }];
          if (!Array.isArray(samples) || samples.length === 0 || samples.length > MAX_FINE_SAMPLES) {
            throw new RangeError(`samples must contain 1-${MAX_FINE_SAMPLES} points`);
          }
          const normalizedSamples = samples.map(parseSample);
          const classCodes = await readSamples(normalizedSamples);
          if (requestUrl.pathname.endsWith('fine-field')) {
            writeJson(response, 200, {
              source: WORLD_COVER_FINE_SOURCE,
              resolutionMeters: WORLD_COVER_FINE_TILE_PIXELS === 36_000 ? 10 : null,
              classCodes
            });
            return;
          }
          const classification = classifyWorldCoverFineCode(classCodes[0]);
          writeJson(response, 200, {
            ...classification,
            resolutionMeters: 10,
            tileId: worldCoverTileId(normalizedSamples[0].latitude, normalizedSamples[0].longitude)
          });
        } catch (error) {
          const status = error instanceof RangeError || error instanceof SyntaxError ? 400 : 502;
          writeJson(response, status, { error: error.message ?? String(error) });
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [worldCoverFinePlugin()],
  server: {
    host: '127.0.0.1'
  }
});
