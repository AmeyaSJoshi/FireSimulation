// Ember (firebrand) transport for spotting — Albini (1979/1983) physics.
//
// This module is a pure function: no I/O, no randomness, no mutable state.
// It exists to support the deterministic-graph-edge design in
// docs/spotting-implementation-plan.md — spotting is represented as extra
// long-range downwind Dijkstra edges whose traversal cost is the computed
// ember flight time, NOT a stochastic ignition. This module only computes
// the physics; it is intentionally not wired into firePropagation.js yet.
//
// SOURCES
// -------
// 1. Flame length from fireline intensity (Byram 1959, "Combustion of
//    forest fuels", in Davis, K.P. (ed.) Forest Fire: Control and Use,
//    McGraw-Hill), as restated with the original coefficient by
//    Alexander, M.E. & Cruz, M.G. 2012. "Graphical aids for visualizing
//    Byram's fireline intensity in relation to flame length and crown
//    scorch height." The Forestry Chronicle 88(6):909-913 (DOI
//    10.5558/tfc2012-035). That paper states the SI-native form directly
//    in kW/m and meters:
//      L (m) = 0.0775 * I (kW/m)^0.46
//    (this is algebraically identical to the more commonly quoted
//    imperial form L(ft) = 0.45 * I(Btu/ft/s)^0.46 — converting the
//    imperial form's coefficient through Btu/ft/s -> kW/m and ft -> m
//    reproduces 0.0775 to 3 significant figures, which is how this was
//    cross-checked here; do NOT apply both forms' unit conversions to the
//    same coefficient, that double-converts and was an earlier bug in
//    this file caught by comparing output flame lengths against expected
//    physical magnitudes for known fire intensities).
//
// 2. Ember ascent/descent (flight) time, Albini, F.A. 1979. "Spot Fire
//    Distance From Burning Trees — A Predictive Model." USDA Forest
//    Service Gen. Tech. Rep. INT-56. The original report's equations are
//    not machine-extractable in this environment, so the exact equation
//    numbers and coefficients below were cross-checked against the
//    open-source, citation-annotated reimplementation at
//    github.com/pyregence/pyretechnics (src/pyretechnics/spot_fire.py,
//    function `albini_t_max`, which cites equations D33, D34, D43 and A58
//    of Albini 1979 by number):
//      a               = 5.963                          (D33)
//      b               = a - 1.4 = 4.563                 (D34)
//      w_F (m/s)       = 2.3 * sqrt(flameLengthMeters)   (A58)
//      charact_t (min) = (2 * flameLengthMeters / w_F) / 60
//      u               = (b + z / flameLengthMeters) / a
//      travelTime      = 1.2 + (a / 3) * (u^1.5 - 1)      (D43)
//      flightTime (min) = charact_t * travelTime
//    where z is the maximum firebrand lofting height (meters).
//
// WHAT WE COULD NOT SOURCE (read before trusting maxSpotDistanceMeters)
// -----------------------------------------------------------------------
// Albini's full model derives z from a coupled flame/plume-rise submodel
// that also depends on firebrand size distribution and empirical
// burning-rate correlations for wood cylinders in cross-flow. We could not
// confidently source those coefficients — they are not a simple closed
// form, and even the pyretechnics port hardcodes a single worked-example
// value (z = 117 m) and separately marks its own general lofting-height
// formula ("albini_firebrand_maximum_height") FIXME/unused.
//
// PHYSICS DEFECT FOUND AND FIXED (see git history / CLAUDE.md handoff for
// the full writeup): treating that worked-example 117 m as a fixed default
// for every fire made maxSpotDistanceMeters DECREASE as fireline intensity
// increased. Root cause, algebraically: in the D43 formula, u = (b + z/L)/A.
// When z is held ~constant while flame length L grows with intensity, z/L
// shrinks, so u shrinks, so travelTime = 1.2 + (A/3)(u^1.5 - 1) shrinks —
// and that shrinkage outpaces the growth of the characteristic time term
// (which scales as sqrt(L)). Net effect: bigger fires produced *shorter*
// flight times and spot distances, which is physically backwards (bigger
// fires loft embers higher and spot farther — that is the entire spotting
// mechanism). This is not merely a units bug; it is structural to using a
// near-constant z regardless of L.
//
// We could not source a general closed-form z(intensity) from Albini 1979
// (see above). Rather than invent a formula and present it as sourced, this
// module now derives z from flame length using a single transparent,
// EXPLICITLY UNSOURCED scaling constant:
//   z = max(canopyHeightMeters + flameLengthMeters,
//           LOFT_HEIGHT_TO_FLAME_LENGTH_RATIO * flameLengthMeters)
// LOFT_HEIGHT_TO_FLAME_LENGTH_RATIO (= 30, dimensionless) is NOT derived
// from Albini or any other cited source. It was chosen only to satisfy two
// requirements: (1) z must grow at least proportionally with flame length
// so u does not collapse as intensity rises (this is what makes flight
// time — and thus spot distance — monotonically increasing in intensity,
// which is the physically required behavior), and (2) it should not force
// unrealistically small or large lofting heights across the fireline
// intensities this module is meant to be used at (roughly 200-90,000
// kW/m). Treat maxSpotDistanceMeters as an order-of-magnitude estimate,
// not a validated absolute distance. The old 117 m constant is preserved
// below as DEFAULT_MAX_LOFT_HEIGHT_METERS purely as the documented Albini
// worked-example reference value (used in tests that check the flight-time
// equation implementation itself) — it is no longer used as the default
// lofting height inside computeSpotting.
//   - callers may still override the lofting height entirely via
//     `maxLoftHeightMeters` when a fire-specific value is available;
//   - the floor of (canopy top + flame length) is kept using ordinary
//     geometry (an ember cannot loft to less than the height its own flame
//     reaches above the canopy) — this floor is our own transparent
//     assumption, not an Albini-sourced number, same as before.
//
// Horizontal transport distance during descent is computed here as
// (ambient wind speed) x (flight time) — constant-wind kinematics, not a
// numerical integration of a log wind profile over the trajectory as
// Albini's full model does. This is a simplification and is documented as
// such; it is an order-of-magnitude estimate of the drift, not a
// reproduction of Albini's full trajectory integral.
//
// `slopeFraction` is accepted for interface completeness (per the
// implementation plan's requested signature) but is currently NOT applied
// — we could not source a physically justified slope adjustment for the
// descent-phase transport distance, so applying one would mean inventing
// a coefficient. Terrain-aware routing of the resulting edges (e.g.
// clipping spot distance at ridgelines) is left to the caller/wiring step.

