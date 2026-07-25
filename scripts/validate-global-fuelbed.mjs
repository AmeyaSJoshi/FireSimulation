import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildRothermelModelFromGlobalFuelbed,
  globalFuelbedParameterKeys,
  normalizeGlobalFuelbedParameters
} from '../src/lib/globalFuelbed.js';
import { calculateSurfaceSpread } from '../src/lib/surfaceSpread.js';

const payload = JSON.parse(await readFile('public/global-fuelbed-parameters.json', 'utf8'));
assert.equal(payload.source?.parameterVersion, 'v1.2');
assert.equal(payload.rows.length, 359);

const scenarios = [
  { dead: 0.03, live: 0.60, wind: 0 },
  { dead: 0.08, live: 0.90, wind: 30 },
  { dead: 0.18, live: 1.20, wind: 60 }
];
let builtCount = 0;
let rejectedCount = 0;
let liveGrassSplitCount = 0;
let canopyStructureCount = 0;
let canopyBaseHeightCount = 0;
let surfaceScenarioCount = 0;

for (const sourceRow of payload.rows) {
  const normalized = normalizeGlobalFuelbedParameters(sourceRow);
  assert.ok(normalized, `normalization failed for ${sourceRow.fuelbed}`);
  assert.ok(globalFuelbedParameterKeys(sourceRow).includes(normalized.fuelbed));
  const model = buildRothermelModelFromGlobalFuelbed(sourceRow);
  if (!model) {
    rejectedCount += 1;
    const unsupportedSurfaceLoad = normalized.grassLoadKgPerM2
      + normalized.dead1hLoadKgPerM2
      + normalized.dead10hLoadKgPerM2
      + normalized.dead100hLoadKgPerM2;
    assert.equal(unsupportedSurfaceLoad, 0, `${normalized.fuelbed} was rejected with surface fuel`);
    continue;
  }

  builtCount += 1;
  assert.equal(model.code, `GF_${normalized.fuelbed}`);
  assert.ok(model.fuelBedDepthMeters >= 0.03 && model.fuelBedDepthMeters <= 0.60);
  assert.equal(model.globalFuelbed.source.parameterVersion, 'v1.2');
  if (model.globalFuelbed.canopyCoverFraction !== null) {
    assert.ok(model.globalFuelbed.canopyCoverFraction >= 0.05
      && model.globalFuelbed.canopyCoverFraction <= 1);
  }
  if (model.globalFuelbed.canopyBaseHeightMeters !== null) {
    const canopyTopHeight = Math.max(
      normalized.treeOverstoryHeightMeters,
      normalized.treeMidstoryHeightMeters
    );
    assert.ok(model.globalFuelbed.canopyBaseHeightMeters >= 0
      && model.globalFuelbed.canopyBaseHeightMeters <= canopyTopHeight,
    `${normalized.fuelbed} live-crown base exceeds canopy height`);
  }
  if (normalized.grassLivePercent !== null) liveGrassSplitCount += 1;
  if (model.globalFuelbed.canopyHeightMeters !== null) canopyStructureCount += 1;
  if (model.globalFuelbed.canopyBaseHeightMeters !== null) canopyBaseHeightCount += 1;

  for (const scenario of scenarios) {
    const spread = calculateSurfaceSpread({
      fuelModel: model,
      moistureFraction: scenario.dead,
      deadMoistureFraction: scenario.dead,
      liveMoistureFraction: scenario.live,
      deadMoistureByClass: { '1h': scenario.dead, '10h': scenario.dead, '100h': scenario.dead },
      liveMoistureByClass: { herbaceous: scenario.live, woody: scenario.live },
      midflameWindKmh: scenario.wind,
      windDirectionRadians: 0
    });
    for (const key of ['rateMPerMin', 'headRateMPerMin', 'flankRateMPerMin', 'backingRateMPerMin', 'firelineIntensityKwPerM']) {
      assert.ok(Number.isFinite(spread[key]) && spread[key] >= 0, `${normalized.fuelbed} ${key} invalid`);
    }
    surfaceScenarioCount += 1;
  }
}

assert.equal(builtCount + rejectedCount, payload.rows.length);
assert.ok(builtCount >= 300);
assert.ok(rejectedCount > 0);
assert.equal(surfaceScenarioCount, builtCount * scenarios.length);

console.log(JSON.stringify({
  source: payload.source,
  rows: payload.rows.length,
  builtCount,
  rejectedCount,
  liveGrassSplitCount,
  canopyStructureCount,
  canopyBaseHeightCount,
  surfaceScenarioCount,
  pass: true
}, null, 2));
