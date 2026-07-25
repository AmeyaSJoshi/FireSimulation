# Rothermel Validation Notes

**Updated:** 2026-07-23

This note records the first independent numerical check of the surface-spread
kernel. The goal is to distinguish equation validation from a claim that the
global application is operationally accurate.

## Primary Sources

- Rothermel, R.C. (1972), *A Mathematical Model for Predicting Fire Spread in
  Wildland Fuels*, USDA Forest Service Research Paper INT-115:
  https://research.fs.usda.gov/treesearch/32533
- Andrews, P.L. (2018), *The Rothermel Surface Fire Spread Model and
  Associated Developments: A Comprehensive Explanation*, USDA Forest Service
  RMRS-GTR-371:
  https://research.fs.usda.gov/treesearch/55928
- Andrews, P.L. (2014), *Current Status and Future Needs of the BehavePlus
  Fire Modeling System*, USDA Forest Service-hosted paper:
  https://research.fs.usda.gov/treesearch/download/47875.pdf
- Ziel, R.J. et al. (2009), USFS GTR-NRS-P-46 Table 1, standard fuel-model
  parameters including TU2:
  https://www.nrs.fs.usda.gov/pubs/gtr/gtr-p-46papers/05-ziel-p-46.pdf
- Andrews (2007), *BehavePlus fire modeling system: burn subsystem*,
  USDA RMRS-GTR-153:
  https://research.fs.usda.gov/treesearch/25948
- Scott, J.H. et al. (2012), *Modeling wind adjustment factor and midflame
  wind speed for Rothermel's surface fire spread model*, USFS RMRS-GTR-266:
  https://www.fs.usda.gov/rm/pubs/rmrs_gtr266.pdf
- Scott, J.H. (2007), *Nomographs for estimating surface fire behavior
  characteristics*, USFS RMRS-GTR-192, Table 1:
  https://www.fs.usda.gov/rm/pubs/rmrs_gtr192.pdf

## Reference Fixture

The BehavePlus example in Andrews (2014), Figure 3, uses fuel model TU2,
5% dead moisture, 50% live moisture, 10% slope, and midflame wind speeds of
3, 6, 9, and 12 km/h. Its published fireline intensities are:

| Midflame wind | Published intensity | App intensity | Relative error |
|---:|---:|---:|---:|
| 3 km/h | 130 kW/m | 135.7 kW/m | 4.4% |
| 6 km/h | 293 kW/m | 306.3 kW/m | 4.5% |
| 9 km/h | 497 kW/m | 520.1 kW/m | 4.6% |
| 12 km/h | 733 kW/m | 767.7 kW/m | 4.7% |

The regression fixture lives in `src/lib/surfaceSpread.test.js` and uses a
5% tolerance. The small positive bias is retained as evidence rather than
hidden with a fitted coefficient.

Run `npm run validate:rothermel` for the same check as a standalone gate. It
prints one row per published wind/intensity pair and exits nonzero if any row
exceeds the 5% tolerance or if either SI heat-area/rate identity fails.

Run `npm run validate:rothermel:rate` for the independent rate gate. This
validator carries a literal TU2 parameter set and recomputes the Rothermel
reaction, heat sink, propagating flux, wind factor, slope factor, residence
time, and rate in US customary units. It compares the production kernel with
that oracle from calm conditions through 12 km/h midflame wind. The production
comparison allows 0.02% for the repository's rounded SI conversions of the
published US-unit fuel parameters. The pinned values are an equation-regression
oracle, not an empirical ROS benchmark;
Andrews (2014) Figure 2 publishes the rate curves as a graph without exact
numeric points. Keeping the two validations separate avoids implying a level
of observational accuracy that the source does not provide.

The kernel also exposes heat per unit area in SI units. Its fireline intensity
is calculated as `heat per unit area (kJ/m²) × rate (m/min) / 60`, and
`src/lib/firePropagation.test.js` asserts that the resulting Rothermel heading
rate produces the expected `distance / rate` travel time. This verifies the
rate-to-propagation unit contract without inventing a published rate fixture.

## Equation Corrections Made

- Characteristic dead/live moisture is weighted by fuel surface-area
  fractions, matching Andrews (2018) Table 6.
- Dead reaction load is weighted by dead-fuel surface-area fractions, while
  live reaction load remains the sum of live classes.
- Heat sink now uses the per-class preignition term weighted by category and
  surface-area fractions, including `exp(-138 / sigma)`.
- TU2 is included as a cited validation-only fuel model. It is not selected by
  the current WorldCover crosswalk.
- The arrival-time solver uses the standard elliptical transformation from
  the local heading/backing rates for crosswind and backing directions. This
  is covered by `src/lib/fireEllipse.test.js` and the propagation integration
  test. The solver can also consume a time-varying forecast-wind timeline;
  that path has a deterministic regression test, but it does not claim that
  the global raster or fuel crosswalk is historically validated.

## Wind-height adjustment

Open-Meteo provides the reference wind at 10 m. When a standard fuel model
supplies a published WAF, `weatherInputs.windToMidflame` first treats that
value as the 20-ft reference factor documented by Scott (2007), then applies
the logarithmic height ratio to the 10 m above-ground observation. This keeps
the published model-specific values while preserving a consistent height
conversion. The reference gate is `npm run validate:waf` and covers all 13
models in Andrews (2012) RMRS-GTR-266 Table 8.

Experimental AG1 and custom models have no published standard WAF in this
repository. They use the equation-based RMRS-GTR-266 fallback and retain an
explicit provenance label rather than borrowing a neighboring model's value.

When no fuel-bed depth is available, the older `x0.4` open or `x0.2` sheltered
fallback remains available and is labeled in metadata. In CONUS, measured
LANDFIRE CH/CC can now replace the sheltered fallback for low enough canopies
where the 10 m reference is actually above canopy top plus 20 ft; tall canopies
continue to use `x0.2` because a free-wind observation above their tops is not
available. The current interactive run carries raw 10 m wind into propagation
and resolves WAF against each destination fuel model and canopy cell. Tree and
mangrove classes without measured structure still carry a coarse shelter flag.
The clicked-fuel depth remains the timeline baseline and metadata reference,
while callers that provide only midflame wind retain compatibility behavior.

The kernel also accepts a `fuelLoadScale` in `[0, 1]`. The WorldCover
crosswalk uses this to represent low availability in sparse, wetland,
mangrove, moss, and agricultural classes without changing their fuel-model
identity. When Copernicus 100 m fractions are available, the crosswalk also
selects the dominant vegetation family per cell and scales availability by
mapped vegetation cover. These are explicit priors, not observations; the
crosswalk version and scenario metadata preserve that distinction.

## What This Does Not Prove

This validates one homogeneous point calculation against a published
BehavePlus example and provides a separate final-perimeter diagnostic harness.
It does not validate the local arrival-time solver against an observed fire,
spatial fuel crosswalks, water/coastline completeness, weather estimates, or
historical fire perimeters. Those require separate fixtures and holdout tests.
