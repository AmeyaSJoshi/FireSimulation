import test from 'node:test';
import assert from 'node:assert/strict';
import { getFuelModel } from './fuelModels.js';
import { createRateBasedFireSimulation } from './firePropagation.js';
import { ellipseRateFromHeadBacking } from './fireEllipse.js';
import { calculateSurfaceSpread } from './surfaceSpread.js';
import { createSuppressionBarrierTimes } from './suppressionConstraints.js';
import { buildRothermelModelFromGlobalFuelbed } from './globalFuelbed.js';

const grass = getFuelModel('GR2');

function create(overrides = {}) {
  return createRateBasedFireSimulation({
    size: 25,
    cellSizeMeters: 100,
    ignition: { x: 12, y: 12 },
    fuelModel: grass,
    moistureFraction: 0.08,
    midflameWindKmh: 0,
    windDirectionRadians: 0,
    timestepMinutes: 10,
    burnDurationMinutes: 30,
    ...overrides
  });
}

function advance(simulation, steps) {
  for (let i = 0; i < steps; i += 1) simulation.step();
}

test('starts at the requested ignition and exposes arrival-time state', () => {
  const simulation = create();
  const state = simulation.getState();

  assert.equal(state.state[12 * 25 + 12], 2);
  assert.equal(state.arrivalTimes[12 * 25 + 12], 0);
  assert.equal(state.stepCount, 0);
  assert.ok(state.pendingCount > 0);
});

test('accepts spatial-grid row and column ignition coordinates', () => {
  const simulation = create({ ignition: { row: 5, col: 7 } });
  const state = simulation.getState();

  assert.equal(state.state[5 * 25 + 7], 2);
  assert.equal(state.arrivalTimes[5 * 25 + 7], 0);
  assert.ok(state.arrivalTimes[12 * 25 + 12] > 0);
});

test('rate-based propagation expands by physical travel time', () => {
  const simulation = create();
  advance(simulation, 16);
  const state = simulation.getState();

  assert.ok(state.burnedCount > 0);
  assert.ok(state.activeCount > 0);
  assert.ok(simulation.getMetrics().maxSpreadDistanceKm > 0);
  assert.equal(state.terrainAvailable, false);
});

test('propagation travel time uses the Rothermel heading rate in SI units', () => {
  const simulation = createRateBasedFireSimulation({
    size: 3,
    cellSizeMeters: 100,
    ignition: { x: 1, y: 1 },
    fuelModel: grass,
    moistureFraction: 0.08,
    midflameWindKmh: 0,
    windDirectionRadians: 0,
    timestepMinutes: 10,
    burnDurationMinutes: 30
  });
  const spread = calculateSurfaceSpread({
    fuelModel: grass,
    moistureFraction: 0.08,
    midflameWindKmh: 0,
    windDirectionRadians: 0
  });

  assert.ok(Math.abs(simulation.getState().arrivalTimes[1 * 3 + 2]
    - 100 / spread.headRateMPerMin) < 1e-9);
});

test('propagation resolves a published global fuelbed definition instead of treating it as a built-in code', () => {
  const globalModel = buildRothermelModelFromGlobalFuelbed({
    fuelbed: '6091b',
    joinValue: 915091,
    dead1hLoadMgPerHa: 0.7,
    dead10hLoadMgPerHa: 1.8,
    dead100hLoadMgPerHa: 4.9
  });
  const simulation = createRateBasedFireSimulation({
    size: 3,
    cellSizeMeters: 100,
    ignition: { x: 1, y: 1 },
    fuelModelCodes: ['NB', 'NB', 'NB', 'NB', 'GF_6091b', 'NB', 'NB', 'NB', 'NB'],
    fuelModelDefinitionsByCode: { GF_6091b: globalModel },
    moistureFraction: 0.08,
    timestepMinutes: 10,
    burnDurationMinutes: 30
  });

  assert.equal(simulation.getState().state[4], 2);
  simulation.step();
  assert.notEqual(simulation.getState().state[4], 0);
});

