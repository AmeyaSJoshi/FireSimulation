import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWaterEvidence } from './waterAuthority.js';

test('classified water wins over the visual texture guard', () => {
  const result = resolveWaterEvidence({ fineClassCode: 80, visualWater: false });
  assert.deepEqual(result, { isWater: true, source: 'ESA WorldCover 10 m' });
});

test('classified land prevents a visual basemap false positive', () => {
  const result = resolveWaterEvidence({ fineClassCode: 30, visualWater: true });
  assert.deepEqual(result, { isWater: false, source: 'classified land-cover sample' });
});

test('visual ocean vetoes approximate coarse land when fine evidence is absent', () => {
  assert.deepEqual(
    resolveWaterEvidence({ coarseClassCode: 30, visualWater: true }),
    { isWater: true, source: 'rendered Earth texture conservative coastal veto' }
  );
});

test('fractional water evidence blocks even when categorical sources say land', () => {
  const result = resolveWaterEvidence({
    fractionalWater: true,
    fineClassCode: 30,
    coarseClassCode: 30
  });
  assert.deepEqual(result, { isWater: true, source: 'Copernicus fractional water cover' });
});

test('visual water is only a fallback when classified evidence is absent', () => {
  assert.deepEqual(
    resolveWaterEvidence({ visualWater: true }),
    { isWater: true, source: 'rendered Earth texture fallback' }
  );
  assert.deepEqual(
    resolveWaterEvidence({ visualWater: false }),
    { isWater: false, source: 'no water evidence' }
  );
});

test('known fractional land is not replaced by the visual water fallback', () => {
  assert.deepEqual(
    resolveWaterEvidence({ fractionalWater: false, visualWater: true }),
    { isWater: false, source: 'classified land-cover sample' }
  );
});

test('propagation edge veto blocks visible water even when a fine cell majority says land', () => {
  assert.deepEqual(
    resolveWaterEvidence({
      fineClassCode: 30,
      visualWater: true,
      edgeVisualVeto: true
    }),
    { isWater: true, source: 'rendered Earth texture conservative edge veto' }
  );
});

test('explicit fractional land still prevents an edge veto from a coarse visual false positive', () => {
  assert.deepEqual(
    resolveWaterEvidence({
      fractionalWater: false,
      fineClassCode: 30,
      visualWater: true,
      edgeVisualVeto: true
    }),
    { isWater: false, source: 'classified land-cover sample' }
  );
});
