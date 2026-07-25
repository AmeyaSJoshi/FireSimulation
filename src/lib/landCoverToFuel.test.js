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
  assert.equal(decision.fuelLoadScale, 1);
});

test('tree cover (10) maps to a timber-litter fuel model', () => {
  const decision = crosswalkLandCoverToFuel({ classCode: 10, className: 'Tree cover' });
  assert.match(decision.fuelCode, /^TL/, `expected TL* fuel, got ${decision.fuelCode}`);
  assert.equal(decision.burnable, true);
  assert.deepEqual(decision.fuelModelAlternatives, ['TL1', 'TL3', 'TU2']);
});

test('published global fuelbeds override coarse class guesses when available', () => {
  const decision = crosswalkLandCoverToFuel({
    classCode: 10,
    className: 'Tree cover',
    globalFuelbed: {
      fuelbed: '6091b',
      joinValue: 915091,
      dead1hLoadMgPerHa: 0.7,
      dead10hLoadMgPerHa: 1.8,
      dead100hLoadMgPerHa: 4.9
    }
  });
  assert.equal(decision.fuelCode, 'GF_6091b');
  assert.equal(decision.fuelModelDefinition.deadFuel[1].loadKgPerM2, 0.18);
  assert.equal(decision.confidence, 'low');
  assert.match(decision.landCoverSource, /Global Fuelbed Dataset/);
});

test('direct LANDFIRE FBFM40 observations override global and coarse fuel guesses', () => {
  const decision = crosswalkLandCoverToFuel({
    classCode: 10,
    className: 'Tree cover',
    landfireFuelModelCode: 'TL9',
    globalFuelbed: { fuelbed: '6091b', dead1hLoadMgPerHa: 0.7 }
  });
  assert.equal(decision.fuelCode, 'TL9');
  assert.equal(decision.confidence, 'high');
  assert.equal(decision.landfireFuelModelCode, 'TL9');
  assert.equal(decision.fuelModelDefinition.code, 'TL9');
  assert.match(decision.rationale, /LANDFIRE/);
});

test('direct LANDFIRE non-burnable output remains a barrier', () => {
  const decision = crosswalkLandCoverToFuel({
    classCode: 30,
    className: 'Grassland',
    landfireFuelModelCode: 'NB'
  });
  assert.equal(decision.fuelCode, NON_BURNABLE_FUEL_CODE);
  assert.equal(decision.burnable, false);
  assert.equal(decision.fuelLoadScale, 0);
});

test('explicit water stays non-burnable even if regional data is inconsistent', () => {
  const decision = crosswalkLandCoverToFuel({
    classCode: 80,
    className: 'Permanent water',
    burnable: false,
    landfireFuelModelCode: 'GR9'
  });
  assert.equal(decision.fuelCode, NON_BURNABLE_FUEL_CODE);
  assert.equal(decision.burnable, false);
});

test('global fuelbeds cannot override explicit water classes', () => {
  const decision = crosswalkLandCoverToFuel({
    classCode: 80,
    className: 'Permanent water',
    burnable: false,
    globalFuelbed: {
      fuelbed: '6091b',
      dead1hLoadMgPerHa: 0.7
    }
  });
  assert.equal(decision.fuelCode, NON_BURNABLE_FUEL_CODE);
  assert.equal(decision.burnable, false);
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
  assert.equal(decision.fuelLoadScale, 0.65);
});

test('sparse and wet land-cover classes retain lower fuel availability priors', () => {
  const sparse = crosswalkLandCoverToFuel({ classCode: 60, className: 'Bare / sparse' });
  const wetland = crosswalkLandCoverToFuel({ classCode: 90, className: 'Herbaceous wetland' });

  assert.ok(sparse.fuelLoadScale < wetland.fuelLoadScale);
  assert.ok(wetland.fuelLoadScale < 1);
  assert.equal(sparse.confidence, 'low');
});

test('fine WorldCover burnable fraction reduces fuel availability without changing fuel identity', () => {
  const decision = crosswalkLandCoverToFuel({
    classCode: 30,
    className: 'Grassland',
    source: 'ESA WorldCover fine test',
    fineSampleCount: 4,
    fineBurnableFraction: 0.5
  });

  assert.equal(decision.fuelCode, 'GR2');
  assert.equal(decision.fuelLoadScale, 0.5);
  assert.equal(decision.fineSampleCount, 4);
  assert.equal(decision.fineBurnableFraction, 0.5);
  assert.match(decision.rationale, /burnable ground/);
});

