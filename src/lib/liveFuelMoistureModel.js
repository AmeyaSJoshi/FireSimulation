// NFDRS v4-style live fuel moisture estimate from daily weather.
//
// The ramp limits, 28-day precipitation/GSI windows, and herbaceous/woody
// transforms follow Jolly et al. (2024), USFS NFDRS v4, sections 4.3.1-4.3.6:
// https://research.fs.usda.gov/download/treesearch/68223.pdf
//
// This module intentionally exposes the historical-max-GSI assumption. A
// location-calibrated historical maximum and field observations are required
// for an operational live-fuel-moisture product.

const HOURS_PER_DAY = 24;
const SECONDS_PER_HOUR = 3600;
const DAY_OF_YEAR_DAYS = 365.2422;
const SOLAR_DECLINATION_MAX_DEGREES = 23.44;

export const DEFAULT_GSI_PARAMETERS = Object.freeze({
  smoothingDays: 28,
  precipitationWindowDays: 28,
  maximumGsiByClass: Object.freeze({ herbaceous: 1, woody: 1 }),
  herbaceous: Object.freeze({ minimumPercent: 30, maximumPercent: 250, greenup: 0.2 }),
  woody: Object.freeze({ minimumPercent: 60, maximumPercent: 200, greenup: 0.2 })
});

function requireFinite(name, value) {
  if (!Number.isFinite(value)) throw new RangeError(`liveFuelMoisture: ${name} must be finite`);
}

function ramp(value, lower, upper) {
  if (value <= lower) return 0;
  if (value >= upper) return 1;
  return (value - lower) / (upper - lower);
}

export function saturationVaporPressurePa(temperatureCelsius) {
  requireFinite('temperatureCelsius', temperatureCelsius);
  // Murray (1967), as cited by Jolly et al. (2024), in Pa. The ice branch
  // avoids applying the liquid-water approximation below freezing.
  if (temperatureCelsius < 0) {
    return 610.78 * Math.exp((21.8746 * temperatureCelsius) / (265.5 + temperatureCelsius));
  }
  return 610.78 * Math.exp((17.2694 * temperatureCelsius) / (238.3 + temperatureCelsius));
}

export function vaporPressureDeficitPa({ temperatureCelsius, relativeHumidityFraction } = {}) {
  requireFinite('temperatureCelsius', temperatureCelsius);
  requireFinite('relativeHumidityFraction', relativeHumidityFraction);
  if (relativeHumidityFraction < 0 || relativeHumidityFraction > 1) {
    throw new RangeError('liveFuelMoisture: relativeHumidityFraction must be between 0 and 1');
  }
  return saturationVaporPressurePa(temperatureCelsius) * (1 - relativeHumidityFraction);
}

function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return 1 + Math.floor((date.getTime() - start) / 86_400_000);
}

export function dayLengthSeconds({ latitude, date } = {}) {
  requireFinite('latitude', latitude);
  if (latitude < -90 || latitude > 90) throw new RangeError('liveFuelMoisture: latitude must be in [-90, 90]');
  const parsedDate = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(parsedDate.getTime())) throw new RangeError('liveFuelMoisture: date must be valid');
  const latitudeRadians = latitude * Math.PI / 180;
  const declinationRadians = SOLAR_DECLINATION_MAX_DEGREES * Math.PI / 180
    * Math.sin((2 * Math.PI * (dayOfYear(parsedDate) - 80)) / DAY_OF_YEAR_DAYS);
  const cosineHourAngle = -Math.tan(latitudeRadians) * Math.tan(declinationRadians);
  if (cosineHourAngle <= -1) return HOURS_PER_DAY * SECONDS_PER_HOUR;
  if (cosineHourAngle >= 1) return 0;
  return (2 * Math.acos(cosineHourAngle) / (2 * Math.PI)) * HOURS_PER_DAY * SECONDS_PER_HOUR;
}

