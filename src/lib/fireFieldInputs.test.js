import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFuelModelCodeField } from './fireFieldInputs.js';
import { createRateBasedFireSimulation } from './firePropagation.js';
import { crosswalkLandCoverToFuel } from './landCoverToFuel.js';

function createGrid(size = 3) {
  return {
    gridSize: size,
    cellCenterLatLon(row, col) {
      return { latitude: row, longitude: col };
    }
  };
}

test('builds a per-cell fuel field from location-specific land-cover decisions', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(),
    classifyAtLatLon: (latitude, longitude) => ({ classCode: latitude === 1 && longitude === 1 ? 50 : 30 }),
    crosswalk: (landCover) => landCover.classCode === 50
      ? { fuelCode: 'NB', burnable: false }
      : { fuelCode: 'GR2', burnable: true },
    ignition: { x: 1, y: 1 },
    ignitionFuelCode: 'GR2'
  });

  assert.deepEqual(result.fuelModelCodes, [
    'GR2', 'GR2', 'GR2',
    'GR2', 'GR2', 'GR2',
    'GR2', 'GR2', 'GR2'
  ]);
  assert.equal(result.summary.classifiedCellCount, 9);
  assert.equal(result.summary.burnableCellCount, 9);
  assert.equal(result.summary.nonBurnableCellCount, 0);
  assert.ok(result.fuelLoadScaleByCell.every((scale) => scale === 1));
});

test('keeps uncovered cells non-burnable and preserves the clicked ignition fuel', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(),
    classifyAtLatLon: (latitude, longitude) => latitude === 1 && longitude === 1
      ? { classCode: 30 }
      : null,
    crosswalk: () => ({ fuelCode: 'GR2', burnable: true }),
    ignition: { x: 1, y: 1 },
    ignitionFuelCode: 'GR2'
  });

  assert.equal(result.fuelModelCodes[4], 'GR2');
  assert.equal(result.fuelModelCodes[0], 'NB');
  assert.equal(result.summary.unknownCellCount, 8);
  assert.equal(result.summary.nonBurnableCellCount, 8);
});

test('does not turn an unsupported land-cover class into a burnable raster', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtLatLon: () => ({ classCode: 999 }),
    crosswalk: () => ({ fuelCode: 'GR1', burnable: true, confidence: 'experimental' })
  });

  assert.deepEqual(result.fuelModelCodes, ['NB', 'NB', 'NB', 'NB']);
  assert.equal(result.summary.unknownCellCount, 0);
  assert.equal(result.summary.nonBurnableCellCount, 4);
  assert.ok(result.fuelLoadScaleByCell.every((scale) => scale === 0));
});

test('carries a crosswalk fuel-availability scale into the field', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtLatLon: () => ({ classCode: 60 }),
    crosswalk: () => ({ fuelCode: 'GR1', burnable: true, confidence: 'low', fuelLoadScale: 0.15 })
  });

  assert.ok([...result.fuelLoadScaleByCell].every((scale) => Math.abs(scale - 0.15) < 1e-6));
});

test('uses direct regional FBFM40 codes per cell and reports their coverage', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtCell: (_row, col) => ({
      classCode: 10,
      className: 'Tree cover',
      burnable: true,
      landfireFuelModelCode: col === 0 ? 'TL9' : 'GR9'
    }),
    crosswalk: crosswalkLandCoverToFuel
  });

  assert.deepEqual(result.fuelModelCodes, ['TL9', 'GR9', 'TL9', 'GR9']);
  assert.equal(result.summary.regionalFuelCellCount, 4);
  assert.equal(result.summary.regionalFuelModelCounts.TL9, 2);
  assert.equal(result.summary.regionalFuelModelCounts.GR9, 2);
  assert.equal(result.summary.globalFuelbedCellCount, 0);
});

test('carries explicit forest fuel alternatives for the uncertainty ensemble', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtCell: () => ({ classCode: 10, className: 'Tree cover', burnable: true }),
    crosswalk: crosswalkLandCoverToFuel
  });

  assert.deepEqual(result.fuelModelAlternativesByCell[0], ['TU2', 'TU1', 'TU3', 'TL3', 'TL1']);
  assert.equal(result.summary.fuelModelAlternativeCellCount, 4);
});

test('carries dynamic global fuelbed definitions alongside their cell codes', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtCell: () => ({
      classCode: 10,
      className: 'Tree cover',
      globalFuelbed: {
        fuelbed: '6091b',
        joinValue: 915091,
        dead1hLoadMgPerHa: 0.7,
        dead10hLoadMgPerHa: 1.8,
        dead100hLoadMgPerHa: 4.9
      }
    }),
    crosswalk: crosswalkLandCoverToFuel
  });

  assert.deepEqual(result.fuelModelCodes, ['GF_6091b', 'GF_6091b', 'GF_6091b', 'GF_6091b']);
  assert.equal(result.fuelModelDefinitionsByCode.GF_6091b.deadFuel[0].loadKgPerM2, 0.07);
  assert.equal(result.summary.globalFuelbedCellCount, 4);
});

