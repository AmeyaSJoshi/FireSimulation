import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ellipseLengthToWidthRatio,
  ellipseRateFromHeadBacking
} from './fireEllipse.js';

test('preserves heading and backing rates at the ellipse endpoints', () => {
  const headRateMPerMin = 12;
  const backingRateMPerMin = 3;

  assert.ok(Math.abs(
    ellipseRateFromHeadBacking({ headRateMPerMin, backingRateMPerMin, angleRadians: 0 })
      - headRateMPerMin
  ) < 1e-12);
  assert.ok(Math.abs(
    ellipseRateFromHeadBacking({ headRateMPerMin, backingRateMPerMin, angleRadians: Math.PI })
      - backingRateMPerMin
  ) < 1e-12);
});

test('returns the standard transverse ellipse rate', () => {
  const rate = ellipseRateFromHeadBacking({
    headRateMPerMin: 12,
    backingRateMPerMin: 3,
    angleRadians: Math.PI / 2
  });

  assert.ok(Math.abs(rate - 4.8) < 1e-12);
});

test('derives length-to-width ratio from the head-to-backing rate pair', () => {
  assert.ok(Math.abs(ellipseLengthToWidthRatio({
    headRateMPerMin: 12,
    backingRateMPerMin: 3
  }) - 1.25) < 1e-12);
});
