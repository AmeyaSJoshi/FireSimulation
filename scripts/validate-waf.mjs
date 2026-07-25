import { calculateUnshelteredWindAdjustment } from '../src/lib/weatherInputs.js';

// Andrews (2012), RMRS-GTR-266 Table 8, BehavePlus-calculated column.
// The fixture validates the equation at its published 20-ft reference height
// before the interactive model applies the 10 m above-ground conversion.
const fixture = [
  { model: 1, depthFeet: 1.0, expected: 0.36 },
  { model: 2, depthFeet: 1.0, expected: 0.36 },
  { model: 3, depthFeet: 2.5, expected: 0.44 },
  { model: 4, depthFeet: 6.0, expected: 0.55 },
  { model: 5, depthFeet: 2.0, expected: 0.42 },
  { model: 6, depthFeet: 2.5, expected: 0.44 },
  { model: 7, depthFeet: 2.5, expected: 0.44 },
  { model: 8, depthFeet: 0.2, expected: 0.28 },
  { model: 9, depthFeet: 0.2, expected: 0.28 },
  { model: 10, depthFeet: 1.0, expected: 0.36 },
  { model: 11, depthFeet: 1.0, expected: 0.36 },
  { model: 12, depthFeet: 2.3, expected: 0.43 },
  { model: 13, depthFeet: 3.0, expected: 0.46 }
];

const tolerance = 0.005;
const rows = fixture.map((row) => {
  const result = calculateUnshelteredWindAdjustment({
    fuelBedDepthMeters: row.depthFeet * 0.3048,
    referenceHeightMeters: 20 * 0.3048
  });
  const actual = result?.adjustmentFactor ?? NaN;
  const absoluteError = Math.abs(actual - row.expected);
  return {
    model: row.model,
    expected: row.expected,
    actual: Number(actual.toFixed(6)),
    absoluteError: Number(absoluteError.toFixed(6)),
    pass: Number.isFinite(actual) && absoluteError <= tolerance
  };
});

const pass = rows.every((row) => row.pass);
console.log(JSON.stringify({
  fixture: 'Andrews 2012 RMRS-GTR-266 Table 8 · BehavePlus calculated WAF',
  source: 'https://www.fs.usda.gov/rm/pubs/rmrs_gtr266.pdf',
  tolerance,
  pass,
  rows
}, null, 2));
if (!pass) process.exitCode = 1;
