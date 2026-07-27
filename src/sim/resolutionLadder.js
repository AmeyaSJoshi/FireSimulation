export const SCENARIO_GRID_SIZE = 64;

const RUNGS = Object.freeze([
  { maximumAltitudeMeters: 2_000, cellSizeMeters: 10, label: 'street' },
  { maximumAltitudeMeters: 20_000, cellSizeMeters: 100, label: 'local' },
  { maximumAltitudeMeters: Infinity, cellSizeMeters: 500, label: 'regional' }
]);

export function resolutionForAltitude(altitudeMeters = null) {
  if (altitudeMeters !== null && (!Number.isFinite(altitudeMeters) || altitudeMeters < 0)) {
    throw new RangeError('resolutionLadder: altitudeMeters must be a non-negative finite number or null');
  }
  const altitude = altitudeMeters ?? 10_000;
  const rung = RUNGS.find((candidate) => altitude < candidate.maximumAltitudeMeters);
  return Object.freeze({
    ...rung,
    gridSize: SCENARIO_GRID_SIZE,
    fieldWidthMeters: rung.cellSizeMeters * SCENARIO_GRID_SIZE
  });
}

