// Archived Open-Meteo weather replay helpers for historical fire validation.
// This is a validation input path, not a promise that reanalysis equals a
// local RAWS observation. The returned values retain that distinction.

import { estimateDeadFuelMoistureFromHourlyWeather } from './fuelMoistureModel.js';
import {
  aggregateHourlyWeatherToDaily,
  estimateLiveFuelMoistureFromDailyWeather
} from './liveFuelMoistureModel.js';
import {
  compassToMathRadians,
  windToMidflame
} from './weatherInputs.js';

const OPEN_METEO_ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const ARCHIVE_HOURLY_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'precipitation',
  'wind_speed_10m',
  'wind_direction_10m'
];

function assertDate(value, name) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new RangeError(`historicalWeather: ${name} must be a valid date`);
  return time;
}

function parseArchiveTimestamp(value, utcOffsetSeconds = 0) {
  if (typeof value !== 'string') return NaN;
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (hasExplicitOffset) return Date.parse(value);

  // Open-Meteo returns timezone-naive strings when `timezone` is requested.
  // Parse those wall-clock fields explicitly instead of letting the host
  // timezone silently change the forcing timeline.
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(value);
  if (!match) return Date.parse(value);
  const milliseconds = match[7]
    ? Number(match[7].padEnd(3, '0'))
    : 0;
  const wallClockMs = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
    milliseconds
  );
  return wallClockMs - (Number.isFinite(utcOffsetSeconds) ? utcOffsetSeconds : 0) * 1000;
}

