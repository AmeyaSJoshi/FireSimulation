import test from 'node:test';
import assert from 'node:assert/strict';
import {
  byramFlameLengthMeters,
  albiniFlightTimeMinutes,
  computeSpotting,
  DEFAULT_MAX_LOFT_HEIGHT_METERS
} from './spotting.js';

// Expected numbers in this file come from two places, stated per test:
//  (a) hand-evaluation of the exact cited equations (Byram 1959 SI form as
//      restated in Alexander & Cruz 2012; Albini 1979 flight-time
//      equations D33/D34/D43/A58 as reproduced with equation numbers in
//      the open-source pyregence/pyretechnics port) — these are
//      arithmetic cross-checks of the implementation against the
//      documented formula, not independent published worked examples,
//      because Albini's original 1979 report was not machine-extractable
//      in this environment (see src/lib/spotting.js header for the full
//      sourcing discussion and caveats).
//  (b) physically-derived sanity/monotonicity expectations (e.g. more
//      wind or more intensity should not shrink the spot distance).

test('byramFlameLengthMeters matches the SI-native Byram (1959) power law', () => {
  // L(m) = 0.0775 * I(kW/m)^0.46 -- hand-computed for I = 2000 kW/m:
  // 2000^0.46 = e^(0.46*ln 2000) = e^(0.46*7.6009) = e^3.4964 = 32.99
  // L = 0.0775 * 32.99 = 2.557 m
  const length = byramFlameLengthMeters(2000);
  assert.ok(Math.abs(length - 2.557) < 0.01, `expected ~2.557, got ${length}`);
});

test('byramFlameLengthMeters is zero for zero intensity and grows with intensity', () => {
  assert.equal(byramFlameLengthMeters(0), 0);
  const low = byramFlameLengthMeters(200);
  const high = byramFlameLengthMeters(20000);
  assert.ok(high > low, 'higher fireline intensity must produce a longer flame length');
});

test('byramFlameLengthMeters rejects negative intensity', () => {
  assert.throws(() => byramFlameLengthMeters(-1), RangeError);
});

test('albiniFlightTimeMinutes matches a hand-evaluation of equations D33/D34/D43/A58', () => {
  // flameLength = 2.5572636210021926 m (from the Byram test above, I=2000 kW/m)
  // z = 117 m (Albini 1979 worked-example lofting height, see module header)
  // a = 5.963, b = 4.563
  // w_F = 2.3 * sqrt(2.5572636210021926) = 2.3 * 1.599145... = 3.678035 m/s
  // charact_t (min) = (2 * 2.5572636210021926 / 3.678035) / 60 = 1.390862 / 60 = 0.0231810 min
  // u = (4.563 + 117/2.5572636210021926) / 5.963 = (4.563 + 45.75539) / 5.963 = 8.42984
  // u^1.5 = 24.4879
  // travelTime = 1.2 + (5.963/3) * (24.4879 - 1) = 1.2 + 1.98767 * 23.4879 = 1.2 + 46.6903 = 47.8903
  // flightTime = 0.0231810 * 47.8903 = 1.11029 min
  const flameLength = byramFlameLengthMeters(2000);
  const flightTime = albiniFlightTimeMinutes(flameLength, DEFAULT_MAX_LOFT_HEIGHT_METERS);
  assert.ok(Math.abs(flightTime - 1.1103) < 0.01, `expected ~1.1103, got ${flightTime}`);
});

test('albiniFlightTimeMinutes is zero for zero flame length', () => {
  assert.equal(albiniFlightTimeMinutes(0, DEFAULT_MAX_LOFT_HEIGHT_METERS), 0);
});

test('albiniFlightTimeMinutes rejects a lofting height below the flame length', () => {
  // Physically the ember cannot loft to less than the flame it rides up on.
  assert.throws(() => albiniFlightTimeMinutes(50, 10), RangeError);
});

test('computeSpotting returns all-zero output for a non-burning (zero intensity) cell', () => {
  const result = computeSpotting({ firelineIntensityKwPerM: 0, midflameWindKmh: 20 });
  assert.equal(result.flameLengthMeters, 0);
  assert.equal(result.flightTimeMinutes, 0);
  assert.equal(result.maxSpotDistanceMeters, 0);
});

test('computeSpotting is deterministic: identical inputs give identical outputs', () => {
  const params = { firelineIntensityKwPerM: 4000, midflameWindKmh: 25, canopyHeightMeters: 15 };
  const a = computeSpotting(params);
  const b = computeSpotting(params);
  assert.deepEqual(a, b);
});

