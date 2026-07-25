import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeCrownRequiredRateMPerMin,
  blendCrownRate,
  calculateCrownFractionBurned,
  classifyCrownFire,
  crownInitiationIntensityKwPerM,
  calculateRothermelActiveCrownSpread
} from './crownFire.js';

test('matches the published Van Wagner initiation example', () => {
  const intensity = crownInitiationIntensityKwPerM({
    canopyBaseHeightMeters: 3,
    foliarMoistureFraction: 1
  });
  assert.ok(Math.abs(intensity - 875) < 2);
});

test('converts the active crown mass-flow threshold to rate', () => {
  assert.equal(activeCrownRequiredRateMPerMin({ canopyBulkDensityKgPerM3: 0.2 }), 15);
});

test('classifies surface, passive, and active fire using measured structure', () => {
  const base = {
    surfaceRateMPerMin: 5,
    surfaceHeatPerUnitAreaKjPerM2: 3000,
    canopyBaseHeightMeters: 1.5,
    canopyBulkDensityKgPerM3: 0.15,
    foliarMoistureFraction: 1
  };
  const surface = classifyCrownFire({
    ...base,
    surfaceFirelineIntensityKwPerM: 100,
    activeCrownRateMPerMin: 1
  });
  const passive = classifyCrownFire({
    ...base,
    surfaceFirelineIntensityKwPerM: 1000,
    activeCrownRateMPerMin: 5
  });
  const active = classifyCrownFire({
    ...base,
    surfaceFirelineIntensityKwPerM: 1000,
    activeCrownRateMPerMin: 30
  });
  assert.equal(surface.type, 'surface');
  assert.equal(passive.type, 'passive');
  assert.equal(active.type, 'active');
  assert.equal(active.crownFractionBurned, 1);
});

test('uses FM10 and the 40 percent open-wind crown correlation', () => {
  const calm = calculateRothermelActiveCrownSpread({ openWindKmh: 0 });
  const windy = calculateRothermelActiveCrownSpread({ openWindKmh: 30 });
  assert.equal(calm.fm10SurfaceSpread.fuelModel, 'FM10');
  assert.ok(windy.activeHeadRateMPerMin > calm.activeHeadRateMPerMin);
});

test('blends only when a measured transition fraction is supplied', () => {
  assert.equal(blendCrownRate({ surfaceRateMPerMin: 4, activeRateMPerMin: 20, crownFractionBurned: 0 }), 4);
  assert.equal(blendCrownRate({ surfaceRateMPerMin: 4, activeRateMPerMin: 20, crownFractionBurned: 1 }), 20);
  assert.equal(blendCrownRate({ surfaceRateMPerMin: 4, activeRateMPerMin: 20, crownFractionBurned: 0.5 }), 12);
});

test('crown fraction transitions linearly between torching and crowning indices', () => {
  assert.equal(calculateCrownFractionBurned({
    openWindKmh: 10,
    torchingIndexWindKmh: 10,
    crowningIndexWindKmh: 30
  }), 0);
  assert.equal(calculateCrownFractionBurned({
    openWindKmh: 20,
    torchingIndexWindKmh: 10,
    crowningIndexWindKmh: 30
  }), 0.5);
  assert.equal(calculateCrownFractionBurned({
    openWindKmh: 40,
    torchingIndexWindKmh: 10,
    crowningIndexWindKmh: 30
  }), 1);
  assert.equal(calculateCrownFractionBurned({
    openWindKmh: 20,
    torchingIndexWindKmh: 10,
    crowningIndexWindKmh: Infinity
  }), 0);
});