export function aggregateHourlyWeatherToDaily(hours = []) {
  if (!Array.isArray(hours) || hours.length === 0) return [];
  const byDate = new Map();
  for (const hour of hours) {
    const time = new Date(hour?.time);
    if (!Number.isFinite(time.getTime())) continue;
    requireFinite('hour.temperatureCelsius', hour.temperatureCelsius);
    requireFinite('hour.relativeHumidityFraction', hour.relativeHumidityFraction);
    requireFinite('hour.precipitationMillimeters', hour.precipitationMillimeters ?? 0);
    const date = time.toISOString().slice(0, 10);
    const current = byDate.get(date) ?? {
      date,
      minTemperatureCelsius: Infinity,
      maxTemperatureCelsius: -Infinity,
      minRelativeHumidityFraction: Infinity,
      precipitationMillimeters: 0
    };
    current.minTemperatureCelsius = Math.min(current.minTemperatureCelsius, hour.temperatureCelsius);
    current.maxTemperatureCelsius = Math.max(current.maxTemperatureCelsius, hour.temperatureCelsius);
    current.minRelativeHumidityFraction = Math.min(
      current.minRelativeHumidityFraction,
      hour.relativeHumidityFraction
    );
    current.precipitationMillimeters += hour.precipitationMillimeters ?? 0;
    byDate.set(date, current);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function liveMoistureFraction(gsi, parameters, maximumGsi) {
  const rescaledGsi = maximumGsi > 0 ? Math.min(1, gsi / maximumGsi) : 0;
  if (rescaledGsi < parameters.greenup) return parameters.minimumPercent / 100;
  const slope = (parameters.maximumPercent - parameters.minimumPercent)
    / (1 - parameters.greenup);
  const intercept = parameters.maximumPercent - slope;
  return (slope * rescaledGsi + intercept) / 100;
}

export function estimateLiveFuelMoistureFromDailyWeather({
  dailyWeather,
  latitude,
  parameters = DEFAULT_GSI_PARAMETERS
} = {}) {
  if (!Array.isArray(dailyWeather) || dailyWeather.length === 0) {
    throw new RangeError('liveFuelMoisture: dailyWeather must contain observations');
  }
  requireFinite('latitude', latitude);
  const smoothingDays = Math.max(1, Math.floor(parameters.smoothingDays ?? 28));
  const precipitationWindowDays = Math.max(1, Math.floor(parameters.precipitationWindowDays ?? 28));
  const dailyIndicators = dailyWeather.map((day, index) => {
    const date = new Date(`${day.date}T12:00:00Z`);
    const vpdPa = vaporPressureDeficitPa({
      temperatureCelsius: day.maxTemperatureCelsius,
      relativeHumidityFraction: day.minRelativeHumidityFraction
    });
    const precipitationStart = Math.max(0, index - precipitationWindowDays + 1);
    const precipitationSum = dailyWeather.slice(precipitationStart, index + 1)
      .reduce((sum, sample) => sum + sample.precipitationMillimeters, 0);
    const temperatureRamp = ramp(day.minTemperatureCelsius, -2, 5);
    const vpdRamp = 1 - ramp(vpdPa, 900, 4100);
    const dayLengthRamp = ramp(dayLengthSeconds({ latitude, date }), 36_000, 39_600);
    const precipitationRamp = ramp(precipitationSum, 0, 10);
    return {
      date: day.date,
      gsi: temperatureRamp * vpdRamp * dayLengthRamp * precipitationRamp,
      components: { temperatureRamp, vpdRamp, dayLengthRamp, precipitationRamp },
      precipitationSumMillimeters: precipitationSum
    };
  });
  const smoothed = dailyIndicators.slice(-smoothingDays);
  const gsi = smoothed.reduce((sum, day) => sum + day.gsi, 0) / smoothed.length;
  const maximumGsiByClass = parameters.maximumGsiByClass ?? DEFAULT_GSI_PARAMETERS.maximumGsiByClass;
  const herbaceousParameters = parameters.herbaceous ?? DEFAULT_GSI_PARAMETERS.herbaceous;
  const woodyParameters = parameters.woody ?? DEFAULT_GSI_PARAMETERS.woody;

  return {
    byClass: {
      herbaceous: liveMoistureFraction(gsi, herbaceousParameters, maximumGsiByClass.herbaceous),
      woody: liveMoistureFraction(gsi, woodyParameters, maximumGsiByClass.woody)
    },
    gsi,
    source: 'Open-Meteo hourly weather',
    method: 'NFDRS v4 GSI live-fuel estimate',
    estimated: true,
    dailyObservationsUsed: dailyWeather.length,
    smoothingDays,
    precipitationWindowDays,
    latestComponents: smoothed.at(-1)?.components ?? null
  };
}

