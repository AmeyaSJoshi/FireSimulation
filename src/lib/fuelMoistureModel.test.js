import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  equilibriumMoistureContentPercent,
  estimateDeadFuelMoistureFromHourlyWeather
} from './fuelMoistureModel.js';

test('equilibrium moisture content follows the NFDRS piecewise equations', () => {
  assert.ok(Math.abs(equilibriumMoistureContentPercent({
    temperatureCelsius: 30,
    relativeHumidityFraction: 0.05
  }) - 1.189115) < 1e-6);

  const moderate = equilibriumMoistureContentPercent({
    temperatureCelsius: 30,
    relativeHumidityFraction: 0.2
  });
  assert.ok(Math.abs(moderate - 4.158206) < 1e-5, `unexpected moderate EMC: ${moderate}`);

  const humid = equilibriumMoistureContentPercent({
    temperatureCelsius: 20,
    relativeHumidityFraction: 0.8
  });
  assert.ok(Math.abs(humid - 16.11668) < 1e-5, `unexpected humid EMC: ${humid}`);
});

test('hourly dead-fuel estimate separates the 1 h, 10 h, and 100 h response', () => {
  const hours = Array.from({ length: 48 }, (_, index) => ({
    time: `2026-07-21T${String(index % 24).padStart(2, '0')}:00`,
    temperatureCelsius: 30,
    relativeHumidityFraction: 0.2,
    precipitationMillimeters: 0
  }));
  const result = estimateDeadFuelMoistureFromHourlyWeather({
    hours,
    initialMoistureByClass: { '1h': 0.08, '10h': 0.08, '100h': 0.08 }
  });

  assert.equal(result.source, 'Open-Meteo hourly weather');
  assert.equal(result.method, 'NFDRS EMC + hourly time-lag estimate');
  assert.ok(result.byClass['1h'] < result.byClass['10h']);
  assert.ok(result.byClass['10h'] < result.byClass['100h']);
  assert.ok(result.byClass['1h'] >= 0);
  assert.ok(result.byClass['100h'] <= 1);
});

test('rain raises the estimated boundary condition instead of drying fuel', () => {
  const dryHours = Array.from({ length: 24 }, () => ({
    temperatureCelsius: 30,
    relativeHumidityFraction: 0.2,
    precipitationMillimeters: 0
  }));
  const rainyHours = dryHours.map((hour, index) => ({
    ...hour,
    precipitationMillimeters: index === 12 ? 3 : 0
  }));
  const initialMoistureByClass = { '1h': 0.04, '10h': 0.04, '100h': 0.04 };
  const dry = estimateDeadFuelMoistureFromHourlyWeather({ hours: dryHours, initialMoistureByClass });
  const rainy = estimateDeadFuelMoistureFromHourlyWeather({ hours: rainyHours, initialMoistureByClass });

  assert.ok(rainy.byClass['1h'] > dry.byClass['1h']);
  assert.ok(rainy.byClass['100h'] > dry.byClass['100h']);
});

test('dead-fuel time lag honors a gap before the first supplied observation', () => {
  const observation = {
    time: '2026-07-21T10:00:00Z',
    temperatureCelsius: 30,
    relativeHumidityFraction: 0.8,
    precipitationMillimeters: 0
  };
  const initialMoistureByClass = { '1h': 0.08, '10h': 0.08, '100h': 0.08 };
  const noGap = estimateDeadFuelMoistureFromHourlyWeather({
    hours: [observation],
    initialMoistureByClass
  });
  const tenHourGap = estimateDeadFuelMoistureFromHourlyWeather({
    hours: [observation],
    initialMoistureByClass,
    previousObservationTime: '2026-07-21T00:00:00Z'
  });

  assert.ok(tenHourGap.byClass['10h'] > noGap.byClass['10h']);
  assert.ok(tenHourGap.byClass['100h'] > noGap.byClass['100h']);
});

test('weather estimate rejects malformed observations', () => {
  assert.throws(() => equilibriumMoistureContentPercent({
    temperatureCelsius: 20,
    relativeHumidityFraction: 1.2
  }), /relativeHumidityFraction/);
  assert.throws(() => estimateDeadFuelMoistureFromHourlyWeather({ hours: [] }), /hours/);
});
