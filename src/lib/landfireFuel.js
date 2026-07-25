// Contract helpers for LANDFIRE's 2024 CONUS Scott & Burgan FBFM40 raster.
// LANDFIRE publishes the standard model code as an integer product value;
// keep that encoding separate from the Rothermel parameter table so a bad or
// missing raster value cannot silently become a burnable default.

import { getFuelModel, NON_BURNABLE_FUEL_CODE } from './fuelModels.js';

export const LANDFIRE_FUEL_SOURCE = 'LANDFIRE 2024 FBFM40 · WCS';
export const LANDFIRE_FUEL_WCS_URL = 'https://edcintl.cr.usgs.gov/geoserver/landfire_wcs/conus_2024/wcs';
export const LANDFIRE_FUEL_COVERAGE = 'LF2024_FBFM40_CONUS';
export const LANDFIRE_FUEL_RESOLUTION_METERS = 30;
export const LANDFIRE_FUEL_NODATA = 0;
export const LANDFIRE_FUEL_MIN_VALID_FRACTION = 0.95;
// The FBFM40 product is a CONUS product. Keep its request envelope separate
// from the broader canopy-service envelope so a canopy bound cannot authorize
// a fuel request outside the actual regional fuel product.
export const LANDFIRE_FUEL_BOUNDS = Object.freeze({
  west: -124.848974,
  south: 24.396308,
  east: -66.885444,
  north: 49.384358
});

function finite(name, value) {
  if (!Number.isFinite(value)) throw new RangeError(`landfireFuel: ${name} must be finite`);
  return value;
}

function positiveInteger(name, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`landfireFuel: ${name} must be a positive integer`);
  }
  return value;
}

export function landfireFuelBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new TypeError('landfireFuel: bbox must be [west, south, east, north]');
  }
  const values = bbox.map((value, index) => finite(`bbox[${index}]`, Number(value)));
  const [west, south, east, north] = values;
  if (west >= east || south >= north || west < -180 || east > 180 || south < -90 || north > 90) {
    throw new RangeError('landfireFuel: bbox must be an ordered geographic extent');
  }
  return values;
}

export function isWithinLandfireFuelCoverage(bbox) {
  const [west, south, east, north] = landfireFuelBbox(bbox);
  return west >= LANDFIRE_FUEL_BOUNDS.west
    && south >= LANDFIRE_FUEL_BOUNDS.south
    && east <= LANDFIRE_FUEL_BOUNDS.east
    && north <= LANDFIRE_FUEL_BOUNDS.north;
}

export function createLandfireFuelWcsRequest({ bbox, width, height } = {}) {
  const normalizedBbox = landfireFuelBbox(bbox);
  const normalizedWidth = positiveInteger('width', Number(width));
  const normalizedHeight = positiveInteger('height', Number(height));
  if (!isWithinLandfireFuelCoverage(normalizedBbox)) {
    throw new RangeError('landfireFuel: bbox is outside LANDFIRE CONUS coverage');
  }
  const params = [
    'service=WCS',
    'version=1.0.0',
    'request=GetCoverage',
    `coverage=${LANDFIRE_FUEL_COVERAGE}`,
    'crs=EPSG:4326',
    `bbox=${normalizedBbox.join(',')}`,
    `width=${normalizedWidth}`,
    `height=${normalizedHeight}`,
    'format=GeoTIFF'
  ].join('&');
  return {
    url: `${LANDFIRE_FUEL_WCS_URL}?${params}`,
    bbox: normalizedBbox,
    width: normalizedWidth,
    height: normalizedHeight,
    coverage: LANDFIRE_FUEL_COVERAGE
  };
}

