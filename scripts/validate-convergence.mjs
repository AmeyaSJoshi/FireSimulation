import { createRateBasedFireSimulation } from '../src/lib/firePropagation.js';
import { getFuelModel } from '../src/lib/fuelModels.js';

const BASE = Object.freeze({
  size: 64,
  cellSizeMeters: 250,
  ignition: { x: 32, y: 32 },
  fuelModel: getFuelModel('GR2'),
  deadMoistureFraction: 0.08,
  liveMoistureFraction: 0.08,
  midflameWindKmh: 12,
  windDirectionRadians: 0,
  burnDurationMinutes: 30,
  maxPropagationMinutes: 360
});
const COARSE_TIMESTEP_MINUTES = 1;
const FINE_TIMESTEP_MINUTES = 0.25;
const OBSERVATION_MINUTES = [180, 240, 300, 355];
const MAX_PERIMETER_CELL_DIFFERENCE = 1;
const MAX_FOOTPRINT_CELL_DIFFERENCE = 4;

function advanceTo(simulation, minutes, timestepMinutes) {
  for (let step = 0; step < minutes / timestepMinutes; step += 1) simulation.step();
}

function compareState(coarse, fine) {
  const coarseState = coarse.getState();
  const fineState = fine.getState();
  let arrivalMismatchCount = 0;
  let maxArrivalErrorMinutes = 0;
  let burnedMaskMismatchCount = 0;
  for (let index = 0; index < coarseState.arrivalTimes.length; index += 1) {
    const coarseArrival = coarseState.arrivalTimes[index];
    const fineArrival = fineState.arrivalTimes[index];
    if (coarseArrival !== fineArrival) {
      arrivalMismatchCount += 1;
      if (Number.isFinite(coarseArrival) && Number.isFinite(fineArrival)) {
        maxArrivalErrorMinutes = Math.max(
          maxArrivalErrorMinutes,
          Math.abs(coarseArrival - fineArrival)
        );
      }
    }
    if ((coarseState.state[index] === 3) !== (fineState.state[index] === 3)) {
      burnedMaskMismatchCount += 1;
    }
  }
  const coarseMetrics = coarse.getMetrics();
  const fineMetrics = fine.getMetrics();
  return {
    arrivalMismatchCount,
    maxArrivalErrorMinutes,
    burnedMaskMismatchCount,
    perimeterCellDifference: Math.abs(
      coarseMetrics.perimeterCells - fineMetrics.perimeterCells
    ),
    footprintCellDifference: Math.abs(
      coarseMetrics.footprintCells - fineMetrics.footprintCells
    ),
    coarse: {
      perimeterCells: coarseMetrics.perimeterCells,
      footprintCells: coarseMetrics.footprintCells
    },
    fine: {
      perimeterCells: fineMetrics.perimeterCells,
      footprintCells: fineMetrics.footprintCells
    }
  };
}

const coarse = createRateBasedFireSimulation({
  ...BASE,
  timestepMinutes: COARSE_TIMESTEP_MINUTES
});
const fine = createRateBasedFireSimulation({
  ...BASE,
  timestepMinutes: FINE_TIMESTEP_MINUTES
});
const rows = OBSERVATION_MINUTES.map((minutes) => {
  advanceTo(coarse, minutes - coarse.getMetrics().elapsedMinutes, COARSE_TIMESTEP_MINUTES);
  advanceTo(fine, minutes - fine.getMetrics().elapsedMinutes, FINE_TIMESTEP_MINUTES);
  const comparison = compareState(coarse, fine);
  return { minutes, ...comparison };
});

const report = {
  fixture: 'GR2 · 250 m raster · 12 km/h east wind · matched model times',
  coarseTimestepMinutes: COARSE_TIMESTEP_MINUTES,
  fineTimestepMinutes: FINE_TIMESTEP_MINUTES,
  tolerance: {
    arrivalErrorMinutes: 0,
    perimeterCellDifference: MAX_PERIMETER_CELL_DIFFERENCE,
    footprintCellDifference: MAX_FOOTPRINT_CELL_DIFFERENCE
  },
  pass: rows.every((row) => (
    row.arrivalMismatchCount === 0
    && row.burnedMaskMismatchCount === 0
    && row.maxArrivalErrorMinutes === 0
    && row.perimeterCellDifference <= MAX_PERIMETER_CELL_DIFFERENCE
    && row.footprintCellDifference <= MAX_FOOTPRINT_CELL_DIFFERENCE
  )),
  interpretation: 'Physical arrival and burnout fields are timestep-independent; a small footprint difference is limited to the coarse heating-state sampling band.',
  rows
};

console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
