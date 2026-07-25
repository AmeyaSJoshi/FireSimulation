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
// FIREBRAND LOFTING HEIGHT — z(firebrand diameter), Albini (1979)
// -----------------------------------------------------------------------
// Albini's full model derives z from a coupled flame/plume-rise submodel
// that depends on firebrand size (diameter) and empirical burning-rate
// correlations for wood cylinders/disks in cross-flow. The original GTR
// INT-56 equations for that submodel are not machine-extractable in this
// environment, but the pyretechnics reimplementation (spot_fire.py)
// preserves Albini's closed-form MAXIMUM lofting height as a direct
// function of firebrand diameter:
//
//   function albini_firebrand_maximum_height(firebrand_diameter):
//     return 0.39e5 * firebrand_diameter
//
// i.e. z (m) = 39000 * D (m), where D is firebrand (disk/cylinder)
// diameter in meters. This is sourced from the pyretechnics
// REIMPLEMENTATION, not the original Albini 1979 GTR text (which we could
// not machine-read) — pyretechnics itself marks the function "# FIXME:
// unused" in its own spread_firebrands pipeline (it uses a fixed z = 117 m
// worked-example constant in albini_t_max instead), but the formula and
// its D33/D43-context are presented as Albini's, and 117 m is exactly what
// this formula reproduces at D = 0.003 m (3 mm) — 0.39e5 * 0.003 = 117 —
// which cross-checks the formula against the one concrete number both this
// project and pyretechnics were previously hardcoding.
//
// Firebrand diameter is now an explicit input (`firebrandDiameterMeters`),
// defaulting to DEFAULT_FIREBRAND_DIAMETER_METERS = 0.003 m (3 mm). This
// default is chosen ONLY because it reproduces the 117 m Albini
// worked-example reference value via the sourced formula above — it is NOT
// independently sourced as "the" typical firebrand diameter. Wildland fire
// literature commonly discusses firebrand diameters on the order of
// 1-10 mm, but that range was not independently verified against a
// specific citation in this pass and should be treated as an unsourced
// plausibility note, not a validated bound. Callers with a fire/fuel-type-
// specific firebrand size estimate should pass `firebrandDiameterMeters`
// explicitly (or `maxLoftHeightMeters` directly, see below).
//
// PHYSICS PROPERTY: with z governed by ember size rather than fire
// intensity, z is roughly CONSTANT across fires with the same firebrand
// diameter, while flame length L grows with intensity. In the Albini D43
// formula, u = (b + z/L)/a: as L grows with a near-constant z, z/L shrinks,
// so u shrinks, so travelTime = 1.2 + (a/3)(u^1.5 - 1) shrinks — and for
// large enough L this can outpace the growth of the characteristic-time
// term (which scales as sqrt(L)). This module previously "fixed" that by
// inventing a constant (LOFT_HEIGHT_TO_FLAME_LENGTH_RATIO = 30) forcing z
// to scale with L so spot distance stayed monotonic in intensity. That
// constant has been REMOVED — it was not sourced from Albini or any other
// citation. With the sourced ember-diameter-based z, maxSpotDistanceMeters
// is NOT guaranteed to be monotonically increasing in fireline intensity;
// see spotting.test.js for what was verified instead. Treat
// maxSpotDistanceMeters as an order-of-magnitude estimate, not a validated
// absolute distance.
//   - callers may still override the lofting height entirely via
//     `maxLoftHeightMeters` when a fire-specific value is available; this
//     takes precedence over firebrandDiameterMeters;
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

