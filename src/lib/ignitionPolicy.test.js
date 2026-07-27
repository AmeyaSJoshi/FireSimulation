import test from 'node:test';
import assert from 'node:assert/strict';
import { canIgniteFuelDecision, canIgniteSurface, surfaceIgnitionMessage } from './ignitionPolicy.js';

test('ignition is blocked only by confirmed water, not by an unresolved classification', () => {
  assert.equal(canIgniteSurface(false), true);
  assert.equal(canIgniteSurface(true), false);
  // null/undefined = the terrain sampler hasn't resolved yet, not a known
  // ocean click. Blocking on this used to make every pre-load click read as
  // permanently "unavailable," since retrying just re-read the same
// not-yet-loaded state. Unknown now proceeds; the scenario adapter's real
  // WorldCover classification (classCode 80) still catches actual water.
  assert.equal(canIgniteSurface(null), true);
  assert.equal(canIgniteSurface(undefined), true);
});

test('surface messages explain the ignition boundary', () => {
  assert.equal(surfaceIgnitionMessage(false), 'Location armed · ignition ready');
  assert.equal(surfaceIgnitionMessage(true), 'Water surface · no ignition');
  assert.equal(surfaceIgnitionMessage(null), 'Surface classification loading · try again');
});

test('non-burnable location fuel decisions cannot start a fire', () => {
  assert.equal(canIgniteFuelDecision({ burnable: false, fuelCode: 'NB' }), false);
  assert.equal(canIgniteFuelDecision({ burnable: true, fuelCode: 'GR2' }), true);
  assert.equal(canIgniteFuelDecision(null), false);
});
