// Open-Meteo weather ingest for the Phase 2 scenario input.
//
// Every value returned is:
//   - Explicitly units-labeled (SI-friendly where the sim cares).
//   - Provenance-stamped (source, observation time, fetch time).
//   - Convention-clear (wind direction is compass-from-degrees; a
//     separate helper converts to the math-frame angle the fire kernel
//     will consume).
//
// The sim's spread kernel expects MIDFLAME wind, not 10-m wind. This
// module reports both: the raw 10-m observation with its measurement
// height + provenance, and the adjusted midflame speed with the method
// used. Rothermel 1972 and Baughman & Albini 1980 describe the
// adjustment. When a fuel-bed depth is available, the unsheltered path uses
// the BehavePlus/Albini-Baughman logarithmic WAF documented in USFS RMRS-GTR-
// 266. A coarse legacy factor remains available for callers that have no fuel
// structure evidence; it is labeled as such in the returned provenance.

import { estimateDeadFuelMoistureFromHourlyWeather } from './fuelMoistureModel.js';
import {
  aggregateHourlyWeatherToDaily,
  estimateLiveFuelMoistureFromDailyWeather
} from './liveFuelMoistureModel.js';

const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CURRENT_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'precipitation'
];
const HOURLY_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'precipitation',
  'wind_speed_10m',
  'wind_direction_10m'
];
const CURRENT_WIND_FIELDS = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];

const MIDFLAME_MULT_OPEN = 0.4;      // Baughman & Albini 1980 midflame factor for exposed fuels
const MIDFLAME_MULT_SHELT = 0.2;     // Sheltered under canopy — conservative starter value
const METERS_PER_FOOT = 0.3048;
const DEFAULT_WIND_REFERENCE_HEIGHT_METERS = 10;
const CANOPY_FREE_WIND_CLEARANCE_METERS = 20 * METERS_PER_FOOT;
const CANOPY_SHELTER_FRACTION_CUTOFF = 0.05;
const BEHAVEPLUS_REFERENCE_HEIGHT_FEET = 20;

const REQUIRED_CURRENT_FIELDS = CURRENT_FIELDS.filter((f) => f !== 'wind_gusts_10m');

export function compassToMathRadians(compassDeg) {
  // Meteorological convention: `compassDeg` is where the wind is COMING FROM,
  // measured clockwise from north. The vector the wind is BLOWING TOWARDS is
  // 180° opposite. In the sim's math frame (x=east, y=north), the "blowing
  // towards" unit vector is (sin(from + π), cos(from + π)). We return the
  // angle of that vector via atan2(y, x).
  const fromRad = (compassDeg * Math.PI) / 180;
  const towardsX = Math.sin(fromRad + Math.PI);
  const towardsY = Math.cos(fromRad + Math.PI);
  return Math.atan2(towardsY, towardsX);
}

// RMRS-GTR-266 Eq. 2. The published sheltered WAF is normalized to free wind
// 20 ft above the canopy top. Open-Meteo supplies wind at a fixed 10 m above
// ground, so only apply this equation when that observation is actually above
// the required normalization height. Taller canopies retain the conservative
// legacy shelter factor instead of silently extrapolating the weather input.
export function calculateCanopyShelteredWindAdjustment({
  canopyHeightMeters,
  canopyCoverFraction,
  crownRatio = 1,
  referenceHeightMeters = DEFAULT_WIND_REFERENCE_HEIGHT_METERS
} = {}) {
  if (!Number.isFinite(canopyHeightMeters) || canopyHeightMeters <= 0) return null;
  if (!Number.isFinite(canopyCoverFraction)
    || canopyCoverFraction < 0
    || canopyCoverFraction > 1) return null;
  if (!Number.isFinite(crownRatio) || crownRatio <= 0 || crownRatio > 1) return null;
  if (!Number.isFinite(referenceHeightMeters) || referenceHeightMeters <= 0) return null;

  const shelterFraction = (canopyCoverFraction / 3) * crownRatio;
  if (shelterFraction < CANOPY_SHELTER_FRACTION_CUTOFF) return null;
  if (referenceHeightMeters < canopyHeightMeters + CANOPY_FREE_WIND_CLEARANCE_METERS) return null;

  const heightFeet = canopyHeightMeters / METERS_PER_FOOT;
  const logTerm = Math.log(
    (20 + 0.36 * heightFeet) / (0.13 * heightFeet)
  );
  const adjustmentFactor = 0.555 / (shelterFraction * logTerm);
  // A WAF above one is not a physically meaningful sheltered reduction. It
  // occurs near the source's five-percent cutoff, so use the known fallback.
  if (!Number.isFinite(adjustmentFactor) || adjustmentFactor <= 0 || adjustmentFactor > 1) return null;
  return {
    adjustmentFactor,
    shelterFraction,
    method: `10m-canopy-GTR-266-Eq2-CH-${canopyHeightMeters.toFixed(2)}m-CC-${canopyCoverFraction.toFixed(2)}`
  };
}

