import test from 'node:test';
import assert from 'node:assert/strict';
import { resolutionForAltitude } from './resolutionLadder.js';
import { activeFireCells } from './scenarioContours.js';
import { createFallbackScenarioAdapters, createViteScenarioAdapters } from './scenarioAdapters.js';
import { runScenario } from './runScenario.js';
import { createRateField } from './rateField.js';
import { propagateRothermelWithJac, propagateWithJac, solveRateFieldInJavaScript } from './jacPropagation.js';
import { clearEnvironmentalRequestCache, loadEnvironmentalContext } from './environmentalAdapters.js';
import { createSpatialGrid } from '../lib/spatialGrid.js';
import { createJacFireRequest } from './jacFireContract.js';
import { createGlobeEnsembleController, createGlobeScenarioController, createMockGlobeClick, fireOverlayFrame, normalizeGlobeClick } from './globeScenarioBridge.js';
import { aggregateScenarioMembers, clearScenarioEnsembleCache, defaultEnsembleVariants, runScenarioEnsemble } from './scenarioEnsemble.js';
import { createScenarioGateway, normalizeScenarioRequest, serializeScenarioResult } from './scenarioGateway.js';

test('resolution ladder keeps a 64 by 64 model field', () => {
  assert.deepEqual(resolutionForAltitude(100), {
    maximumAltitudeMeters: 2_000,
    cellSizeMeters: 10,
    label: 'street',
    gridSize: 64,
    fieldWidthMeters: 640
  });
  assert.equal(resolutionForAltitude(2_000).cellSizeMeters, 100);
  assert.equal(resolutionForAltitude(20_000).cellSizeMeters, 500);
});

test('globe bridge preserves click precision and produces a scrub-ready fire frame', async () => {
  const click = normalizeGlobeClick({ latitude: 37.7749, longitude: -122.4194, cameraAltitudeMeters: 500 });
  assert.equal(click.viewHint.altitudeMeters, 500);
  const arrivals = new Float32Array([0, 1, 2, -1]);
  const scenario = {
    arrivalField: arrivals,
    region: { bbox: { west: 1, south: 2, east: 3, north: 4 }, gridSize: 2, cellSizeMeters: 10 }
  };
  const bridge = createGlobeScenarioController({
    runScenarioImpl: async (request, options) => {
      assert.deepEqual(request, click);
      assert.equal(options.propagation, 'jac-rothermel');
      return scenario;
    }
  });
  await bridge.ignite({ latitude: 37.7749, longitude: -122.4194, cameraAltitudeMeters: 500 });
  assert.deepEqual([...bridge.frame(1).state], [1, 2, 2, 0]);
  assert.deepEqual([...fireOverlayFrame(scenario, 2).state], [1, 1, 2, 0]);
  const mockClick = createMockGlobeClick({ latitude: -33.8688, longitude: 151.2093, cameraAltitudeMeters: 900 });
  assert.deepEqual(mockClick(), { latitude: -33.8688, longitude: 151.2093, cameraAltitudeMeters: 900 });
});

