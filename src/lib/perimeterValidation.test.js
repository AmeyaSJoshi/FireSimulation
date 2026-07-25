import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpatialGrid } from './spatialGrid.js';
import { createRateBasedFireSimulation } from './firePropagation.js';
import { getFuelModel } from './fuelModels.js';
import {
  DEER_FIRE_2016,
  RESERVOIR_FIRE_2016
} from './historicalPerimeterFixtures.js';
import { RUSH_CREEK_PROGRESSION } from './historicalProgressionFixtures.js';
import {
  comparePerimeterMasks,
  rasterizePerimeterGeometry,
  validateArrivalAgainstPerimeter,
  validateArrivalAgainstPerimeterSeries
} from './perimeterValidation.js';

const GRID_SIZE = 128;
const CELL_SIZE_METERS = 100;
const RESERVOIR_GRID = createSpatialGrid({
  latitude: 39.152745,
  longitude: -122.571182,
  cellSizeMeters: CELL_SIZE_METERS,
  gridSize: GRID_SIZE
});

const DEER_GRID = createSpatialGrid({
  latitude: DEER_FIRE_2016.ignition.latitude,
  longitude: DEER_FIRE_2016.ignition.longitude,
  cellSizeMeters: CELL_SIZE_METERS,
  gridSize: GRID_SIZE
});

test('rasterizes the public Reservoir Fire perimeter onto the geodesic grid', () => {
  const observedMask = rasterizePerimeterGeometry({
    geometry: RESERVOIR_FIRE_2016.geometry,
    grid: RESERVOIR_GRID
  });
  const observedCellCount = observedMask.reduce((sum, value) => sum + value, 0);
  const observedAreaKm2 = observedCellCount * (CELL_SIZE_METERS / 1000) ** 2;
  const reportedAreaKm2 = RESERVOIR_FIRE_2016.reportedAcres * 0.0040468564224;

  assert.ok(observedCellCount > 0);
  assert.ok(Math.abs(observedAreaKm2 - reportedAreaKm2) / reportedAreaKm2 < 0.2,
    `rasterized ${observedAreaKm2} km² vs reported ${reportedAreaKm2} km²`);
});

test('rasterizes an independent public Deer Fire perimeter near its reported area', () => {
  const observedMask = rasterizePerimeterGeometry({
    geometry: DEER_FIRE_2016.geometry,
    grid: DEER_GRID
  });
  const observedCellCount = observedMask.reduce((sum, value) => sum + value, 0);
  const observedAreaKm2 = observedCellCount * (CELL_SIZE_METERS / 1000) ** 2;
  const reportedAreaKm2 = DEER_FIRE_2016.reportedAcres * 0.0040468564224;

  assert.ok(observedCellCount > 0);
  assert.ok(Math.abs(observedAreaKm2 - reportedAreaKm2) / reportedAreaKm2 < 0.2,
    `rasterized ${observedAreaKm2} km² vs reported ${reportedAreaKm2} km²`);
});

test('independent Deer Fire baseline produces bounded comparison metrics', () => {
  const observedMask = rasterizePerimeterGeometry({
    geometry: DEER_FIRE_2016.geometry,
    grid: DEER_GRID
  });
  const simulation = createRateBasedFireSimulation({
    size: GRID_SIZE,
    cellSizeMeters: CELL_SIZE_METERS,
    ignition: DEER_GRID.latLonToCell(
      DEER_FIRE_2016.ignition.latitude,
      DEER_FIRE_2016.ignition.longitude
    ),
    fuelModel: getFuelModel('TU2'),
    deadMoistureFraction: 0.05,
    liveMoistureFraction: 0.5,
    midflameWindKmh: 0,
    terrainHeights: new Float32Array(GRID_SIZE * GRID_SIZE),
    timestepMinutes: 1,
    burnDurationMinutes: 30,
    maxPropagationMinutes: Infinity
  });
  const report = validateArrivalAgainstPerimeter({
    arrivalTimes: simulation.getState().arrivalTimes,
    observedMask,
    size: GRID_SIZE,
    modelTimeMinutes: 4 * 24 * 60,
    cellSizeMeters: CELL_SIZE_METERS
  });

  assert.ok(report.iou >= 0 && report.iou <= 1);
  assert.ok(report.f1 >= 0 && report.f1 <= 1);
  assert.ok(Number.isFinite(report.centroidErrorKm));
});

test('perimeter metrics report exact overlap and boundary agreement', () => {
  const observedMask = rasterizePerimeterGeometry({
    geometry: RESERVOIR_FIRE_2016.geometry,
    grid: RESERVOIR_GRID
  });
  const report = comparePerimeterMasks({
    predictedMask: observedMask,
    observedMask,
    size: GRID_SIZE,
    cellSizeMeters: CELL_SIZE_METERS
  });

  assert.equal(report.iou, 1);
  assert.equal(report.precision, 1);
  assert.equal(report.recall, 1);
  assert.equal(report.f1, 1);
  assert.equal(report.meanBoundaryDistanceKm, 0);
  assert.equal(report.meanObservedBoundaryDistanceKm, 0);
});

