// Directional fire spread ellipse used to transform the Rothermel heading
// rate into rates at other azimuths.
//
// Primary references:
// - Andrews (2018), USDA RMRS-GTR-371:
//   https://research.fs.usda.gov/treesearch/55928
// - Andrews (2007), BehavePlus fire modeling system, USDA RMRS-GTR-153:
//   https://research.fs.usda.gov/treesearch/25948
//
// Rothermel predicts the heading rate. The standard elliptical transformation
// infers the rest of the fire perimeter from heading/backing rates, preserving
// the locally calculated endpoints instead of applying another wind heuristic.

function requireFinite(name, value) {
  if (!Number.isFinite(value)) {
    throw new RangeError(`fireEllipse: ${name} must be finite, got ${value}`);
  }
}

function requireRate(name, value) {
  requireFinite(name, value);
  if (value < 0) throw new RangeError(`fireEllipse: ${name} must be >= 0, got ${value}`);
}

function ellipseEccentricity({ headRateMPerMin, backingRateMPerMin }) {
  requireRate('headRateMPerMin', headRateMPerMin);
  requireRate('backingRateMPerMin', backingRateMPerMin);
  if (headRateMPerMin <= 0) return 0;
  if (backingRateMPerMin > headRateMPerMin) {
    throw new RangeError(
      `fireEllipse: backingRateMPerMin must not exceed headRateMPerMin, got ${backingRateMPerMin}`
    );
  }
  return (headRateMPerMin - backingRateMPerMin)
    / (headRateMPerMin + backingRateMPerMin);
}

export function ellipseLengthToWidthRatio({ headRateMPerMin, backingRateMPerMin } = {}) {
  const eccentricity = ellipseEccentricity({ headRateMPerMin, backingRateMPerMin });
  if (eccentricity >= 1) return Infinity;
  return 1 / Math.sqrt(1 - eccentricity ** 2);
}

export function ellipseRateFromHeadBacking({
  headRateMPerMin,
  backingRateMPerMin,
  angleRadians = 0
} = {}) {
  requireFinite('angleRadians', angleRadians);
  requireRate('headRateMPerMin', headRateMPerMin);
  requireRate('backingRateMPerMin', backingRateMPerMin);
  if (headRateMPerMin === 0) return 0;
  if (angleRadians === 0) return headRateMPerMin;
  if (Math.abs(angleRadians) === Math.PI) return backingRateMPerMin;

  const eccentricity = ellipseEccentricity({ headRateMPerMin, backingRateMPerMin });
  const denominator = 1 - eccentricity * Math.cos(angleRadians);
  if (denominator <= 0) return 0;
  return headRateMPerMin * (1 - eccentricity) / denominator;
}
