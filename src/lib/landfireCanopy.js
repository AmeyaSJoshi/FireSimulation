// Pure contract helpers for LANDFIRE 2024 CONUS canopy structure.
//
// The WCS service returns integer rasters with product-specific scale
// factors. Keep those conversions here so the server adapter and tests share
// one interpretation of CBH/CBD and nodata.

export const LANDFIRE_CANOPY_SOURCE = 'LANDFIRE 2024 CONUS · WCS';
export const LANDFIRE_CANOPY_WCS_URL = 'https://edcintl.cr.usgs.gov/geoserver/landfire_wcs/conus_2024/wcs';
export const LANDFIRE_CANOPY_COVERAGES = Object.freeze({
  canopyHeight: 'LF2024_CH_CONUS',
  canopyCover: 'LF2024_CC_CONUS',
  canopyBaseHeight: 'LF2024_CBH_CONUS',
  canopyBulkDensity: 'LF2024_CBD_CONUS'
});
export const LANDFIRE_CANOPY_NODATA = 32767;
export const LANDFIRE_CANOPY_BOUNDS = Object.freeze({
  west: -128.38728541914483,
  south: 22.42833949781445,
  east: -64.05405005567833,
  north: 52.48155970969548
});

function finite(name, value) {
  if (!Number.isFinite(value)) throw new RangeError(`landfireCanopy: ${name} must be finite`);
  return value;
}

function positiveInteger(name, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`landfireCanopy: ${name} must be a positive integer`);
  }
  return value;
}

export function landfireCanopyBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new TypeError('landfireCanopy: bbox must be [west, south, east, north]');
  }
  const [west, south, east, north] = bbox.map((value, index) => finite(`bbox[${index}]`, Number(value)));
  if (west >= east || south >= north || west < -180 || east > 180 || south < -90 || north > 90) {
    throw new RangeError('landfireCanopy: bbox must be an ordered geographic extent');
  }
  return [west, south, east, north];
}

export function isWithinLandfireCanopyCoverage(bbox) {
  const [west, south, east, north] = landfireCanopyBbox(bbox);
  return west >= LANDFIRE_CANOPY_BOUNDS.west
    && south >= LANDFIRE_CANOPY_BOUNDS.south
    && east <= LANDFIRE_CANOPY_BOUNDS.east
    && north <= LANDFIRE_CANOPY_BOUNDS.north;
}

export function createLandfireWcsRequest({
  bbox,
  width,
  height,
  coverage
} = {}) {
  const normalizedBbox = landfireCanopyBbox(bbox);
  const normalizedWidth = positiveInteger('width', Number(width));
  const normalizedHeight = positiveInteger('height', Number(height));
  if (!Object.values(LANDFIRE_CANOPY_COVERAGES).includes(coverage)) {
    throw new RangeError(`landfireCanopy: unsupported coverage ${coverage}`);
  }
  if (!isWithinLandfireCanopyCoverage(normalizedBbox)) {
    throw new RangeError('landfireCanopy: bbox is outside LANDFIRE CONUS coverage');
  }
  // GeoServer's WCS 1.0 parser is unusually strict about preserving the
  // geographic comma separators and CRS colon. These values are all numeric
  // or enum-validated above, so a literal query is both safe and compatible.
  const params = [
    'service=WCS',
    'version=1.0.0',
    'request=GetCoverage',
    `coverage=${coverage}`,
    'crs=EPSG:4326',
    `bbox=${normalizedBbox.join(',')}`,
    `width=${normalizedWidth}`,
    `height=${normalizedHeight}`,
    'format=GeoTIFF'
  ].join('&');
  return {
    url: `${LANDFIRE_CANOPY_WCS_URL}?${params}`,
    bbox: normalizedBbox,
    width: normalizedWidth,
    height: normalizedHeight,
    coverage
  };
}

export function normalizeLandfireCanopyValue(rawValue, kind) {
  const raw = Number(rawValue);
  if (!Number.isFinite(raw) || raw === LANDFIRE_CANOPY_NODATA) return null;
  if (kind === 'canopyHeight') {
    const meters = raw / 10;
    return meters >= 0 && meters <= 100 ? meters : null;
  }
  if (kind === 'canopyCover') {
    const fraction = raw / 100;
    return fraction >= 0 && fraction <= 1 ? fraction : null;
  }
  if (kind === 'canopyBaseHeight') {
    const meters = raw / 10;
    return meters >= 0 && meters <= 100 ? meters : null;
  }
  if (kind === 'canopyBulkDensity') {
    const kilogramsPerCubicMeter = raw / 100;
    return kilogramsPerCubicMeter >= 0 && kilogramsPerCubicMeter <= 2
      ? kilogramsPerCubicMeter
      : null;
  }
  throw new RangeError(`landfireCanopy: unsupported kind ${kind}`);
}

export function normalizeLandfireCanopyRaster(rawValues, kind) {
  if (!rawValues || typeof rawValues.length !== 'number') {
    throw new TypeError('landfireCanopy: raster values are required');
  }
  return Array.from(rawValues, (value) => normalizeLandfireCanopyValue(value, kind));
}

export function hasUsableCrownStructure({ canopyBaseHeightMeters, canopyBulkDensityKgPerM3 } = {}) {
  return Number.isFinite(canopyBaseHeightMeters)
    && canopyBaseHeightMeters >= 0
    && Number.isFinite(canopyBulkDensityKgPerM3)
    && canopyBulkDensityKgPerM3 > 0;
}

export function hasUsableCanopyWindStructure({ canopyHeightMeters, canopyCoverFraction } = {}) {
  return Number.isFinite(canopyHeightMeters)
    && canopyHeightMeters > 0
    && Number.isFinite(canopyCoverFraction)
    && canopyCoverFraction >= 0.05
    && canopyCoverFraction <= 1;
}