export function normalizeLandfireFuelValue(rawValue) {
  const raw = Number(rawValue);
  if (!Number.isFinite(raw) || raw === LANDFIRE_FUEL_NODATA) return null;
  const value = Math.trunc(raw);
  if (value === 91 || value === 92 || value === 93 || value === 98 || value === 99) return 'NB';
  if (value >= 101 && value <= 109) return `GR${value - 100}`;
  if (value >= 121 && value <= 124) return `GS${value - 120}`;
  if (value >= 141 && value <= 149) return `SH${value - 140}`;
  if (value >= 161 && value <= 165) return `TU${value - 160}`;
  if (value >= 181 && value <= 189) return `TL${value - 180}`;
  if (value >= 201 && value <= 204) return `SB${value - 200}`;
  return null;
}

export function normalizeLandfireFuelRaster(rawValues) {
  if (!rawValues || typeof rawValues.length !== 'number') {
    throw new TypeError('landfireFuel: raster values are required');
  }
  return Array.from(rawValues, normalizeLandfireFuelValue);
}

export function summarizeLandfireFuelRaster(rawValues) {
  if (!rawValues || typeof rawValues.length !== 'number') {
    throw new TypeError('landfireFuel: raster values are required');
  }
  const values = Array.from(rawValues, (value) => {
    const normalized = normalizeLandfireFuelValue(value);
    if (normalized) return normalized;
    if (typeof value === 'string') {
      try {
        const model = getFuelModel(value);
        if (model?.code === value
          && (model.burnable === false || /^(GR|GS|SH|TU|TL|SB)[1-9]$/.test(value))) {
          return value;
        }
      } catch {
        // Unknown strings remain no-data rather than becoming a fuel class.
      }
    }
    return null;
  });
  const modelCounts = {};
  let validCellCount = 0;
  for (const value of values) {
    if (!value) continue;
    validCellCount += 1;
    modelCounts[value] = (modelCounts[value] ?? 0) + 1;
  }
  return {
    values,
    totalCellCount: values.length,
    validCellCount,
    validCellFraction: values.length > 0 ? validCellCount / values.length : 0,
    modelCounts
  };
}

// Live LANDFIRE GeoServer WCS 1.0.0 responses do not return an exact
// bbox/resolution match for the request: they snap/resample the requested
// extent to the coverage's native grid. Real samples pulled in July 2026
// showed the returned raster's bbox always containing the requested bbox,
// with resolution up to ~1.6x coarser per axis (never finer). Width/height
// were always honored exactly. MAX_RESOLUTION_RATIO bounds how much coarser
// a response may be before it's treated as wrong rather than merely padded.
const LANDFIRE_FUEL_MAX_RESOLUTION_RATIO = 4;

