// Pure helpers for the published ETH Global Canopy Height 2020 product.
// The map is an estimate of canopy-top height, not canopy-base height or
// canopy-bulk density. Consumers must preserve that distinction and must not
// use this layer alone to trigger crown-fire spread.

export const CANOPY_HEIGHT_SOURCE = 'ETH Global Canopy Height 2020 · 10 m COG';
export const CANOPY_HEIGHT_RESOLUTION_METERS = 10;
export const CANOPY_HEIGHT_TILE_DEGREES = 3;
export const CANOPY_HEIGHT_TILE_PIXELS = 36_000;
export const CANOPY_HEIGHT_S3_BASE = 'https://libdrive.ethz.ch/index.php/s/cO8or7iOe5dT2Rt/download?path=%2F3deg_cogs&files=';
export const CANOPY_HEIGHT_SAMPLE_OFFSETS = Object.freeze([-0.35, 0, 0.35]);
export const CANOPY_HEIGHT_SAMPLES_PER_CELL = CANOPY_HEIGHT_SAMPLE_OFFSETS.length ** 2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function tileCoordinate(value, direction) {
  const max = direction === 'latitude' ? 87 : 177;
  return clamp(Math.floor(value / CANOPY_HEIGHT_TILE_DEGREES)
    * CANOPY_HEIGHT_TILE_DEGREES, -max, max);
}

function formatTileNumber(value, width) {
  return String(Math.abs(value)).padStart(width, '0');
}

export function canopyHeightTileBounds(latitude, longitude) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError('canopyHeight: latitude must be in [-90, 90]');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError('canopyHeight: longitude must be in [-180, 180]');
  }
  const latitudeSouth = tileCoordinate(latitude === 90 ? 89.999999 : latitude, 'latitude');
  const longitudeWest = tileCoordinate(longitude === 180 ? 179.999999 : longitude, 'longitude');
  return {
    latitudeSouth,
    latitudeNorth: latitudeSouth + CANOPY_HEIGHT_TILE_DEGREES,
    longitudeWest,
    longitudeEast: longitudeWest + CANOPY_HEIGHT_TILE_DEGREES
  };
}

export function canopyHeightTileId(latitude, longitude) {
  const bounds = canopyHeightTileBounds(latitude, longitude);
  return `${bounds.latitudeSouth >= 0 ? 'N' : 'S'}${formatTileNumber(bounds.latitudeSouth, 2)}${bounds.longitudeWest >= 0 ? 'E' : 'W'}${formatTileNumber(bounds.longitudeWest, 3)}`;
}

export function canopyHeightTileUrl(tileId) {
  if (!/^[NS]\d{2}[EW]\d{3}$/.test(tileId)) {
    throw new RangeError(`canopyHeight: invalid tile id ${tileId}`);
  }
  return `${CANOPY_HEIGHT_S3_BASE}ETH_GlobalCanopyHeight_10m_2020_${tileId}_Map.tif`;
}

export function canopyHeightPixelCoordinates(latitude, longitude, tileId) {
  const match = /^([NS])(\d{2})([EW])(\d{3})$/.exec(tileId);
  if (!match) throw new RangeError(`canopyHeight: invalid tile id ${tileId}`);
  const latitudeSouth = Number(match[2]) * (match[1] === 'N' ? 1 : -1);
  const longitudeWest = Number(match[4]) * (match[3] === 'E' ? 1 : -1);
  return {
    x: clamp(Math.floor(((longitude - longitudeWest) / CANOPY_HEIGHT_TILE_DEGREES)
      * CANOPY_HEIGHT_TILE_PIXELS), 0, CANOPY_HEIGHT_TILE_PIXELS - 1),
    y: clamp(Math.floor(((latitudeSouth + CANOPY_HEIGHT_TILE_DEGREES - latitude)
      / CANOPY_HEIGHT_TILE_DEGREES) * CANOPY_HEIGHT_TILE_PIXELS), 0, CANOPY_HEIGHT_TILE_PIXELS - 1)
  };
}

export function classifyCanopyHeight(value, source = CANOPY_HEIGHT_SOURCE) {
  const heightMeters = Number(value);
  if (!Number.isFinite(heightMeters) || heightMeters < 0 || heightMeters > 120) return null;
  return {
    heightMeters,
    source,
    resolutionMeters: CANOPY_HEIGHT_RESOLUTION_METERS,
    confidence: 'medium'
  };
}

export function aggregateCanopyHeightSamples(samples, {
  gridSize,
  samplesPerCell = CANOPY_HEIGHT_SAMPLES_PER_CELL
} = {}) {
  if (!Number.isInteger(gridSize) || gridSize < 1) {
    throw new RangeError('canopyHeight: gridSize must be a positive integer');
  }
  if (!Number.isInteger(samplesPerCell) || samplesPerCell < 1) {
    throw new RangeError('canopyHeight: samplesPerCell must be a positive integer');
  }
  const expectedLength = gridSize * gridSize * samplesPerCell;
  if (!Array.isArray(samples) || samples.length !== expectedLength) {
    throw new RangeError(`canopyHeight: expected ${expectedLength} samples, got ${samples?.length ?? 0}`);
  }
  return Array.from({ length: gridSize * gridSize }, (_, cellIndex) => {
    const values = samples.slice(cellIndex * samplesPerCell, (cellIndex + 1) * samplesPerCell)
      .map((sample) => sample?.heightMeters)
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (values.length === 0) return null;
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const heightMeters = values.length % 2 === 0
      ? (values[middle - 1] + values[middle]) / 2
      : values[middle];
    return {
      ...classifyCanopyHeight(heightMeters),
      validSampleCount: values.length,
      sampleCount: samplesPerCell
    };
  });
}
