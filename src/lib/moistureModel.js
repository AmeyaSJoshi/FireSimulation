// Moisture weighting and damping used by the Rothermel surface-spread kernel.
// Andrews (2018), RMRS-GTR-371, Table 6 weights characteristic moisture by
// fuel surface-area fractions. Its live moisture-of-extinction relationship
// separately uses the exp(-138 / sigma) and exp(-500 / sigma) load weights.

const METERS_PER_FOOT = 0.3048;

function positiveLoad(row) {
  return row && Number.isFinite(row.loadKgPerM2) && row.loadKgPerM2 > 0
    && Number.isFinite(row.savRatioPerMeter) && row.savRatioPerMeter > 0;
}

function heatingNumber(row, exponent) {
  const sigmaPerFoot = row.savRatioPerMeter * METERS_PER_FOOT;
  return row.loadKgPerM2 * Math.exp(-exponent / sigmaPerFoot);
}

export function characteristicFuelMoisture(rows = [], moistureFraction = 0, exponent = 138) {
  let totalSurfaceArea = 0;
  let weightedMoisture = 0;

  for (const row of rows) {
    if (!positiveLoad(row)) continue;
    const weight = row.loadKgPerM2 * row.savRatioPerMeter;
    const rowMoisture = Number.isFinite(row.moistureFraction)
      ? row.moistureFraction
      : moistureFraction;
    totalSurfaceArea += weight;
    weightedMoisture += weight * rowMoisture;
  }

  return {
    fraction: totalSurfaceArea > 0 ? weightedMoisture / totalSurfaceArea : moistureFraction,
    surfaceAreaWeight: totalSurfaceArea,
    // Preserve the old field name for downstream diagnostics; this is now
    // the Table 6 surface-area weight, not an extinction heating number.
    heatingNumber: totalSurfaceArea
  };
}

export function calculateLiveMoistureOfExtinction({
  deadRows = [],
  liveRows = [],
  deadMoistureFraction,
  deadExtinctionFraction
} = {}) {
  const deadHeatingNumber = deadRows.reduce((sum, row) => (
    positiveLoad(row) ? sum + heatingNumber(row, 138) : sum
  ), 0);
  const liveHeatingNumber = liveRows.reduce((sum, row) => (
    positiveLoad(row) ? sum + heatingNumber(row, 500) : sum
  ), 0);

  if (!(deadHeatingNumber > 0) || !(liveHeatingNumber > 0)) return deadExtinctionFraction;

  const liveExtinction = 2.9
    * (deadHeatingNumber / liveHeatingNumber)
    * (1 - deadMoistureFraction / deadExtinctionFraction)
    - 0.226;
  return Math.max(deadExtinctionFraction, liveExtinction);
}

export function moistureDamping(moistureFraction, extinctionFraction) {
  if (!(extinctionFraction > 0)) return 0;
  const ratio = Math.min(1, Math.max(0, moistureFraction / extinctionFraction));
  if (ratio <= 0) return 1;
  if (ratio >= 1) return 0;
  return Math.max(0, 1 - 2.59 * ratio + 5.11 * ratio ** 2 - 3.52 * ratio ** 3);
}