export const SPOTTING_VERSION = 'albini-1979-flight-time-0.1.0';

// Byram (1959) flame-length coefficients, SI-native form as restated in
// Alexander & Cruz (2012). Units: I in kW/m, L in m.
const BYRAM_FLAME_LENGTH_COEFFICIENT = 0.0775;
const BYRAM_FLAME_LENGTH_EXPONENT = 0.46;

// Albini (1979) dimensionless flight-time constants (D33, D34).
const ALBINI_A = 5.963;
const ALBINI_B = ALBINI_A - 1.4;

// Worked-example maximum firebrand lofting height (meters). Sourced from
// the pyretechnics reimplementation of Albini (1979), which itself notes
// this as "derived for (D44)" rather than a general formula. Retained here
// as a documented reference value only (used by tests that exercise the
// flight-time equation directly with a known input) — computeSpotting no
// longer uses this as its default lofting height; see module header.
export const DEFAULT_MAX_LOFT_HEIGHT_METERS = 117.0;

// Explicitly UNSOURCED scaling constant: how many multiples of flame
// length the lofting height is assumed to reach. See the "PHYSICS DEFECT
// FOUND AND FIXED" discussion in the module header for why this exists and
// why it must scale with flame length rather than being a fixed height.
// This is a transparent approximation, not a value derived from Albini
// 1979 or any other cited source.
export const LOFT_HEIGHT_TO_FLAME_LENGTH_RATIO = 30;

// Standard SI conversion (not fire-specific, high confidence).
const KMH_TO_MS = 1 / 3.6;

function requireFinite(name, value) {
  if (!Number.isFinite(value)) throw new RangeError(`spotting: ${name} must be finite`);
  return value;
}

function requireNonNegative(name, value) {
  requireFinite(name, value);
  if (value < 0) throw new RangeError(`spotting: ${name} must be >= 0`);
  return value;
}

/**
 * Byram (1959) flame length from Byram's fireline intensity (SI-native
 * form; see module header).
 * @param {number} firelineIntensityKwPerM
 * @returns {number} flame length in meters
 */
export function byramFlameLengthMeters(firelineIntensityKwPerM) {
  requireNonNegative('firelineIntensityKwPerM', firelineIntensityKwPerM);
  if (firelineIntensityKwPerM === 0) return 0;
  return BYRAM_FLAME_LENGTH_COEFFICIENT
    * firelineIntensityKwPerM ** BYRAM_FLAME_LENGTH_EXPONENT;
}

