import { getFuelModel } from '../src/lib/fuelModels.js';
import { calculateSurfaceSpread } from '../src/lib/surfaceSpread.js';

// Andrews (2014), Figure 3: TU2, 5% dead moisture, 50% live moisture,
// 10% slope, and the four published midflame-wind/fireline-intensity pairs.
// Keep this fixture independent from the historical perimeter diagnostics:
// it checks the local equation implementation only.
const REFERENCE = Object.freeze([
  { midflameWindKmh: 3, firelineIntensityKwPerM: 130 },
  { midflameWindKmh: 6, firelineIntensityKwPerM: 293 },
  { midflameWindKmh: 9, firelineIntensityKwPerM: 497 },
  { midflameWindKmh: 12, firelineIntensityKwPerM: 733 }
]);
const RELATIVE_TOLERANCE = 0.05;
const tu2 = getFuelModel('TU2');

const rows = REFERENCE.map((fixture) => {
  const result = calculateSurfaceSpread({
    fuelModel: tu2,
    deadMoistureFraction: 0.05,
    liveMoistureFraction: 0.50,
    midflameWindKmh: fixture.midflameWindKmh,
    windDirectionRadians: 0,
    slopeRadians: Math.atan(0.10),
    slopeAspectEast: 1,
    slopeAspectNorth: 0,
    travelDirectionEast: 1,
    travelDirectionNorth: 0
  });
  const relativeError = Math.abs(
    result.firelineIntensityKwPerM - fixture.firelineIntensityKwPerM
  ) / fixture.firelineIntensityKwPerM;
  const heatAreaIdentityError = Math.abs(
    result.heatPerUnitAreaKjPerM2
      - result.reactionIntensityKjPerM2Min * result.intermediate.residenceTimeMinutes
  );
  const rateIdentityError = Math.abs(
    result.firelineIntensityKwPerM
      - result.heatPerUnitAreaKjPerM2 * result.rateMPerMin / 60
  );
  return {
    midflameWindKmh: fixture.midflameWindKmh,
    expectedFirelineIntensityKwPerM: fixture.firelineIntensityKwPerM,
    actualFirelineIntensityKwPerM: Number(result.firelineIntensityKwPerM.toFixed(3)),
    relativeError: Number(relativeError.toFixed(6)),
    heatAreaIdentityError,
    rateIdentityError,
    pass: relativeError <= RELATIVE_TOLERANCE
      && heatAreaIdentityError < 1e-9
      && rateIdentityError < 1e-9
  };
});

const report = {
  fixture: 'Andrews 2014 BehavePlus Figure 3 · TU2',
  source: 'https://research.fs.usda.gov/download/treesearch/47875.pdf',
  tolerance: RELATIVE_TOLERANCE,
  pass: rows.every((row) => row.pass),
  rows
};

console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
