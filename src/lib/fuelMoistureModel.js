// Weather-derived dead-fuel moisture estimate.
//
// The EMC branches and the exponential time-lag update follow the USFS
// 1978 NFDRS technical documentation (USDA INT-115, Appendix C and the
// 1-hour model, equations 25-26):
// https://research.fs.usda.gov/download/treesearch/29615.pdf
//
// This is deliberately labeled an estimate, not an observation and not a
// full NFDRS4/Nelson implementation. The operational model also uses fuel
// interface adjustments, station state, and longer daily bookkeeping.

const FUEL_TIME_LAGS_HOURS = Object.freeze({
  '1h': 1,
  '10h': 10,
  '100h': 100
});

const DEFAULT_INITIAL_MOISTURE = Object.freeze({
  '1h': 0.08,
  '10h': 0.08,
  '100h': 0.08
});

const MEASURABLE_PRECIPITATION_MM = 0.1;
const RAIN_BOUNDARY_BASE_PERCENT = 76;
const RAIN_BOUNDARY_INCREMENT_PERCENT_PER_HOUR = 2.7;

function assertFinite(value, name) {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

export function equilibriumMoistureContentPercent({
  temperatureCelsius,
  relativeHumidityFraction
} = {}) {
  assertFinite(temperatureCelsius, 'temperatureCelsius');
  assertFinite(relativeHumidityFraction, 'relativeHumidityFraction');
  if (relativeHumidityFraction < 0 || relativeHumidityFraction > 1) {
    throw new RangeError('relativeHumidityFraction must be between 0 and 1');
  }

  const temperatureFahrenheit = temperatureCelsius * 9 / 5 + 32;
  const relativeHumidityPercent = relativeHumidityFraction * 100;
  let emc;

  if (relativeHumidityPercent < 10) {
    emc = 0.03229
      + 0.281073 * relativeHumidityPercent
      - 0.000578 * temperatureFahrenheit * relativeHumidityPercent;
  } else if (relativeHumidityPercent < 50) {
    emc = 2.22749
      + 0.160107 * relativeHumidityPercent
      - 0.014784 * temperatureFahrenheit;
  } else {
    emc = 21.0606
      + 0.005565 * relativeHumidityPercent ** 2
      - 0.00035 * relativeHumidityPercent * temperatureFahrenheit
      - 0.483199 * relativeHumidityPercent;
  }

  return Math.max(0, Math.min(100, emc));
}

function rainfallBoundaryFraction(precipitationMillimeters) {
  if (!Number.isFinite(precipitationMillimeters) || precipitationMillimeters < 0) {
    throw new RangeError('precipitationMillimeters must be finite and non-negative');
  }
  if (precipitationMillimeters < MEASURABLE_PRECIPITATION_MM) return null;

  // For hourly observations, measurable precipitation represents one hour of
  // precipitation duration. The boundary is the hourly form of the USFS
  // precipitation-duration function used in the 1978 10/100-hour models.
  return (RAIN_BOUNDARY_BASE_PERCENT + RAIN_BOUNDARY_INCREMENT_PERCENT_PER_HOUR) / 100;
}

function initialMoisture(initialMoistureByClass, className) {
  const value = initialMoistureByClass?.[className] ?? DEFAULT_INITIAL_MOISTURE[className];
  assertFinite(value, `initialMoistureByClass.${className}`);
  if (value < 0 || value > 1) {
    throw new RangeError(`initialMoistureByClass.${className} must be between 0 and 1`);
  }
  return value;
}

function observationStepHours(previousTime, currentTime) {
  if (!previousTime || !currentTime) return 1;
  const previousMs = Date.parse(previousTime);
  const currentMs = Date.parse(currentTime);
  if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs)) return 1;
  return Math.max(1 / 60, Math.min(24, (currentMs - previousMs) / 3_600_000));
}

export function estimateDeadFuelMoistureFromHourlyWeather({
  hours,
  initialMoistureByClass = DEFAULT_INITIAL_MOISTURE,
  previousObservationTime = null
} = {}) {
  if (!Array.isArray(hours) || hours.length === 0) {
    throw new RangeError('hours must contain at least one weather observation');
  }

  const moisture = Object.fromEntries(Object.keys(FUEL_TIME_LAGS_HOURS).map((className) => [
    className,
    initialMoisture(initialMoistureByClass, className)
  ]));
  let previousTime = previousObservationTime;
  let lastEquilibriumFraction = null;

  for (const observation of hours) {
    const temperatureCelsius = observation?.temperatureCelsius;
    const relativeHumidityFraction = observation?.relativeHumidityFraction;
    const precipitationMillimeters = observation?.precipitationMillimeters ?? 0;
    const equilibriumFraction = equilibriumMoistureContentPercent({
      temperatureCelsius,
      relativeHumidityFraction
    }) / 100;
    const rainBoundary = rainfallBoundaryFraction(precipitationMillimeters);
    const boundaryFraction = rainBoundary === null
      ? equilibriumFraction
      : Math.max(equilibriumFraction, rainBoundary);
    const deltaHours = observationStepHours(previousTime, observation?.time);

    for (const [className, timeLagHours] of Object.entries(FUEL_TIME_LAGS_HOURS)) {
      const response = 1 - Math.exp(-deltaHours / timeLagHours);
      moisture[className] += (boundaryFraction - moisture[className]) * response;
      moisture[className] = Math.max(0, Math.min(1, moisture[className]));
    }

    lastEquilibriumFraction = equilibriumFraction;
    previousTime = observation?.time ?? null;
  }

  return {
    byClass: moisture,
    source: 'Open-Meteo hourly weather',
    method: 'NFDRS EMC + hourly time-lag estimate',
    observationsUsed: hours.length,
    equilibriumMoistureFraction: lastEquilibriumFraction,
    estimated: true
  };
}
