import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FUEL_MODEL_TABLE_VERSION,
  getFuelModel,
  listFuelModelCodes,
  NON_BURNABLE_FUEL_CODE
} from './fuelModels.js';

test('exposes a version string so downstream records can survive future changes', () => {
  assert.match(FUEL_MODEL_TABLE_VERSION, /^\d+\.\d+\.\d+$/);
});

test('lists at least one model per major surface class we crosswalk from WorldCover', () => {
  const codes = listFuelModelCodes();
  // At minimum: short-grass, brush, timber-litter, and non-burnable
  assert.ok(codes.length >= 6, `expected ≥6 fuel models, got ${codes.length}`);
  assert.ok(codes.includes(NON_BURNABLE_FUEL_CODE));
});

test('every model carries a citation to its published source', () => {
  for (const code of listFuelModelCodes()) {
    const model = getFuelModel(code);
    assert.ok(model.citation, `fuel model ${code} missing citation`);
    assert.match(model.citation, /\d{4}/, `citation for ${code} should include a year`);
  }
});

test('every burnable model has finite, positive Rothermel parameters', () => {
  for (const code of listFuelModelCodes()) {
    const model = getFuelModel(code);
    if (!model.burnable) continue;
    assert.ok(model.fuelBedDepthMeters > 0, `${code}: fuelBedDepthMeters`);
    assert.ok(model.heatContentKjPerKg > 0, `${code}: heatContentKjPerKg`);
    assert.ok(model.moistureOfExtinctionFraction > 0 && model.moistureOfExtinctionFraction < 1,
      `${code}: moistureOfExtinctionFraction`);
    // At least one dead fuel class with load > 0
    const hasDeadLoad = model.deadFuel.some((row) => row.loadKgPerM2 > 0);
    assert.ok(hasDeadLoad, `${code}: expected at least one dead-fuel class with a positive load`);
    // Every fuel-class row has SAV ratio > 0
    for (const row of [...model.deadFuel, ...model.liveFuel]) {
      assert.ok(row.savRatioPerMeter > 0, `${code}: row ${row.className} SAV`);
    }
  }
});

test('the non-burnable code returns burnable=false with zero fuel load', () => {
  const nb = getFuelModel(NON_BURNABLE_FUEL_CODE);
  assert.equal(nb.burnable, false);
  const totalLoad = [...nb.deadFuel, ...nb.liveFuel].reduce((sum, r) => sum + r.loadKgPerM2, 0);
  assert.equal(totalLoad, 0);
});

test('getFuelModel throws for unknown codes rather than silently returning a default', () => {
  assert.throws(() => getFuelModel('NOT_A_REAL_CODE'), /unknown fuel model/i);
});

test('grass-type model has higher SAV than timber-type (grass is finer fuel)', () => {
  const grass = getFuelModel('GR1');
  const timber = getFuelModel('TL1');
  const grassSav = grass.deadFuel[0].savRatioPerMeter;
  const timberSav = timber.deadFuel[0].savRatioPerMeter;
  assert.ok(grassSav > timberSav,
    `grass SAV ${grassSav} should exceed timber SAV ${timberSav}`);
});

test('shrub-type model has higher 100-h dead fuel load than grass-type', () => {
  const grass = getFuelModel('GR1');
  const shrub = getFuelModel('SH2');
  const grass100 = grass.deadFuel.find((r) => r.className === '100h').loadKgPerM2;
  const shrub100 = shrub.deadFuel.find((r) => r.className === '100h').loadKgPerM2;
  assert.ok(shrub100 > grass100,
    `shrub 100-h load ${shrub100} should exceed grass 100-h load ${grass100}`);
});
