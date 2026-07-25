import { performance } from 'node:perf_hooks';
import { createRateBasedFireSimulation } from '../src/lib/firePropagation.js';
import { getFuelModel } from '../src/lib/fuelModels.js';
import { runSeededArrivalEnsemble } from '../src/lib/uncertainty.js';

const size = 128;
const baseConfig = {
  size,
  cellSizeMeters: 500,
  ignition: { x: (size - 1) / 2, y: (size - 1) / 2 },
  fuelModel: getFuelModel('TU2'),
  deadMoistureFraction: 0.05,
  liveMoistureFraction: 0.5,
  terrainHeights: new Float32Array(size * size),
  timestepMinutes: 1,
  burnDurationMinutes: 30,
  maxPropagationMinutes: 72 * 60,
  weatherTimeline: [{
    minutesFromIgnition: 0,
    midflameWindKmh: 6,
    windDirectionRadians: 0,
    deadMoistureFraction: 0.05,
    liveMoistureFraction: 0.5
  }]
};

const deterministicStart = performance.now();
const deterministic = createRateBasedFireSimulation(baseConfig);
const deterministicMs = performance.now() - deterministicStart;

const ensembleStart = performance.now();
const ensemble = runSeededArrivalEnsemble({
  baseConfig,
  createSimulation: createRateBasedFireSimulation,
  memberCount: 8,
  seed: 17,
  perturbations: {
    windFraction: 0.10,
    directionRadians: Math.PI / 36,
    moistureFraction: 0.02,
    liveMoistureFraction: 0.10,
    fuelAvailabilityFraction: 0.10
  },
  horizonMinutes: 72 * 60
});
const ensembleMs = performance.now() - ensembleStart;

console.log(JSON.stringify({
  grid: `${size}x${size}`,
  deterministicMs: Number(deterministicMs.toFixed(2)),
  ensembleMembers: ensemble.memberCount,
  ensembleMs: Number(ensembleMs.toFixed(2)),
  ensembleMultiplier: Number((ensembleMs / Math.max(deterministicMs, 0.001)).toFixed(2)),
  deterministicArrivalCount: Array.from(deterministic.getState().arrivalTimes)
    .filter(Number.isFinite).length,
  ensembleFootprintCellsAt72Hours: ensemble.footprintAtMinutes,
  note: 'Node core benchmark; browser worker/render overhead is not included.'
}, null, 2));