export function normalizeHistoricalHourlyWeather(payload) {
  const hourly = payload?.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return [];
  const utcOffsetSeconds = Number.isFinite(payload?.utc_offset_seconds)
    ? payload.utc_offset_seconds
    : 0;
  const observations = [];
  for (let index = 0; index < hourly.time.length; index += 1) {
    const time = hourly.time[index];
    const timestampMs = parseArchiveTimestamp(time, utcOffsetSeconds);
    if (!Number.isFinite(timestampMs)) continue;
    const temperatureCelsius = hourly.temperature_2m?.[index];
    const relativeHumidityPercent = hourly.relative_humidity_2m?.[index];
    const precipitationMillimeters = hourly.precipitation?.[index] ?? 0;
    if (!Number.isFinite(temperatureCelsius)
      || !Number.isFinite(relativeHumidityPercent)
      || !Number.isFinite(precipitationMillimeters)) continue;
    observations.push({
      time: new Date(timestampMs).toISOString(),
      temperatureCelsius,
      relativeHumidityFraction: relativeHumidityPercent / 100,
      precipitationMillimeters,
      windSpeedKmh: Number.isFinite(hourly.wind_speed_10m?.[index])
        ? hourly.wind_speed_10m[index]
        : null,
      windDirectionDeg: Number.isFinite(hourly.wind_direction_10m?.[index])
        ? hourly.wind_direction_10m[index]
        : null
    });
  }
  return observations.sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

export function buildHistoricalWeatherTimeline({
  hours,
  ignitionTime,
  canopySheltered = false,
  fuelBedDepthMeters = null,
  initialDeadMoistureByClass = null,
  latitude
} = {}) {
  const ignitionMs = assertDate(ignitionTime, 'ignitionTime');
  if (!Array.isArray(hours) || hours.length === 0) {
    throw new RangeError('historicalWeather: hours must contain at least one observation');
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError('historicalWeather: latitude must be in [-90, 90]');
  }

  let deadMoistureByClass = initialDeadMoistureByClass;
  let previousWeatherTime = null;
  let preIgnitionObservationsUsed = 0;
  let firstProcessedWeatherTime = null;
  const dailyWeather = aggregateHourlyWeatherToDaily(hours);
  const liveMoistureByDate = new Map();
  for (let index = 0; index < dailyWeather.length; index += 1) {
    liveMoistureByDate.set(
      dailyWeather[index].date,
      estimateLiveFuelMoistureFromDailyWeather({
        dailyWeather: dailyWeather.slice(0, index + 1),
        latitude
      })
    );
  }
  const windHours = [];
  const timeline = [];
  for (const hour of hours) {
    const hourMs = Date.parse(hour.time);
    if (!Number.isFinite(hourMs)) continue;
    const fuelMoisture = estimateDeadFuelMoistureFromHourlyWeather({
      hours: [hour],
      initialMoistureByClass: deadMoistureByClass ?? undefined,
      previousObservationTime: previousWeatherTime
    });
    deadMoistureByClass = fuelMoisture.byClass;
    previousWeatherTime = hour.time;
    firstProcessedWeatherTime ??= hour.time;
    if (hourMs < ignitionMs) {
      preIgnitionObservationsUsed += 1;
      continue;
    }
    if (Number.isFinite(hour.windSpeedKmh) && hour.windSpeedKmh >= 0
      && Number.isFinite(hour.windDirectionDeg)) {
      windHours.push(hour);
      timeline.push({
        minutesFromIgnition: (hourMs - ignitionMs) / 60_000,
        tenMeterWindKmh: hour.windSpeedKmh,
        referenceHeightMeters: 10,
        midflameWindKmh: windToMidflame({
          tenMeterWindKmh: hour.windSpeedKmh,
          canopySheltered,
          fuelBedDepthMeters
        }).speedKmh,
        windDirectionRadians: compassToMathRadians(hour.windDirectionDeg),
        deadMoistureByClass: { ...deadMoistureByClass },
        liveMoistureByClass: liveMoistureByDate.get(hour.time.slice(0, 10))?.byClass ?? null,
        sourceTime: hour.time
      });
    }
  }
  if (timeline.length === 0) {
    throw new RangeError('historicalWeather: no valid wind observations at or after ignitionTime');
  }

  const liveFuelMoisture = dailyWeather.length > 0
    ? liveMoistureByDate.get(dailyWeather.at(-1).date) ?? null
    : null;

  return {
    source: 'Open-Meteo /archive historical reanalysis',
    attribution: 'Open-Meteo · CC BY 4.0; ERA5 / ERA5-Land derived archive data',
    observationTime: new Date(ignitionMs).toISOString(),
    windTimeline: timeline,
    fuelMoisture: {
      byClass: { ...deadMoistureByClass },
      source: 'Open-Meteo historical hourly weather',
      method: 'NFDRS EMC + hourly time-lag replay estimate',
      observationsUsed: hours.length,
      preIgnitionObservationsUsed,
      estimated: true
    },
    liveFuelMoisture,
    hourly: {
      observationsUsed: hours.length,
      windObservationsUsed: windHours.length,
      historyHours: hours.length,
      preIgnitionObservationsUsed,
      spinUpHours: firstProcessedWeatherTime
        ? Math.max(0, (ignitionMs - Date.parse(firstProcessedWeatherTime)) / 3_600_000)
        : 0
    }
  };
}

export function buildHistoricalWeatherUrl({ latitude, longitude, startDate, endDate } = {}) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError('historicalWeather: latitude must be in [-90, 90]');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError('historicalWeather: longitude must be in [-180, 180]');
  }
  const startMs = assertDate(startDate, 'startDate');
  const endMs = assertDate(endDate, 'endDate');
  if (endMs < startMs) throw new RangeError('historicalWeather: endDate must be after startDate');
  const url = new URL(OPEN_METEO_ARCHIVE_URL);
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('start_date', new Date(startMs).toISOString().slice(0, 10));
  url.searchParams.set('end_date', new Date(endMs).toISOString().slice(0, 10));
  url.searchParams.set('hourly', ARCHIVE_HOURLY_FIELDS.join(','));
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('timezone', 'GMT');
  return url.toString();
}

export async function fetchHistoricalWeatherInputs({
  latitude,
  longitude,
  startDate,
  endDate,
  ignitionTime = startDate,
  canopySheltered = false,
  fuelBedDepthMeters = null,
  initialDeadMoistureByClass = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('historicalWeather: fetch implementation unavailable');
  const url = buildHistoricalWeatherUrl({ latitude, longitude, startDate, endDate });
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`historical weather fetch failed with HTTP ${response.status}`);
  const payload = await response.json();
  const hours = normalizeHistoricalHourlyWeather(payload);
  const result = buildHistoricalWeatherTimeline({
    hours,
    ignitionTime,
    canopySheltered,
    fuelBedDepthMeters,
    initialDeadMoistureByClass,
    latitude
  });
  return {
    ...result,
    fetchedAt: Date.now(),
    location: { latitude: payload.latitude ?? latitude, longitude: payload.longitude ?? longitude },
    archiveWindow: { startDate, endDate },
    requestUrl: url
  };
}
