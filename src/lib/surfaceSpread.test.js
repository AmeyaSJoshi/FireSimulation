import test from 'node:test';
import assert from 'node:assert/strict';
import { getFuelModel } from './fuelModels.js';
import { calculateSurfaceSpread } from './surfaceSpread.js';

const grass = getFuelModel('GR2');

function spread(overrides = {}) {
  return calculateSurfaceSpread({
    fuelModel: grass,
    moistureFraction: 0.08,
    midflameWindKmh: 0,
    windDirectionRadians: 0,
    slopeRadians: 0,
    slopeAspectEast: 0,
    slopeAspectNorth: 0,
    travelDirectionEast: 1,
    travelDirectionNorth: 0,
    ...overrides
  });
}

test('returns finite SI rates and inspectable Rothermel intermediates', () => {
  const result = spread();

  assert.ok(result.rateMPerMin > 0);
  assert.ok(Number.isFinite(result.reactionIntensityKjPerM2Min));
  assert.ok(Number.isFinite(result.propagatingFluxRatio));
  assert.ok(Number.isFinite(result.factors.wind));
  assert.ok(Number.isFinite(result.factors.slope));
  assert.equal(result.units.rate, 'm/min');
  assert.equal(result.units.reactionIntensity, 'kJ/m²/min');
  assert.deepEqual(result.warnings, []);
});

test('derives fireline intensity from reaction intensity and residence time', () => {
  const result = spread({ midflameWindKmh: 12 });
  const expected = result.reactionIntensityKjPerM2Min
    * result.intermediate.residenceTimeMinutes
    * result.rateMPerMin / 60;

  assert.ok(Math.abs(result.firelineIntensityKwPerM - expected) < 1e-9);
  assert.ok(result.firelineIntensityKwPerM > 0);
});

test('exposes the Rothermel heat-area and rate relationship used for travel time', () => {
  const result = spread({ midflameWindKmh: 12 });
  const expectedHeatArea = result.reactionIntensityKjPerM2Min
    * result.intermediate.residenceTimeMinutes;
  const impliedFirelineIntensity = expectedHeatArea * result.rateMPerMin / 60;

  assert.ok(Math.abs(result.heatPerUnitAreaKjPerM2 - expectedHeatArea) < 1e-9);
  assert.ok(Math.abs(result.firelineIntensityKwPerM - impliedFirelineIntensity) < 1e-9);
  assert.equal(result.units.heatPerUnitArea, 'kJ/m²');
});

test('matches the published heat-of-preignition and heating-number equations', () => {
  const result = spread({ moistureFraction: 0.08 });

  // Andrews (2018), RMRS-GTR-371: Qig = 250 + 1116 Mf in Btu/lb and
  // epsilon = exp(-138 / sigma), with the explicit conversion to SI.
  assert.ok(Math.abs(result.intermediate.heatOfPreignitionKjPerKg - 789.16528) < 1e-6);
  assert.ok(Math.abs(result.intermediate.effectiveHeatingNumber - 0.9269847025) < 1e-9);
});

test('matches the published TU2 BehavePlus fireline-intensity reference case', () => {
  // Andrews (2014), Current status and future needs of the BehavePlus Fire
  // Modeling System, Fig. 3: TU2, 5% dead moisture, 50% live moisture,
  // 10% slope, with fireline intensity 130/293/497/733 kW/m at 3/6/9/12
  // km/h midflame wind. The source is a USFS-hosted paper describing the
  // BehavePlus SURFACE module built on Rothermel (1972).
  const tu2 = getFuelModel('TU2');
  const expected = [130, 293, 497, 733];
  for (const [index, wind] of [3, 6, 9, 12].entries()) {
    const result = calculateSurfaceSpread({
      fuelModel: tu2,
      deadMoistureFraction: 0.05,
      liveMoistureFraction: 0.50,
      midflameWindKmh: wind,
      windDirectionRadians: 0,
      slopeRadians: Math.atan(0.10),
      slopeAspectEast: 1,
      slopeAspectNorth: 0,
      travelDirectionEast: 1,
      travelDirectionNorth: 0
    });
    assert.ok(Math.abs(result.firelineIntensityKwPerM - expected[index]) <= expected[index] * 0.05,
      `wind ${wind}: expected ${expected[index]} kW/m, got ${result.firelineIntensityKwPerM}`);
  }
});

test('flat calm conditions are approximately isotropic', () => {
  const east = spread({ travelDirectionEast: 1, travelDirectionNorth: 0 });
  const north = spread({ travelDirectionEast: 0, travelDirectionNorth: 1 });

  assert.ok(Math.abs(east.rateMPerMin - north.rateMPerMin) < 1e-9);
});

test('wind produces head, flank, and backing ordering', () => {
  const head = spread({
    midflameWindKmh: 24,
    windDirectionRadians: 0,
    travelDirectionEast: 1,
    travelDirectionNorth: 0
  });
  const flank = spread({
    midflameWindKmh: 24,
    windDirectionRadians: 0,
    travelDirectionEast: 0,
    travelDirectionNorth: 1
  });
  const backing = spread({
    midflameWindKmh: 24,
    windDirectionRadians: 0,
    travelDirectionEast: -1,
    travelDirectionNorth: 0
  });

  assert.ok(head.rateMPerMin > flank.rateMPerMin);
  assert.ok(flank.rateMPerMin >= backing.rateMPerMin);
  assert.ok(backing.rateMPerMin > 0);
});