/**
 * Albini (1979) ember flight (ascent + descent) time given a flame length
 * and a maximum firebrand lofting height. See module header for the exact
 * equations and their source.
 * @param {number} flameLengthMeters
 * @param {number} maxLoftHeightMeters
 * @returns {number} flight time in minutes
 */
export function albiniFlightTimeMinutes(flameLengthMeters, maxLoftHeightMeters) {
  requireNonNegative('flameLengthMeters', flameLengthMeters);
  requireNonNegative('maxLoftHeightMeters', maxLoftHeightMeters);
  if (flameLengthMeters === 0) return 0;
  if (maxLoftHeightMeters < flameLengthMeters) {
    throw new RangeError('spotting: maxLoftHeightMeters must be >= flameLengthMeters');
  }
  const windAtFlameHeightMs = 2.3 * Math.sqrt(flameLengthMeters); // (A58)
  const characteristicTimeMinutes = (2 * flameLengthMeters / windAtFlameHeightMs) / 60;
  const u = (ALBINI_B + maxLoftHeightMeters / flameLengthMeters) / ALBINI_A;
  const travelTime = 1.2 + (ALBINI_A / 3) * (u ** 1.5 - 1); // (D43)
  return characteristicTimeMinutes * travelTime;
}

/**
 * Computes Albini (1979) ember flight time and an estimated maximum
 * downwind spot-fire distance from a torching/high-intensity source cell.
 * Pure function: same inputs always produce the same outputs.
 *
 * @param {object} params
 * @param {number} params.firelineIntensityKwPerM - Byram fireline intensity, kW/m.
 * @param {number} params.midflameWindKmh - transport wind speed, km/h (midflame
 *   or 20-ft open wind; see module header — used as constant-wind drift
 *   during descent, not integrated over a wind profile).
 * @param {number} [params.canopyHeightMeters=0] - used only as a floor so the
 *   effective lofting height is never below canopy top + flame length.
 * @param {number} [params.slopeFraction=0] - accepted for interface
 *   completeness; NOT currently applied (see module header).
 * @param {number} [params.maxLoftHeightMeters] - override for the maximum
 *   firebrand lofting height; defaults to DEFAULT_MAX_LOFT_HEIGHT_METERS
 *   raised to at least canopyHeightMeters + flame length.
 * @returns {{
 *   flameLengthMeters: number,
 *   maxLoftHeightMeters: number,
 *   flightTimeMinutes: number,
 *   maxSpotDistanceMeters: number,
 *   version: string
 * }}
 */
export function computeSpotting({
  firelineIntensityKwPerM,
  midflameWindKmh,
  canopyHeightMeters = 0,
  slopeFraction = 0,
  maxLoftHeightMeters = null
} = {}) {
  requireNonNegative('firelineIntensityKwPerM', firelineIntensityKwPerM);
  requireNonNegative('midflameWindKmh', midflameWindKmh);
  requireNonNegative('canopyHeightMeters', canopyHeightMeters);
  requireFinite('slopeFraction', slopeFraction);

  const flameLengthMeters = byramFlameLengthMeters(firelineIntensityKwPerM);

  // See module header "PHYSICS DEFECT FOUND AND FIXED": the lofting height
  // must scale with flame length (not be a near-constant default) or the
  // flight-time formula produces spot distances that decrease with rising
  // intensity, which is physically backwards.
  const loftFloorMeters = Math.max(
    canopyHeightMeters + flameLengthMeters,
    LOFT_HEIGHT_TO_FLAME_LENGTH_RATIO * flameLengthMeters
  );
  const resolvedMaxLoftHeightMeters = maxLoftHeightMeters === null
    ? loftFloorMeters
    : requireNonNegative('maxLoftHeightMeters', maxLoftHeightMeters);

  if (flameLengthMeters === 0) {
    return {
      flameLengthMeters: 0,
      maxLoftHeightMeters: resolvedMaxLoftHeightMeters,
      flightTimeMinutes: 0,
      maxSpotDistanceMeters: 0,
      version: SPOTTING_VERSION
    };
  }

  const flightTimeMinutes = albiniFlightTimeMinutes(
    flameLengthMeters,
    Math.max(resolvedMaxLoftHeightMeters, flameLengthMeters)
  );

  const windMs = midflameWindKmh * KMH_TO_MS;
  const maxSpotDistanceMeters = windMs * flightTimeMinutes * 60;

  return {
    flameLengthMeters,
    maxLoftHeightMeters: resolvedMaxLoftHeightMeters,
    flightTimeMinutes,
    maxSpotDistanceMeters,
    version: SPOTTING_VERSION
  };
}