test('burned-out cells remain in metrics but no longer render as active fire', () => {
  const simulation = createRateBasedFireSimulation({
    size: 3,
    cellSizeMeters: 100,
    ignition: { x: 1, y: 1 },
    fuelModelCodes: ['NB', 'NB', 'NB', 'NB', 'GR2', 'NB', 'NB', 'NB', 'NB'],
    moistureFraction: 0.08,
    timestepMinutes: 10,
    burnDurationMinutes: 10
  });
  simulation.step();
  const state = simulation.getState();
  const frame = simulation.getFrame();

  assert.ok(state.burnedCount > 0);
  assert.equal(state.activeCount, 0);
  assert.ok(simulation.getMetrics().burnedAreaKm2 > 0);
  assert.equal(frame.some((value, index) => index % 4 === 3 && value > 0), false);
});

test('burnout lifetime derives from each fuel model residence time', () => {
  const simulation = createRateBasedFireSimulation({
    size: 3,
    cellSizeMeters: 100,
    ignition: { x: 1, y: 1 },
    fuelModelCodes: ['NB', 'NB', 'NB', 'NB', 'GR2', 'NB', 'NB', 'NB', 'NB'],
    moistureFraction: 0.08,
    timestepMinutes: 1,
    burnDurationMinutes: 30
  });

  assert.ok(simulation.getBurnDurationMinutes(4) > 0.2);
  assert.ok(simulation.getBurnDurationMinutes(4) < 0.3);
  simulation.step();
  assert.equal(simulation.getState().state[4], 3);
});

test('accelerated playback can render a physically burned interval without changing state', () => {
  const simulation = createRateBasedFireSimulation({
    size: 3,
    cellSizeMeters: 100,
    ignition: { x: 1, y: 1 },
    fuelModelCodes: ['NB', 'NB', 'NB', 'NB', 'GR2', 'NB', 'NB', 'NB', 'NB'],
    moistureFraction: 0.08,
    timestepMinutes: 1,
    burnDurationMinutes: 30
  });

  simulation.step();
  assert.equal(simulation.getState().state[4], 3);
  assert.equal(simulation.getFrame().some((value, index) => index % 4 === 3 && value > 0), false);
  assert.ok(simulation.getFrame({ fromModelTime: 0 })[4 * 4 + 3] > 0);
});

test('smaller solver timesteps converge on physical arrivals and perimeter', () => {
  const base = {
    size: 64,
    cellSizeMeters: 250,
    ignition: { x: 32, y: 32 },
    fuelModel: grass,
    deadMoistureFraction: 0.08,
    liveMoistureFraction: 0.08,
    midflameWindKmh: 12,
    windDirectionRadians: 0,
    burnDurationMinutes: 30,
    maxPropagationMinutes: 360
  };
  const coarse = createRateBasedFireSimulation({ ...base, timestepMinutes: 1 });
  const fine = createRateBasedFireSimulation({ ...base, timestepMinutes: 0.25 });
  advance(coarse, 300);
  advance(fine, 1200);

  assert.deepEqual([...coarse.getState().arrivalTimes], [...fine.getState().arrivalTimes]);
  assert.deepEqual([...coarse.getState().state].map((value) => value === 3),
    [...fine.getState().state].map((value) => value === 3));
  assert.ok(Math.abs(
    coarse.getMetrics().perimeterCells - fine.getMetrics().perimeterCells
  ) <= 1);
  assert.ok(Math.abs(
    coarse.getMetrics().footprintCells - fine.getMetrics().footprintCells
  ) <= 4);
});

test('same inputs produce deterministic arrival times and frames', () => {
  const first = create();
  const second = create();
  advance(first, 8);
  advance(second, 8);

  assert.deepEqual([...first.getState().state], [...second.getState().state]);
  assert.deepEqual([...first.getState().arrivalTimes], [...second.getState().arrivalTimes]);
  assert.deepEqual([...first.getFrame()], [...second.getFrame()]);
});

test('non-burnable cells block the arrival-time solver', () => {
  const size = 25;
  const codes = Array(size * size).fill('GR2');
  for (let y = 0; y < size; y += 1) codes[y * size + 16] = 'NB';
  const simulation = create({ fuelModelCodes: codes });
  advance(simulation, 40);

  const state = simulation.getState();
  for (let y = 0; y < size; y += 1) {
    assert.equal(state.arrivalTimes[y * size + 17], Infinity);
    assert.equal(state.state[y * size + 17], 0);
  }
});