// =========================================================================
// ELMFIRE EMPIRICAL SPOTTING-DISTANCE MODEL — THIS IS THE OPERATIVE PATH
// =========================================================================
//
// WHY: the Albini (1979) mechanistic model above is retained for reference
// only. Its lofting height z is governed by firebrand DIAMETER, not fire
// intensity (see the long header comment above and the non-monotonicity
// test in spotting.test.js) — no published closed form was found relating
// ember diameter to fire intensity (checked: Sardoy et al., pyretechnics,
// and general web search), so the Albini path can produce spot distance
// that DECREASES as fireline intensity increases, which is physically
// backwards for routing/graph-edge use. ELMFire's empirical model is
// monotonic in both intensity and wind by construction, so it is used here
// as the operative estimator instead.
//
// FORMULA (Lautenberger, ELMFIRE — github.com/lautenberger/elmfire):
//   E[dX] = a * I^b * U^c        (expected/mean downwind spot distance)
//   Var[dX] = d * E[dX]          (not used here; see determinism note below)
// where I = Byram fireline intensity, U = 20-ft wind speed, and a, b, c, d
// are empirical coefficients named in ELMFire's &SPOTTING namelist as
// MEAN_SPOTTING_DIST (a), SPOT_FLIN_EXP (b), SPOT_WS_EXP (c), and
// NORMALIZED_SPOTTING_DIST_VARIANCE (d).
//
// SOURCE OF THE FORMULA STRUCTURE:
//   - github.com/lautenberger/elmfire, build/source/elmfire_spotting.f90,
//     subroutine SPOTTING, lines ~65-67:
//       MSD = MAX(MEAN_SPOTTING_DIST*(FLIN**SPOT_FLIN_EXP)*(WS20_NOW**SPOT_WS_EXP), 1.0)
//       MU_DIST    = LOG(MSD*MSD / SQRT(MSD * NORMALIZED_SPOTTING_DIST_VARIANCE + MSD*MSD))
//       SIGMA_DIST = SQRT(LOG(1. + MSD * NORMALIZED_SPOTTING_DIST_VARIANCE / (MSD*MSD)))
//     i.e. MSD is exactly E[dX] = a*I^b*U^c, and the lognormal is
//     moment-matched from mean MSD and variance MSD*d.
//   - Confirmed independently in the official docs,
//     github.com/lautenberger/elmfire, docs/user_guide/spotting.rst
//     (rendered at elmfire.io/user_guide/spotting.html), which states the
//     same formula in math notation: m = a*Qdot'^b*u20^c, v = m*d.
//
// SOURCE OF THE NUMERIC VALUES USED HERE (a, b, c, d):
//   docs/user_guide/spotting.rst, lines 18-34, "Shown below is a sample
//   spotting configuration":
//     MEAN_SPOTTING_DIST                = 5.0
//     SPOT_FLIN_EXP                     = 0.3
//     SPOT_WS_EXP                       = 0.7
//     NORMALIZED_SPOTTING_DIST_VARIANCE = 250.0
//   IMPORTANT CAVEAT: these are ELMFire's documented SAMPLE/reference
//   configuration values, not universal physical constants — the same docs
//   describe these four parameters as calibration coefficients that
//   ELMFire normally tunes per-fire via STOCHASTIC_SPOTTING/CALIBRATION
//   mode against observed perimeters. We checked whether the *compiled-in*
//   Fortran fallback defaults (elmfire_namelists.f90, READ_SPOTTING
//   subroutine) were a better-sourced alternative: SPOT_FLIN_EXP=0.5,
//   SPOT_WS_EXP=0.9 do have nonzero fallbacks there, but MEAN_SPOTTING_DIST
//   and NORMALIZED_SPOTTING_DIST_VARIANCE both default to 0.0 in that same
//   subroutine (i.e. spotting is a no-op unless the user supplies a and d
//   explicitly) — confirmed by checking ELMFire's own example configs
//   (verification/03-spotting/elmfire.data.in and
//   tutorials/05-UMD-spotting/elmfire.data.in), neither of which sets
//   MEAN_SPOTTING_DIST or NORMALIZED_SPOTTING_DIST_VARIANCE at all. So the
//   compiled-in fallback is not usable as "the" default either. We use the
//   documented sample configuration (a=5.0, b=0.3, c=0.7, d=250.0) because
//   it is the only complete, published, non-zero, citable set of all four
//   coefficients found in ELMFire's own materials.
//
// UNITS (confirmed from ELMFire's own docs, not assumed):
//   - I (fireline intensity) is in kW/m — SI. Source:
//     docs/user_guide/spotting.rst, line 118-119: "CRITICAL_SPOTTING_
//     FIRELINE_INTENSITY ... is the fireline intensity in units of kW/m".
//   - U (20-ft wind speed) is in MPH, not m/s or km/h. Source:
//     docs/user_guide/io.rst, line 87: "WS_FILENAME: 20-ft wind speed in
//     mph". This module's midflameWindKmh input is converted to mph before
//     applying the exponent (see MPH_PER_KMH below) specifically because
//     of this sourced unit requirement — do not remove that conversion.
//
// DETERMINISM: this project's solver is Dijkstra-based and benchmark
// comparisons depend on determinism, so only E[dX] (the lognormal MEAN) is
// implemented below. ELMFire itself samples a random distance from the
// lognormal(mu, sigma) distribution per ember; we deliberately do NOT do
// that here. Var[dX]/d is documented above for completeness but is not
// consumed by any function in this file.
// =========================================================================

// a = MEAN_SPOTTING_DIST, ELMFire sample &SPOTTING config (spotting.rst).
const ELMFIRE_DOWNWIND_DISTANCE_MEAN = 5.0;
// b = SPOT_FLIN_EXP, ELMFire sample &SPOTTING config (spotting.rst).
const ELMFIRE_FLIN_EXPONENT = 0.3;
// c = SPOT_WS_EXP, ELMFire sample &SPOTTING config (spotting.rst).
const ELMFIRE_WS_EXPONENT = 0.7;
// d = NORMALIZED_SPOTTING_DIST_VARIANCE, ELMFire sample &SPOTTING config
// (spotting.rst). Not consumed here (see DETERMINISM note above); exported
// only so the sourced value is visible/citable to callers who need Var[dX].
export const ELMFIRE_DOWNWIND_VARIANCE_MEAN_RATIO = 250.0;

export const ELMFIRE_SPOTTING_VERSION = 'elmfire-empirical-mean-0.1.0';

