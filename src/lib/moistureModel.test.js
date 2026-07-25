import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLiveMoistureOfExtinction, characteristicFuelMoisture, moistureDamping } from './moistureModel.js';

test('weights characteristic moisture toward fine fuels using surface area', () => {
  const result = characteristicFuelMoisture([
    { loadKgPerM2: 0.1, savRatioPerMeter: 6562, moistureFraction: 0.04 },
    { loadKgPerM2: 0.9, savRatioPerMeter: 98, moistureFraction: 0.40 }
  ]);

  assert.ok(result.fraction < 0.10);
  assert.ok(result.heatingNumber > 0);
});

test('computes live moisture of extinction from dead/live heating-number loads', () => {
  const deadRows = [{ loadKgPerM2: 0.1, savRatioPerMeter: 6562 }];
  const liveRows = [{ loadKgPerM2: 0.3, savRatioPerMeter: 5906 }];
  const deadMoistureFraction = 0.05;
  const deadExtinctionFraction = 0.15;
  const deadSigmaPerFoot = 6562 * 0.3048;
  const liveSigmaPerFoot = 5906 * 0.3048;
  const ratio = (
    0.1 * Math.exp(-138 / deadSigmaPerFoot)
  ) / (
    0.3 * Math.exp(-500 / liveSigmaPerFoot)
  );
  const expected = Math.max(
    deadExtinctionFraction,
    2.9 * ratio * (1 - deadMoistureFraction / deadExtinctionFraction) - 0.226
  );

  assert.ok(Math.abs(calculateLiveMoistureOfExtinction({
    deadRows,
    liveRows,
    deadMoistureFraction,
    deadExtinctionFraction
  }) - expected) < 1e-12);
});

test('moisture damping is one when dry and zero at extinction', () => {
  assert.equal(moistureDamping(0, 0.15), 1);
  assert.equal(moistureDamping(0.15, 0.15), 0);
});