test('terrain derivatives bias travel time toward an uphill direction', () => {
  const size = 25;
  const terrainHeights = new Float32Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) terrainHeights[row * size + col] = col * 20;
  }
  const simulation = create({ terrainHeights });
  advance(simulation, 12);
  const state = simulation.getState();
  const east = state.arrivalTimes[12 * size + 17];
  const west = state.arrivalTimes[12 * size + 7];

  assert.ok(east < west);
  assert.equal(state.terrainAvailable, true);
});

test('separate live moisture reaches the propagation solver', () => {
  const dryLive = create({ liveMoistureFraction: 0.08 });
  const wetLive = create({ liveMoistureFraction: 0.62 });

  assert.ok(dryLive.arrivalTimes[12 * 25 + 17] < wetLive.arrivalTimes[12 * 25 + 17]);
  assert.equal(wetLive.params.deadMoistureFraction, 0.08);
  assert.equal(wetLive.params.liveMoistureFraction, 0.62);
});

test('class-specific moisture reaches the propagation solver', () => {
  const tu2 = getFuelModel('TU2');
  const createWithMeasuredMoisture = (deadMoistureByClass) => createRateBasedFireSimulation({
    size: 3,
    cellSizeMeters: 100,
    ignition: { x: 1, y: 1 },
    fuelModel: tu2,
    deadMoistureFraction: 0.20,
    liveMoistureFraction: 0.20,
    deadMoistureByClass,
    timestepMinutes: 10,
    burnDurationMinutes: 30
  });
  const dryFine = createWithMeasuredMoisture({ '1h': 0.02, '10h': 0.20, '100h': 0.20 });
  const wetFine = createWithMeasuredMoisture({ '1h': 0.20, '10h': 0.02, '100h': 0.02 });

  assert.ok(dryFine.arrivalTimes[1 * 3 + 2] < wetFine.arrivalTimes[1 * 3 + 2]);
});

test('propagation uses the fire ellipse for crosswind neighbor travel', () => {
  const simulation = createRateBasedFireSimulation({
    size: 3,
    cellSizeMeters: 100,
    ignition: { x: 1, y: 1 },
    fuelModel: grass,
    moistureFraction: 0.08,
    midflameWindKmh: 20,
    windDirectionRadians: 0,
    timestepMinutes: 10,
    burnDurationMinutes: 30
  });
  const localSpread = calculateSurfaceSpread({
    fuelModel: grass,
    moistureFraction: 0.08,
    midflameWindKmh: 20,
    windDirectionRadians: 0
  });
  const expectedCrosswindRate = ellipseRateFromHeadBacking({
    headRateMPerMin: localSpread.headRateMPerMin,
    backingRateMPerMin: localSpread.backingRateMPerMin,
    angleRadians: Math.PI / 2
  });

  assert.ok(Math.abs(
    simulation.arrivalTimes[0 * 3 + 1] - 100 / expectedCrosswindRate
  ) < 1e-9);
});

test('propagation uses forecast wind at the arrival time', () => {
  const calm = create({
    size: 9,
    cellSizeMeters: 100,
    ignition: { x: 4, y: 4 },
    timestepMinutes: 10,
    weatherTimeline: [
      { minutesFromIgnition: 0, midflameWindKmh: 0, windDirectionRadians: 0 },
      { minutesFromIgnition: 30, midflameWindKmh: 0, windDirectionRadians: 0 }
    ]
  });
  const windShift = create({
    size: 9,
    cellSizeMeters: 100,
    ignition: { x: 4, y: 4 },
    timestepMinutes: 10,
    weatherTimeline: [
      { minutesFromIgnition: 0, midflameWindKmh: 0, windDirectionRadians: 0 },
      { minutesFromIgnition: 30, midflameWindKmh: 30, windDirectionRadians: 0 }
    ]
  });

  const eastIndex = 4 * 9 + 6;
  const westIndex = 4 * 9 + 2;
  assert.ok(windShift.arrivalTimes[eastIndex] < calm.arrivalTimes[eastIndex]);
  assert.equal(calm.arrivalTimes[eastIndex], calm.arrivalTimes[westIndex]);
  assert.ok(windShift.arrivalTimes[eastIndex] < windShift.arrivalTimes[westIndex]);
});