// Sourced unit conversion (not fire-specific): 1 km/h = 0.621371 mph.
const MPH_PER_KMH = 0.621371;

/**
 * ELMFire (Lautenberger) empirical expected downwind spot-fire distance,
 * E[dX] = a * I^b * U^c. THIS IS THE OPERATIVE spotting-distance estimator
 * for this project (see module header for why the Albini path above is
 * reference-only). Deterministic: returns the lognormal distribution's
 * MEAN, never a sampled/random draw.
 *
 * Monotonic in both firelineIntensityKwPerM and midflameWindKmh by
 * construction (both exponents b, c > 0), unlike the Albini path.
 *
 * @param {object} params
 * @param {number} params.firelineIntensityKwPerM - Byram fireline intensity, kW/m.
 * @param {number} params.midflameWindKmh - wind speed, km/h. Internally
 *   converted to mph — see module header for why ELMFire's formula requires
 *   mph specifically.
 * @returns {{
 *   expectedSpotDistanceMeters: number,
 *   version: string
 * }}
 */
export function computeElmfireSpotting({ firelineIntensityKwPerM, midflameWindKmh } = {}) {
  requireNonNegative('firelineIntensityKwPerM', firelineIntensityKwPerM);
  requireNonNegative('midflameWindKmh', midflameWindKmh);

  if (firelineIntensityKwPerM === 0 || midflameWindKmh === 0) {
    return { expectedSpotDistanceMeters: 0, version: ELMFIRE_SPOTTING_VERSION };
  }

  const windMph = midflameWindKmh * MPH_PER_KMH;
  const expectedSpotDistanceMeters = ELMFIRE_DOWNWIND_DISTANCE_MEAN
    * firelineIntensityKwPerM ** ELMFIRE_FLIN_EXPONENT
    * windMph ** ELMFIRE_WS_EXPONENT;

  return { expectedSpotDistanceMeters, version: ELMFIRE_SPOTTING_VERSION };
}

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

// Albini (1979) maximum firebrand lofting height coefficient, sourced from
// the pyretechnics reimplementation's `albini_firebrand_maximum_height`
// function (see module header): z (m) = ALBINI_LOFT_HEIGHT_COEFFICIENT *
// firebrandDiameterMeters. Dimensionally this coefficient absorbs the
// unit conversion and empirical plume-rise correlation from Albini's
// submodel; pyretechnics states it as the literal constant 0.39e5.
const ALBINI_LOFT_HEIGHT_COEFFICIENT = 0.39e5;

// Default firebrand diameter (meters) = 3 mm. NOT independently sourced as
// "the" typical firebrand size — chosen because it reproduces the 117 m
// Albini worked-example lofting height via the sourced formula above
// (0.39e5 * 0.003 = 117). See module header for the full caveat.
export const DEFAULT_FIREBRAND_DIAMETER_METERS = 0.003;

/**
 * Albini (1979) maximum firebrand lofting height as a function of firebrand
 * diameter. See module header for sourcing (pyretechnics reimplementation,
 * not the original GTR text).
 * @param {number} firebrandDiameterMeters
 * @returns {number} maximum lofting height in meters
 */
export function albiniFirebrandMaximumHeightMeters(firebrandDiameterMeters) {
  requireNonNegative('firebrandDiameterMeters', firebrandDiameterMeters);
  return ALBINI_LOFT_HEIGHT_COEFFICIENT * firebrandDiameterMeters;
}

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
 * @param {number} [params.firebrandDiameterMeters] - firebrand (ember)
 *   diameter, meters; defaults to DEFAULT_FIREBRAND_DIAMETER_METERS.
 *   Ignored if `maxLoftHeightMeters` is supplied. See module header for
 *   sourcing and the caveat that the default is not independently
 *   validated as a typical firebrand size.
 * @param {number} [params.maxLoftHeightMeters] - override for the maximum
 *   firebrand lofting height; if omitted, derived from
 *   `firebrandDiameterMeters` via the sourced Albini formula, raised to at
 *   least canopyHeightMeters + flame length.
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
  firebrandDiameterMeters = DEFAULT_FIREBRAND_DIAMETER_METERS,
  maxLoftHeightMeters = null
} = {}) {
  requireNonNegative('firelineIntensityKwPerM', firelineIntensityKwPerM);
  requireNonNegative('midflameWindKmh', midflameWindKmh);
  requireNonNegative('canopyHeightMeters', canopyHeightMeters);
  requireFinite('slopeFraction', slopeFraction);
  requireNonNegative('firebrandDiameterMeters', firebrandDiameterMeters);

  const flameLengthMeters = byramFlameLengthMeters(firelineIntensityKwPerM);

  // Lofting height is governed by firebrand (ember) size, per Albini
  // (1979) via the pyretechnics reimplementation — see module header. It
  // is floored at (canopy top + flame length) on ordinary geometric
  // grounds (an ember cannot loft below the flame it rides up on).
  const loftFloorMeters = Math.max(
    canopyHeightMeters + flameLengthMeters,
    albiniFirebrandMaximumHeightMeters(firebrandDiameterMeters)
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
