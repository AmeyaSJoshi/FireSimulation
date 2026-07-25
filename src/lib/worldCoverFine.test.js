import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateWorldCoverFineSamples,
  classifyWorldCoverFineCode,
  createWorldCoverFineSampleBatches,
  nearestWorldCoverFineSample,
  normalizeWorldCoverFineSamples,
  summarizeWorldCoverFineCoverage,
  WORLD_COVER_FINE_SAMPLE_OFFSETS,
  WORLD_COVER_FINE_SAMPLES_PER_CELL,
  WORLD_COVER_FINE_BATCH_RETRIES,
  worldCoverPixelCoordinates,
  worldCoverTileBounds,
  worldCoverTileId,
  worldCoverTileUrl
} from './worldCoverFine.js';

test('WorldCover fine adapter maps a point to the correct 3 degree tile', () => {
  assert.equal(worldCoverTileId(44.95, -115.04), 'N42W117');
  assert.deepEqual(worldCoverTileBounds(44.95, -115.04), {
    latitudeSouth: 42,
    latitudeNorth: 45,
    longitudeWest: -117,
    longitudeEast: -114
  });
});

test('WorldCover fine adapter maps north-up 10 m pixels inside a tile', () => {
  const pixel = worldCoverPixelCoordinates(44.95, -115.04, 'N42W117');
  assert.deepEqual(pixel, { x: 23519, y: 599 });
  assert.match(worldCoverTileUrl('N42W117'), /ESA_WorldCover_10m_2021_v200_N42W117_Map\.tif$/);
});

test('WorldCover fine class codes preserve the hard water boundary', () => {
  assert.equal(classifyWorldCoverFineCode(80).burnable, false);
  assert.equal(classifyWorldCoverFineCode(10).confidence, 'high');
  assert.equal(classifyWorldCoverFineCode(999), null);
});

test('WorldCover fine field response normalizes every sample', () => {
  const result = normalizeWorldCoverFineSamples({
    source: 'test source',
    classCodes: [10, 80, 50]
  });
  assert.equal(result.length, 3);
  assert.equal(result[0].source, 'test source');
  assert.equal(result[1].burnable, false);
  assert.equal(result[2].className, 'Built-up');
});

test('fine-cover request batches preserve raster order and bounded sizes', () => {
  const samples = Array.from({ length: 10 }, (_, index) => ({ index }));
  const batches = createWorldCoverFineSampleBatches(samples, 4);

  assert.deepEqual(batches.map((batch) => batch.startIndex), [0, 4, 8]);
  assert.deepEqual(batches.map((batch) => batch.samples.length), [4, 4, 2]);
  assert.ok(batches.every((batch) => batch.requestCount === 3));
  assert.deepEqual(
    batches.flatMap((batch) => batch.samples).map((sample) => sample.index),
    samples.map((sample) => sample.index)
  );
});

test('fine-cover request batching rejects invalid inputs', () => {
  assert.throws(() => createWorldCoverFineSampleBatches([], 4), /non-empty/);
  assert.throws(() => createWorldCoverFineSampleBatches([{}], 0), /integer/);
  assert.throws(() => createWorldCoverFineSampleBatches([{}], 65537), /integer/);
});

test('fine-cover transport has a bounded retry budget', () => {
  assert.equal(WORLD_COVER_FINE_BATCH_RETRIES, 2);
  assert.ok(Number.isInteger(WORLD_COVER_FINE_BATCH_RETRIES));
  assert.ok(WORLD_COVER_FINE_BATCH_RETRIES >= 1);
});

test('fine-cover coverage reports partial batches without overstating completeness', () => {
  assert.deepEqual(summarizeWorldCoverFineCoverage({
    totalSampleCount: 12,
    validSampleCount: 8,
    totalBatchCount: 3,
    successfulBatchCount: 2
  }), {
    totalSampleCount: 12,
    validSampleCount: 8,
    sampleCoverageFraction: 2 / 3,
    totalBatchCount: 3,
    successfulBatchCount: 2,
    failedBatchCount: 1,
    complete: false
  });
  assert.throws(() => summarizeWorldCoverFineCoverage({
    totalSampleCount: 4,
    validSampleCount: 5,
    totalBatchCount: 1,
    successfulBatchCount: 1
  }), /valid samples cannot exceed/);
});

test('aggregates within-cell fine samples by majority with a water tie-break', () => {
  const source = 'test source';
  const samples = [
    10, 30, 10, 30,
    30, 30, 30, 80,
    10, 10, 10, 10,
    10, 10, 10, 10
  ]
    .map((classCode) => classifyWorldCoverFineCode(classCode, source));
  const result = aggregateWorldCoverFineSamples(samples, { gridSize: 2, samplesPerCell: 4 });

  assert.deepEqual(result.map((entry) => entry.classCode), [10, 30, 10, 10]);
  assert.equal(result[0].source, source);
  assert.equal(aggregateWorldCoverFineSamples(
    [10, 30, 80, 80].map((classCode) => classifyWorldCoverFineCode(classCode)),
    { gridSize: 1, samplesPerCell: 4 }
  )[0].classCode, 80);
});

test('fine-cover aggregation preserves the sampled burnable fraction', () => {
  const samples = [10, 10, 10, 80].map((classCode) => classifyWorldCoverFineCode(classCode));
  const result = aggregateWorldCoverFineSamples(samples, { gridSize: 1, samplesPerCell: 4 });

  assert.equal(result[0].classCode, 10);
  assert.equal(result[0].fineSampleCount, 4);
  assert.equal(result[0].fineBurnableFraction, 0.75);
});

test('nearest fine sample preserves a narrow water edge hidden by the cell majority', () => {
  const land = classifyWorldCoverFineCode(10);
  const water = classifyWorldCoverFineCode(80);
  const samples = Array.from({ length: WORLD_COVER_FINE_SAMPLES_PER_CELL }, () => land);
  // The last row of samples is adjacent to the eastern cell boundary. A
  // water pixel there must remain visible to an edge-barrier query even when
  // the cell's majority label is tree cover.
  samples[(WORLD_COVER_FINE_SAMPLE_OFFSETS.length - 1) * WORLD_COVER_FINE_SAMPLE_OFFSETS.length] = water;

  const result = nearestWorldCoverFineSample(samples, {
    gridSize: 1,
    cellRow: 0.5,
    cellCol: -0.45
  });

  assert.equal(result.classCode, 80);
});