test('carries FCCS persistence separately from surface fuel loads', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtCell: () => ({
      classCode: 10,
      burnable: true,
      globalFuelbed: {
        fuelbed: 'slow-fuel',
        dead1hLoadMgPerHa: 1,
        dead1000hLoadMgPerHa: 3,
        litterDepthCm: 2,
        duffDepthInches: 1.8
      }
    }),
    crosswalk: crosswalkLandCoverToFuel
  });

  assert.ok([...result.fuelPersistenceMinutesByCell].every((value) => value > 0));
  assert.equal(result.summary.fuelPersistenceCellCount, 4);
  assert.ok(result.summary.maxFuelPersistenceMinutes <= 48 * 60);
});

test('uses FCCS canopy structure as a wind-shelter fallback when external canopy data is absent', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtCell: () => ({
      classCode: 30,
      className: 'Grassland',
      burnable: true,
      globalFuelbed: {
        fuelbed: 'forest-structure',
        treeCoverPercent: 45,
        treeOverstoryCoverPercent: 45,
        treeOverstoryHeightMeters: 22,
        treeOverstoryLiveCrownBaseMeters: 8,
        dead1hLoadMgPerHa: 2
      }
    }),
    crosswalk: crosswalkLandCoverToFuel
  });

  assert.deepEqual([...result.canopyShelteredByCell], [1, 1, 1, 1]);
  assert.deepEqual([...result.canopyHeightByCell], [22, 22, 22, 22]);
  assert.ok([...result.canopyCoverFractionByCell]
    .every((value) => Math.abs(value - 0.45) < 1e-6));
  assert.deepEqual([...result.canopyBaseHeightByCell], [8, 8, 8, 8]);
  assert.equal(result.summary.globalCanopyStructureDataCellCount, 4);
  assert.equal(result.summary.globalCanopyBaseHeightDataCellCount, 4);
  assert.equal(result.summary.crownStructureDataCellCount, 0);
});

test('summarizes fine sampled burnable fractions across the field', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtLatLon: () => ({ classCode: 30 }),
    crosswalk: () => ({
      fuelCode: 'GR2',
      burnable: true,
      confidence: 'medium',
      fuelLoadScale: 0.5,
      fineBurnableFraction: 0.5
    })
  });

  assert.equal(result.summary.fineSampledCellCount, 4);
  assert.equal(result.summary.meanFineBurnableFraction, 0.5);
  assert.equal(result.summary.minFineBurnableFraction, 0.5);
  assert.equal(result.summary.maxFineBurnableFraction, 0.5);
});

test('reports crosswalk confidence across the entire propagation field', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtLatLon: (_latitude, longitude) => longitude === 0
      ? { classCode: 30 }
      : { classCode: 40 },
    crosswalk: (landCover) => landCover.classCode === 30
      ? { fuelCode: 'GR2', burnable: true, confidence: 'medium' }
      : { fuelCode: 'AG1', burnable: true, confidence: 'low' }
  });

  assert.equal(result.summary.crosswalkCellCount, 4);
  assert.deepEqual(result.summary.crosswalkConfidenceCounts, {
    high: 0,
    medium: 2,
    low: 2,
    experimental: 0
  });
  assert.equal(result.summary.experimentalCellCount, 0);
  assert.equal(result.summary.lowConfidenceCellCount, 2);
  assert.equal(result.summary.unknownOrUnclassifiedCellCount, 0);
});

test('counts experimental decisions even when the raster excludes them as barriers', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(),
    classifyAtLatLon: () => ({ classCode: 999 }),
    crosswalk: () => ({ fuelCode: 'GR1', burnable: true, confidence: 'experimental' })
  });

  assert.equal(result.summary.experimentalCellCount, 9);
  assert.equal(result.summary.crosswalkConfidenceCounts.experimental, 9);
  assert.equal(result.summary.unknownOrUnclassifiedCellCount, 0);
});

test('accepts a higher-resolution per-cell land-cover classifier', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtLatLon: () => ({ classCode: 50 }),
    classifyAtCell: (_row, col) => ({ classCode: col === 0 ? 30 : 50 }),
    crosswalk: crosswalkLandCoverToFuel
  });

  assert.deepEqual(result.fuelModelCodes, ['GR2', 'NB', 'GR2', 'NB']);
  assert.equal(result.summary.burnableCellCount, 2);
});

