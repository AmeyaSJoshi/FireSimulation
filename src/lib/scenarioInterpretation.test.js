import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpreadExplanation, formatCompassDirection, formatElevationRange, formatModelTime } from './scenarioInterpretation.js';

test('formats model time without hiding the educational timestep', () => {
  assert.equal(formatModelTime(0), '0 min');
  assert.equal(formatModelTime(1), '1 min');
  assert.equal(formatModelTime(75), '1 h 15 min');
  assert.equal(formatModelTime(125), '2 h 05 min');
});

test('converts spread angles into stable compass labels', () => {
  assert.equal(formatCompassDirection(0), 'N');
  assert.equal(formatCompassDirection(22.5), 'NE');
  assert.equal(formatCompassDirection(90), 'E');
  assert.equal(formatCompassDirection(-45), 'NW');
  assert.equal(formatCompassDirection(360), 'N');
});

test('summarizes sampled terrain elevation', () => {
  assert.equal(formatElevationRange(new Float32Array([-12.4, 18.6, 204.9])), '-12–205 m');
  assert.equal(formatElevationRange(null), 'Unavailable');
});

test('explains the strongest active spread driver', () => {
  assert.equal(
    buildSpreadExplanation({ direction: 'E', windSpeed: 42, slopeStrength: 0.1, moisture: 0.2 }),
    'Wind is driving spread toward the east.'
  );
  assert.equal(
    buildSpreadExplanation({ direction: 'N', windSpeed: 0, slopeStrength: 0.8, moisture: 0.2 }),
    'Slope is favoring uphill spread toward the north.'
  );
  assert.equal(
    buildSpreadExplanation({ direction: 'S', windSpeed: 0, slopeStrength: 0, moisture: 0.85 }),
    'High moisture is suppressing spread toward the south.'
  );
});
