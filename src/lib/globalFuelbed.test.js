import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRothermelModelFromGlobalFuelbed,
  globalFuelbedParameterKeys,
  GLOBAL_FUELBED_MAX_PERSISTENCE_MINUTES,
  globalFuelbedPixelCoordinates,
  globalFuelbedPersistenceMinutes,
  globalFuelbedTileForLocation,
  globalFuelbedToFuelDecision,
  normalizeGlobalFuelbedParameters
} from './globalFuelbed.js';

test('selects the authoritative tile and pixel for a global location', () => {
  const tile = globalFuelbedTileForLocation(44.983286, -114.993013);
  assert.equal(tile.id, 1);
  assert.deepEqual(globalFuelbedPixelCoordinates(44.983286, -114.993013, tile), {
    x: 23402,
    y: 14406
  });
});

test('normalizes published Mg/ha values into solver kg/m2 loads', () => {
  const normalized = normalizeGlobalFuelbedParameters({
    fuelbed: '6091b',
    joinValue: 915091,
    biome: 'boreal',
    treeCoverPercent: 23,
    treeOverstoryCoverPercent: 23,
    treeMidstoryCoverPercent: 12.99,
    treeOverstoryHeightMeters: 18,
    treeOverstoryLiveCrownBaseMeters: 8,
    treeMidstoryHeightMeters: 8,
    treeMidstoryLiveCrownBaseMeters: 4,
    treeLadderFuelPresent: 1,
    grassHeightMeters: 0.4,
    woodyDepthCm: 7.1,
    duffDepthInches: 1.8,
    grassLoadMgPerHa: 1.2,
    dead1hLoadMgPerHa: 0.7,
    dead10hLoadMgPerHa: 1.8,
    dead100hLoadMgPerHa: 4.9,
    dead1000hLoadMgPerHa: 12,
    litterDepthCm: 1.8,
    grassLivePercent: 65
  });

  assert.equal(normalized.joinValue, '915091');
  assert.equal(normalized.grassLoadKgPerM2, 0.12);
  assert.equal(normalized.grassLivePercent, 65);
  assert.equal(normalized.treeOverstoryHeightMeters, 18);
  assert.equal(normalized.treeOverstoryLiveCrownBaseMeters, 8);
  assert.equal(normalized.treeLadderFuelPresent, 1);
  assert.equal(normalized.dead1hLoadKgPerM2, 0.07);
  assert.equal(normalized.dead10hLoadKgPerM2, 0.18);
  assert.equal(normalized.dead100hLoadKgPerM2, 0.49);
  assert.equal(normalized.litterDepthMeters, 0.018);
  assert.equal(normalized.grassHeightMeters, 0.4);
  assert.equal(normalized.woodyDepthMeters, 0.071);
  assert.equal(normalized.duffDepthMeters, 0.0457);
  assert.deepEqual(globalFuelbedParameterKeys(normalized), ['6091b', '915091']);
});

test('builds a provenance-bearing custom Rothermel model from explicit surface loads', () => {
  const model = buildRothermelModelFromGlobalFuelbed({
    fuelbed: '6091b',
    joinValue: 915091,
    woodyDepthCm: 7.1,
    grassLoadMgPerHa: 1.2,
    dead1hLoadMgPerHa: 0.7,
    dead10hLoadMgPerHa: 1.8,
    dead100hLoadMgPerHa: 4.9,
    dead1000hLoadMgPerHa: 12,
    litterDepthCm: 1.8
  });

  assert.equal(model.code, 'GF_6091b');
  assert.equal(model.deadFuel[0].loadKgPerM2, 0.07);
  assert.equal(model.deadFuel[1].loadKgPerM2, 0.18);
  assert.equal(model.deadFuel[2].loadKgPerM2, 0.49);
  assert.equal(model.liveFuel[0].loadKgPerM2, 0.12);
  assert.equal(model.fuelBedDepthMeters, 0.071);
  assert.equal(model.fuelBedDepthBasis, 'fccs-woody-depth');
  assert.equal(model.globalFuelbed.joinValue, '915091');
  assert.match(model.citation, /excludes 1000-hour/i);
});

