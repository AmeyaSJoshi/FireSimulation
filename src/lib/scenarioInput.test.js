import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioInput, SCENARIO_INPUT_SCHEMA_VERSION } from './scenarioInput.js';

const validRequired = {
  latitude: 37.5,
  longitude: -122.3,
  cellSizeMeters: 1000,
  gridSize: 128
};

test('emits the current schema version', () => {
  const input = createScenarioInput(validRequired);
  assert.equal(input.schemaVersion, SCENARIO_INPUT_SCHEMA_VERSION);
  assert.match(SCENARIO_INPUT_SCHEMA_VERSION, /^\d+\.\d+\.\d+$/);
});

test('records the click location as WGS-84 lat/lon', () => {
  const input = createScenarioInput(validRequired);
  assert.deepEqual(input.location, { latitude: 37.5, longitude: -122.3 });
});

test('describes the spatial grid with origin, cell size, and grid size', () => {
  const input = createScenarioInput(validRequired);
  assert.equal(input.grid.cellSizeMeters, 1000);
  assert.equal(input.grid.gridSize, 128);
  assert.equal(input.grid.origin.latitude, 37.5);
  assert.equal(input.grid.origin.longitude, -122.3);
});

test('elevation section is a labeled placeholder when no elevation data supplied', () => {
  const input = createScenarioInput(validRequired);
  assert.equal(input.elevation.hasData, false);
  assert.equal(input.elevation.source, null);
  assert.equal(input.elevation.fetchedAt, null);
});

test('elevation section carries provenance when data is supplied', () => {
  const fetchedAt = 1_700_000_000_000;
  const input = createScenarioInput({
    ...validRequired,
    elevation: {
      source: 'Copernicus GLO-90 via Open-Meteo',
      fetchedAt,
      spanKm: 128,
      hasData: true,
      noDataCellCount: 0
    }
  });
  assert.equal(input.elevation.hasData, true);
  assert.equal(input.elevation.source, 'Copernicus GLO-90 via Open-Meteo');
  assert.equal(input.elevation.fetchedAt, fetchedAt);
  assert.equal(input.elevation.spanKm, 128);
});

test('weather section is an explicit scenario placeholder until Phase 2 wires a fetch', () => {
  const input = createScenarioInput(validRequired);
  assert.equal(input.weather.source, 'scenario');
  assert.equal(input.weather.hasData, false);
  assert.equal(input.weather.fetchedAt, null);
});

test('wind block records speed, direction, and adjustment provenance', () => {
  const input = createScenarioInput({
    ...validRequired,
    wind: { source: 'scenario', speedKmh: 20, directionCompassDeg: 135 }
  });
  assert.equal(input.wind.source, 'scenario');
  assert.equal(input.wind.speedKmh, 20);
  assert.equal(input.wind.directionCompassDeg, 135);
  assert.equal(input.wind.measurementHeightMeters, null);
  assert.equal(input.wind.midflameAdjustment, null);
});

test('moisture defaults to a labeled scenario value', () => {
  const input = createScenarioInput({ ...validRequired, moisture: { value: 0.3 } });
  assert.equal(input.moisture.source, 'scenario');
  assert.equal(input.moisture.value, 0.3);
});

test('fuel defaults to the legacy preset with source labeled', () => {
  const input = createScenarioInput({ ...validRequired, fuel: { code: 'brush' } });
  assert.equal(input.fuel.source, 'scenario-preset');
  assert.equal(input.fuel.code, 'brush');
});

test('landCover is null until Phase 2 supplies a real crosswalk', () => {
  const input = createScenarioInput(validRequired);
  assert.equal(input.landCover, null);
});

test('simulation block captures engine, seed, and timestep', () => {
  const input = createScenarioInput({
    ...validRequired,
    simulation: { engine: 'legacy', seed: 42, timestepMinutes: 1 }
  });
  assert.equal(input.simulation.engine, 'legacy');
  assert.equal(input.simulation.seed, 42);
  assert.equal(input.simulation.timestepMinutes, 1);
});

test('provenance carries a createdAt timestamp and the model version', () => {
  const before = Date.now();
  const input = createScenarioInput(validRequired);
  const after = Date.now();
  assert.ok(input.provenance.createdAt >= before && input.provenance.createdAt <= after);
  assert.match(input.provenance.modelVersion, /^phase\d+/);
});

test('rejects missing or invalid latitude/longitude', () => {
  assert.throws(() => createScenarioInput({ ...validRequired, latitude: NaN }), /latitude/);
  assert.throws(() => createScenarioInput({ ...validRequired, longitude: 500 }), /longitude/);
});

test('rejects invalid grid parameters', () => {
  assert.throws(() => createScenarioInput({ ...validRequired, cellSizeMeters: 0 }), /cellSize/);
  assert.throws(() => createScenarioInput({ ...validRequired, gridSize: 1 }), /gridSize/);
});

test('rejects unknown simulation engines', () => {
  assert.throws(() => createScenarioInput({
    ...validRequired,
    simulation: { engine: 'made-up-engine', seed: 1 }
  }), /engine/);
});