// RMRS-GTR-266 Eq. 8 gives the unsheltered WAF relative to wind measured
// 20 ft above the fuel bed. Standard fuel-model tables may replace the
// equation's generic HF/H=1 value; the height-ratio conversion keeps that
// published value compatible with Open-Meteo's 10 m above-ground wind.
export function calculateUnshelteredWindAdjustment({
  fuelBedDepthMeters,
  referenceHeightMeters = DEFAULT_WIND_REFERENCE_HEIGHT_METERS,
  publishedAdjustmentFactor = null
} = {}) {
  if (!Number.isFinite(fuelBedDepthMeters) || fuelBedDepthMeters <= 0) return null;
  if (!Number.isFinite(referenceHeightMeters) || referenceHeightMeters <= 0) return null;
  if (publishedAdjustmentFactor !== null
    && (!Number.isFinite(publishedAdjustmentFactor)
      || publishedAdjustmentFactor <= 0
      || publishedAdjustmentFactor > 1)) return null;

  const depthFeet = fuelBedDepthMeters / METERS_PER_FOOT;
  const referenceHeightFeet = referenceHeightMeters / METERS_PER_FOOT;
  const sourceLogTerm = Math.log(
    (BEHAVEPLUS_REFERENCE_HEIGHT_FEET + 0.36 * depthFeet) / (0.13 * depthFeet)
  );
  const referenceLogTerm = Math.log(
    (referenceHeightFeet + 0.36 * depthFeet) / (0.13 * depthFeet)
  );
  if (!(sourceLogTerm > 0) || !(referenceLogTerm > 0)) return null;
  const sourceFactor = publishedAdjustmentFactor
    ?? (1.83 / sourceLogTerm);
  const adjustmentFactor = sourceFactor * sourceLogTerm / referenceLogTerm;
  if (!Number.isFinite(adjustmentFactor) || adjustmentFactor <= 0 || adjustmentFactor > 1) return null;
  return {
    adjustmentFactor,
    sourceFactor,
    sourceReferenceHeightFeet: BEHAVEPLUS_REFERENCE_HEIGHT_FEET,
    referenceHeightMeters
  };
}

export function windToMidflame({
  tenMeterWindKmh,
  canopySheltered = false,
  fuelBedDepthMeters = null,
  referenceHeightMeters = DEFAULT_WIND_REFERENCE_HEIGHT_METERS,
  canopyHeightMeters = null,
  canopyCoverFraction = null,
  crownRatio = 1,
  fuelModel = null
}) {
  if (!Number.isFinite(tenMeterWindKmh) || tenMeterWindKmh < 0) {
    throw new RangeError(`windToMidflame: tenMeterWindKmh must be finite ≥ 0, got ${tenMeterWindKmh}`);
  }
  const hasFuelBedDepth = Number.isFinite(fuelBedDepthMeters) && fuelBedDepthMeters > 0;
  if (!Number.isFinite(referenceHeightMeters) || referenceHeightMeters <= 0) {
    throw new RangeError(`windToMidflame: referenceHeightMeters must be positive, got ${referenceHeightMeters}`);
  }
  let mult;
  let method;
  const measuredCanopyWaf = canopySheltered
    ? calculateCanopyShelteredWindAdjustment({
      canopyHeightMeters,
      canopyCoverFraction,
      crownRatio,
      referenceHeightMeters
    })
    : null;
  if (measuredCanopyWaf) {
    mult = measuredCanopyWaf.adjustmentFactor;
    method = measuredCanopyWaf.method;
  } else if (hasFuelBedDepth && !canopySheltered) {
    const unshelteredWaf = calculateUnshelteredWindAdjustment({
      fuelBedDepthMeters,
      referenceHeightMeters,
      publishedAdjustmentFactor: fuelModel?.windAdjustmentFactor ?? null
    });
    mult = unshelteredWaf?.adjustmentFactor ?? MIDFLAME_MULT_OPEN;
    method = fuelModel?.windAdjustmentFactor
      ? `10m-open-published-WAF-${fuelModel.code}-${fuelModel.windAdjustmentFactor.toFixed(2)}`
      : `10m-open-BehavePlus-WAF-depth-${fuelBedDepthMeters.toFixed(3)}m`;
  } else {
    mult = canopySheltered ? MIDFLAME_MULT_SHELT : MIDFLAME_MULT_OPEN;
    method = canopySheltered ? '10m-canopy-to-midflame-x0.2' : '10m-open-to-midflame-x0.4';
  }
  return {
    speedKmh: tenMeterWindKmh * mult,
    adjustmentFactor: mult,
    method
  };
}