test('computeSpotting spot distance grows monotonically with wind speed at fixed intensity', () => {
  const base = { firelineIntensityKwPerM: 3000, canopyHeightMeters: 10 };
  const low = computeSpotting({ ...base, midflameWindKmh: 10 });
  const high = computeSpotting({ ...base, midflameWindKmh: 40 });
  assert.ok(high.maxSpotDistanceMeters > low.maxSpotDistanceMeters);
});

test('computeSpotting distance is zero at zero wind (no horizontal transport)', () => {
  const result = computeSpotting({ firelineIntensityKwPerM: 3000, midflameWindKmh: 0 });
  assert.equal(result.maxSpotDistanceMeters, 0);
  assert.ok(result.flightTimeMinutes > 0, 'flight time is still nonzero even with no wind');
});

test('computeSpotting raises the effective lofting height floor above canopy + flame length', () => {
  // With a very tall canopy, the floor (canopy + flame length) should
  // exceed the 117 m worked-example default, and maxLoftHeightMeters in
  // the result should reflect that floor.
  const result = computeSpotting({
    firelineIntensityKwPerM: 3000,
    midflameWindKmh: 20,
    canopyHeightMeters: 150
  });
  assert.ok(result.maxLoftHeightMeters > DEFAULT_MAX_LOFT_HEIGHT_METERS);
  assert.ok(result.maxLoftHeightMeters >= 150 + result.flameLengthMeters - 1e-9);
});

test('computeSpotting honors an explicit maxLoftHeightMeters override', () => {
  const result = computeSpotting({
    firelineIntensityKwPerM: 3000,
    midflameWindKmh: 20,
    maxLoftHeightMeters: 200
  });
  assert.equal(result.maxLoftHeightMeters, 200);
});

test('computeSpotting rejects negative inputs', () => {
  assert.throws(() => computeSpotting({ firelineIntensityKwPerM: -1, midflameWindKmh: 10 }), RangeError);
  assert.throws(() => computeSpotting({ firelineIntensityKwPerM: 10, midflameWindKmh: -1 }), RangeError);
  assert.throws(() => computeSpotting({ firelineIntensityKwPerM: 10, midflameWindKmh: 10, canopyHeightMeters: -1 }), RangeError);
});

test('computeSpotting spot distance strictly increases with fireline intensity (regression for the fixed loft-height defect)', () => {
  // Previously, maxSpotDistanceMeters DECREASED as intensity rose (987 m at
  // I=200 down to 97 m at I=90000) because the lofting height default was
  // ~constant (117 m) regardless of flame length, which shrinks the
  // dimensionless ratio z/L in the Albini D43 formula as L grows. Bigger
  // fires must spot farther, not less far — this is the entire spotting
  // mechanism. See src/lib/spotting.js module header for the root-cause
  // writeup.
  const intensities = [200, 2000, 10000, 30000, 90000];
  const distances = intensities.map((firelineIntensityKwPerM) => computeSpotting({
    firelineIntensityKwPerM,
    midflameWindKmh: 20,
    canopyHeightMeters: 20
  }).maxSpotDistanceMeters);

  for (let i = 1; i < distances.length; i += 1) {
    assert.ok(
      distances[i] > distances[i - 1],
      `expected spot distance to increase from I=${intensities[i - 1]} `
      + `(${distances[i - 1].toFixed(1)} m) to I=${intensities[i]} `
      + `(${distances[i].toFixed(1)} m)`
    );
  }
});

test('computeSpotting spot distance strictly increases with wind across a range of speeds', () => {
  const winds = [5, 10, 20, 30, 40, 60];
  const distances = winds.map((midflameWindKmh) => computeSpotting({
    firelineIntensityKwPerM: 5000,
    midflameWindKmh,
    canopyHeightMeters: 10
  }).maxSpotDistanceMeters);

  for (let i = 1; i < distances.length; i += 1) {
    assert.ok(
      distances[i] > distances[i - 1],
      `expected spot distance to increase from wind=${winds[i - 1]} km/h `
      + `(${distances[i - 1].toFixed(1)} m) to wind=${winds[i]} km/h `
      + `(${distances[i].toFixed(1)} m)`
    );
  }
});

test('computeSpotting accepts slopeFraction without error (documented as currently unused)', () => {
  const flat = computeSpotting({ firelineIntensityKwPerM: 3000, midflameWindKmh: 20, slopeFraction: 0 });
  const steep = computeSpotting({ firelineIntensityKwPerM: 3000, midflameWindKmh: 20, slopeFraction: 0.6 });
  // No sourced slope adjustment exists in this module (see header caveat),
  // so results must be identical rather than silently diverging.
  assert.deepEqual(flat, steep);
});
