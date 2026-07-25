import { runConusHackathonBenchmarks } from '../src/lib/hackathonBenchmarkRunner.js';

const deadMoistureValues = [0.03, 0.05, 0.08, 0.12];
const liveMoistureValues = [0.3, 0.5, 0.8, 1.1];
const fuelScaleValues = [0.5, 0.75, 1];
const runs = [];

for (const deadMoistureFraction of deadMoistureValues) {
  for (const liveMoistureFraction of liveMoistureValues) {
    for (const fuelLoadScale of fuelScaleValues) {
      const result = runConusHackathonBenchmarks({
        deadMoistureFraction,
        liveMoistureFraction,
        fuelLoadScale,
        splits: ['calibration']
      });
      runs.push({
        parameters: result.parameters,
        summary: result.summary,
        cases: result.cases.map(({ id, report }) => ({
          id,
          iou: report.iou,
          f1: report.f1,
          predictedToObservedAreaRatio: report.observedAreaKm2 > 0
            ? report.predictedAreaKm2 / report.observedAreaKm2
            : null
        }))
      });
    }
  }
}

runs.sort((left, right) => (
  (right.summary.meanIoU ?? -Infinity) - (left.summary.meanIoU ?? -Infinity)
));

const bestCalibration = runs[0];
const holdout = bestCalibration
  ? runConusHackathonBenchmarks({
    ...bestCalibration.parameters,
    splits: ['holdout']
  })
  : null;

console.log(JSON.stringify({
  region: 'conus-showcase',
  benchmark: 'calibration-only parameter sweep with untouched holdout check; do not treat as trained calibration',
  testedRuns: runs.length,
  ranking: runs.slice(0, 10),
  bestCalibration: bestCalibration ?? null,
  holdoutCheck: holdout
    ? {
      caseCount: holdout.summary.caseCount,
      summary: holdout.summary,
      cases: holdout.cases.map(({ id, split, report }) => ({
        id,
        split,
        iou: report.iou,
        f1: report.f1,
        predictedToObservedAreaRatio: report.observedAreaKm2 > 0
          ? report.predictedAreaKm2 / report.observedAreaKm2
          : null
      }))
    }
    : null
}, null, 2));
