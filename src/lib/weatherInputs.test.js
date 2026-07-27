import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeatherTimeline,
  calculateCanopyShelteredWindAdjustment,
  calculateUnshelteredWindAdjustment,
  fetchWeatherInputs,
  fetchCurrentWind,
  windToMidflame,
  compassToMathRadians,
  isWeatherStale
} from './weatherInputs.js';

// Fake Open-Meteo /forecast response payload
function fakeOpenMeteoResponse(overrides = {}) {
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const hourTimes = Array.from({ length: 4 }, (_, index) => (
    new Date(nowMs - (3 - index) * 3_600_000).toISOString()
  ));
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
    hourly: {
      time: hourTimes,
      temperature_2m: [22, 22.5, 23, 22.5],
      relative_humidity_2m: [42, 40, 38, 38],
      precipitation: [0, 0, 0, 0],
      wind_speed_10m: [20, 22, 24, 24],
      wind_direction_10m: [200, 205, 210, 210]
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

test('windToMidflame: fuel-bed WAF uses depth and returns explicit provenance', () => {
  const result = windToMidflame({
    tenMeterWindKmh: 25,
    canopySheltered: false,
    fuelBedDepthMeters: 0.305
  });
  const depthFeet = 0.305 / 0.3048;
  const expectedFactor = 1.83 / Math.log(((10 / 0.3048) + 0.36 * depthFeet) / (0.13 * depthFeet));
  assert.ok(Math.abs(result.adjustmentFactor - expectedFactor) < 1e-12);
  assert.equal(result.method, '10m-open-BehavePlus-WAF-depth-0.305m');
  assert.ok(result.speedKmh < 25 * 0.4);
});

test('windToMidflame: published standard-model WAF survives 10 m height conversion', () => {
  const model = { code: 'GR2', windAdjustmentFactor: 0.36 };
  const sourceHeightMeters = 20 * 0.3048;
  const source = calculateUnshelteredWindAdjustment({
    fuelBedDepthMeters: 0.305,
    referenceHeightMeters: sourceHeightMeters,
    publishedAdjustmentFactor: model.windAdjustmentFactor
  });
  assert.ok(Math.abs(source.adjustmentFactor - 0.36) < 1e-12);
  const tenMeter = windToMidflame({
    tenMeterWindKmh: 25,
    fuelBedDepthMeters: 0.305,
    fuelModel: model
  });
  const expected = 0.36 * Math.log((20 + 0.36 * (0.305 / 0.3048)) / (0.13 * (0.305 / 0.3048)))
    / Math.log(((10 / 0.3048) + 0.36 * (0.305 / 0.3048)) / (0.13 * (0.305 / 0.3048)));
  assert.ok(Math.abs(tenMeter.adjustmentFactor - expected) < 1e-12);
  assert.equal(tenMeter.method, '10m-open-published-WAF-GR2-0.36');
});

test('windToMidflame: deeper unsheltered fuel has a larger WAF', () => {
  const shortFuel = windToMidflame({ tenMeterWindKmh: 25, fuelBedDepthMeters: 0.122 });
  const tallFuel = windToMidflame({ tenMeterWindKmh: 25, fuelBedDepthMeters: 0.305 });
  assert.ok(tallFuel.speedKmh > shortFuel.speedKmh);
});

test('windToMidflame: sheltered fuel keeps the conservative canopy path when depth is known', () => {
  const result = windToMidflame({
    tenMeterWindKmh: 25,
    canopySheltered: true,
    fuelBedDepthMeters: 0.305
  });
  assert.equal(result.speedKmh, 5);
  assert.equal(result.method, '10m-canopy-to-midflame-x0.2');
});

test('windToMidflame: measured low canopy uses the published sheltered WAF', () => {
  const result = windToMidflame({
    tenMeterWindKmh: 25,
    canopySheltered: true,
    canopyHeightMeters: 3,
    canopyCoverFraction: 0.75
  });
  const heightFeet = 3 / 0.3048;
  const shelterFraction = 0.75 / 3;
  const expectedFactor = 0.555 / (shelterFraction * Math.log((20 + 0.36 * heightFeet) / (0.13 * heightFeet)));
  assert.ok(Math.abs(result.adjustmentFactor - expectedFactor) < 1e-12);
  assert.equal(result.speedKmh, 25 * expectedFactor);
  assert.match(result.method, /GTR-266-Eq2/);
  assert.equal(calculateCanopyShelteredWindAdjustment({
    canopyHeightMeters: 18,
    canopyCoverFraction: 0.75
  }), null);
});

test('windToMidflame: calm 10-m wind stays calm at midflame', () => {
  const midflame = windToMidflame({ tenMeterWindKmh: 0, canopySheltered: false });
  assert.equal(midflame.speedKmh, 0);
});

test('windToMidflame: rejects non-finite wind speed', () => {
  assert.throws(() => windToMidflame({ tenMeterWindKmh: NaN, canopySheltered: false }));
});

test('forecast weather timeline carries rain-driven dead-fuel moisture forward', () => {
  const observationTime = '2025-07-23T12:00:00Z';
  const hours = [
    {
      time: observationTime,
      temperatureCelsius: 25,
      relativeHumidityFraction: 0.35,
      precipitationMillimeters: 0,
      windSpeedKmh: 12,
      windDirectionDeg: 180
    },
    {
      time: '2025-07-23T13:00:00Z',
      temperatureCelsius: 18,
      relativeHumidityFraction: 0.95,
      precipitationMillimeters: 12,
      windSpeedKmh: 8,
      windDirectionDeg: 180
    },
    {
      time: '2025-07-23T14:00:00Z',
      temperatureCelsius: 18,
      relativeHumidityFraction: 0.95,
      precipitationMillimeters: 0,
      windSpeedKmh: 5,
      windDirectionDeg: 180
    }
  ];
  const timeline = buildWeatherTimeline({
    hours,
    observationTime,
    initialDeadMoistureByClass: { '1h': 0.06, '10h': 0.08, '100h': 0.10 }
  });

  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].minutesFromIgnition, 0);
  assert.equal(timeline[0].deadMoistureByClass['1h'], 0.06);
  assert.ok(timeline[1].deadMoistureByClass['1h'] > timeline[0].deadMoistureByClass['1h']);
  const dryTimeline = buildWeatherTimeline({
    hours: hours.map((hour) => ({ ...hour, precipitationMillimeters: 0 })),
    observationTime,
    initialDeadMoistureByClass: { '1h': 0.06, '10h': 0.08, '100h': 0.10 }
  });
  assert.ok(timeline[2].deadMoistureByClass['1h'] > dryTimeline[2].deadMoistureByClass['1h']);
  const delayedFirstTimeline = buildWeatherTimeline({
    hours: hours.slice(1),
    observationTime,
    initialDeadMoistureByClass: { '1h': 0.06, '10h': 0.08, '100h': 0.10 }
  });
  assert.ok(delayedFirstTimeline[0].deadMoistureByClass['1h'] > 0.06);
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
  assert.equal(result.source, 'Open-Meteo /forecast (current + hourly)');
  assert.equal(result.wind.tenMeterSpeedKmh, 24);
  assert.equal(result.wind.compassDirectionDeg, 210);
  assert.equal(result.wind.midflameSpeedKmh, 24 * 0.4);
  assert.equal(result.temperature.celsius, 22.5);
  assert.equal(result.relativeHumidity.fraction, 0.38);
  assert.equal(result.precipitation.millimeters, 0);
  assert.equal(result.fuelMoisture.observationsUsed, 4);
  assert.equal(result.fuelMoisture.estimated, true);
  assert.equal(result.liveFuelMoisture.method, 'NFDRS v4 GSI live-fuel estimate');
  assert.ok(result.fetchedAt <= Date.now() && result.fetchedAt >= Date.now() - 5_000);
  assert.equal(result.observationTime, fixture.current.time);
  assert.ok(result.windTimeline.length >= 1);
  assert.ok(result.weatherTimeline.length >= 1);
});

