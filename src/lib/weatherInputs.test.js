import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchWeatherInputs,
  windToMidflame,
  compassToMathRadians,
  isWeatherStale
} from './weatherInputs.js';

// Fake Open-Meteo /forecast response payload
function fakeOpenMeteoResponse(overrides = {}) {
  const now = new Date().toISOString();
  return {
    latitude: 40.0,
    longitude: -100.0,
    elevation: 500,
    generationtime_ms: 0.3,
    utc_offset_seconds: 0,
    timezone: 'GMT',
    current_units: {
      temperature_2m: '°C',
      relative_humidity_2m: '%',
      wind_speed_10m: 'km/h',
      wind_direction_10m: '°',
      wind_gusts_10m: 'km/h',
      precipitation: 'mm'
    },
    current: {
      time: now,
      temperature_2m: 22.5,
      relative_humidity_2m: 38,
      wind_speed_10m: 24,
      wind_direction_10m: 210,
      wind_gusts_10m: 32,
      precipitation: 0
    },
    ...overrides
  };
}

test('compassToMathRadians: 0° compass (from north) becomes wind blowing SOUTH in math frame', () => {
  // Meteorological convention: 0° means wind coming FROM north, going toward south.
  // Math frame: south = -y, so wind vector = (0, -1). atan2(-1, 0) = -π/2.
  const rad = compassToMathRadians(0);
  assert.ok(Math.abs(rad - -Math.PI / 2) < 1e-6,
    `0° compass should map to ~-π/2 (south-blowing), got ${rad}`);
});

test('compassToMathRadians: 90° compass (from east) becomes wind blowing WEST', () => {
  // Wind FROM east goes toward west; math (-1, 0); atan2(0, -1) = π.
  const rad = compassToMathRadians(90);
  assert.ok(Math.abs(Math.abs(rad) - Math.PI) < 1e-6,
    `90° compass should map to ±π (west-blowing), got ${rad}`);
});

test('windToMidflame: reduces 10-m wind by the standard 0.4 factor when no canopy assumed', () => {
  const midflame = windToMidflame({ tenMeterWindKmh: 25, canopySheltered: false });
  assert.ok(Math.abs(midflame.speedKmh - 25 * 0.4) < 1e-6);
  assert.equal(midflame.method, '10m-open-to-midflame-x0.4');
});

test('windToMidflame: sheltered fuel gets a lower midflame speed than open fuel at same 10-m wind', () => {
  const open = windToMidflame({ tenMeterWindKmh: 25, canopySheltered: false });
  const shelt = windToMidflame({ tenMeterWindKmh: 25, canopySheltered: true });
  assert.ok(shelt.speedKmh < open.speedKmh);
});

test('windToMidflame: calm 10-m wind stays calm at midflame', () => {
  const midflame = windToMidflame({ tenMeterWindKmh: 0, canopySheltered: false });
  assert.equal(midflame.speedKmh, 0);
});

test('windToMidflame: rejects non-finite wind speed', () => {
  assert.throws(() => windToMidflame({ tenMeterWindKmh: NaN, canopySheltered: false }));
});

test('isWeatherStale: fresh timestamp within TTL is not stale', () => {
  assert.equal(isWeatherStale({ fetchedAt: Date.now() - 5_000 }, 60_000), false);
});

test('isWeatherStale: expired timestamp beyond TTL is stale', () => {
  assert.equal(isWeatherStale({ fetchedAt: Date.now() - 120_000 }, 60_000), true);
});

test('isWeatherStale: missing timestamp is stale', () => {
  assert.equal(isWeatherStale(null, 60_000), true);
  assert.equal(isWeatherStale({}, 60_000), true);
});

test('fetchWeatherInputs: parses Open-Meteo response into normalized SI-ish object with provenance', async () => {
  const fixture = fakeOpenMeteoResponse();
  const result = await fetchWeatherInputs({
    latitude: 40, longitude: -100,
    fetchImpl: async () => ({ ok: true, json: async () => fixture })
  });
  assert.equal(result.source, 'Open-Meteo /forecast (current)');
  assert.equal(result.wind.tenMeterSpeedKmh, 24);
  assert.equal(result.wind.compassDirectionDeg, 210);
  assert.equal(result.wind.midflameSpeedKmh, 24 * 0.4);
  assert.equal(result.temperature.celsius, 22.5);
  assert.equal(result.relativeHumidity.fraction, 0.38);
  assert.equal(result.precipitation.millimeters, 0);
  assert.ok(result.fetchedAt <= Date.now() && result.fetchedAt >= Date.now() - 5_000);
  assert.equal(result.observationTime, fixture.current.time);
});

test('fetchWeatherInputs: distinguishes measurement height from midflame height in the returned object', async () => {
  const result = await fetchWeatherInputs({
    latitude: 40, longitude: -100,
    fetchImpl: async () => ({ ok: true, json: async () => fakeOpenMeteoResponse() })
  });
  assert.equal(result.wind.measurementHeightMeters, 10);
  assert.equal(result.wind.midflameAdjustmentMethod, '10m-open-to-midflame-x0.4');
});

test('fetchWeatherInputs: throws when the upstream response is not ok', async () => {
  await assert.rejects(
    fetchWeatherInputs({
      latitude: 40, longitude: -100,
      fetchImpl: async () => ({ ok: false, status: 503 })
    }),
    /weather/i
  );
});

test('fetchWeatherInputs: rejects a response with missing current-block fields', async () => {
  const bad = fakeOpenMeteoResponse();
  delete bad.current.wind_speed_10m;
  await assert.rejects(
    fetchWeatherInputs({
      latitude: 40, longitude: -100,
      fetchImpl: async () => ({ ok: true, json: async () => bad })
    }),
    /wind_speed_10m/
  );
});