test('propagation samples changing forcing during a cell transition', () => {
  const base = {
    size: 3,
    cellSizeMeters: 100,
    ignition: { x: 1, y: 1 },
    fuelModel: grass,
    moistureFraction: 0.08,
    timestepMinutes: 10,
    burnDurationMinutes: 30
  };
  const calm = createRateBasedFireSimulation({
    ...base,
    weatherTimeline: [
      { minutesFromIgnition: 0, midflameWindKmh: 0, windDirectionRadians: 0 },
      { minutesFromIgnition: 0.01, midflameWindKmh: 0, windDirectionRadians: 0 }
    ]
  });
  const changing = createRateBasedFireSimulation({
    ...base,
    weatherTimeline: [
      { minutesFromIgnition: 0, midflameWindKmh: 0, windDirectionRadians: 0 },
      { minutesFromIgnition: 30, midflameWindKmh: 30, windDirectionRadians: 0 }
    ]
  });

  assert.ok(changing.arrivalTimes[5] < calm.arrivalTimes[5]);
});

test('historical weather blocks new spread after the final observation', () => {
  const simulation = create({
    size: 3,
    cellSizeMeters: 1000,
    ignition: { x: 1, y: 1 },
    weatherTimeline: [
      { minutesFromIgnition: 0, midflameWindKmh: 0, windDirectionRadians: 0 },
      { minutesFromIgnition: 1, midflameWindKmh: 0, windDirectionRadians: 0 }
    ]
  });

  assert.equal(simulation.arrivalTimes[1 * 3 + 2], Infinity);
  assert.equal(simulation.params.weatherTimelineEndMinutes, 1);
  assert.equal(simulation.params.weatherPostWindowPolicy, 'block');
});

test('propagation integrates a crossing across multiple weather intervals', () => {
  const timeline = [
    { minutesFromIgnition: 0, midflameWindKmh: 0, windDirectionRadians: 0 },
    { minutesFromIgnition: 30, midflameWindKmh: 30, windDirectionRadians: 0 },
    { minutesFromIgnition: 60, midflameWindKmh: 0, windDirectionRadians: 0 }
  ];
  const simulation = createRateBasedFireSimulation({
    size: 3,
    cellSizeMeters: 1000,
    ignition: { x: 1, y: 1 },
    fuelModel: grass,
    moistureFraction: 0.08,
    timestepMinutes: 1,
    burnDurationMinutes: 30,
    weatherTimeline: timeline
  });
  const rateAt = (minutes) => {
    const wind = minutes <= 30 ? minutes : (minutes <= 60 ? 60 - minutes : 0);
    return calculateSurfaceSpread({
      fuelModel: grass,
      moistureFraction: 0.08,
      midflameWindKmh: wind,
      windDirectionRadians: 0
    }).headRateMPerMin;
  };
  let remainingDistanceMeters = 1000;
  let expectedMinutes = 0;
  const referenceStepMinutes = 0.01;
  while (remainingDistanceMeters > 0 && expectedMinutes < 120) {
    const rate = rateAt(expectedMinutes + referenceStepMinutes / 2);
    const distance = rate * referenceStepMinutes;
    if (distance >= remainingDistanceMeters) {
      expectedMinutes += remainingDistanceMeters / rate;
      remainingDistanceMeters = 0;
      break;
    }
    remainingDistanceMeters -= distance;
    expectedMinutes += referenceStepMinutes;
  }

  assert.ok(Math.abs(simulation.arrivalTimes[5] - expectedMinutes) < 0.1);
});

test('propagation resolves raw reference wind with the destination fuel bed', () => {
  const size = 9;
  const rawWindTimeline = [{
    minutesFromIgnition: 0,
    tenMeterWindKmh: 30,
    referenceHeightMeters: 10,
    midflameWindKmh: 12,
    windDirectionRadians: 0
  }];
  const open = create({
    size,
    ignition: { x: 4, y: 4 },
    weatherTimeline: rawWindTimeline,
    canopyShelteredByCell: new Uint8Array(size * size)
  });
  const shelteredCells = new Uint8Array(size * size);
  shelteredCells.fill(1);
  const sheltered = create({
    size,
    ignition: { x: 4, y: 4 },
    weatherTimeline: rawWindTimeline,
    canopyShelteredByCell: shelteredCells
  });

  const targetIndex = 4 * size + 6;
  assert.ok(open.arrivalTimes[targetIndex] < sheltered.arrivalTimes[targetIndex]);
  assert.ok(Number.isFinite(open.arrivalTimes[targetIndex]));
  assert.ok(Number.isFinite(sheltered.arrivalTimes[targetIndex]));
});

