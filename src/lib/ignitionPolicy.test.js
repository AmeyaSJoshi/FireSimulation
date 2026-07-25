import test from 'node:test';
import assert from 'node:assert/strict';
import { canIgniteFuelDecision, canIgniteSurface, surfaceIgnitionMessage } from './ignitionPolicy.js';

test('only a confirmed land surface can ignite', () => {
  assert.equal(canIgniteSurface(false), true);
  assert.equal(canIgniteSurface(true), false);
  assert.equal(canIgniteSurface(null), false);
  assert.equal(canIgniteSurface(undefined), false);
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