export function validateLandfireFuelRasterGeometry({
  bbox,
  width,
  height,
  imageBoundingBox,
  imageResolution,
  coordinateReferenceSystem,
  pixelIsArea
} = {}) {
  const normalizedBbox = landfireFuelBbox(bbox);
  const normalizedWidth = positiveInteger('width', Number(width));
  const normalizedHeight = positiveInteger('height', Number(height));
  if (!isWithinLandfireFuelCoverage(normalizedBbox)) {
    throw new RangeError('landfireFuel: bbox is outside LANDFIRE CONUS coverage');
  }
  if (!Array.isArray(imageBoundingBox) || imageBoundingBox.length !== 4
    || imageBoundingBox.some((value) => !Number.isFinite(Number(value)))) {
    throw new TypeError('landfireFuel: GeoTIFF geographic bounding box is required');
  }
  if (!Array.isArray(imageResolution) || imageResolution.length < 2
    || !Number.isFinite(Number(imageResolution[0]))
    || !Number.isFinite(Number(imageResolution[1]))) {
    throw new TypeError('landfireFuel: GeoTIFF resolution is required');
  }
  if (coordinateReferenceSystem !== 'EPSG:4326') {
    throw new RangeError('landfireFuel: GeoTIFF must be encoded as EPSG:4326');
  }
  if (pixelIsArea !== true) {
    throw new RangeError('landfireFuel: GeoTIFF pixels must represent areas');
  }

  const [west, south, east, north] = normalizedBbox;
  const [imageWest, imageSouth, imageEast, imageNorth] = imageBoundingBox.map(Number);
  if (imageWest >= imageEast || imageSouth >= imageNorth) {
    throw new RangeError('landfireFuel: GeoTIFF bounding box is not a valid west<east, south<north extent');
  }
  const expectedResolutionX = (east - west) / normalizedWidth;
  const expectedResolutionY = (north - south) / normalizedHeight;

  // Bounds check: the returned raster must fully cover the requested extent
  // (it may legitimately be larger; see LANDFIRE_FUEL_MAX_RESOLUTION_RATIO).
  // A half-pixel epsilon absorbs floating-point rounding at the edge.
  const edgeEpsilonX = expectedResolutionX * 0.5;
  const edgeEpsilonY = expectedResolutionY * 0.5;
  if (imageWest > west + edgeEpsilonX
    || imageEast < east - edgeEpsilonX
    || imageSouth > south + edgeEpsilonY
    || imageNorth < north - edgeEpsilonY) {
    throw new RangeError('landfireFuel: GeoTIFF bounds do not cover the requested bbox');
  }

  // Resolution magnitude only: geotiff.js's getResolution() reports a
  // NEGATIVE y-component for a north-up raster encoded with ModelPixelScale,
  // but a POSITIVE y-component for a north-up raster encoded with
  // ModelTransformation (the tag GeoServer's WCS actually emits) -- the sign
  // is a library encoding-path artifact, not a reliable orientation signal.
  // Row-order/transposition correctness is instead proven at the pixel-value
  // level by the asymmetric fixture in scripts/validate-regional-inputs.mjs.
  const resolutionX = Math.abs(Number(imageResolution[0]));
  const resolutionY = Math.abs(Number(imageResolution[1]));
  if (resolutionX <= 0 || resolutionY <= 0
    || resolutionX < expectedResolutionX * 0.5
    || resolutionY < expectedResolutionY * 0.5
    || resolutionX > expectedResolutionX * LANDFIRE_FUEL_MAX_RESOLUTION_RATIO
    || resolutionY > expectedResolutionY * LANDFIRE_FUEL_MAX_RESOLUTION_RATIO) {
    throw new RangeError('landfireFuel: GeoTIFF resolution is missing, non-positive, or outside the accepted range for the requested bbox');
  }
  return {
    coordinateReferenceSystem,
    pixelIsArea: true,
    boundingBox: [imageWest, imageSouth, imageEast, imageNorth],
    requestedBoundingBox: normalizedBbox,
    resolution: [resolutionX, resolutionY],
    width: normalizedWidth,
    height: normalizedHeight
  };
}

export function landfireFuelModelToFuelDecision(code) {
  const normalizedCode = typeof code === 'string' ? normalizeLandfireFuelValue(code) ?? code : null;
  if (!normalizedCode) return null;
  let model;
  try {
    model = getFuelModel(normalizedCode);
  } catch {
    return null;
  }
  const burnable = model.burnable === true && normalizedCode !== NON_BURNABLE_FUEL_CODE;
  return {
    fuelCode: normalizedCode,
    fuelModelDefinition: model,
    fuelModelAlternatives: null,
    fuelLoadScale: burnable ? 1 : 0,
    fuelDisplayName: model.displayName,
    burnable,
    confidence: 'high',
    rationale: burnable
      ? `LANDFIRE 2024 CONUS FBFM40 directly identifies ${normalizedCode}; Scott & Burgan parameters are used without a land-cover crosswalk.`
      : 'LANDFIRE 2024 CONUS FBFM40 identifies a non-burnable fuel class.',
    landfireFuelModelCode: normalizedCode,
    landfireFuelSource: LANDFIRE_FUEL_SOURCE,
    landfireFuelResolutionMeters: LANDFIRE_FUEL_RESOLUTION_METERS,
    crosswalkVersion: 'LANDFIRE-FBFM40-1.0.0'
  };
}