test('propagation uses measured canopy structure for the sheltered WAF when reference height allows it', () => {
  const size = 9;
  const rawWindTimeline = [{
    minutesFromIgnition: 0,
    tenMeterWindKmh: 30,
    referenceHeightMeters: 10,
    midflameWindKmh: 6,
    windDirectionRadians: 0
  }];
  const shelteredCells = new Uint8Array(size * size).fill(1);
  const canopyHeightByCell = new Float32Array(size * size).fill(3);
  const canopyCoverFractionByCell = new Float32Array(size * size).fill(0.75);
  const fallback = create({
    size,
    ignition: { x: 4, y: 4 },
    weatherTimeline: rawWindTimeline,
    canopyShelteredByCell: shelteredCells
  });
  const measured = create({
    size,
    ignition: { x: 4, y: 4 },
    weatherTimeline: rawWindTimeline,
    canopyShelteredByCell: shelteredCells,
    canopyHeightByCell,
    canopyCoverFractionByCell
  });

  const targetIndex = 4 * size + 6;
  assert.ok(measured.arrivalTimes[targetIndex] < fallback.arrivalTimes[targetIndex]);
});

test('measured CBH and CBD can transition an eligible destination to active crown spread', () => {
  const size = 3;
  const fuelModelCodes = Array(size * size).fill('SH2');
  const crownAvailable = new Uint8Array(size * size).fill(1);
  const canopyBaseHeight = new Float32Array(size * size).fill(1.5);
  const canopyBulkDensity = new Float32Array(size * size).fill(0.15);
  const base = {
    size,
    cellSizeMeters: 100,
    ignition: { x: 1, y: 1 },
    fuelModelCodes,
    deadMoistureFraction: 0.05,
    liveMoistureFraction: 0.60,
    tenMeterWindKmh: 30,
    midflameWindKmh: 10,
    windDirectionRadians: 0,
    canopyBaseHeightByCell: canopyBaseHeight,
    canopyBulkDensityByCell: canopyBulkDensity
  };
  const surfaceOnly = createRateBasedFireSimulation(base);
  const crownEnabled = createRateBasedFireSimulation({
    ...base,
    canopyCrownAvailableByCell: crownAvailable
  });

  assert.ok(crownEnabled.arrivalTimes[1 * size + 2] < surfaceOnly.arrivalTimes[1 * size + 2]);
  assert.ok(surfaceOnly.arrivalTimes[1 * size + 2] > 20);
  assert.ok(crownEnabled.arrivalTimes[1 * size + 2] < 5);
});

test('passive crown transition blends surface and active rates instead of jumping states', () => {
  const size = 3;
  const fuelModelCodes = Array(size * size).fill('SH2');
  const crownAvailable = new Uint8Array(size * size).fill(1);
  const canopyBaseHeight = new Float32Array(size * size).fill(1.5);
  const canopyBulkDensity = new Float32Array(size * size).fill(0.15);
  const base = {
    size,
    cellSizeMeters: 100,
    ignition: { x: 1, y: 1 },
    fuelModelCodes,
    deadMoistureFraction: 0.05,
    liveMoistureFraction: 0.60,
    tenMeterWindKmh: 15,
    midflameWindKmh: 5,
    windDirectionRadians: 0,
    canopyBaseHeightByCell: canopyBaseHeight,
    canopyBulkDensityByCell: canopyBulkDensity
  };
  const surfaceOnly = createRateBasedFireSimulation(base);
  const crownEnabled = createRateBasedFireSimulation({
    ...base,
    canopyCrownAvailableByCell: crownAvailable
  });
  const target = 1 * size + 2;

  assert.ok(crownEnabled.arrivalTimes[target] < surfaceOnly.arrivalTimes[target]);
  assert.ok(crownEnabled.arrivalTimes[target] > 0);
});

