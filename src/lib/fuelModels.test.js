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

test('publishes the complete 40-model Scott and Burgan family for LANDFIRE FBFM40', () => {
  const expectedFamilies = ['GR', 'GS', 'SH', 'TU', 'TL', 'SB'];
  const codes = listFuelModelCodes();
  for (const family of expectedFamilies) {
    const familyCodes = codes.filter((code) => code.startsWith(family));
    assert.equal(familyCodes.length, family === 'GR' || family === 'SH' || family === 'TL' ? 9 : family === 'TU' ? 5 : family === 'GS' || family === 'SB' ? 4 : 0);
    for (const code of familyCodes) assert.ok(getFuelModel(code).burnable, `${code} should be burnable`);
  }
});

test('generated FBFM40 rows preserve published load, depth, and moisture conversions', () => {
  const tonsToKg = (value) => value * 0.2242;
  const gr9 = getFuelModel('GR9');
  assert.ok(Math.abs(gr9.liveFuel[0].loadKgPerM2 - tonsToKg(9.0)) < 1e-12);
  assert.equal(gr9.fuelBedDepthMeters, 5 * 0.3048);
  assert.equal(gr9.moistureOfExtinctionFraction, 0.40);

  const sh9 = getFuelModel('SH9');
  assert.ok(Math.abs(sh9.deadFuel[1].loadKgPerM2 - tonsToKg(2.45)) < 1e-12);
  assert.ok(Math.abs(sh9.liveFuel[1].loadKgPerM2 - tonsToKg(7.00)) < 1e-12);
  assert.equal(sh9.fuelBedDepthMeters, 4.4 * 0.3048);

  const tl8 = getFuelModel('TL8');
  assert.ok(Math.abs(tl8.deadFuel[0].loadKgPerM2 - tonsToKg(5.8)) < 1e-12);
  assert.equal(tl8.windAdjustmentFactor, null);
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

test('every fuel model exposes the particle properties required by Rothermel', () => {
  for (const code of listFuelModelCodes()) {
    const model = getFuelModel(code);
    assert.ok(model.particleDensityKgPerM3 > 0, `${code}: particle density`);
    assert.equal(model.totalMineralContentFraction, 0.0555, `${code}: total mineral content`);
    assert.equal(model.effectiveMineralContentFraction, 0.01, `${code}: effective mineral content`);
  }
});

test('Scott and Burgan reference rows retain their published SI conversions', () => {
  const load = (tonsPerAcre) => tonsPerAcre * 0.2242;
  const sav = (perFoot) => perFoot * 3.28084;
  const assertClose = (actual, expected, label, tolerance = 0.001) => {
    assert.ok(Math.abs(actual - expected) < tolerance,
      `${label}: expected ${expected}, got ${actual}`);
  };

  const gr1 = getFuelModel('GR1');
  assertClose(gr1.deadFuel[0].savRatioPerMeter, sav(2200), 'GR1 1-h SAV', 0.5);
  assertClose(gr1.liveFuel[0].savRatioPerMeter, sav(2000), 'GR1 live herb SAV', 0.5);

  const gr2 = getFuelModel('GR2');
  assertClose(gr2.liveFuel[0].savRatioPerMeter, sav(1800), 'GR2 live herb SAV', 0.5);

  const gs1 = getFuelModel('GS1');
  assertClose(gs1.liveFuel[0].loadKgPerM2, load(0.50), 'GS1 live herb load');
  assertClose(gs1.liveFuel[0].savRatioPerMeter, sav(1800), 'GS1 live herb SAV', 0.5);
  assertClose(gs1.liveFuel[1].loadKgPerM2, load(0.65), 'GS1 live woody load');
  assertClose(gs1.liveFuel[1].savRatioPerMeter, sav(1800), 'GS1 live woody SAV', 0.5);

  const sh2 = getFuelModel('SH2');
  assertClose(sh2.deadFuel[1].loadKgPerM2, load(2.40), 'SH2 10-h load');
  assertClose(sh2.liveFuel[0].savRatioPerMeter, sav(9999), 'SH2 live herb SAV', 0.5);
  assertClose(sh2.liveFuel[1].loadKgPerM2, load(3.85), 'SH2 live woody load');
  assertClose(sh2.liveFuel[1].savRatioPerMeter, sav(1600), 'SH2 live woody SAV', 0.5);

  const tl1 = getFuelModel('TL1');
  assertClose(tl1.deadFuel[1].loadKgPerM2, load(2.20), 'TL1 10-h load');

  const tl3 = getFuelModel('TL3');
  assertClose(tl3.deadFuel[2].loadKgPerM2, load(2.80), 'TL3 100-h load');
});

test('includes the TU2 reference model used by the BehavePlus validation case', () => {
  const tu2 = getFuelModel('TU2');
  const load = (tonsPerAcre) => tonsPerAcre * 0.2242;
  const sav = (perFoot) => perFoot * 3.28084;

  assert.equal(tu2.displayName, 'Moderate load humid climate timber-shrub');
  assert.equal(tu2.moistureOfExtinctionFraction, 0.30);
  assert.equal(tu2.fuelBedDepthMeters, 0.3048);
  assert.equal(tu2.deadFuel[0].loadKgPerM2, load(1.0));
  assert.ok(Math.abs(tu2.deadFuel[1].loadKgPerM2 - load(1.8)) < 1e-12);
  assert.ok(Math.abs(tu2.deadFuel[2].loadKgPerM2 - load(1.3)) < 1e-12);
  assert.ok(Math.abs(tu2.liveFuel[1].loadKgPerM2 - load(0.2)) < 1e-12);
  assert.ok(Math.abs(tu2.deadFuel[0].savRatioPerMeter - sav(2000)) < 0.5);
  assert.ok(Math.abs(tu2.liveFuel[1].savRatioPerMeter - sav(1600)) < 0.5);
  assert.equal(tu2.windAdjustmentFactor, 0.36);
  assert.match(tu2.windAdjustmentCitation, /RMRS-GTR-192/);
});

test('published standard-model WAFs are present while experimental models stay explicit', () => {
  assert.deepEqual(
    ['GR1', 'GR2', 'GS1', 'SH2', 'TL1', 'TL3'].map((code) => getFuelModel(code).windAdjustmentFactor),
    [0.31, 0.36, 0.35, 0.36, 0.28, 0.29]
  );
  assert.equal(getFuelModel('AG1').windAdjustmentFactor, null);
  assert.equal(getFuelModel('AG1').windAdjustmentCitation, null);
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
