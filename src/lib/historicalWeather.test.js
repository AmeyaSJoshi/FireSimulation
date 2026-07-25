import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHistoricalWeatherTimeline,
  buildHistoricalWeatherUrl,
  fetchHistoricalWeatherInputs,
  normalizeHistoricalHourlyWeather
} from './historicalWeather.js';

const HOURLY = {
  time: [
    '2021-07-16T00:00:00Z',
    '2021-07-16T01:00:00Z',
    '2021-07-16T02:00:00Z',
    '2021-07-16T03:00:00Z'
  ],
  temperature_2m: [20, 21, 22, 23],
  relative_humidity_2m: [80, 70, 60, 50],
  precipitation: [0, 0, 5, 0],
  wind_speed_10m: [10, 12, 14, 16],
  wind_direction_10m: [0, 90, 180, 270]
};

test('historical weather normalizes archive hourly records', () => {
  const hours = normalizeHistoricalHourlyWeather({ hourly: HOURLY });
  assert.equal(hours.length, 4);
  assert.equal(hours[2].relativeHumidityFraction, 0.6);
  assert.equal(hours[2].precipitationMillimeters, 5);
  assert.equal(hours[3].windDirectionDeg, 270);
});

test('historical weather treats timezone-naive archive times as response-local wall clock', () => {
  const hours = normalizeHistoricalHourlyWeather({
    timezone: 'GMT',
    utc_offset_seconds: 0,
    hourly: {
      ...HOURLY,
      time: ['2021-07-16T00:00', '2021-07-16T01:00', '2021-07-16T02:00', '2021-07-16T03:00']
    }
  });
  assert.equal(hours[0].time, '2021-07-16T00:00:00.000Z');
  assert.equal(hours[3].time, '2021-07-16T03:00:00.000Z');
});

test('historical weather applies a non-zero archive UTC offset', () => {
  const hours = normalizeHistoricalHourlyWeather({
    timezone: 'America/Los_Angeles',
    utc_offset_seconds: -7 * 60 * 60,
    hourly: {
      ...HOURLY,
      time: ['2021-07-16T00:00', '2021-07-16T01:00', '2021-07-16T02:00', '2021-07-16T03:00']
    }
  });
  assert.equal(hours[0].time, '2021-07-16T07:00:00.000Z');
  assert.equal(hours[3].time, '2021-07-16T10:00:00.000Z');
});

test('historical timeline carries wind and evolving dead-fuel moisture', () => {
  const hours = normalizeHistoricalHourlyWeather({ hourly: HOURLY });
  const result = buildHistoricalWeatherTimeline({
    hours,
    ignitionTime: '2021-07-16T00:00:00Z',
    latitude: 44.98
  });

  assert.equal(result.windTimeline.length, 4);
  assert.equal(result.windTimeline[0].minutesFromIgnition, 0);
  assert.equal(result.windTimeline[3].minutesFromIgnition, 180);
  assert.equal(result.windTimeline[3].tenMeterWindKmh, 16);
  assert.equal(result.windTimeline[3].referenceHeightMeters, 10);
  assert.ok(result.windTimeline[2].deadMoistureByClass['1h']
    > result.windTimeline[1].deadMoistureByClass['1h']);
  assert.ok(Number.isFinite(result.windTimeline[0].liveMoistureByClass.herbaceous));
  assert.ok(Number.isFinite(result.windTimeline[0].liveMoistureByClass.woody));
  assert.equal(result.fuelMoisture.byClass['1h'], result.windTimeline.at(-1).deadMoistureByClass['1h']);
});

test('historical timeline spins dead fuel moisture up through pre-ignition observations', () => {
  const hours = normalizeHistoricalHourlyWeather({ hourly: HOURLY });
  const spunUp = buildHistoricalWeatherTimeline({
    hours,
    ignitionTime: '2021-07-16T02:00:00Z',
    latitude: 44.98
  });
  const coldStart = buildHistoricalWeatherTimeline({
    hours: hours.slice(2),
    ignitionTime: '2021-07-16T02:00:00Z',
    latitude: 44.98
  });

  assert.equal(spunUp.windTimeline[0].minutesFromIgnition, 0);
  assert.equal(spunUp.fuelMoisture.preIgnitionObservationsUsed, 2);
  assert.equal(spunUp.hourly.preIgnitionObservationsUsed, 2);
  assert.equal(spunUp.hourly.spinUpHours, 2);
  assert.notEqual(
    spunUp.windTimeline[0].deadMoistureByClass['1h'],
    coldStart.windTimeline[0].deadMoistureByClass['1h']
  );
});

test('historical timeline applies the optional fuel-bed WAF to archived wind', () => {
  const hours = normalizeHistoricalHourlyWeather({ hourly: HOURLY });
  const result = buildHistoricalWeatherTimeline({
    hours,
    ignitionTime: '2021-07-16T00:00:00Z',
    latitude: 44.98,
    fuelBedDepthMeters: 0.305
  });
  assert.ok(result.windTimeline[0].midflameWindKmh < 10 * 0.4);
});

test('historical archive URL carries the requested coordinate, dates, and variables', () => {
  const url = new URL(buildHistoricalWeatherUrl({
    latitude: 44.98,
    longitude: -114.99,
    startDate: '2021-07-16',
    endDate: '2021-07-17'
  }));
  assert.equal(url.hostname, 'archive-api.open-meteo.com');
  assert.equal(url.searchParams.get('start_date'), '2021-07-16');
  assert.equal(url.searchParams.get('end_date'), '2021-07-17');
  assert.match(url.searchParams.get('hourly'), /wind_direction_10m/);
});

test('historical weather fetch parses a public archive-shaped response', async () => {
  let requestedUrl = null;
  const result = await fetchHistoricalWeatherInputs({
    latitude: 44.98,
    longitude: -114.99,
    startDate: '2021-07-16',
    endDate: '2021-07-16',
    ignitionTime: '2021-07-16T00:00:00Z',
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ latitude: 44.98, longitude: -114.99, hourly: HOURLY }) };
    }
  });

  assert.match(requestedUrl, /archive-api\.open-meteo\.com/);
  assert.equal(result.hourly.observationsUsed, 4);
  assert.equal(result.windTimeline.length, 4);
  assert.equal(result.location.latitude, 44.98);
});
