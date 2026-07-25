// Pure helpers for the server-side ESA WorldCover 2021 10 m COG adapter.
// The browser never downloads a COG directly; Vite's local middleware reads
// only the requested samples and returns class codes over same-origin HTTP.

export const WORLD_COVER_FINE_SOURCE = 'ESA WorldCover 2021 v200 · 10 m COG';
export const WORLD_COVER_FINE_RESOLUTION_METERS = 10;
export const WORLD_COVER_FINE_TILE_DEGREES = 3;
export const WORLD_COVER_FINE_TILE_PIXELS = 36_000;
export const WORLD_COVER_FINE_S3_BASE = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map';
// Four samples per axis stay inside the 500 m model cell while placing two
// samples close to each edge. The edge-nearest samples are important for
// narrow rivers and coastlines; the full set is majority-voted for fuel.
export const WORLD_COVER_FINE_SAMPLE_OFFSETS = Object.freeze([-0.45, -0.15, 0.15, 0.45]);
export const WORLD_COVER_FINE_SAMPLES_PER_CELL = WORLD_COVER_FINE_SAMPLE_OFFSETS.length ** 2;
export const WORLD_COVER_FINE_MAX_SAMPLES_PER_REQUEST = 8192;
export const WORLD_COVER_FINE_REQUEST_CONCURRENCY = 4;
export const WORLD_COVER_FINE_BATCH_RETRIES = 2;

const CLASS_NAMES = Object.freeze({
  0: 'No data',
  10: 'Tree cover',
  20: 'Shrubland',
  30: 'Grassland',
  40: 'Cropland',
  50: 'Built-up',
  60: 'Bare / sparse',
  70: 'Snow and ice',
  80: 'Permanent water',
  90: 'Herbaceous wetland',
  95: 'Mangroves',
  100: 'Moss and lichen'
});

const NON_BURNABLE_CLASSES = new Set([0, 50, 70, 80]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function tileCoordinate(value, direction) {
  const max = direction === 'latitude' ? 87 : 177;
  return clamp(Math.floor(value / WORLD_COVER_FINE_TILE_DEGREES)
    * WORLD_COVER_FINE_TILE_DEGREES, -max, max);
}

function formatTileNumber(value, width) {
  return String(Math.abs(value)).padStart(width, '0');
}

export function worldCoverTileBounds(latitude, longitude) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError('worldCoverFine: latitude must be in [-90, 90]');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError('worldCoverFine: longitude must be in [-180, 180]');
  }
  const latitudeSouth = tileCoordinate(latitude === 90 ? 89.999999 : latitude, 'latitude');
  const longitudeWest = tileCoordinate(longitude === 180 ? 179.999999 : longitude, 'longitude');
  return {
    latitudeSouth,
    latitudeNorth: latitudeSouth + WORLD_COVER_FINE_TILE_DEGREES,
    longitudeWest,
    longitudeEast: longitudeWest + WORLD_COVER_FINE_TILE_DEGREES
  };
}

export function worldCoverTileId(latitude, longitude) {
  const bounds = worldCoverTileBounds(latitude, longitude);
  return `${bounds.latitudeSouth >= 0 ? 'N' : 'S'}${formatTileNumber(bounds.latitudeSouth, 2)}${bounds.longitudeWest >= 0 ? 'E' : 'W'}${formatTileNumber(bounds.longitudeWest, 3)}`;
}

export function worldCoverTileUrl(tileId) {
  if (!/^[NS]\d{2}[EW]\d{3}$/.test(tileId)) {
    throw new RangeError(`worldCoverFine: invalid tile id ${tileId}`);
  }
  return `${WORLD_COVER_FINE_S3_BASE}/ESA_WorldCover_10m_2021_v200_${tileId}_Map.tif`;
}