export function isWeatherStale(entry, ttlMs) {
  if (!entry || !Number.isFinite(entry.fetchedAt)) return true;
  return (Date.now() - entry.fetchedAt) > ttlMs;
}

async function fetchWithRateLimitRetry(fetchImpl, url, signal, delayMs) {
  let response = await fetchImpl(url, signal ? { signal } : undefined);
  if (response.status === 429 && !signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
    response = await fetchImpl(url, signal ? { signal } : undefined);
  }
  return response;
}

function normalizeHourlyWeather(payload, observationTime) {
  const hourly = payload?.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return [];
  const hours = [];
  for (let index = 0; index < hourly.time.length; index += 1) {
    const time = hourly.time[index];
    const timeMs = Date.parse(time);
    const temperatureCelsius = hourly.temperature_2m?.[index];
    const relativeHumidityPercent = hourly.relative_humidity_2m?.[index];
    const precipitationMillimeters = hourly.precipitation?.[index] ?? 0;
    const windSpeedKmh = hourly.wind_speed_10m?.[index];
    const windDirectionDeg = hourly.wind_direction_10m?.[index];
    if (!Number.isFinite(timeMs)
      || !Number.isFinite(temperatureCelsius)
      || !Number.isFinite(relativeHumidityPercent)
      || !Number.isFinite(precipitationMillimeters)) continue;
    hours.push({
      time,
      temperatureCelsius,
      relativeHumidityFraction: relativeHumidityPercent / 100,
      precipitationMillimeters,
      windSpeedKmh: Number.isFinite(windSpeedKmh) ? windSpeedKmh : null,
      windDirectionDeg: Number.isFinite(windDirectionDeg) ? windDirectionDeg : null
    });
  }
  return hours.slice(-36 * 24);
}

export function buildWindTimeline(
  hours,
  observationTime,
  canopySheltered,
  horizonHours = 72,
  fuelBedDepthMeters = null,
  fuelModel = null
) {
  const observationMs = Date.parse(observationTime);
  if (!Number.isFinite(observationMs)) return [];
  if (!Number.isFinite(horizonHours) || horizonHours < 0) {
    throw new RangeError('weatherInputs: horizonHours must be non-negative');
  }
  return hours
    .filter((hour) => (
      Number.isFinite(hour.windSpeedKmh)
      && hour.windSpeedKmh >= 0
      && Number.isFinite(hour.windDirectionDeg)
      && Number.isFinite(Date.parse(hour.time))
      && Date.parse(hour.time) >= observationMs
      && Date.parse(hour.time) <= observationMs + horizonHours * 3_600_000
    ))
    .map((hour) => ({
      minutesFromIgnition: Math.max(0, (Date.parse(hour.time) - observationMs) / 60_000),
      tenMeterWindKmh: hour.windSpeedKmh,
      referenceHeightMeters: DEFAULT_WIND_REFERENCE_HEIGHT_METERS,
      midflameWindKmh: windToMidflame({
        tenMeterWindKmh: hour.windSpeedKmh,
        canopySheltered,
        fuelBedDepthMeters,
        fuelModel
      }).speedKmh,
      windDirectionRadians: compassToMathRadians(hour.windDirectionDeg),
      sourceTime: hour.time
    }));
}