test('fetchWeatherInputs: uses the full available history for 100-hour fuel spin-up', async () => {
  const fixture = fakeOpenMeteoResponse();
  const nowMs = Date.parse(fixture.current.time);
  const historyLength = 120;
  fixture.hourly.time = Array.from({ length: historyLength }, (_, index) => (
    new Date(nowMs - (historyLength - 1 - index) * 3_600_000).toISOString()
  ));
  fixture.hourly.temperature_2m = Array(historyLength).fill(22.5);
  fixture.hourly.relative_humidity_2m = Array(historyLength).fill(38);
  fixture.hourly.precipitation = Array(historyLength).fill(0);
  fixture.hourly.wind_speed_10m = Array(historyLength).fill(24);
  fixture.hourly.wind_direction_10m = Array(historyLength).fill(210);

  const result = await fetchWeatherInputs({
    latitude: 40,
    longitude: -100,
    fetchImpl: async () => ({ ok: true, json: async () => fixture })
  });

  assert.equal(result.fuelMoisture.observationsUsed, historyLength);
});

test('fetchWeatherInputs: requests hourly weather history for dead-fuel estimation', async () => {
  let requestedUrl = '';
  await fetchWeatherInputs({
    latitude: 40, longitude: -100,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => fakeOpenMeteoResponse() };
    }
  });
  assert.match(requestedUrl, /hourly=/);
  assert.match(requestedUrl, /past_days=7/);
  assert.match(requestedUrl, /forecast_days=1/);
});