test('scenario gateway keeps the renderer contract geographic, cancellable, and JSON-safe', async () => {
  const request = normalizeScenarioRequest({
    ignition: { latitude: 37.7749, longitude: -122.4194 },
    viewHint: { altitudeMeters: 500 },
    overrides: { windSpeedKmh: 18 }
  });
  assert.deepEqual(request, {
    ignition: { latitude: 37.7749, longitude: -122.4194 },
    viewHint: { altitudeMeters: 500 },
    overrides: { windSpeedKmh: 18, windDirectionDeg: null, moistureFraction: null, horizonMinutes: null }
  });
  assert.throws(
    () => normalizeScenarioRequest({ ignition: { latitude: 91, longitude: 0 } }),
    /ignition.latitude/
  );
  let calls = 0;
  const gateway = createScenarioGateway({
    mode: 'scenario',
    runScenarioImpl: (nextRequest, { signal }) => new Promise((resolve, reject) => {
      calls += 1;
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
      setTimeout(() => resolve({
        ignition: nextRequest.ignition,
        region: { bbox: { west: -123, south: 37, east: -122, north: 38 }, gridSize: 2, cellSizeMeters: 10 },
        arrivalField: new Float32Array([0, 4, -1, 8]),
        context: { buildings: [], roads: [] },
        evidence: { sources: [{ name: 'fixture' }], fallbacks: [] },
        confidence: 'fixture',
        simulation: { engine: 'fixture' }
      }), 5);
    })
  });
  const stale = gateway.submit(request);
  const staleRejected = assert.rejects(stale, { name: 'AbortError' });
  const result = await gateway.submit({ ...request, ignition: { latitude: 38, longitude: -122.4194 } });
  await staleRejected;
  assert.equal(result.kind, 'scenario');
  assert.deepEqual([...result.burnProbability], [1, 1, 0, 1]);
  const cached = await gateway.submit({ ...request, ignition: { latitude: 38, longitude: -122.4194 } });
  assert.equal(cached, result);
  assert.equal(calls, 2);
  const transport = serializeScenarioResult(result);
  assert.deepEqual(transport.arrivalMinutes, [0, 4, -1, 8]);
  assert.deepEqual(transport.burnProbability, [1, 1, 0, 1]);
  assert.throws(() => serializeScenarioResult({
    ...result,
    region: { ...result.region, gridSize: 3 }
  }), /gridSize/);

  const ensembleGateway = createScenarioGateway({
    adapters: { loadContext() {} },
    ensembleOptions: { scenarioOptions: { propagation: 'physical' } },
    scenarioOptions: { propagation: 'jac-rothermel' },
    runEnsembleImpl: async (_nextRequest, options) => {
      assert.equal(options.scenarioOptions.propagation, 'jac-rothermel');
      assert.equal(options.cache, false);
      assert.equal(options.signal instanceof AbortSignal, true);
      assert.equal(options.adapters.loadContext instanceof Function, true);
      return {
        ignition: { latitude: 37, longitude: -122 },
        region: { bbox: { west: -123, south: 37, east: -122, north: 38 }, gridSize: 2, cellSizeMeters: 10 },
        consensusArrivalMinutes: new Float32Array([0, 4, -1, 8]),
        burnFraction: new Float32Array([1, 1, 0, 1]),
        members: [],
        context: { buildings: [], roads: [] }
      };
    }
  });
  const ensembleResult = await ensembleGateway.submit(request);
  assert.equal(ensembleResult.kind, 'ensemble');
});

test('ensemble reuses one context and returns a median consensus field', async () => {
  const variants = defaultEnsembleVariants({ windSpeedKmh: 20, windDirectionDeg: 350, moistureFraction: 0.08, horizonMinutes: 60 });
  assert.equal(variants.length, 9);
  assert.equal(variants[3].windDirectionDeg, 330);
  assert.equal(variants[4].windDirectionDeg, 10);
  const aggregate = aggregateScenarioMembers([
    { arrivalField: new Float32Array([0, 2, -1]) },
    { arrivalField: new Float32Array([0, 4, 8]) },
    { arrivalField: new Float32Array([0, 6, -1]) }
  ]);
  assert.deepEqual([...aggregate.burnCount], [3, 3, 1]);
  assert.deepEqual([...aggregate.consensusArrivalMinutes], [0, 4, -1]);
  let loads = 0;
  const adapters = {
    async loadContext({ totalCells }) {
      loads += 1;
      return { fuelCodes: Array(totalCells).fill('GR1'), terrainHeights: null, weather: null };
    }
  };
  clearScenarioEnsembleCache(adapters);
  const ensemble = await runScenarioEnsemble({ ignition: { latitude: 37, longitude: -122 } }, {
    adapters,
    scenarioOptions: { propagation: 'physical' }
  });
  assert.equal(loads, 1);
  assert.equal(ensemble.members.length, 9);
  assert.equal(ensemble.consensusArrivalMinutes.length, 4_096);
  const cached = await runScenarioEnsemble({ ignition: { latitude: 37, longitude: -122 } }, {
    adapters,
    scenarioOptions: { propagation: 'physical' }
  });
  assert.equal(cached, ensemble);
  assert.equal(loads, 1);
  const changedWind = await runScenarioEnsemble({
    ignition: { latitude: 37, longitude: -122 },
    overrides: { windSpeedKmh: 24 }
  }, {
    adapters,
    scenarioOptions: { propagation: 'physical' }
  });
  assert.notEqual(changedWind, ensemble);
  assert.equal(loads, 2);
  const ensembleBridge = createGlobeEnsembleController({
    runEnsembleImpl: async () => ({
      consensusArrivalMinutes: new Float32Array([0, 1, -1, -1]),
      burnFraction: new Float32Array([1, 1, 0, 0]),
      region: { bbox: { west: 1, south: 2, east: 3, north: 4 }, gridSize: 2, cellSizeMeters: 10 }
    })
  });
  await ensembleBridge.ignite({ latitude: 37, longitude: -122 });
  assert.deepEqual([...ensembleBridge.frame(1).state], [1, 2, 0, 0]);
  assert.deepEqual([...ensembleBridge.frame(1).burnFraction], [1, 1, 0, 0]);
});