test('arrival-field comparison produces a deterministic historical baseline report', () => {
  const observedMask = rasterizePerimeterGeometry({
    geometry: RESERVOIR_FIRE_2016.geometry,
    grid: RESERVOIR_GRID
  });
  const simulation = createRateBasedFireSimulation({
    size: GRID_SIZE,
    cellSizeMeters: CELL_SIZE_METERS,
    ignition: { x: (GRID_SIZE - 1) / 2, y: (GRID_SIZE - 1) / 2 },
    fuelModel: getFuelModel('TU2'),
    deadMoistureFraction: 0.05,
    liveMoistureFraction: 0.5,
    midflameWindKmh: 0,
    terrainHeights: new Float32Array(GRID_SIZE * GRID_SIZE),
    timestepMinutes: 1,
    burnDurationMinutes: 30
  });
  const report = validateArrivalAgainstPerimeter({
    arrivalTimes: simulation.getState().arrivalTimes,
    observedMask,
    size: GRID_SIZE,
    modelTimeMinutes: 1_300,
    cellSizeMeters: CELL_SIZE_METERS
  });

  assert.ok(report.iou >= 0 && report.iou <= 1);
  assert.ok(report.recall >= 0 && report.recall <= 1);
  assert.ok(Number.isFinite(report.meanBoundaryDistanceKm));
  assert.ok(report.observedAreaKm2 > 0);
});

test('progression validation preserves chronological observations and aggregates metrics', () => {
  const rushGrid = createSpatialGrid({
    latitude: RUSH_CREEK_PROGRESSION.ignition.latitude,
    longitude: RUSH_CREEK_PROGRESSION.ignition.longitude,
    cellSizeMeters: CELL_SIZE_METERS,
    gridSize: GRID_SIZE
  });
  const simulation = createRateBasedFireSimulation({
    size: GRID_SIZE,
    cellSizeMeters: CELL_SIZE_METERS,
    ignition: rushGrid.latLonToCell(
      RUSH_CREEK_PROGRESSION.ignition.latitude,
      RUSH_CREEK_PROGRESSION.ignition.longitude
    ),
    fuelModel: getFuelModel('TU2'),
    deadMoistureFraction: 0.05,
    liveMoistureFraction: 0.5,
    midflameWindKmh: 0,
    terrainHeights: new Float32Array(GRID_SIZE * GRID_SIZE),
    timestepMinutes: 1,
    burnDurationMinutes: 30
  });
  const result = validateArrivalAgainstPerimeterSeries({
    arrivalTimes: simulation.getState().arrivalTimes,
    observations: RUSH_CREEK_PROGRESSION.observations.slice(0, 3),
    grid: rushGrid,
    size: GRID_SIZE,
    modelStartTime: RUSH_CREEK_PROGRESSION.discoveryTime,
    cellSizeMeters: CELL_SIZE_METERS
  });

  assert.equal(result.observationCount, 3);
  assert.equal(result.reports.length, 3);
  assert.ok(result.reports[0].modelTimeMinutes < result.reports[1].modelTimeMinutes);
  assert.ok(result.summary.meanIou >= 0 && result.summary.meanIou <= 1);
  assert.equal(result.growthIntervals.length, 2);
  assert.equal(result.growthIntervals[0].from, result.reports[0].capturedAt);
  assert.ok(Number.isFinite(result.summary.meanPredictedToObservedGrowthRatio)
    || result.summary.meanPredictedToObservedGrowthRatio === null);
  assert.equal(result.summary.final.capturedAt, result.reports[2].capturedAt);
});

test('progression diagnostics flag continued model growth during an observed stall', () => {
  const observations = [
    { capturedAt: '2021-07-18T00:00:00.000Z', reportedAcres: 100 },
    { capturedAt: '2021-07-19T00:00:00.000Z', reportedAcres: 100 }
  ];
  const size = 3;
  const arrivalTimes = new Float64Array([0, 0, Infinity, 0, 0, Infinity, Infinity, Infinity, 60]);
  const grid = createSpatialGrid({
    latitude: 44,
    longitude: -115,
    cellSizeMeters: 1000,
    gridSize: size
  });
  const observedMask = new Uint8Array([1, 1, 0, 1, 1, 0, 0, 0, 0]);
  const result = validateArrivalAgainstPerimeterSeries({
    arrivalTimes,
    observations: observations.map((observation) => ({ ...observation, observedMask })),
    grid,
    size,
    modelStartTime: observations[0].capturedAt,
    cellSizeMeters: 1000
  });

  assert.equal(result.summary.observedStallIntervals, 1);
  assert.equal(result.summary.likelyContainmentOrSuppressionIntervals, 1);
  assert.equal(result.summary.firstLikelyContainmentOrSuppressionInterval.from, result.reports[0].capturedAt);
  assert.equal(result.summary.preSuppression.observationCount, 1);
  assert.equal(result.summary.preSuppression.final.capturedAt, result.reports[0].capturedAt);
  assert.equal(result.growthIntervals[0].observedStall, true);
  assert.equal(result.growthIntervals[0].modelContinuedSpread, true);
});
