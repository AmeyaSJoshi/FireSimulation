// Guarded implementation of the published Rothermel/Van Wagner crown-fire
// coupling. It is intentionally separate from the surface kernel: callers
// must provide measured CBH and CBD before this module can change spread.

import { getFuelModel } from './fuelModels.js';
import { calculateSurfaceSpread } from './surfaceSpread.js';

export const CROWN_FIRE_VERSION = 'rothermel-1991-van-wagner-1977-0.1.0';
export const CROWN_ACTIVE_MASS_FLOW_KG_PER_M2_SEC = 0.05;
export const FM10_CROWN_WIND_FRACTION = 0.4;
export const FM10_CROWN_RATE_MULTIPLIER = 3.34;
export const FM10_CROWN_REFERENCE_HEIGHT_METERS = 6.1;

const FM10 = getFuelModel('FM10');

function requireFinite(name, value) {
  if (!Number.isFinite(value)) throw new RangeError(`crownFire: ${name} must be finite`);
  return value;
}

function requireNonNegative(name, value) {
  requireFinite(name, value);
  if (value < 0) throw new RangeError(`crownFire: ${name} must be >= 0`);
  return value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function crownInitiationIntensityKwPerM({
  canopyBaseHeightMeters,
  foliarMoistureFraction = 1
} = {}) {
  requireNonNegative('canopyBaseHeightMeters', canopyBaseHeightMeters);
  requireNonNegative('foliarMoistureFraction', foliarMoistureFraction);
  // Van Wagner (1977), as combined in Scott & Reinhardt (2001), Eq. 11.
  return (0.01 * canopyBaseHeightMeters
    * (460 + 25.9 * foliarMoistureFraction * 100)) ** 1.5;
}

export function activeCrownRequiredRateMPerMin({ canopyBulkDensityKgPerM3 } = {}) {
  requireFinite('canopyBulkDensityKgPerM3', canopyBulkDensityKgPerM3);
  if (canopyBulkDensityKgPerM3 <= 0) return Infinity;
  // 0.05 kg m^-2 s^-1 converted to m min^-1: 30 / CBD.
  return (CROWN_ACTIVE_MASS_FLOW_KG_PER_M2_SEC * 60) / canopyBulkDensityKgPerM3;
}

function windAtCrownReferenceHeight({ openWindKmh, referenceHeightMeters = 10 }) {
  requireNonNegative('openWindKmh', openWindKmh);
  requireFinite('referenceHeightMeters', referenceHeightMeters);
  if (referenceHeightMeters <= 0) throw new RangeError('crownFire: referenceHeightMeters must be > 0');
  // A neutral 1/7 power profile converts the 10-m observation to the 6.1-m
  // open wind used by the Rothermel correlation. This is a transparent
  // height conversion, not a canopy shelter factor.
  return openWindKmh * (FM10_CROWN_REFERENCE_HEIGHT_METERS / referenceHeightMeters) ** (1 / 7);
}

export function calculateRothermelActiveCrownSpread({
  openWindKmh,
  referenceHeightMeters = 10,
  windDirectionRadians = 0,
  slopeRadians = 0,
  slopeAspectEast = 0,
  slopeAspectNorth = 0,
  deadMoistureFraction = 0.08,
  liveMoistureFraction = 1
} = {}) {
  const openWindAtCrownHeight = windAtCrownReferenceHeight({ openWindKmh, referenceHeightMeters });
  const fm10Spread = calculateSurfaceSpread({
    fuelModel: FM10,
    deadMoistureFraction,
    liveMoistureFraction,
    midflameWindKmh: openWindAtCrownHeight * FM10_CROWN_WIND_FRACTION,
    windDirectionRadians,
    slopeRadians,
    slopeAspectEast,
    slopeAspectNorth
  });
  return {
    version: CROWN_FIRE_VERSION,
    openWindAtCrownHeightKmh: openWindAtCrownHeight,
    activeHeadRateMPerMin: FM10_CROWN_RATE_MULTIPLIER * fm10Spread.headRateMPerMin,
    activeFlankRateMPerMin: FM10_CROWN_RATE_MULTIPLIER * fm10Spread.flankRateMPerMin,
    activeBackingRateMPerMin: FM10_CROWN_RATE_MULTIPLIER * fm10Spread.backingRateMPerMin,
    fm10SurfaceSpread: fm10Spread
  };
}

export function classifyCrownFire({
  surfaceFirelineIntensityKwPerM,
  surfaceRateMPerMin,
  surfaceHeatPerUnitAreaKjPerM2,
  canopyBaseHeightMeters,
  canopyBulkDensityKgPerM3,
  foliarMoistureFraction = 1,
  activeCrownRateMPerMin,
  crownFractionBurned = null
} = {}) {
  requireNonNegative('surfaceFirelineIntensityKwPerM', surfaceFirelineIntensityKwPerM);
  requireNonNegative('surfaceRateMPerMin', surfaceRateMPerMin);
  requireNonNegative('surfaceHeatPerUnitAreaKjPerM2', surfaceHeatPerUnitAreaKjPerM2);
  requireNonNegative('activeCrownRateMPerMin', activeCrownRateMPerMin);
  const initiationIntensityKwPerM = crownInitiationIntensityKwPerM({
    canopyBaseHeightMeters,
    foliarMoistureFraction
  });
  const requiredActiveRateMPerMin = activeCrownRequiredRateMPerMin({ canopyBulkDensityKgPerM3 });
  const initiationRateMPerMin = surfaceHeatPerUnitAreaKjPerM2 > 0
    ? initiationIntensityKwPerM * 60 / surfaceHeatPerUnitAreaKjPerM2
    : Infinity;
  const canInitiate = surfaceFirelineIntensityKwPerM > initiationIntensityKwPerM;
  const canSustainActive = activeCrownRateMPerMin >= requiredActiveRateMPerMin;
  const type = !canInitiate ? 'surface' : (canSustainActive ? 'active' : 'passive');
  const resolvedCrownFractionBurned = Number.isFinite(crownFractionBurned)
    ? clamp(crownFractionBurned, 0, 1)
    : (type === 'active' ? 1 : 0);
  return {
    version: CROWN_FIRE_VERSION,
    type,
    canInitiate,
    canSustainActive,
    crownFractionBurned: resolvedCrownFractionBurned,
    initiationIntensityKwPerM,
    initiationRateMPerMin,
    requiredActiveRateMPerMin,
    activeCrownRateMPerMin,
    surfaceRateMPerMin
  };
}

export function calculateCrownFractionBurned({
  openWindKmh,
  torchingIndexWindKmh,
  crowningIndexWindKmh
} = {}) {
  requireNonNegative('openWindKmh', openWindKmh);
  // An infinite torching index means the surface fire in this fuel cannot
  // reach the crown initiation intensity at any modelled wind speed (true
  // for light litter and grass models, whose fireline intensity stays one
  // to two orders of magnitude below the Van Wagner threshold). That is a
  // valid "never torches" result, not a bad input -- same treatment as an
  // infinite crowning index below.
  if (torchingIndexWindKmh === Infinity) return 0;
  requireNonNegative('torchingIndexWindKmh', torchingIndexWindKmh);
  if (crowningIndexWindKmh === Infinity) return 0;
  requireNonNegative('crowningIndexWindKmh', crowningIndexWindKmh);
  if (openWindKmh <= torchingIndexWindKmh) return 0;
  if (crowningIndexWindKmh <= torchingIndexWindKmh) return 1;
  // Scott & Reinhardt (2001), following Van Wagner (1989, 1993): CFB is
  // linear from zero at TI to one at CI.
  return clamp(
    (openWindKmh - torchingIndexWindKmh)
      / (crowningIndexWindKmh - torchingIndexWindKmh),
    0,
    1
  );
}

export function blendCrownRate({ surfaceRateMPerMin, activeRateMPerMin, crownFractionBurned } = {}) {
  requireNonNegative('surfaceRateMPerMin', surfaceRateMPerMin);
  requireNonNegative('activeRateMPerMin', activeRateMPerMin);
  requireFinite('crownFractionBurned', crownFractionBurned);
  return surfaceRateMPerMin + clamp(crownFractionBurned, 0, 1)
    * (activeRateMPerMin - surfaceRateMPerMin);
}
