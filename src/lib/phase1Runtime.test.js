import test from 'node:test';
import assert from 'node:assert/strict';
import { compassToMathRadians } from './weatherInputs.js';
import { resolvePhase1RuntimeInputs } from './phase1Runtime.js';

test('manual wind controls override the weather-resolved wind on reconfigure', () => {
  const runtime = resolvePhase1RuntimeInputs({
    midflameWindKmh: 8,
    windDirectionRadians: 1.2,
    moistureFraction: 0.32,
    defaultSlopeRadians: 0,
    defaultSlopeAspectNorth: 0,
    params: { windSpeed: 20, windDirection: 90, moisture: 0.18, slopeStrength: 0.5 }
  });

  assert.equal(runtime.midflameWindKmh, 8);
  assert.equal(runtime.tenMeterWindKmh, 20);
  assert.equal(runtime.windDirectionRadians, compassToMathRadians(90));
  assert.equal(runtime.moistureFraction, 0.18);
  assert.equal(runtime.defaultSlopeRadians, Math.atan(0.5));
});

test('weather-resolved wind remains active when the user leaves wind at calm', () => {
  const runtime = resolvePhase1RuntimeInputs({
    midflameWindKmh: 6.5,
    windDirectionRadians: -0.7,
    params: { windSpeed: 0, windDirection: 0, moisture: 0.24, slopeStrength: 0 }
  });

  assert.equal(runtime.midflameWindKmh, 6.5);
  assert.equal(runtime.tenMeterWindKmh, null);
  assert.equal(runtime.windDirectionRadians, -0.7);
  assert.equal(runtime.moistureFraction, 0.24);
});

test('slope preset points the fallback aspect uphill while real terrain can override it', () => {
  const runtime = resolvePhase1RuntimeInputs({
    defaultSlopeRadians: 0,
    defaultSlopeAspectNorth: 0,
    params: { scenario: 'slope', slopeStrength: 1 }
  });

  assert.equal(runtime.defaultSlopeRadians, Math.atan(1));
  assert.equal(runtime.defaultSlopeAspectEast, 0);
  assert.equal(runtime.defaultSlopeAspectNorth, 1);
});

test('resolves separate dead and live fuel moisture controls', () => {
  const runtime = resolvePhase1RuntimeInputs({
    moistureFraction: 0.32,
    params: { deadMoisture: 0.08, liveMoisture: 0.62 }
  });

  assert.equal(runtime.deadMoistureFraction, 0.08);
  assert.equal(runtime.liveMoistureFraction, 0.62);
  assert.equal(runtime.moistureFraction, 0.08);
});