test('upslope spread exceeds downslope spread', () => {
  const uphill = spread({
    slopeRadians: Math.atan(0.35),
    slopeAspectEast: 1,
    slopeAspectNorth: 0,
    travelDirectionEast: 1,
    travelDirectionNorth: 0
  });
  const downhill = spread({
    slopeRadians: Math.atan(0.35),
    slopeAspectEast: 1,
    slopeAspectNorth: 0,
    travelDirectionEast: -1,
    travelDirectionNorth: 0
  });

  assert.ok(uphill.rateMPerMin > downhill.rateMPerMin);
  assert.ok(downhill.rateMPerMin > 0);
});

test('higher fuel moisture suppresses spread', () => {
  const dry = spread({ moistureFraction: 0.04 });
  const wet = spread({ moistureFraction: 0.14 });

  assert.ok(dry.rateMPerMin > wet.rateMPerMin);
  assert.ok(wet.rateMPerMin > 0);
});

test('lower fuel availability suppresses spread without changing the fuel identity', () => {
  const full = spread({ fuelLoadScale: 1 });
  const sparse = spread({ fuelLoadScale: 0.2 });

  assert.ok(full.rateMPerMin > sparse.rateMPerMin);
  assert.ok(sparse.rateMPerMin > 0);
  assert.equal(sparse.fuelModel, 'GR2');
  assert.equal(sparse.fuelLoadScale, 0.2);
});

test('separate live moisture suppresses live-fuel contribution', () => {
  const liveFuel = getFuelModel('GR1');
  const dryLive = spread({ fuelModel: liveFuel, deadMoistureFraction: 0.08, liveMoistureFraction: 0.20 });
  const wetLive = spread({ fuelModel: liveFuel, deadMoistureFraction: 0.08, liveMoistureFraction: 0.35 });

  assert.ok(dryLive.rateMPerMin > wetLive.rateMPerMin);
  assert.ok(dryLive.intermediate.liveReactionContribution > wetLive.intermediate.liveReactionContribution);
  assert.equal(dryLive.intermediate.characteristicDeadMoistureFraction, 0.08);
  assert.equal(dryLive.intermediate.characteristicLiveMoistureFraction, 0.20);
});

test('accepts measured moisture by dead size class and live category', () => {
  const tu2 = getFuelModel('TU2');
  const dryFine = calculateSurfaceSpread({
    fuelModel: tu2,
    deadMoistureFraction: 0.20,
    liveMoistureFraction: 0.20,
    deadMoistureByClass: { '1h': 0.02, '10h': 0.20, '100h': 0.20 },
    liveMoistureByClass: { herbaceous: 0.20, woody: 0.20 },
    midflameWindKmh: 0,
    windDirectionRadians: 0
  });
  const wetFine = calculateSurfaceSpread({
    fuelModel: tu2,
    deadMoistureFraction: 0.20,
    liveMoistureFraction: 0.20,
    deadMoistureByClass: { '1h': 0.20, '10h': 0.02, '100h': 0.02 },
    liveMoistureByClass: { herbaceous: 0.20, woody: 0.20 },
    midflameWindKmh: 0,
    windDirectionRadians: 0
  });

  assert.ok(dryFine.rateMPerMin > wetFine.rateMPerMin);
  assert.ok(
    dryFine.intermediate.characteristicDeadMoistureFraction
      < wetFine.intermediate.characteristicDeadMoistureFraction
  );
});

test('dead fuel at its moisture of extinction cannot sustain spread', () => {
  const result = spread({ deadMoistureFraction: grass.moistureOfExtinctionFraction, liveMoistureFraction: 0.2 });

  assert.equal(result.rateMPerMin, 0);
  assert.equal(result.reactionIntensityKjPerM2Min, 0);
  assert.ok(result.warnings.includes('dead fuel moisture at or above extinction'));
});

test('non-burnable fuel returns zero spread without NaN values', () => {
  const result = spread({ fuelModel: getFuelModel('NB') });

  assert.equal(result.rateMPerMin, 0);
  assert.equal(result.reactionIntensityKjPerM2Min, 0);
  assert.equal(result.firelineIntensityKwPerM, 0);
  assert.ok(result.warnings.includes('non-burnable fuel'));
});

test('reversing wind reverses the directional bias', () => {
  const eastWind = spread({
    midflameWindKmh: 24,
    windDirectionRadians: 0,
    travelDirectionEast: 1,
    travelDirectionNorth: 0
  });
  const westWind = spread({
    midflameWindKmh: 24,
    windDirectionRadians: Math.PI,
    travelDirectionEast: 1,
    travelDirectionNorth: 0
  });

  assert.ok(eastWind.rateMPerMin > westWind.rateMPerMin);
});

test('rejects a missing fuel model instead of silently inventing one', () => {
  assert.throws(
    () => calculateSurfaceSpread({ moistureFraction: 0.08 }),
    /fuelModel/
  );
});