test('splits published grass load between dead 1-hour and live herbaceous fuel', () => {
  const model = buildRothermelModelFromGlobalFuelbed({
    fuelbed: 'grass-live-split',
    grassLoadMgPerHa: 10,
    grassLivePercent: 25,
    dead1hLoadMgPerHa: 1
  });

  assert.equal(model.deadFuel[0].loadKgPerM2, 0.85);
  assert.equal(model.liveFuel[0].loadKgPerM2, 0.25);
  assert.equal(model.globalFuelbed.grassDeadLoadKgPerM2, 0.75);
  assert.equal(model.globalFuelbed.grassLiveLoadKgPerM2, 0.25);
  assert.match(model.citation, /FCCS G_live split at 25%/);
});

test('uses published FCCS tree structure for wind shelter without enabling crown fire', () => {
  const model = buildRothermelModelFromGlobalFuelbed({
    fuelbed: 'forest-structure',
    treeCoverPercent: 45,
    treeOverstoryCoverPercent: 18,
    treeMidstoryCoverPercent: 45,
    treeOverstoryHeightMeters: 22,
    treeOverstoryLiveCrownBaseMeters: 8,
    treeMidstoryHeightMeters: 9,
    treeMidstoryLiveCrownBaseMeters: 4,
    dead1hLoadMgPerHa: 2
  });

  assert.equal(model.globalFuelbed.canopyHeightMeters, 22);
  assert.equal(model.globalFuelbed.canopyCoverFraction, 0.18);
  assert.equal(model.globalFuelbed.canopyCoverBasis, 'fccs-overstory-cover');
  assert.equal(model.globalFuelbed.canopyBaseHeightMeters, 4);
  assert.match(model.globalFuelbed.canopyBaseHeightSource, /HLC proxy/);
  assert.match(model.globalFuelbed.canopyStructureSource, /TO\/TM structure/);
  assert.match(model.citation, /tree-cover\/height shelter fallback/);
});

test('rejects a fuelbed that only has unsupported litter or duff mass', () => {
  assert.equal(buildRothermelModelFromGlobalFuelbed({
    fuelbed: 'litter-only',
    dead1000hLoadMgPerHa: 25,
    litterDepthCm: 4
  }), null);
});

test('uses published grass height for grass-dominant fuelbeds', () => {
  const model = buildRothermelModelFromGlobalFuelbed({
    fuelbed: 'grass-test',
    grassHeightMeters: 0.42,
    grassLoadMgPerHa: 8.3,
    dead1hLoadMgPerHa: 0.2
  });
  assert.equal(model.fuelBedDepthMeters, 0.42);
  assert.equal(model.fuelBedDepthBasis, 'fccs-grass-height');
});

test('returns a low-confidence decision instead of hiding the bridge limitation', () => {
  const decision = globalFuelbedToFuelDecision({
    fuelbed: '6091b',
    joinValue: 915091,
    dead1hLoadMgPerHa: 0.7,
    dead10hLoadMgPerHa: 1.8,
    dead100hLoadMgPerHa: 4.9
  });
  assert.equal(decision.confidence, 'low');
  assert.equal(decision.globalFuelbedId, '6091b');
  assert.equal(decision.fuelModelDefinition.code, 'GF_6091b');
});

test('derives a bounded persistence window from supported slow-fuel evidence', () => {
  const persistence = globalFuelbedPersistenceMinutes({
    fuelbed: 'slow-fuel',
    dead1000hLoadMgPerHa: 3,
    litterDepthCm: 2,
    duffDepthInches: 1.8,
    woodyDepthCm: 8,
    treeLadderFuelPresent: 1
  });

  assert.ok(persistence > 0);
  assert.ok(persistence <= GLOBAL_FUELBED_MAX_PERSISTENCE_MINUTES);
  assert.equal(globalFuelbedPersistenceMinutes({
    fuelbed: 'fine-only',
    dead1hLoadMgPerHa: 1
  }), 0);
});