test('honors the land-cover source burnable flag for permanent water', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(),
    classifyAtLatLon: () => ({ classCode: 80, className: 'Permanent water', burnable: false }),
    crosswalk: crosswalkLandCoverToFuel
  });

  assert.ok(result.fuelModelCodes.every((code) => code === 'NB'));
  assert.equal(result.summary.burnableCellCount, 0);
});

test('fractional water cover blocks the local field even when WorldCover says grassland', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtLatLon: () => ({ classCode: 30, className: 'Grassland', burnable: true }),
    crosswalk: crosswalkLandCoverToFuel,
    classifyAtCell: () => ({
      classCode: 30,
      className: 'Grassland',
      burnable: true,
      coverFractions: {
        permanentWaterCoverFraction: 75,
        seasonalWaterCoverFraction: 0
      }
    })
  });

  assert.ok(result.fuelModelCodes.every((code) => code === 'NB'));
  assert.equal(result.summary.burnableCellCount, 0);
  assert.equal(result.summary.nonBurnableCellCount, 4);
});

test('does not reuse one fractional-cover decision for every cell of a WorldCover class', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtLatLon: () => ({ classCode: 30, className: 'Grassland', burnable: true }),
    classifyAtCell: (_row, col) => ({
      classCode: 30,
      className: 'Grassland',
      burnable: true,
      coverFractions: col === 0
        ? { treeCoverFraction: 80, grassCoverFraction: 10 }
        : { grassCoverFraction: 80, treeCoverFraction: 10 }
    }),
    crosswalk: crosswalkLandCoverToFuel
  });

  assert.deepEqual(result.fuelModelCodes, ['TU2', 'GR2', 'TU2', 'GR2']);
  assert.ok(Math.abs(result.fuelLoadScaleByCell[0] - 0.9) < 1e-6);
  assert.ok(Math.abs(result.fuelLoadScaleByCell[1] - 0.9) < 1e-6);
});

test('records canopy shelter per mapped tree and mangrove cell for local WAF', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtCell: (row, col) => ({
      classCode: row === 0 && col === 0 ? 10 : (row === 1 && col === 1 ? 95 : 30),
      className: 'mapped',
      burnable: true
    }),
    crosswalk: crosswalkLandCoverToFuel
  });

  assert.deepEqual([...result.canopyShelteredByCell], [1, 0, 0, 1]);
  assert.equal(result.summary.canopyShelteredCellCount, 2);
});

test('uses measured canopy height when available instead of assuming every tree label is sheltered', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtCell: () => ({ classCode: 10, className: 'Tree cover', burnable: true }),
    canopyHeightByCell: new Float32Array([1.2, 8.5, 2.5, 0]),
    crosswalk: crosswalkLandCoverToFuel
  });

  assert.deepEqual([...result.canopyShelteredByCell], [0, 1, 1, 0]);
  assert.equal(result.summary.canopyHeightDataCellCount, 4);
  assert.equal(result.summary.canopyHeightShelteredCellCount, 2);
  assert.equal(result.summary.canopyShelteredCellCount, 2);
});

test('preserves measured canopy cover for structure-aware sheltered WAF', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtCell: () => ({ classCode: 10, className: 'Tree cover', burnable: true }),
    canopyHeightByCell: new Float32Array([3, 3, 3, 3]),
    canopyCoverFractionByCell: new Float32Array([0.75, 0.1, -1, 0.5]),
    crosswalk: crosswalkLandCoverToFuel
  });

  assert.deepEqual([...result.canopyHeightByCell], [3, 3, 3, 3]);
  assert.ok([...result.canopyCoverFractionByCell]
    .every((value, index) => index === 2 ? value === -1 : Math.abs(value - [0.75, 0.1, -1, 0.5][index]) < 1e-6));
  assert.equal(result.summary.canopyWindStructureDataCellCount, 3);
});

test('enables crown structure only for tree cells with both CBH and CBD', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(2),
    classifyAtCell: (_row, col) => ({
      classCode: col === 0 ? 10 : 30,
      className: 'mapped',
      burnable: true
    }),
    canopyBaseHeightByCell: new Float32Array([1.5, 2, 1, 2]),
    canopyBulkDensityByCell: new Float32Array([0.06, 0.08, -1, 0]),
    crosswalk: crosswalkLandCoverToFuel
  });

  assert.deepEqual([...result.canopyCrownAvailableByCell], [1, 0, 0, 0]);
  assert.equal(result.summary.crownStructureDataCellCount, 1);
  assert.ok(Math.abs(result.canopyBaseHeightByCell[0] - 1.5) < 1e-6);
  assert.ok(Math.abs(result.canopyBulkDensityByCell[0] - 0.06) < 1e-6);
});

