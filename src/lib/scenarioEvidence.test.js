import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyScenarioEvidence,
  formatScenarioEvidence,
  isWithinConusShowcaseBounds
} from './scenarioEvidence.js';

const completeFuel = {
  totalCellCount: 100,
  unknownOrUnclassifiedCellCount: 2
};

test('CONUS evidence becomes showcase-ready only when the main inputs arrive', () => {
  const profile = classifyScenarioEvidence({
    coordinates: { latitude: 39, longitude: -105 },
    terrainAvailable: true,
    fineLandCoverCoverage: 1,
    fractionalCoverAvailable: true,
    landfireCanopyAvailable: true,
    landfireFuelAvailable: true,
    weatherAvailable: true,
    fuelSummary: completeFuel
  });

  assert.equal(profile.tier, 'showcase');
  assert.equal(profile.profileId, 'conus-showcase');
  assert.equal(profile.readyCount, 7);
  assert.match(formatScenarioEvidence(profile), /CONUS showcase inputs · 7\/7/);
});

test('CONUS stays regional when a source is missing instead of overstating confidence', () => {
  const profile = classifyScenarioEvidence({
    coordinates: { latitude: 39, longitude: -105 },
    terrainAvailable: true,
    fineLandCoverCoverage: 1,
    weatherAvailable: true,
    landfireFuelAvailable: true,
    fuelSummary: completeFuel
  });

  assert.equal(profile.tier, 'regional');
  assert.equal(profile.readyCount, 5);
  assert.match(profile.caveat, /diagnostic/);
});

test('locations outside CONUS remain exploratory even when global inputs are complete', () => {
  assert.equal(isWithinConusShowcaseBounds({ latitude: 51, longitude: -114 }), false);
  const profile = classifyScenarioEvidence({
    coordinates: { latitude: 51, longitude: -114 },
    terrainAvailable: true,
    fineLandCoverCoverage: 1,
    fractionalCoverAvailable: true,
    landfireCanopyAvailable: true,
    landfireFuelAvailable: true,
    weatherAvailable: true,
    fuelSummary: completeFuel
  });

  assert.equal(profile.tier, 'exploratory');
  assert.match(formatScenarioEvidence(profile), /Global exploratory inputs/);
});