test('fetchWeatherInputs: preserves the full 72-hour forecast for time-varying wind', async () => {
  const fixture = fakeOpenMeteoResponse();
  const observationMs = Date.parse(fixture.current.time);
  fixture.hourly.time.push(new Date(observationMs + 3_600_000).toISOString());
  fixture.hourly.temperature_2m.push(23);
  fixture.hourly.relative_humidity_2m.push(37);
  fixture.hourly.precipitation.push(0);
  fixture.hourly.wind_speed_10m.push(40);
  fixture.hourly.wind_direction_10m.push(180);
  fixture.hourly.time.push(new Date(observationMs + 48 * 3_600_000).toISOString());
  fixture.hourly.temperature_2m.push(19);
  fixture.hourly.relative_humidity_2m.push(45);
  fixture.hourly.precipitation.push(0);
  fixture.hourly.wind_speed_10m.push(30);
  fixture.hourly.wind_direction_10m.push(270);
  const result = await fetchWeatherInputs({
    latitude: 40, longitude: -100,
    fetchImpl: async () => ({ ok: true, json: async () => fixture })
  });

  assert.equal(result.windTimeline.length, 3);
  assert.equal(result.windTimeline[1].minutesFromIgnition, 60);
  assert.equal(result.windTimeline[1].tenMeterWindKmh, 40);
  assert.equal(result.windTimeline[1].referenceHeightMeters, 10);
  assert.equal(result.windTimeline[1].midflameWindKmh, 16);
  assert.equal(result.windTimeline[2].minutesFromIgnition, 48 * 60);
  assert.equal(result.weatherTimeline[1].minutesFromIgnition, 60);
  assert.ok(Number.isFinite(result.weatherTimeline[1].deadMoistureByClass['1h']));
});

test('fetchWeatherInputs: distinguishes measurement height from midflame height in the returned object', async () => {
  const result = await fetchWeatherInputs({
    latitude: 40, longitude: -100,
    fetchImpl: async () => ({ ok: true, json: async () => fakeOpenMeteoResponse() })
  });
  assert.equal(result.wind.measurementHeightMeters, 10);
  assert.equal(result.wind.midflameAdjustmentMethod, '10m-open-to-midflame-x0.4');
});

test('fetchWeatherInputs: carries fuel-bed WAF provenance into current and forecast wind', async () => {
  const result = await fetchWeatherInputs({
    latitude: 40,
    longitude: -100,
    fuelBedDepthMeters: 0.305,
    fetchImpl: async () => ({ ok: true, json: async () => fakeOpenMeteoResponse() })
  });
  assert.match(result.wind.midflameAdjustmentMethod, /^10m-open-BehavePlus-WAF-depth-/);
  assert.equal(result.wind.fuelBedDepthMeters, 0.305);
  assert.ok(result.windTimeline.every((entry) => entry.midflameWindKmh < 24 * 0.4));
});

test('fetchCurrentWind: requests only the current 10 m wind fields', async () => {
  let requestedUrl = '';
  const result = await fetchCurrentWind({
    latitude: 40,
    longitude: -100,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({ current: {
          time: '2026-07-26T12:00', wind_speed_10m: 24, wind_direction_10m: 210, wind_gusts_10m: 32
        } })
      };
    }
  });
  assert.match(requestedUrl, /current=wind_speed_10m%2Cwind_direction_10m%2Cwind_gusts_10m/);
  assert.doesNotMatch(requestedUrl, /hourly=|past_days=|forecast_days=/);
  assert.equal(result.tenMeterSpeedKmh, 24);
  assert.equal(result.compassDirectionDeg, 210);
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

test('fetchWeatherInputs: retries one transient rate limit', async () => {
  let calls = 0;
  const result = await fetchWeatherInputs({
    latitude: 40,
    longitude: -100,
    rateLimitRetryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 429 }
        : { ok: true, status: 200, json: async () => fakeOpenMeteoResponse() };
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.wind.tenMeterSpeedKmh, 24);
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