test('runScenario returns a renderer-independent 64 by 64 arrival field', async () => {
  const result = await runScenario({
    ignition: { latitude: 37.7749, longitude: -122.4194 },
    viewHint: { altitudeMeters: 100 }
  }, { adapters: createFallbackScenarioAdapters() });
  assert.equal(result.region.gridSize, 64);
  assert.equal(result.region.cellSizeMeters, 10);
  assert.ok(result.arrivalField instanceof Float32Array);
  assert.equal(result.arrivalField.length, 4_096);
  assert.equal(result.arrivalField[2_080], 0);
  assert.equal(result.simulation.rateField.length, 4_096);
  assert.equal(result.simulation.engine, 'javascript-physical');
  assert.equal(result.confidence, 'fallback');
});

test('runScenario accepts the gateway null values for unset weather overrides', async () => {
  const result = await runScenario({
    ignition: { latitude: 37, longitude: -122 },
    overrides: {
      windSpeedKmh: null,
      windDirectionDeg: null,
      moistureFraction: null,
      horizonMinutes: null
    }
  }, { propagation: 'physical' });
  assert.equal(result.simulation.horizonMinutes, 720);
});

test('runScenario can route through Jac with a JavaScript-safe fallback contract', async () => {
  const field = new Float32Array(64 * 64);
  field.fill(7);
  const result = await runScenario({ ignition: { latitude: 37, longitude: -122 } }, {
    propagation: 'jac',
    propagate: async (request) => {
      assert.equal(request.rates.length, 64 * 64);
      assert.equal(request.ignitionIndex, 2080);
      return { arrivalField: field, engine: 'jac', fallbackReason: null };
    }
  });
  assert.equal(result.simulation.engine, 'jac');
  assert.equal(result.arrivalField, field);
});

test('runScenario can route the full fuel and terrain contract through Jac', async () => {
  const field = new Float32Array(64 * 64);
  const result = await runScenario({ ignition: { latitude: 37, longitude: -122 } }, {
    propagation: 'jac-rothermel',
    propagateRothermel: async (request) => {
      assert.equal(request.fuel_model_indices.length, 4_096);
      assert.equal(request.terrain_heights.length, 4_096);
      assert.equal(request.midflame_winds_by_model.length, 1);
      assert.equal(request.max_propagation_minutes, 720);
      assert.equal(request.grid_size, 64);
      return { arrivalField: field, engine: 'jac-rothermel', fallbackReason: null };
    }
  });
  assert.equal(result.simulation.engine, 'jac-rothermel');
  assert.equal(result.arrivalField, field);
});

test('the Rothermel scenario adapter solves in-process and normalizes unreachable cells', async () => {
  // Was: asserted the HTTP POST url/body to the Jac walker. The solve is now
  // local, so this asserts the contract that actually matters — a complete
  // arrival field with unreachable cells normalized to -1.
  const gridSize = 6;
  const fuelCodes = Array(gridSize ** 2).fill('NB');
  const ignitionIndex = 14;
  fuelCodes[ignitionIndex] = 'GR2';
  const result = await propagateRothermelWithJac(createJacFireRequest({
    fuelCodes,
    gridSize,
    cellSizeMeters: 10,
    ignitionIndex,
    maxPropagationMinutes: 120,
    deadMoistureFraction: 0.06,
    liveMoistureFraction: 0.6,
    midflameWindKmh: 12,
    windDirectionRadians: 0
  }));

  assert.equal(result.engine, 'javascript-rothermel');
  assert.equal(result.arrivalField.length, gridSize ** 2);
  assert.equal(result.arrivalField[ignitionIndex], 0);
  // Non-burnable surroundings are unreachable and must normalize to -1.
  assert.ok([...result.arrivalField].some((value) => value === -1));
});

test('runScenario carries multi-row weather through the Jac physical contract', async () => {
  let jacCalls = 0;
  const field = new Float32Array(64 * 64);
  const result = await runScenario({ ignition: { latitude: 37, longitude: -122 } }, {
    propagation: 'jac-rothermel',
    adapters: {
      async loadContext({ totalCells }) {
        return {
          fuelCodes: Array(totalCells).fill('GR1'),
          terrainHeights: null,
          weather: {
            wind: { tenMeterSpeedKmh: 12, compassDirectionDeg: 90 },
            fuelMoisture: { byClass: { '1h': 0.04, '10h': 0.06, '100h': 0.08 } },
            liveFuelMoisture: { byClass: { herbaceous: 0.45, woody: 0.7 } },
            windTimeline: [
              { minutesFromIgnition: 0, midflameWindKmh: 4, windDirectionRadians: 0 },
              { minutesFromIgnition: 60, midflameWindKmh: 8, windDirectionRadians: 1 }
            ]
          }
        };
      }
    },
    propagateRothermel: async (request) => {
      jacCalls += 1;
      assert.equal(request.weather_minutes.length, 2);
      assert.equal(request.weather_midflame_winds_by_time.length, 2);
      return { arrivalField: field, engine: 'jac-rothermel', fallbackReason: null };
    }
  });
  assert.equal(jacCalls, 1);
  assert.equal(result.simulation.engine, 'jac-rothermel');
  assert.equal(result.arrivalField, field);
});

