import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareHackathonBenchmarks,
  HACKATHON_VALIDATION_REGION,
  summarizeHackathonBenchmarks
} from './hackathonValidation.js';

function report(iou, f1, predictedAreaKm2, observedAreaKm2, centroidErrorKm) {
  return {
    iou,
    f1,
    precision: 0.6,
    recall: 0.5,
    predictedAreaKm2,
    observedAreaKm2,
    centroidErrorKm
  };
}

test('summarizes multiple U.S. benchmark cases without hiding the worst case', () => {
  const summary = summarizeHackathonBenchmarks([
    { id: 'reservoir', report: report(0.4, 0.5, 4, 5, 1) },
    { id: 'deer', report: report(0.6, 0.7, 6, 5, 2) }
  ]);
  assert.equal(HACKATHON_VALIDATION_REGION.id, 'conus-showcase');
  assert.equal(summary.caseCount, 2);
  assert.equal(summary.meanIoU, 0.5);
  assert.equal(summary.medianIoU, 0.5);
  assert.equal(summary.meanPredictedToObservedAreaRatio, 1);
  assert.equal(summary.bestCaseId, 'deer');
  assert.equal(summary.worstCaseId, 'reservoir');
  assert.match(summary.interpretation, /diagnostic benchmark/);
});

test('benchmark comparison exposes directional deltas', () => {
  const delta = compareHackathonBenchmarks({
    baseline: {
      meanIoU: 0.2,
      meanF1: 0.3,
      meanPrecision: 0.8,
      meanRecall: 0.1,
      meanPredictedToObservedAreaRatio: 0.4,
      meanCentroidErrorKm: 3
    },
    candidate: {
      meanIoU: 0.3,
      meanF1: 0.4,
      meanPrecision: 0.7,
      meanRecall: 0.2,
      meanPredictedToObservedAreaRatio: 0.8,
      meanCentroidErrorKm: 2
    }
  });
  assert.deepEqual(delta, {
    meanIoU: 0.09999999999999998,
    meanF1: 0.10000000000000003,
    meanPrecision: -0.10000000000000009,
    meanRecall: 0.1,
    meanPredictedToObservedAreaRatio: 0.4,
    meanCentroidErrorKm: -1,
    interpretation: 'Positive IoU/F1/precision/recall deltas are improvements; a negative centroid-error delta is an improvement.'
  });
});

