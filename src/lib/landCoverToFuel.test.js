import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crosswalkLandCoverToFuel,
  LAND_COVER_CROSSWALK_VERSION
} from './landCoverToFuel.js';
import { NON_BURNABLE_FUEL_CODE } from './fuelModels.js';

test('exposes a version so records can survive future crosswalk edits', () => {
  assert.match(LAND_COVER_CROSSWALK_VERSION, /^\d+\.\d+\.\d+$/);
});

test('grassland (WorldCover code 30) maps to a grass fuel model', () => {
  const decision = crosswalkLandCoverToFuel({ classCode: 30, className: 'Grassland' });
  assert.match(decision.fuelCode, /^GR/, `expected GR* fuel, got ${decision.fuelCode}`);
  assert.equal(decision.burnable, true);
});

test('tree cover (10) maps to a timber-litter fuel model', () => {
  const decision = crosswalkLandCoverToFuel({ classCode: 10, className: 'Tree cover' });
  assert.match(decision.fuelCode, /^TL/, `expected TL* fuel, got ${decision.fuelCode}`);
  assert.equal(decision.burnable, true);
});

test('shrubland (20) maps to a shrub fuel model', () => {
  const decision = crosswalkLandCoverToFuel({ classCode: 20, className: 'Shrubland' });
  assert.match(decision.fuelCode, /^SH/, `expected SH* fuel, got ${decision.fuelCode}`);
  assert.equal(decision.burnable, true);
});

test('cropland (40) maps to the experimental agricultural fuel model with low confidence', () => {
  const decision = crosswalkLandCoverToFuel({ classCode: 40, className: 'Cropland' });
  assert.equal(decision.fuelCode, 'AG1');
  assert.equal(decision.confidence, 'low');
  assert.match(decision.rationale, /agricultur/i);
});

test('built-up (50), water (80), snow/ice (70) all map to non-burnable', () => {
  for (const [code, name] of [[50, 'Built-up'], [80, 'Water'], [70, 'Snow and ice']]) {
    const decision = crosswalkLandCoverToFuel({ classCode: code, className: name });
    assert.equal(decision.fuelCode, NON_BURNABLE_FUEL_CODE, `class ${code} ${name}`);
    assert.equal(decision.burnable, false);
  }
});

test('null / undefined land cover produces an experimental-confidence result and does not throw', () => {
  const forNull = crosswalkLandCoverToFuel(null);
  assert.equal(forNull.confidence, 'experimental');
  assert.equal(forNull.burnable, true, 'must still allow ignition with a conservative default');
  assert.match(forNull.rationale, /(no land cover|unavailable)/i);

  const forUndefined = crosswalkLandCoverToFuel(undefined);
  assert.equal(forUndefined.confidence, 'experimental');
});

test('an unknown WorldCover class returns experimental with a rationale mentioning the code', () => {
  const decision = crosswalkLandCoverToFuel({ classCode: 999, className: 'Test class' });
  assert.equal(decision.confidence, 'experimental');
  assert.match(decision.rationale, /999/);
});

test('every result carries a citation to the source crosswalk decision', () => {
  const cases = [
    { classCode: 30 }, { classCode: 10 }, { classCode: 50 },
    { classCode: 999 }, null, undefined
  ];
  for (const input of cases) {
    const result = crosswalkLandCoverToFuel(input);
    assert.ok(result.crosswalkVersion, `missing version for input ${JSON.stringify(input)}`);
    assert.equal(result.crosswalkVersion, LAND_COVER_CROSSWALK_VERSION);
  }
});

test('confidence is one of the four allowed levels for every crosswalk row', () => {
  const validLevels = new Set(['high', 'medium', 'low', 'experimental']);
  for (const code of [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100, 999]) {
    const decision = crosswalkLandCoverToFuel({ classCode: code });
    assert.ok(validLevels.has(decision.confidence),
      `class ${code}: unexpected confidence ${decision.confidence}`);
  }
});