// Carry the dead-fuel state forward through the forecast as well as the wind.
// The first entry is the current estimate; later entries apply the NFDRS
// time-lag update to each hourly observation, so forecast rain can suppress
// future Rothermel spread instead of affecting only the metadata panel.
export function buildWeatherTimeline({
  hours,
  observationTime,
  canopySheltered = false,
  fuelBedDepthMeters = null,
  fuelModel = null,
  initialDeadMoistureByClass = null,
  horizonHours = 72
} = {}) {
  const observationMs = Date.parse(observationTime);
  if (!Number.isFinite(observationMs) || !Array.isArray(hours)) return [];
  if (!Number.isFinite(horizonHours) || horizonHours < 0) {
    throw new RangeError('weatherInputs: horizonHours must be non-negative');
  }

  let deadMoistureByClass = initialDeadMoistureByClass
    ? { ...initialDeadMoistureByClass }
    : null;
  let previousObservationTime = observationTime;
  let firstHour = true;
  const timeline = [];
  for (const hour of hours) {
    const hourMs = Date.parse(hour?.time);
    if (!Number.isFinite(hourMs)
      || hourMs < observationMs
      || hourMs > observationMs + horizonHours * 3_600_000) continue;

    if (firstHour && hourMs === observationMs) {
      // The current estimate already incorporates the observed hour. Do not
      // advance it twice before the first forecast step.
      if (!deadMoistureByClass) {
        deadMoistureByClass = estimateDeadFuelMoistureFromHourlyWeather({
          hours: [hour],
          previousObservationTime: hour.time
        }).byClass;
      }
    } else {
      deadMoistureByClass = estimateDeadFuelMoistureFromHourlyWeather({
        hours: [hour],
        initialMoistureByClass: deadMoistureByClass,
        previousObservationTime: previousObservationTime
      }).byClass;
    }
    previousObservationTime = hour.time;
    firstHour = false;

    if (!Number.isFinite(hour.windSpeedKmh)
      || hour.windSpeedKmh < 0
      || !Number.isFinite(hour.windDirectionDeg)) continue;
    timeline.push({
      minutesFromIgnition: (hourMs - observationMs) / 60_000,
      tenMeterWindKmh: hour.windSpeedKmh,
      referenceHeightMeters: DEFAULT_WIND_REFERENCE_HEIGHT_METERS,
      midflameWindKmh: windToMidflame({
        tenMeterWindKmh: hour.windSpeedKmh,
        canopySheltered,
        fuelBedDepthMeters,
        fuelModel
      }).speedKmh,
      windDirectionRadians: compassToMathRadians(hour.windDirectionDeg),
      deadMoistureByClass: { ...deadMoistureByClass },
      sourceTime: hour.time
    });
  }
  return timeline;
}