test('propagation uses time-varying dead-fuel moisture at the arrival time', () => {
  const dry = create({
    size: 9,
    cellSizeMeters: 100,
    ignition: { x: 4, y: 4 },
    deadMoistureFraction: 0.08,
    liveMoistureFraction: 0.08
  });
  const moistureShift = create({
    size: 9,
    cellSizeMeters: 100,
    ignition: { x: 4, y: 4 },
    deadMoistureFraction: 0.08,
    liveMoistureFraction: 0.08,
    weatherTimeline: [
      {
        minutesFromIgnition: 0,
        midflameWindKmh: 0,
        windDirectionRadians: 0,
        deadMoistureByClass: { '1h': 0.08, '10h': 0.08, '100h': 0.08 }
      },
      {
        minutesFromIgnition: 1,
        midflameWindKmh: 0,
        windDirectionRadians: 0,
        deadMoistureByClass: { '1h': 0.7, '10h': 0.7, '100h': 0.7 }
      }
    ]
  });

  const targetIndex = 4 * 9 + 6;
  assert.ok(moistureShift.arrivalTimes[targetIndex] > dry.arrivalTimes[targetIndex]
    || moistureShift.arrivalTimes[targetIndex] === Infinity);
});

test('propagation does not cross an edge that becomes moisture-extinguished mid-transition', () => {
  const simulation = create({
    size: 3,
    ignition: { x: 1, y: 1 },
    weatherTimeline: [
      {
        minutesFromIgnition: 0,
        midflameWindKmh: 0,
        windDirectionRadians: 0,
        deadMoistureByClass: { '1h': 0.08, '10h': 0.08, '100h': 0.08 }
      },
      {
        minutesFromIgnition: 0.01,
        midflameWindKmh: 0,
        windDirectionRadians: 0,
        deadMoistureByClass: { '1h': 0.7, '10h': 0.7, '100h': 0.7 }
      }
    ]
  });

  assert.equal(simulation.arrivalTimes[1 * 3 + 2], Infinity);
});

test('slow-fuel persistence can wait for a later positive weather window', () => {
  const timeline = [
    {
      minutesFromIgnition: 0,
      midflameWindKmh: 0,
      windDirectionRadians: 0,
      deadMoistureByClass: { '1h': 0.08, '10h': 0.08, '100h': 0.08 }
    },
    {
      minutesFromIgnition: 1,
      midflameWindKmh: 0,
      windDirectionRadians: 0,
      deadMoistureByClass: { '1h': 0.7, '10h': 0.7, '100h': 0.7 }
    },
    {
      minutesFromIgnition: 30,
      midflameWindKmh: 0,
      windDirectionRadians: 0,
      deadMoistureByClass: { '1h': 0.08, '10h': 0.08, '100h': 0.08 }
    },
    {
      minutesFromIgnition: 240,
      midflameWindKmh: 0,
      windDirectionRadians: 0,
      deadMoistureByClass: { '1h': 0.08, '10h': 0.08, '100h': 0.08 }
    }
  ];
  const simulation = create({
    size: 3,
    cellSizeMeters: 100,
    ignition: { x: 1, y: 1 },
    weatherTimeline: timeline,
    fuelPersistenceMinutesByCell: new Float32Array(9).fill(300)
  });

  assert.ok(Number.isFinite(simulation.arrivalTimes[1 * 3 + 2]));
  assert.ok(simulation.arrivalTimes[1 * 3 + 2] > 1);
});

test('slow-fuel persistence still expires when no later positive window exists', () => {
  const simulation = create({
    size: 3,
    cellSizeMeters: 100,
    ignition: { x: 1, y: 1 },
    weatherTimeline: [
      {
        minutesFromIgnition: 0,
        midflameWindKmh: 0,
        windDirectionRadians: 0,
        deadMoistureByClass: { '1h': 0.08, '10h': 0.08, '100h': 0.08 }
      },
      {
        minutesFromIgnition: 1,
        midflameWindKmh: 0,
        windDirectionRadians: 0,
        deadMoistureByClass: { '1h': 0.7, '10h': 0.7, '100h': 0.7 }
      },
      {
        minutesFromIgnition: 30,
        midflameWindKmh: 0,
        windDirectionRadians: 0,
        deadMoistureByClass: { '1h': 0.7, '10h': 0.7, '100h': 0.7 }
      }
    ],
    fuelPersistenceMinutesByCell: new Float32Array(9).fill(300)
  });

  assert.equal(simulation.arrivalTimes[1 * 3 + 2], Infinity);
});

