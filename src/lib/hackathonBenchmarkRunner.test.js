import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HACKATHON_BENCHMARK_DEFINITIONS,
  runConusHackathonBenchmarks
} from './hackathonBenchmarkRunner.js';
import { OFFICIAL_BENCHMARK_FIXTURES } from './officialBenchmarkFixtures.js';

test('runs the complete CONUS showcase benchmark deterministically', () => {
  const first = runConusHackathonBenchmarks();
  const second = runConusHackathonBenchmarks();
  assert.equal(HACKATHON_BENCHMARK_DEFINITIONS.length, 6);
  assert.equal(OFFICIAL_BENCHMARK_FIXTURES.length, 4);
  assert.equal(first.region.id, 'conus-showcase');
  assert.equal(first.summary.caseCount, 6);
  assert.equal(first.cases.filter((entry) => entry.split === 'calibration').length, 4);
  assert.equal(first.cases.filter((entry) => entry.split === 'holdout').length, 2);
  assert.equal(new Set(first.cases.map((entry) => entry.id)).size, 6);
  assert.ok(first.cases.every((entry) => entry.report.observedAreaKm2 > 0));
  assert.ok(first.cases.every((entry) => entry.dataQuality?.fuel));
  assert.ok(first.cases.some((entry) => entry.sourceSnapshotSha256));
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(
    first.cases.map((entry) => entry.report),
    second.cases.map((entry) => entry.report)
  );
});

test('benchmark calibration and holdout splits are independently selectable', () => {
  const calibration = runConusHackathonBenchmarks({ splits: ['calibration'] });
  const holdout = runConusHackathonBenchmarks({ splits: ['holdout'] });
  assert.equal(calibration.summary.caseCount, 4);
  assert.ok(calibration.cases.every((entry) => entry.split === 'calibration'));
  assert.equal(holdout.summary.caseCount, 2);
  assert.ok(holdout.cases.every((entry) => entry.split === 'holdout'));
  assert.throws(
    () => runConusHackathonBenchmarks({ splits: [] }),
    /splits/
  );
});

test('official perimeter fixtures retain source integrity and case-specific grids', () => {
  assert.deepEqual(
    OFFICIAL_BENCHMARK_FIXTURES.map((fixture) => fixture.id),
    ['oregon-gulch-2014', 'big-five-2015', 'dinely-2017', 'stoll-2018']
  );
  assert.ok(OFFICIAL_BENCHMARK_FIXTURES.every((fixture) => (
    fixture.sourceQueryUrl
    && /^[a-f0-9]{64}$/.test(fixture.sourceSnapshotSha256)
    && /^[a-f0-9]{64}$/.test(fixture.geometrySha256)
    && fixture.geometry.coordinates.length > 0
    && fixture.size >= 128
    && fixture.cellSizeMeters >= 100
  )));
});

test('benchmark cases honestly report which fields are real vs synthetic fallback', () => {
  const result = runConusHackathonBenchmarks();
  for (const entry of result.cases) {
    assert.ok(entry.usingRealFields, `${entry.id} missing usingRealFields`);
    assert.equal(typeof entry.usingRealFields.terrain, 'boolean');
    assert.equal(typeof entry.usingRealFields.fuel, 'boolean');
    assert.equal(typeof entry.usingRealFields.weather, 'boolean');
    // inputProfile must name the actual per-field state, not a blanket claim.
    assert.match(entry.inputProfile, /fuel/);
    assert.match(entry.inputProfile, /terrain/);
    assert.match(entry.inputProfile, /weather/);
    if (entry.usingRealFields.fuel) assert.match(entry.dataQuality.fuel, /real_worldcover_10m/);
    if (entry.usingRealFields.terrain) assert.match(entry.dataQuality.terrain, /real_elevation/);
    if (entry.usingRealFields.weather) assert.match(entry.dataQuality.weather, /real_historical_archive/);
  }
});

test('benchmark runner rejects invalid calibration parameters', () => {
  assert.throws(
    () => runConusHackathonBenchmarks({ fuelLoadScale: 1.1 }),
    /fuelLoadScale/
  );
  assert.throws(
    () => runConusHackathonBenchmarks({ deadMoistureFraction: 1.1 }),
    /deadMoistureFraction/
  );
});