test('built-up (50), water (80), snow/ice (70) all map to non-burnable', () => {
  for (const [code, name] of [[50, 'Built-up'], [80, 'Water'], [70, 'Snow and ice']]) {
    const decision = crosswalkLandCoverToFuel({ classCode: code, className: name });
    assert.equal(decision.fuelCode, NON_BURNABLE_FUEL_CODE, `class ${code} ${name}`);
    assert.equal(decision.burnable, false);
    assert.equal(decision.fuelLoadScale, 0);
  }
});

test('WorldCover no-data cells are non-burnable instead of experimental fuel', () => {
  const decision = crosswalkLandCoverToFuel({ classCode: 0, className: 'No data', burnable: false });
  assert.equal(decision.fuelCode, NON_BURNABLE_FUEL_CODE);
  assert.equal(decision.burnable, false);
});

test('Copernicus fractional water cover creates a hard non-burnable barrier', () => {
  const decision = crosswalkLandCoverToFuel({
    classCode: 30,
    className: 'Grassland',
    source: 'Copernicus Global Dynamic Land Cover v3',
    coverFractions: {
      permanentWaterCoverFraction: 60,
      seasonalWaterCoverFraction: 0
    }
  });
  assert.equal(decision.fuelCode, NON_BURNABLE_FUEL_CODE);
  assert.equal(decision.burnable, false);
  assert.equal(decision.fuelLoadScale, 0);
  assert.match(decision.rationale, /fractional water cover/i);
});

test('Copernicus vegetation fractions select the dominant fuel and scale available cover', () => {
  const decision = crosswalkLandCoverToFuel({
    classCode: 30,
    className: 'Grassland',
    coverFractions: {
      treeCoverFraction: 80,
      shrubCoverFraction: 0,
      grassCoverFraction: 10,
      cropsCoverFraction: 0,
      bareCoverFraction: 10
    },
    fractionalCoverSource: 'Copernicus Global Dynamic Land Cover v3',
    fractionalCoverResolutionMeters: 100,
    fractionalCoverConfidence: 'high'
  });

  assert.equal(decision.fuelCode, 'TL1');
  assert.equal(decision.fuelLoadScale, 0.9);
  assert.equal(decision.confidence, 'low');
  assert.equal(decision.fractionalCoverUsed, true);
  assert.match(decision.rationale, /dominant tree/i);
});

test('fractional grass and shrub samples preserve wetland and shrub fuel semantics', () => {
  const grass = crosswalkLandCoverToFuel({
    classCode: 90,
    className: 'Herbaceous wetland',
    coverFractions: { grassCoverFraction: 70, bareCoverFraction: 30 }
  });
  const shrub = crosswalkLandCoverToFuel({
    classCode: 20,
    className: 'Shrubland',
    coverFractions: { shrubCoverFraction: 60, bareCoverFraction: 40 }
  });

  assert.equal(grass.fuelCode, 'GS1');
  assert.equal(grass.fuelLoadScale, 0.7);
  assert.equal(shrub.fuelCode, 'SH2');
  assert.equal(shrub.fuelLoadScale, 0.6);
});

test('very sparse fractional vegetation leaves the WorldCover fallback in charge', () => {
  const decision = crosswalkLandCoverToFuel({
    classCode: 60,
    className: 'Bare / sparse',
    coverFractions: { grassCoverFraction: 10, bareCoverFraction: 90 }
  });

  assert.equal(decision.fuelCode, 'GR1');
  assert.equal(decision.fuelLoadScale, 0.15);
  assert.equal(decision.fractionalCoverUsed, false);
});

test('null / undefined land cover produces an experimental-confidence result and does not throw', () => {
  const forNull = crosswalkLandCoverToFuel(null);
  assert.equal(forNull.confidence, 'experimental');
  assert.equal(forNull.burnable, true, 'must still allow ignition with a conservative default');
  assert.equal(forNull.fuelLoadScale, 1);
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