export function worldCoverPixelCoordinates(latitude, longitude, tileId) {
  const match = /^([NS])(\d{2})([EW])(\d{3})$/.exec(tileId);
  if (!match) throw new RangeError(`worldCoverFine: invalid tile id ${tileId}`);
  const latitudeSouth = Number(match[2]) * (match[1] === 'N' ? 1 : -1);
  const longitudeWest = Number(match[4]) * (match[3] === 'E' ? 1 : -1);
  const x = Math.floor(((longitude - longitudeWest) / WORLD_COVER_FINE_TILE_DEGREES)
    * WORLD_COVER_FINE_TILE_PIXELS);
  const y = Math.floor(((latitudeSouth + WORLD_COVER_FINE_TILE_DEGREES - latitude)
    / WORLD_COVER_FINE_TILE_DEGREES) * WORLD_COVER_FINE_TILE_PIXELS);
  return {
    x: clamp(x, 0, WORLD_COVER_FINE_TILE_PIXELS - 1),
    y: clamp(y, 0, WORLD_COVER_FINE_TILE_PIXELS - 1)
  };
}

export function classifyWorldCoverFineCode(classCode, source = WORLD_COVER_FINE_SOURCE) {
  if (!Number.isInteger(classCode) || CLASS_NAMES[classCode] === undefined) return null;
  return {
    classCode,
    className: CLASS_NAMES[classCode],
    burnable: !NON_BURNABLE_CLASSES.has(classCode),
    source,
    confidence: 'high'
  };
}

export function normalizeWorldCoverFineSamples(payload) {
  if (!Array.isArray(payload?.classCodes)) return null;
  return payload.classCodes.map((classCode) => classifyWorldCoverFineCode(
    classCode,
    payload.source ?? WORLD_COVER_FINE_SOURCE
  ));
}

// Keep browser transport bounded. The server can read a much larger field,
// but one oversized request makes a remote COG timeout discard all fine data.
// Each batch retains its original offset so responses can be reassembled in
// the same raster order before majority voting.
export function createWorldCoverFineSampleBatches(
  samples,
  maxSamplesPerRequest = WORLD_COVER_FINE_MAX_SAMPLES_PER_REQUEST
) {
  if (!Array.isArray(samples) || samples.length < 1) {
    throw new RangeError('worldCoverFine: samples must be a non-empty array');
  }
  if (!Number.isInteger(maxSamplesPerRequest)
    || maxSamplesPerRequest < 1
    || maxSamplesPerRequest > 65536) {
    throw new RangeError('worldCoverFine: maxSamplesPerRequest must be an integer in [1, 65536]');
  }
  const batches = [];
  for (let startIndex = 0; startIndex < samples.length; startIndex += maxSamplesPerRequest) {
    batches.push({
      startIndex,
      samples: samples.slice(startIndex, startIndex + maxSamplesPerRequest),
      requestCount: Math.ceil(samples.length / maxSamplesPerRequest)
    });
  }
  return batches;
}

export function summarizeWorldCoverFineCoverage({
  totalSampleCount,
  validSampleCount,
  totalBatchCount,
  successfulBatchCount
} = {}) {
  const values = [
    totalSampleCount,
    validSampleCount,
    totalBatchCount,
    successfulBatchCount
  ];
  if (!values.every((value) => Number.isInteger(value) && value >= 0)) {
    throw new RangeError('worldCoverFine: coverage counts must be non-negative integers');
  }
  if (validSampleCount > totalSampleCount) {
    throw new RangeError('worldCoverFine: valid samples cannot exceed total samples');
  }
  if (successfulBatchCount > totalBatchCount) {
    throw new RangeError('worldCoverFine: successful batches cannot exceed total batches');
  }
  return {
    totalSampleCount,
    validSampleCount,
    sampleCoverageFraction: totalSampleCount > 0
      ? validSampleCount / totalSampleCount
      : 0,
    totalBatchCount,
    successfulBatchCount,
    failedBatchCount: totalBatchCount - successfulBatchCount,
    complete: totalSampleCount > 0
      && validSampleCount === totalSampleCount
      && successfulBatchCount === totalBatchCount
  };
}

