import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFuelModel } from './fuelModels.js';
import { createRateBasedFireSimulation } from './firePropagation.js';
import {
  createSeededRandom,
  perturbWeatherTimeline,
  runSeededArrivalEnsemble
} from './uncertainty.js';

test('seeded random perturbations are reproducible and bounded', () => {
  const first = createSeededRandom(17);
  const second = createSeededRandom(17);
  assert.deepEqual(
    Array.from({ length: 5 }, () => first()),
    Array.from({ length: 5 }, () => second())
  );

  const timeline = perturbWeatherTimeline([
    {
      minutesFromIgnition: 0,
      midflameWindKmh: 10,
      windDirectionRadians: 0,
      deadMoistureByClass: { '1h': 0.08, '10h': 0.1, '100h': 0.12 }
    }
  ], {
    rng: createSeededRandom(4),
    windFraction: 0.2,
    directionRadians: 0.1,
    moistureFraction: 0.02
  });

  assert.ok(timeline[0].midflameWindKmh >= 8 && timeline[0].midflameWindKmh <= 12);
  assert.ok(Math.abs(timeline[0].windDirectionRadians) <= 0.1);
  assert.ok(timeline[0].deadMoistureByClass['1h'] >= 0.06);
  assert.ok(timeline[0].deadMoistureByClass['1h'] <= 0.1);
});

test('arrival ensemble returns deterministic, labeled quantiles', () => {
  const baseConfig = {
    size: 9,
    cellSizeMeters: 100,
    ignition: { x: 4, y: 4 },
    fuelModel: getFuelModel('TU2'),
    deadMoistureFraction: 0.05,
    liveMoistureFraction: 0.5,
    terrainHeights: new Float32Array(81),
    timestepMinutes: 1,
    burnDurationMinutes: 30,
    maxPropagationMinutes: 240,
    weatherTimeline: [{
      minutesFromIgnition: 0,
      midflameWindKmh: 6,
      windDirectionRadians: 0,
      deadMoistureFraction: 0.05,
      liveMoistureFraction: 0.5
    }]
  };
  const createSimulation = (config) => createRateBasedFireSimulation(config);
  const first = runSeededArrivalEnsemble({
    baseConfig,
    createSimulation,
    memberCount: 5,
    seed: 17,
    perturbations: { windFraction: 0.1 }
  });
  const second = runSeededArrivalEnsemble({
    baseConfig,
    createSimulation,
    memberCount: 5,
    seed: 17,
    perturbations: { windFraction: 0.1 }
  });

  assert.equal(first.version.startsWith('phase5-uncertainty-'), true);
  assert.equal(first.memberCount, 5);
  assert.deepEqual(Array.from(first.arrivalTimeQuantiles.median), Array.from(second.arrivalTimeQuantiles.median));
  assert.equal(first.interpretation.calibratedProbability, false);
  assert.equal(first.arrivalTimeQuantiles.median.length, 81);
  assert.ok(first.footprintAtMinutes.median > 0);
});

test('arrival ensemble samples explicit fuel-model alternatives reproducibly', () => {
  const seen = [];
  const baseConfig = {
    fuelModelCodes: ['TL1', 'TL1', 'GR2'],
    fuelModelAlternativesByCell: [['TL1', 'TL3'], ['TL1', 'TU2'], null],
    maxPropagationMinutes: 10
  };
  const createSimulation = (config) => {
    seen.push([...config.fuelModelCodes]);
    return { getState: () => ({ arrivalTimes: new Float64Array([0, 1, 2]) }) };
  };

  const first = runSeededArrivalEnsemble({
    baseConfig,
    createSimulation,
    memberCount: 4,
    seed: 17
  });
  const firstChoices = seen.splice(0);
  runSeededArrivalEnsemble({
    baseConfig,
    createSimulation,
    memberCount: 4,
    seed: 17
  });

  assert.deepEqual(firstChoices, seen);
  assert.equal(first.perturbations.fuelModelAlternatives, true);
  assert.ok(firstChoices.some((codes) => codes[0] !== 'TL1' || codes[1] !== 'TL1'));
});
