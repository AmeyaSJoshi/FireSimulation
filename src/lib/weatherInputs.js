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
// adjustment; we ship a coarse constant multiplier here (0.4 for open
// fuels, 0.2 for canopy-sheltered) as a first-cut consistent with
// BehavePlus defaults. Phase 3 refines to a canopy-aware log profile.

const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CURRENT_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'precipitation'
];

const MIDFLAME_MULT_OPEN = 0.4;      // Baughman & Albini 1980 midflame factor for exposed fuels
const MIDFLAME_MULT_SHELT = 0.2;     // Sheltered under canopy — conservative starter value

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

export function windToMidflame({ tenMeterWindKmh, canopySheltered }) {
  if (!Number.isFinite(tenMeterWindKmh) || tenMeterWindKmh < 0) {
    throw new RangeError(`windToMidflame: tenMeterWindKmh must be finite ≥ 0, got ${tenMeterWindKmh}`);
  }
  const mult = canopySheltered ? MIDFLAME_MULT_SHELT : MIDFLAME_MULT_OPEN;
  return {
    speedKmh: tenMeterWindKmh * mult,
    method: canopySheltered ? '10m-canopy-to-midflame-x0.2' : '10m-open-to-midflame-x0.4'
  };
}

export function isWeatherStale(entry, ttlMs) {
  if (!entry || !Number.isFinite(entry.fetchedAt)) return true;
  return (Date.now() - entry.fetchedAt) > ttlMs;
}

export async function fetchWeatherInputs({
  latitude,
  longitude,
  canopySheltered = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('weatherInputs: fetch implementation unavailable');
  }
  const url = new URL(OPEN_METEO_FORECAST_URL);
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('current', CURRENT_FIELDS.join(','));
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('timezone', 'GMT');

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchImpl(url.toString(), controller ? { signal: controller.signal } : undefined);
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
    canopySheltered
  });

  return {
    source: 'Open-Meteo /forecast (current)',
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
      midflameAdjustmentMethod: midflame.method,
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
    }
  };
}
