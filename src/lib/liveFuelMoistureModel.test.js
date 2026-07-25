import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateHourlyWeatherToDaily,
  dayLengthSeconds,
  estimateLiveFuelMoistureFromDailyWeather,
  saturationVaporPressurePa,
  vaporPressureDeficitPa
} from './liveFuelMoistureModel.js';

test('Murray saturation vapor pressure returns a physically plausible value', () => {
  const pressure = saturationVaporPressurePa(20);
  assert.ok(Math.abs(pressure - 2338) < 30, `unexpected saturation pressure: ${pressure}`);
  assert.ok(vaporPressureDeficitPa({ temperatureCelsius: 20, relativeHumidityFraction: 0.5 }) > 0);
});

test('day length stays bounded and is longer in summer at mid-latitudes', () => {
  const winter = dayLengthSeconds({ latitude: 40, date: '2026-01-15' });
  const summer = dayLengthSeconds({ latitude: 40, date: '2026-06-15' });
  assert.ok(winter > 0 && winter < 86_400);
  assert.ok(summer > winter);
});

test('hourly weather aggregates into daily extrema and precipitation totals', () => {
  const daily = aggregateHourlyWeatherToDaily([
    { time: '2026-06-15T00:00:00Z', temperatureCelsius: 12, relativeHumidityFraction: 0.8, precipitationMillimeters: 1 },
    { time: '2026-06-15T12:00:00Z', temperatureCelsius: 30, relativeHumidityFraction: 0.25, precipitationMillimeters: 2 },
    { time: '2026-06-16T00:00:00Z', temperatureCelsius: 15, relativeHumidityFraction: 0.7, precipitationMillimeters: 0 }
  ]);
  assert.equal(daily.length, 2);
  assert.equal(daily[0].minTemperatureCelsius, 12);
  assert.equal(daily[0].maxTemperatureCelsius, 30);
  assert.equal(daily[0].minRelativeHumidityFraction, 0.25);
  assert.equal(daily[0].precipitationMillimeters, 3);
});

test('GSI transforms dormant and green live fuel moisture separately', () => {
  const dailyWeather = Array.from({ length: 28 }, (_, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, '0')}`,
    minTemperatureCelsius: 10,
    maxTemperatureCelsius: 20,
    minRelativeHumidityFraction: 0.7,
    precipitationMillimeters: 2
  }));
  const green = estimateLiveFuelMoistureFromDailyWeather({ dailyWeather, latitude: 40 });
  assert.ok(green.gsi > 0.2);
  assert.ok(green.byClass.herbaceous > 0.3);
  assert.ok(green.byClass.woody > 0.6);

  const dormant = estimateLiveFuelMoistureFromDailyWeather({
    dailyWeather: dailyWeather.map((day) => ({
      ...day,
      minTemperatureCelsius: -5,
      minRelativeHumidityFraction: 0.1,
      precipitationMillimeters: 0
    })),
    latitude: 40
  });
  assert.equal(dormant.gsi, 0);
  assert.equal(dormant.byClass.herbaceous, 0.3);
  assert.equal(dormant.byClass.woody, 0.6);
});

