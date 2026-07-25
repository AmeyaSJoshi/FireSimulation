// Shared scoring and summary contracts for the hackathon's U.S. validation
// mode. This module never decides whether a run is "accurate"; it reports
// comparable evidence so that calibration changes cannot hide regressions.

export const HACKATHON_VALIDATION_REGION = Object.freeze({
  id: 'conus-showcase',
  label: 'CONUS / United States showcase',
  coverage: 'regional high-confidence target; global fallback remains exploratory',
  sourcePolicy: 'public U.S. fuel, canopy, weather, and perimeter inputs where available'
});

function finiteValues(cases, selector) {
  return cases
    .map(selector)
    .filter((value) => Number.isFinite(value));
}

function mean(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function requireCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new RangeError('hackathonValidation: at least one benchmark case is required');
  }
  for (const [index, entry] of cases.entries()) {
    if (!entry || typeof entry !== 'object' || !entry.id) {
      throw new TypeError(`hackathonValidation: case ${index} must have an id`);
    }
    if (!entry.report || typeof entry.report !== 'object') {
      throw new TypeError(`hackathonValidation: case ${entry.id} must have a report`);
    }
  }
}

export function summarizeHackathonBenchmarks(cases) {
  requireCases(cases);
  const iou = finiteValues(cases, (entry) => entry.report.iou);
  const f1 = finiteValues(cases, (entry) => entry.report.f1);
  const precision = finiteValues(cases, (entry) => entry.report.precision);
  const recall = finiteValues(cases, (entry) => entry.report.recall);
  const centroidErrorKm = finiteValues(cases, (entry) => entry.report.centroidErrorKm);
  const areaRatios = finiteValues(cases, (entry) => {
    const observed = entry.report.observedAreaKm2;
    return observed > 0 ? entry.report.predictedAreaKm2 / observed : null;
  });
  const best = [...cases].sort((left, right) => (
    (right.report.iou ?? -Infinity) - (left.report.iou ?? -Infinity)
  ))[0];
  const worst = [...cases].sort((left, right) => (
    (left.report.iou ?? Infinity) - (right.report.iou ?? Infinity)
  ))[0];
  return {
    caseCount: cases.length,
    meanIoU: mean(iou),
    medianIoU: median(iou),
    meanF1: mean(f1),
    meanPrecision: mean(precision),
    meanRecall: mean(recall),
    meanPredictedToObservedAreaRatio: mean(areaRatios),
    meanCentroidErrorKm: mean(centroidErrorKm),
    bestCaseId: best.id,
    bestCaseIoU: best.report.iou,
    worstCaseId: worst.id,
    worstCaseIoU: worst.report.iou,
    interpretation: 'U.S. diagnostic benchmark only; these metrics are evidence for calibration, not operational accuracy.'
  };
}

export function compareHackathonBenchmarks({ baseline, candidate } = {}) {
  if (!baseline || !candidate) {
    throw new TypeError('hackathonValidation: baseline and candidate summaries are required');
  }
  const delta = (key) => Number.isFinite(candidate[key]) && Number.isFinite(baseline[key])
    ? candidate[key] - baseline[key]
    : null;
  return {
    meanIoU: delta('meanIoU'),
    meanF1: delta('meanF1'),
    meanPrecision: delta('meanPrecision'),
    meanRecall: delta('meanRecall'),
    meanPredictedToObservedAreaRatio: delta('meanPredictedToObservedAreaRatio'),
    meanCentroidErrorKm: delta('meanCentroidErrorKm'),
    interpretation: 'Positive IoU/F1/precision/recall deltas are improvements; a negative centroid-error delta is an improvement.'
  };
}