export function aggregateWorldCoverFineSamples(
  classifications,
  { gridSize, samplesPerCell = WORLD_COVER_FINE_SAMPLES_PER_CELL } = {}
) {
  if (!Number.isInteger(gridSize) || gridSize < 1) {
    throw new RangeError('worldCoverFine: gridSize must be a positive integer');
  }
  if (!Number.isInteger(samplesPerCell) || samplesPerCell < 1) {
    throw new RangeError('worldCoverFine: samplesPerCell must be a positive integer');
  }
  const expectedLength = gridSize * gridSize * samplesPerCell;
  if (!Array.isArray(classifications) || classifications.length !== expectedLength) {
    throw new RangeError(`worldCoverFine: expected ${expectedLength} samples, got ${classifications?.length ?? 0}`);
  }

  return Array.from({ length: gridSize * gridSize }, (_, cellIndex) => {
    const counts = new Map();
    const start = cellIndex * samplesPerCell;
    let validSampleCount = 0;
    let burnableSampleCount = 0;
    let selectedEntry = null;
    for (let offset = 0; offset < samplesPerCell; offset += 1) {
      const entry = classifications[start + offset];
      const classCode = entry?.classCode;
      if (!Number.isInteger(classCode)) continue;
      validSampleCount += 1;
      if (entry.burnable !== false) burnableSampleCount += 1;
      counts.set(classCode, (counts.get(classCode) ?? 0) + 1);
    }
    let selectedClassCode = null;
    let selectedCount = 0;
    for (const [classCode, count] of counts) {
      // Keep ties deterministic and conservative for permanent water.
      if (count > selectedCount || (count === selectedCount && classCode === 80)) {
        selectedClassCode = classCode;
        selectedCount = count;
        selectedEntry = classifications
          .slice(start, start + samplesPerCell)
          .find((entry) => entry?.classCode === classCode) ?? null;
      }
    }
    if (!selectedEntry) return selectedClassCode === null ? null : classifications[start] ?? null;
    return {
      ...selectedEntry,
      fineSampleCount: validSampleCount,
      fineBurnableFraction: validSampleCount > 0
        ? burnableSampleCount / validSampleCount
        : 0
    };
  });
}

// Return the native fine sample nearest a spatial-grid coordinate. This is
// intentionally separate from the majority classification: a cell center
// needs a stable fuel label, while a water-edge query must be able to see a
// narrow water sample that would be outvoted by surrounding land.
export function nearestWorldCoverFineSample(
  classifications,
  { gridSize, cellRow, cellCol, sampleOffsets = WORLD_COVER_FINE_SAMPLE_OFFSETS } = {}
) {
  if (!Number.isInteger(gridSize) || gridSize < 1) {
    throw new RangeError('worldCoverFine: gridSize must be a positive integer');
  }
  if (!Number.isFinite(cellRow) || !Number.isFinite(cellCol)) {
    throw new RangeError('worldCoverFine: cellRow and cellCol must be finite');
  }
  if (!Array.isArray(sampleOffsets) || sampleOffsets.length < 1) {
    throw new RangeError('worldCoverFine: sampleOffsets must not be empty');
  }
  const samplesPerCell = sampleOffsets.length ** 2;
  const expectedLength = gridSize * gridSize * samplesPerCell;
  if (!Array.isArray(classifications) || classifications.length !== expectedLength) {
    throw new RangeError(`worldCoverFine: expected ${expectedLength} samples, got ${classifications?.length ?? 0}`);
  }

  let closest = null;
  let closestDistance = Infinity;
  const baseRow = Math.floor(cellRow);
  const baseCol = Math.floor(cellCol);
  for (let row = Math.max(0, baseRow - 1); row <= Math.min(gridSize - 1, baseRow + 1); row += 1) {
    for (let col = Math.max(0, baseCol - 1); col <= Math.min(gridSize - 1, baseCol + 1); col += 1) {
      const cellIndex = row * gridSize + col;
      for (let rowOffsetIndex = 0; rowOffsetIndex < sampleOffsets.length; rowOffsetIndex += 1) {
        const sampleRow = row + sampleOffsets[rowOffsetIndex];
        for (let colOffsetIndex = 0; colOffsetIndex < sampleOffsets.length; colOffsetIndex += 1) {
          const sampleCol = col + sampleOffsets[colOffsetIndex];
          const distance = (sampleRow - cellRow) ** 2 + (sampleCol - cellCol) ** 2;
          if (distance < closestDistance) {
            closestDistance = distance;
            closest = classifications[
              cellIndex * samplesPerCell
                + rowOffsetIndex * sampleOffsets.length
                + colOffsetIndex
            ] ?? null;
          }
        }
      }
    }
  }
  return closest;
}