test('coverage-aware adapters prefer LANDFIRE in CONUS and WorldCover elsewhere', async () => {
  const calls = [];
  const adapters = createViteScenarioAdapters({
    environmentalLayers: false,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === '/api/fuel/landfire-field') {
        return { ok: true, json: async () => ({
          available: true, source: 'LANDFIRE', resolutionMeters: 30,
          fuelModelCodes: Array(4_096).fill('GR1')
        }) };
      }
      return { ok: true, json: async () => ({
        source: 'ESA WorldCover', resolutionMeters: 10, classCodes: Array(4_096).fill(10)
      }) };
    }
  });
  const us = await runScenario({ ignition: { latitude: 37, longitude: -122 } }, { adapters });
  assert.deepEqual(calls, ['/api/fuel/landfire-field']);
  assert.equal(us.evidence.sources[0].name, 'LANDFIRE');
  assert.equal(us.confidence, 'regional');

  calls.length = 0;
  const global = await runScenario({ ignition: { latitude: -33.8688, longitude: 151.2093 } }, { adapters });
  assert.deepEqual(calls, ['/api/landcover/fine-field']);
  assert.equal(global.evidence.sources[0].name, 'ESA WorldCover');
  assert.equal(global.confidence, 'global');
});

test('coverage-aware adapters fall from failed LANDFIRE to WorldCover', async () => {
  const adapters = createViteScenarioAdapters({
    environmentalLayers: false,
    fetchImpl: async (url) => url === '/api/fuel/landfire-field'
      ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, json: async () => ({ classCodes: Array(4_096).fill(10) }) }
  });
  const result = await runScenario({ ignition: { latitude: 37, longitude: -122 } }, { adapters });
  assert.equal(result.confidence, 'global');
  assert.match(result.evidence.fallbacks[0], /LANDFIRE adapter returned HTTP 503/);
});

test('environmental adapters add terrain, live weather, and OSM features at 10 m', async () => {
  const adapters = createViteScenarioAdapters({
    fetchImpl: async (url) => {
      if (url === '/api/landcover/fine-field') {
        return { ok: true, json: async () => ({ classCodes: Array(4_096).fill(10) }) };
      }
      if (url.startsWith('https://api.open-meteo.com/v1/elevation')) {
        const count = new URL(url).searchParams.get('latitude').split(',').length;
        return { ok: true, json: async () => ({ elevation: Array(count).fill(100) }) };
      }
      if (url.startsWith('https://api.open-meteo.com/v1/forecast')) {
        return { ok: true, json: async () => ({
          latitude: -33.8688, longitude: 151.2093,
          current: {
            time: '2026-07-26T12:00', temperature_2m: 25, relative_humidity_2m: 35,
            wind_speed_10m: 24, wind_direction_10m: 80, wind_gusts_10m: 30, precipitation: 0
          },
          hourly: { time: [] }
        }) };
      }
      return { ok: true, json: async () => ({ elements: [
        { tags: { building: 'yes', 'building:levels': '2' }, geometry: [{ lat: -33.86, lon: 151.20 }, { lat: -33.86, lon: 151.21 }, { lat: -33.87, lon: 151.21 }] },
        { tags: { highway: 'residential' }, geometry: [{ lat: -33.86, lon: 151.20 }, { lat: -33.87, lon: 151.21 }] }
      ] }) };
    }
  });
  const result = await runScenario({
    ignition: { latitude: -33.8688, longitude: 151.2093 },
    viewHint: { altitudeMeters: 100 }
  }, { adapters });
  assert.equal(result.context.terrain.available, true);
  assert.equal(result.context.wind.tenMeterSpeedKmh, 24);
  assert.equal(result.context.weather.wind.tenMeterSpeedKmh, 24);
  assert.equal(result.simulation.windSpeedKmh, 24);
  assert.equal(result.context.buildings.length, 1);
  assert.equal(result.context.roads.length, 1);
});