export async function fetchWeatherInputs({
  latitude,
  longitude,
  canopySheltered = false,
  fuelBedDepthMeters = null,
  fuelModel = null,
  initialDeadMoistureByClass = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  rateLimitRetryDelayMs = 500
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('weatherInputs: fetch implementation unavailable');
  }
  const url = new URL(OPEN_METEO_FORECAST_URL);
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('current', CURRENT_FIELDS.join(','));
  url.searchParams.set('hourly', HOURLY_FIELDS.join(','));
  // Seven days provides a conservative 100-hour-fuel moisture spin-up while
  // keeping an interactive request well inside public-provider fair use.
  url.searchParams.set('past_days', '7');
  // Aethon's fire window is two hours; one forecast day is ample for the
  // weather timeline and avoids fetching unused multi-day data.
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('timezone', 'GMT');

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchWithRateLimitRetry(fetchImpl, url.toString(), controller?.signal, rateLimitRetryDelayMs);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`weather fetch failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  const current = payload?.current;
  if (!current) {
    throw new Error('weather response missing "current" block');
  }
  for (const field of REQUIRED_CURRENT_FIELDS) {
    if (typeof current[field] !== 'number') {
      throw new Error(`weather response missing numeric "${field}"`);
    }
  }

  const midflame = windToMidflame({
    tenMeterWindKmh: current.wind_speed_10m,
    canopySheltered,
    fuelBedDepthMeters,
    fuelModel
  });
  const allHourlyWeather = normalizeHourlyWeather(payload, current.time);
  const observationMs = Date.parse(current.time);
  const hourlyWeather = allHourlyWeather.filter((hour) => Date.parse(hour.time) <= observationMs);
  // Keep the complete requested history so the 100-hour fuel class receives
  // a physically meaningful spin-up rather than an arbitrary short window.
  const deadFuelHours = hourlyWeather;
  const fuelMoisture = deadFuelHours.length > 0
    ? estimateDeadFuelMoistureFromHourlyWeather({
      hours: deadFuelHours,
      initialMoistureByClass: initialDeadMoistureByClass ?? undefined
    })
    : null;
  const dailyWeather = aggregateHourlyWeatherToDaily(hourlyWeather);
  const liveFuelMoisture = dailyWeather.length > 0
    ? estimateLiveFuelMoistureFromDailyWeather({
      dailyWeather,
      latitude: payload.latitude ?? latitude
    })
    : null;
  const windTimeline = buildWindTimeline(
    allHourlyWeather,
    current.time,
    canopySheltered,
    72,
    fuelBedDepthMeters,
    fuelModel
  );
  const weatherTimeline = buildWeatherTimeline({
    hours: allHourlyWeather,
    observationTime: current.time,
    canopySheltered,
    fuelBedDepthMeters,
    fuelModel,
    initialDeadMoistureByClass: fuelMoisture?.byClass ?? initialDeadMoistureByClass,
    horizonHours: 72
  });

  return {
    source: fuelMoisture || liveFuelMoisture
      ? 'Open-Meteo /forecast (current + hourly)'
      : 'Open-Meteo /forecast (current)',
    attribution: 'Open-Meteo · CC BY 4.0',
    fetchedAt: Date.now(),
    observationTime: current.time,
    location: { latitude: payload.latitude, longitude: payload.longitude },
    elevationMeters: payload.elevation ?? null,
    wind: {
      tenMeterSpeedKmh: current.wind_speed_10m,
      gustsKmh: Number.isFinite(current.wind_gusts_10m) ? current.wind_gusts_10m : null,
      compassDirectionDeg: current.wind_direction_10m,
      measurementHeightMeters: 10,
      midflameSpeedKmh: midflame.speedKmh,
      fuelBedDepthMeters,
      midflameAdjustmentMethod: midflame.method,
      midflameAdjustmentScope: fuelBedDepthMeters
        ? 'destination-fuel-cell WAF when raw 10m timeline reaches propagation; clicked-fuel baseline for metadata'
        : 'single scenario factor because no fuel-bed depth was supplied',
      mathFrameRadians: compassToMathRadians(current.wind_direction_10m)
    },
    temperature: {
      celsius: current.temperature_2m,
      measurementHeightMeters: 2
    },
    relativeHumidity: {
      fraction: current.relative_humidity_2m / 100,
      measurementHeightMeters: 2
    },
    precipitation: {
      millimeters: current.precipitation,
      period: 'current-hour'
    },
    fuelMoisture,
    liveFuelMoisture,
    windTimeline,
    weatherTimeline,
    hourly: {
      observationsUsed: hourlyWeather.length,
      historyHours: hourlyWeather.length > 0 ? hourlyWeather.length - 1 : 0,
      forecastHours: windTimeline.length,
      forecastMoistureHours: weatherTimeline.length
    }
  };
}

// Kept separate from moisture history so a normal ignition can obtain live
// 10 m wind without paying for a multi-day weather payload.
export async function fetchCurrentWind({
  latitude,
  longitude,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  rateLimitRetryDelayMs = 500
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('current wind fetch is unavailable');
  const url = new URL(OPEN_METEO_FORECAST_URL);
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('current', CURRENT_WIND_FIELDS.join(','));
  url.searchParams.set('wind_speed_unit', 'kmh');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchWithRateLimitRetry(fetchImpl, url.toString(), controller?.signal, rateLimitRetryDelayMs);
    if (!response.ok) throw new Error(`current wind fetch failed with HTTP ${response.status}`);
    const current = (await response.json())?.current;
    if (!Number.isFinite(current?.wind_speed_10m) || !Number.isFinite(current?.wind_direction_10m)) {
      throw new Error('current wind response missing speed or direction');
    }
    return {
      source: 'Open-Meteo /forecast (current wind)',
      attribution: 'Open-Meteo · CC BY 4.0',
      fetchedAt: Date.now(),
      observationTime: current.time ?? null,
      tenMeterSpeedKmh: current.wind_speed_10m,
      compassDirectionDeg: current.wind_direction_10m,
      gustsKmh: Number.isFinite(current.wind_gusts_10m) ? current.wind_gusts_10m : null
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