test('higher-resolution water mask overrides a burnable land-cover classification', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(),
    classifyAtLatLon: () => ({ classCode: 30, className: 'Grassland', burnable: true }),
    isWaterAtLatLon: (latitude, longitude) => latitude === 1 && longitude === 1,
    crosswalk: () => ({ fuelCode: 'GR2', burnable: true, confidence: 'high' }),
    ignition: { x: 1, y: 1 },
    ignitionFuelCode: 'GR2'
  });

  assert.equal(result.fuelModelCodes[4], 'NB');
  assert.equal(result.summary.waterCellCount, 1);
  assert.equal(result.summary.burnableCellCount, 8);
});

test('blocks a water boundary between two land-centered cells', () => {
  const size = 3;
  const result = buildFuelModelCodeField({
    grid: createGrid(size),
    classifyAtLatLon: () => ({ classCode: 30, className: 'Grassland', burnable: true }),
    // The water strip falls between integer cell centers, so center-only
    // sampling would incorrectly leave every cell burnable.
    isWaterAtLatLon: (_latitude, longitude) => Math.abs(longitude - 0.5) < 0.01,
    crosswalk: () => ({ fuelCode: 'GR2', burnable: true, confidence: 'high' }),
    ignition: { x: 0, y: 1 },
    ignitionFuelCode: 'GR2'
  });
  const simulation = createRateBasedFireSimulation({
    size,
    cellSizeMeters: 100,
    ignition: { x: 0, y: 1 },
    fuelModelCodes: result.fuelModelCodes,
    waterBarrierEdges: result.waterBarrierEdges,
    moistureFraction: 0.04,
    timestepMinutes: 10,
    burnDurationMinutes: 30
  });

  assert.equal(result.summary.waterCellCount, 0);
  assert.ok(result.summary.waterBarrierEdgeCount > 0);
  assert.equal(simulation.getState().arrivalTimes[1 * size + 1], Infinity);
});

test('applies an ignition override using spatial-grid row and column coordinates', () => {
  const result = buildFuelModelCodeField({
    grid: createGrid(3),
    classifyAtLatLon: () => ({ classCode: 30, className: 'Grassland', burnable: true }),
    crosswalk: () => ({ fuelCode: 'NB', burnable: false, confidence: 'medium' }),
    ignition: { row: 0, col: 2 },
    ignitionFuelCode: 'GR2'
  });

  assert.equal(result.fuelModelCodes[2], 'GR2');
  assert.equal(result.fuelModelCodes[0], 'NB');
});

test('labels water callbacks as center or edge queries', () => {
  const queryKinds = new Set();
  buildFuelModelCodeField({
    grid: createGrid(3),
    classifyAtLatLon: () => ({ classCode: 30, className: 'Grassland', burnable: true }),
    isWaterAtLatLon: (_latitude, _longitude, context) => {
      queryKinds.add(context?.kind);
      return false;
    },
    crosswalk: () => ({ fuelCode: 'GR2', burnable: true, confidence: 'high' })
  });

  assert.equal(queryKinds.has('cell-center'), true);
  assert.equal(queryKinds.has('cell-edge'), true);
});

test('location-derived barriers are honored by the arrival-time propagation engine', () => {
  const size = 9;
  const result = buildFuelModelCodeField({
    grid: createGrid(size),
    classifyAtLatLon: (_latitude, longitude) => ({ classCode: longitude > 4 ? 50 : 30 }),
    crosswalk: (landCover) => landCover.classCode === 50
      ? { fuelCode: 'NB', burnable: false, confidence: 'medium' }
      : { fuelCode: 'GR2', burnable: true, confidence: 'medium' },
    ignition: { x: 4, y: 4 },
    ignitionFuelCode: 'GR2'
  });
  const simulation = createRateBasedFireSimulation({
    size,
    cellSizeMeters: 100,
    ignition: { x: 4, y: 4 },
    fuelModelCodes: result.fuelModelCodes,
    moistureFraction: 0.04,
    timestepMinutes: 10,
    burnDurationMinutes: 30
  });
  const state = simulation.getState();

  assert.ok(Number.isFinite(state.arrivalTimes[4 * size + 3]));
  assert.equal(state.arrivalTimes[4 * size + 5], Infinity);
});

test('rejects a missing grid or classifier instead of silently creating a burnable field', () => {
  assert.throws(
    () => buildFuelModelCodeField({ grid: createGrid(), crosswalk: () => ({ fuelCode: 'GR2' }) }),
    /classifyAtLatLon/
  );
  assert.throws(
    () => buildFuelModelCodeField({ classifyAtLatLon: () => null, crosswalk: () => ({ fuelCode: 'GR2' }) }),
    /grid/
  );
});