test('environmental request cache reuses a location instead of refetching it', async () => {
  clearEnvironmentalRequestCache();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url.startsWith('https://api.open-meteo.com/v1/elevation')) {
      const count = new URL(url).searchParams.get('latitude').split(',').length;
      return { ok: true, json: async () => ({ elevation: Array(count).fill(100) }) };
    }
    if (url.startsWith('https://api.open-meteo.com/v1/forecast')) {
      return { ok: true, json: async () => ({
        latitude: 37, longitude: -122,
        current: { time: '2026-07-26T12:00', temperature_2m: 20, relative_humidity_2m: 40, wind_speed_10m: 10, wind_direction_10m: 90, wind_gusts_10m: 12, precipitation: 0 },
        hourly: { time: [] }
      }) };
    }
    return { ok: true, json: async () => ({ elements: [] }) };
  };
  const grid = createSpatialGrid({ latitude: 37, longitude: -122, cellSizeMeters: 10, gridSize: 64 });
  const request = { grid, bbox: [-122.01, 36.99, -121.99, 37.01], fuelCodes: Array(4_096).fill('GR1'), fetchImpl, cache: true };
  await loadEnvironmentalContext(request);
  const firstRunCalls = calls;
  await loadEnvironmentalContext(request);
  assert.equal(calls, firstRunCalls);
});

test('Jac fire contract compacts fuel definitions and supplies flat terrain when unavailable', () => {
  const request = createJacFireRequest({
    fuelCodes: ['GR1', 'GR1', 'NB', 'GR1'], gridSize: 2, cellSizeMeters: 10, ignitionIndex: 0, maxPropagationMinutes: 720,
    deadMoistureFraction: 0.08, liveMoistureFraction: 0.6,
    midflameWindKmh: 6, windDirectionRadians: 0
  });
  assert.deepEqual(request.fuel_model_indices, [0, 0, 1, 0]);
  assert.equal(request.dead_loads_by_model.length, 2);
  assert.deepEqual(request.terrain_heights, [0, 0, 0, 0]);
  assert.deepEqual(request.midflame_winds_by_model, [6, 6]);
  assert.deepEqual(request.burnable_by_model, [1, 0]);
  assert.equal(request.max_propagation_minutes, 720);
});

test('Jac fire contract preserves fuel-class moisture for the Rothermel kernel', () => {
  const request = createJacFireRequest({
    fuelCodes: ['GR1', 'GR1', 'GR1', 'GR1'], gridSize: 2, cellSizeMeters: 10, ignitionIndex: 0, maxPropagationMinutes: 720,
    deadMoistureFraction: 0.08, liveMoistureFraction: 0.6,
    deadMoistureByClass: { '1h': 0.03, '10h': 0.06, '100h': 0.1 },
    liveMoistureByClass: { herbaceous: 0.45, woody: 0.8 },
    midflameWindKmh: 6, windDirectionRadians: 0
  });
  assert.deepEqual(request.dead_moistures_by_model, [[0.03, 0.06, 0.1]]);
  assert.deepEqual(request.live_moistures_by_model, [[0.45, 0.8]]);
});

test('rate solver produces the arrival field and preserves unreachable cells', async () => {
  // Was: fed a fake Jac HTTP response and asserted the JS result matched it,
  // plus an offline-fallback path. There is no remote engine to cross-check
  // or fall back from now — the JS solver is the engine, so this asserts its
  // output directly.
  const request = {
    rates: new Float32Array([1, 1, 0, 1]),
    gridSize: 2,
    cellSizeMeters: 10,
    ignitionIndex: 0
  };
  const expected = solveRateFieldInJavaScript(request);
  assert.deepEqual([...expected], [0, 10, -1, 14.142135620117188]);

  const result = await propagateWithJac(request);
  assert.equal(result.engine, 'javascript-rate');
  assert.equal(result.fallbackReason, null);
  assert.deepEqual([...result.arrivalField], [...expected]);
});

test('rate field preserves non-burnable cells', () => {
  const field = createRateField({
    fuelCodes: ['SH5', 'NB'],
    windSpeedKmh: 18,
    windDirectionDeg: 45,
    moistureFraction: 0.08
  });
  assert.ok(field[0] > 0);
  assert.equal(field[1], 0);
});

test('active fire cells ignore unreachable arrivals', () => {
  const state = activeFireCells({
    arrivalField: new Float32Array([0, 1, -1, 4]),
    gridSize: 2,
    atMinutes: 1,
    frontWindowMinutes: 0.5
  });
  assert.deepEqual(state.burnedIndices, [0, 1]);
  assert.deepEqual(state.frontIndices, [1]);
});