test('propagation can finish a short edge before a later extinction interval', () => {
  const simulation = create({
    size: 3,
    cellSizeMeters: 0.0005,
    ignition: { x: 1, y: 1 },
    weatherTimeline: [
      {
        minutesFromIgnition: 0,
        midflameWindKmh: 0,
        windDirectionRadians: 0,
        deadMoistureByClass: { '1h': 0.08, '10h': 0.08, '100h': 0.08 }
      },
      {
        minutesFromIgnition: 0.01,
        midflameWindKmh: 0,
        windDirectionRadians: 0,
        deadMoistureByClass: { '1h': 0.7, '10h': 0.7, '100h': 0.7 }
      }
    ]
  });

  assert.ok(Number.isFinite(simulation.arrivalTimes[1 * 3 + 2]));
  assert.ok(simulation.arrivalTimes[1 * 3 + 2] < 0.01);
});

test('interactive propagation horizon prevents unreachable future arrivals', () => {
  const simulation = create({
    size: 9,
    cellSizeMeters: 100,
    ignition: { x: 4, y: 4 },
    maxPropagationMinutes: 0
  });
  const state = simulation.getState();

  assert.equal(state.arrivalTimes[4 * 9 + 4], 0);
  assert.equal(state.arrivalTimes[4 * 9 + 5], Infinity);
  assert.equal(simulation.params.maxPropagationMinutes, 0);
});

test('reports when the interactive horizon hides otherwise reachable fuel', () => {
  const simulation = create({
    size: 9,
    cellSizeMeters: 100,
    ignition: { x: 4, y: 4 },
    maxPropagationMinutes: 0
  });

  assert.ok(simulation.getState().horizonLimitedCellCount > 0);
  assert.equal(simulation.getMetrics().terminationReason, 'horizon_reached');
  assert.equal(simulation.getMetrics().fieldBoundaryReached, false);
});

test('reports a finite field boundary instead of claiming fuel exhaustion', () => {
  const simulation = create({
    size: 3,
    cellSizeMeters: 100,
    ignition: { x: 1, y: 1 },
    maxPropagationMinutes: Infinity
  });

  assert.equal(simulation.getState().horizonLimitedCellCount, 0);
  assert.equal(simulation.getMetrics().terminationReason, 'field_boundary_reached');
  assert.equal(simulation.getMetrics().fieldBoundaryReached, true);
});

test('propagation applies per-cell fuel availability scales', () => {
  const fullScale = new Float32Array(9 * 9).fill(1);
  const sparseScale = new Float32Array(9 * 9).fill(0.15);
  const full = create({
    size: 9,
    cellSizeMeters: 100,
    ignition: { x: 4, y: 4 },
    fuelLoadScaleByCell: fullScale
  });
  const sparse = create({
    size: 9,
    cellSizeMeters: 100,
    ignition: { x: 4, y: 4 },
    fuelLoadScaleByCell: sparseScale
  });

  const targetIndex = 4 * 9 + 6;
  assert.ok(sparse.arrivalTimes[targetIndex] > full.arrivalTimes[targetIndex]
    || sparse.arrivalTimes[targetIndex] === Infinity);
});

test('time-aware suppression barriers block a transition after activation', () => {
  const immediateBarrier = createSuppressionBarrierTimes({
    size: 5,
    edges: [{ from: [2, 2], to: [2, 3], blockedFromMinutes: 0 }]
  });
  const delayedBarrier = createSuppressionBarrierTimes({
    size: 5,
    edges: [{ from: [2, 2], to: [2, 3], blockedFromMinutes: 90 }]
  });
  const fuelModelCodes = Array(25).fill('NB');
  fuelModelCodes[2 * 5 + 2] = 'GR2';
  fuelModelCodes[2 * 5 + 3] = 'GR2';
  const blocked = create({
    size: 5,
    ignition: { x: 2, y: 2 },
    fuelModelCodes,
    suppressionBarrierTimes: immediateBarrier
  });
  const open = create({
    size: 5,
    ignition: { x: 2, y: 2 },
    fuelModelCodes,
    suppressionBarrierTimes: delayedBarrier
  });
  const targetIndex = 2 * 5 + 3;

  assert.equal(blocked.arrivalTimes[targetIndex], Infinity);
  assert.ok(Number.isFinite(open.arrivalTimes[targetIndex]));
  assert.ok(blocked.getMetrics().suppressionBlockedTransitionCount > 0);
  assert.equal(blocked.getState().suppressionBarrierEdgeCount, 2);
});

test('suppression barrier arrays must match the directed edge raster', () => {
  assert.throws(
    () => create({ size: 5, suppressionBarrierTimes: new Float64Array(5) }),
    /suppressionBarrierTimes must have length/
  );
});
