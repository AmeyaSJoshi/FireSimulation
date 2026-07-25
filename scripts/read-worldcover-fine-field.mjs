import { fromUrl } from 'geotiff';
import {
  WORLD_COVER_FINE_SOURCE,
  WORLD_COVER_FINE_SAMPLE_OFFSETS,
  aggregateWorldCoverFineSamples,
  classifyWorldCoverFineCode,
  worldCoverPixelCoordinates,
  worldCoverTileId,
  worldCoverTileUrl
} from '../src/lib/worldCoverFine.js';

// Read only the COG windows that cover the requested grid samples. This keeps
// offline validation on the same real 10 m source as the localhost adapter.
export async function readWorldCoverFineField({
  grid,
  fromUrlImpl = fromUrl,
  sampleOffsets = WORLD_COVER_FINE_SAMPLE_OFFSETS
} = {}) {
  if (!grid || !Number.isInteger(grid.gridSize) || typeof grid.cellCenterLatLon !== 'function') {
    throw new TypeError('fineField: grid with gridSize and cellCenterLatLon is required');
  }

  if (!Array.isArray(sampleOffsets) || sampleOffsets.length < 1) {
    throw new RangeError('fineField: sampleOffsets must not be empty');
  }
  const samples = [];
  for (let row = 0; row < grid.gridSize; row += 1) {
    for (let col = 0; col < grid.gridSize; col += 1) {
      for (const rowOffset of sampleOffsets) {
        for (const colOffset of sampleOffsets) {
          const coordinates = grid.cellCenterLatLon(row + rowOffset, col + colOffset);
          const tileId = worldCoverTileId(coordinates.latitude, coordinates.longitude);
          const pixel = worldCoverPixelCoordinates(coordinates.latitude, coordinates.longitude, tileId);
          samples.push({ sampleIndex: samples.length, row, col, tileId, pixel });
        }
      }
    }
  }

  const tileGroups = new Map();
  for (const sample of samples) {
    const group = tileGroups.get(sample.tileId) ?? {
      samples: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity
    };
    group.samples.push(sample);
    group.minX = Math.min(group.minX, sample.pixel.x);
    group.minY = Math.min(group.minY, sample.pixel.y);
    group.maxX = Math.max(group.maxX, sample.pixel.x);
    group.maxY = Math.max(group.maxY, sample.pixel.y);
    tileGroups.set(sample.tileId, group);
  }

  const sampleClassCodes = new Uint8Array(samples.length);
  const tileSummaries = [];
  for (const [tileId, group] of tileGroups) {
    const tiff = await fromUrlImpl(worldCoverTileUrl(tileId));
    const image = await tiff.getImage(0);
    const width = group.maxX - group.minX + 1;
    const height = group.maxY - group.minY + 1;
    const [raster] = await image.readRasters({
      window: [group.minX, group.minY, group.maxX + 1, group.maxY + 1],
      width,
      height
    });
    for (const sample of group.samples) {
      const offset = (sample.pixel.y - group.minY) * width + sample.pixel.x - group.minX;
      sampleClassCodes[sample.sampleIndex] = Number(raster[offset]);
    }
    tileSummaries.push({ tileId, sampleCount: group.samples.length, windowPixels: width * height });
  }

  const sampleClassifications = [...sampleClassCodes]
    .map((classCode) => classifyWorldCoverFineCode(classCode));
  const samplesPerCell = sampleOffsets.length ** 2;
  const classifications = aggregateWorldCoverFineSamples(sampleClassifications, {
    gridSize: grid.gridSize,
    samplesPerCell
  });
  return {
    classCodes: Uint8Array.from(classifications.map((entry) => entry?.classCode ?? 0)),
    sampleClassCodes,
    classifications,
    sampleClassifications,
    source: WORLD_COVER_FINE_SOURCE,
    resolutionMeters: 10,
    tileSummaries
  };
}
