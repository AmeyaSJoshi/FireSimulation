# Handoff status — realistic fire model rewrite

**Last updated:** 2026-07-24 (America/Los_Angeles) — Claude verified all prior
Codex results reproduce exactly; bundled a real LANDFIRE FBFM40 sample and
fixed a real geometry-validation bug it exposed (section 11-12); then wired
real terrain/fuel/weather into all 6 hackathon benchmark cases (Copernicus
DEM GLO-30 + WorldCover 10m + Open-Meteo historical archive, all frozen
offline), which exposed and fixed a real wind/slope physics bug in
`surfaceSpread.js`. New honest benchmark baseline with all fields real:
meanIoU 0.0942 (down from 0.3085 on the old fully-synthetic baseline —
expected, not a regression). See section 13 of
[`remaining-regional-model-execution-prompt.txt`](remaining-regional-model-execution-prompt.txt)
for full details.
**Working branch:** `main`
**Head commit:** `d4c809b` (`git log --oneline -6` for context)

The active hackathon objective is now CONUS/U.S. as the high-confidence
showcase region, with global locations retained as lower-confidence exploratory
fallbacks. The reproducible two-case baseline is available through
`npm run validate:hackathon`; the 48-combination diagnostic sweep is available
through `npm run calibrate:hackathon`. Neither command is a claim of trained or
operational accuracy.

The app now exposes the same distinction in its Model provenance panel through
an evidence profile. It reports whether the clicked run has CONUS showcase,
CONUS regional, or global exploratory inputs based on the actual fuel, cover,
weather, terrain, canopy, and fractional-source responses.

The working tree currently contains the uncommitted regional-fuel integration
work described below. Do not treat `d4c809b` as containing these changes.

Read this before doing anything else with the fire-model rewrite. It is
the running status file for the phased plan defined in
[`realistic-fire-model-claude-code-prompt.txt`](realistic-fire-model-claude-code-prompt.txt).
For the current dependency-ordered execution brief, also read
[`remaining-regional-model-execution-prompt.txt`](remaining-regional-model-execution-prompt.txt).
Everything here is grounded in what's already in the repo; nothing is
aspirational. When you finish a phase, update this file.

---

## Status at a glance

| Phase | Charter (prompt § 14) | Status | Evidence |
|---|---|---|---|
| 0 | Audit and baseline | ✅ done | [`phase-0-baseline.md`](phase-0-baseline.md) · commit `7c58c0a` |
| 1 | Spatial + data contracts, feature flag | ✅ done | commit `7c58c0a` (bundled with the sprint-work-in-flight) |
| 2 | Fuel and weather inputs, land-cover crosswalk | ✅ done | commit `6465498` · [`land-cover-source.md`](research/land-cover-source.md) |
| 3 | Pure Rothermel surface-spread kernel | ✅ integrated, reference-checked | [`src/lib/surfaceSpread.js`](../src/lib/surfaceSpread.js) · 13 focused tests · active worker branch |
| 4 | Arrival-time spatial propagation | ✅ integrated, validation ongoing | [`src/lib/firePropagation.js`](../src/lib/firePropagation.js) · 7 focused tests |
| 5 | Uncertainty ensemble + historical validation | 🟡 experimental ensemble + public replay harness | [`historical-perimeter-validation.md`](research/historical-perimeter-validation.md) · [`src/lib/uncertainty.js`](../src/lib/uncertainty.js); calibrated hindcast remains |

**Baseline you must not regress:**
- `npm test` → **335 tests pass, 0 fail**, including direct regional FBFM40 mapping and scenario-evidence profile tests. This includes the authoritative water-source, propagation-edge visual veto, TU2 reference-validation, published standard-model WAFs, ellipse propagation, sub-cell water-edge, class-moisture, 72-hour weather forecast, forecast moisture timeline, hourly weather-estimate, GSI live-moisture, forecast-wind, fuel-bed-aware WAF, per-cell raw-wind WAF, measured LANDFIRE canopy CH/CC sheltered WAF, piecewise weather integration, moisture-extinction edge blocking, multi-time progression, archived-weather replay, lifecycle horizon, fuel-availability, fine WorldCover field, fine COG reader, bounded fine-cover request batching and retry budget, partial fine-field coverage reporting, within-cell fine-cover majority and burnable-fraction prior, edge-nearest fine water samples, gap-aware dead-fuel lag, deterministic archive-time normalization, pre-ignition dead-fuel spin-up, full-history 100-hour initialization, row/column ignition compatibility, suppression-aware diagnostics and perimeter assimilation diagnostic, seeded uncertainty, forest fuel alternatives, worker ensemble smoke, field-quality diagnostics, optional Copernicus fraction adapter, fractional fuel crosswalk, per-cell cache-fix, authoritative water resolver, conservative coastal veto, SI rate-to-arrival validation, termination-provenance, time-aware suppression-barrier, independent-perimeter, adaptive-validation-domain, batched-elevation-field, global canopy-height field work, LANDFIRE canopy structure and interpolated passive-to-active crown-fire coupling, global FCCS fuelbed normalization and worker wiring, FCCS geometry-aware bed-depth selection, FCCS live-grass partitioning, global canopy shelter fallback, bounded FCCS persistence, multi-interval weather waiting, complete FBFM40 table coverage, time-varying live-moisture forcing, and finite persistence expiry.
- `npm run build` → clean, ~762 ms, 717 KB main chunk (Three.js dominates; Vite still reports the expected chunk-size warning).
- `npm run validate:rothermel` → **pass** for all four Andrews (2014) TU2
  BehavePlus Figure 3 reference points (4.38%–4.74% relative error, under the
  5% gate); heat-area and rate identities are exact to machine precision.
- `SIMULATION_ENGINE = 'phase1'` is now the app default. The click workflow
  builds a per-cell WorldCover fuel field, fetches current + hourly weather,
  estimates dead-fuel moisture, loads
  elevation, and sends all of those inputs to the Rothermel worker. The
  legacy cellular engine remains available for controlled comparisons.

### Latest measured fine-resolution replay

### Global FCCS fuelbed bridge

### CONUS regional FBFM40 fuel field

`src/lib/fuelModels.js` now contains the complete Scott and Burgan FBFM40
family, with published load, SAV, bed-depth, heat, and extinction values
converted to SI units. `src/lib/landfireFuel.js` validates and maps the
LANDFIRE 2024 CONUS raster codes (`91`–`204`) to those exact model codes.
The Vite adapter exposes `/api/fuel/landfire-field`, bounds requests to the
CONUS extent, caches bounded fields, and passes the direct 30 m model code to
the per-cell Rothermel field. Explicit water/no-data barriers still win.

The app reports `LANDFIRE FBFM40` in field quality and fuel provenance only
when valid regional cells actually arrive. If the public WCS is unavailable,
it reports an explicit fallback and uses the global FCCS/WorldCover path; it
does not claim a CONUS showcase run. LANDFIRE's FBFM40 product is intended for
regional/strategic planning and the current WCS request is a data transport,
not a validation of predictive accuracy.

The interactive field now requests the published Pettinari and Chuvieco
Global Fuelbed Dataset at approximately 300 m for each model-cell center.
Vite downloads and caches only the intersecting WGS84 tile, reads a bounded
window, resolves numeric `JOIN_VALUE` values against the generated v1.2
parameter table, and passes custom provenance-bearing Rothermel definitions to
the worker. Explicit water, built-up, snow/ice, no-data, raster no-data, and
unsupported litter/duff-only cells remain non-burnable or unresolved.

The bridge is deliberately `low` confidence: the current surface kernel uses
FCCS grass plus dead 1/10/100-hour loads with standard particle properties,
splits the published grass load with `G_live (%)` when available, and uses
published grass height or woody fuel depth for the Rothermel bed-depth term
when present. FCCS overstory cover is preferred for its tree-height wind-shelter
fallback when higher-resolution canopy data is unavailable, and TO/TM height to
live crown is retained as a canopy-base-height proxy. The bridge is now
`global-fccs-bridge-0.3.0` and the all-row validator exercises 353 usable
fuelbeds across three weather/moisture scenarios. Crown fire still requires
independently supplied canopy bulk density plus a usable base height. FCCS
1000-hour, litter chemistry, duff, live woody structure, and crown fuel are not
silently invented. FCCS rows with supported slow-fuel evidence now carry a
separate, provenance-bearing `fuelPersistenceMinutes` ignition-memory window,
capped at 48 hours. It allows a source cell to wait across fully extinguished
weather intervals without adding unsupported heavy mass or a flame-speed
multiplier to Rothermel. When the source is unavailable the app
reports `Global FCCS unavailable · WorldCover fallback` and continues using
the existing WorldCover crosswalk. See
[`global-fuelbed-source.md`](research/global-fuelbed-source.md).

The server adapter now unwraps the one-band GeoTIFF result before indexing
multi-sample windows; a single-point probe had previously masked this shape
error. The production-parity replay is available as
`npm run validate:progression:fine-hindcast:global` and sends the same dynamic
FCCS definitions, canopy arrays, and water barriers used by localhost. Its
current Rush Creek result is still a deliberate calibration failure: all
16,383 classified cells use FCCS models, 13,912 carry the persistence proxy,
and the corrected 48-hour replay reaches 338 100 m cells (3.38 km²) by the
final observation, with final IoU `0.0661` versus `38.42 km²` observed. This is
a real improvement over the prior one-cell stall, but it is not yet an
accurate hindcast. The remaining gap is regional fuel/moisture, ignition,
spotting, and suppression calibration, not another data-source substitution.

Historical archived weather now carries live herbaceous and woody moisture on
each hourly timeline entry. The replay previously collapsed the full July to
September archive into one late-season live-moisture value, which suppressed
the initial live herbaceous component. Time-varying class moisture is now
interpolated during edge travel; the production-parity replay still exposes
its low score for calibration work.

`npm run validate:progression:fine-hindcast:global` completed successfully
against the public Open-Meteo archive, the global FCCS endpoint, and the direct
ESA WorldCover 2021 v200 10 m COG field. The 128 × 128, 100 m replay uses the
same sixteen-sample-per-cell majority contract as localhost: it classified
16,383 of 16,384 cells, found 1 water cell, 16 water-barrier edges, and 13,912
cells with canopy/persistence inputs. With piecewise weather integration and
the bounded 48-hour FCCS persistence window, the model reaches 338 cells
(`3.38 km²`) by the final observation; final IoU is `0.0661`, mean IoU is
`0.1025`, and the observed final area is `38.42 km²`. A repeat run is
deterministic. This remains a deliberate calibration failure, not an accuracy
claim: the model still lacks regional fuel/moisture calibration, spotting, and
suppression inputs. The older one-cell result came from the pre-persistence
bridge and should not be used as the current baseline.

The earlier homogeneous-TU2 and coarse-mapped ablations remain archived in
the prior handoff notes, but are not comparable to this stricter weather
integration. Three observed growth-stall intervals remain in the historical
record; the current solver does not infer suppression from them. Early
under-growth and later over-growth are separate calibration problems, not a
justification for one global speed multiplier.

The historical dead-fuel replay now passes the previous observation timestamp
into the NFDRS time-lag update. Complete hourly archives produce the same
benchmark, while missing or irregular observations now receive the physically
appropriate elapsed-time response. The direct 10 m COG reader has a mocked
range-read test covering multi-tile grouping and raster-position restoration.

Historical archive timestamps are normalized using the response's declared
`utc_offset_seconds`. This matters because Open-Meteo returns timezone-naive
wall-clock strings when the request asks for `timezone=GMT`; relying on the
host timezone previously shifted the cached Rush Creek forcing by seven hours.
The replay harnesses now carry both `{ row, col }` and `{ x, y }` ignition
coordinates at the solver boundary, preventing a silent fallback to the grid
center. Historical replay now carries pre-ignition observations through the
NFDRS lag state, and network-backed validators request seven days of spin-up;
the interactive path uses the full 35-day history available from its forecast
request so the 100-hour class is not initialized from a short arbitrary slice.

The interactive terrain field now requests a 32 × 32 elevation raster through
bounded 100-point Open-Meteo batches (11 requests for the 32 km field), then
interpolates it onto the 64 × 64 fire grid. This changes the effective source
spacing from roughly 3.5 km to roughly 1 km and preserves request-count and
sample-size provenance in the runtime/cache note. It is still a GLO-90 DSM,
not a 90 m ground-truth DEM; regional terrain remains a future refinement.

Forecast weather now carries a separate hourly dead-fuel moisture timeline.
Each forecast hour advances the same NFDRS time-lag state used for historical
replay, including precipitation wetting, and the worker consumes that timeline
when evaluating arrival-time spread. Wind-only timelines remain available for
compatibility; both timeline forms retain raw 10 m wind so the propagation
solver can resolve WAF against each destination fuel model. Manual wind
overrides use the same per-cell path with the slider speed as the raw reference
wind and still intentionally disable forecast forcing.

The progression harness now accepts `--size` and `--cell-meters`; the
`validate:progression:large` script uses a 256 × 256, 100 m domain. On the
cached archived-weather homogeneous replay, that larger domain avoids the
12.8 km field saturation but still overpredicts heavily (mean IoU `0.1275`,
final IoU `0.0620`, final predicted area `619.23 km²` versus `38.42 km²`).
This is evidence that domain size was not the only error and that suppression,
ignition timing, and calibration must be modeled or excluded explicitly.

The progression harness also supports geometry-driven sizing:

```bash
npm run validate:progression:adaptive -- --weather-file <file>
```

Adaptive mode sizes from the observed perimeter envelope plus an explicit
16-cell margin and records requested/actual dimensions. The cached Rush Creek
run selected 193 × 193, returned mean IoU `0.1517`, final IoU `0.1063`, and
final predicted area `362.03 km²` versus `38.47 km²` observed. The model still
reported `field_boundary_reached`; adaptive sizing is a diagnostic against
truncation, not a solution for physical overgrowth.

`src/lib/uncertainty.js` now provides a seeded, deterministic experimental
ensemble boundary. It perturbs documented wind, direction, moisture, and fuel
availability ranges and returns low/median/high arrival-time and footprint
quantiles. Mapped forest cells also carry explicit TL1/TL3/TU2 alternatives;
the opt-in ensemble samples those model families so forest crosswalk ambiguity
is represented instead of hidden. The worker/UI exposes it only through the
opt-in **experimental sensitivity range** checkbox. The default remains
deterministic, and the quantiles are explicitly labeled uncalibrated rather
than probabilities. The worker transfers the range arrays once on the first
frame and keeps subsequent frames compact.

`npm run benchmark:fire` measured a 128 × 128 core run at `16.90 ms` and an
8-member sensitivity run at `72.83 ms` (`4.31x`) on this machine. This is a
Node core benchmark; browser worker scheduling, rendering, and network data
loading still need a real browser performance pass before increasing member
count.

---

## What's actually in the repo today

### Modules landed (grouped by phase)

Phase 0 (audit only — no code shipped):
- [`docs/phase-0-baseline.md`](phase-0-baseline.md) — architecture map,
  data/unit/coord contract, worker message shapes, findings F1–F8, and
  the Phase 1 proposal.

Phase 1 modules (all TDD, all pure, all opt-in):
- [`src/lib/spatialGrid.js`](../src/lib/spatialGrid.js) — spherical/geodesic
  tangent-plane grid, antimeridian handling, and near-pole-safe mapping.
  10 tests.
- [`src/lib/terrainDerivatives.js`](../src/lib/terrainDerivatives.js) —
  slope + aspect from central finite differences, strict no-data
  propagation. 9 tests.
- [`src/lib/scenarioInput.js`](../src/lib/scenarioInput.js) — versioned
  schema (1.0.0) with source provenance for every field. 15 tests.
- [`src/lib/workerMessageRouter.js`](../src/lib/workerMessageRouter.js) —
  pure dispatch. `update` is a deprecated alias for `configure` (closes
  Finding F8). 8 tests.
- [`src/lib/elevationField.js`](../src/lib/elevationField.js) — added
  `fetchedAt` on every fetch + `isElevationCacheEntryStale`. 4 new tests.
- [`src/workers/fireWorker.js`](../src/workers/fireWorker.js) — refactored
  onmessage to dispatch via the router; warns on deprecated `update`.
- [`src/main.js`](../src/main.js) — added `SIMULATION_ENGINE = 'phase1'`
  feature flag surfaced in metadata; terrain cache now stores
  `{ heights, fetchedAt, source }`; `update` → `configure` at every call
  site.

Phase 2 modules (all TDD, all with citations):
- [`docs/research/land-cover-source.md`](research/land-cover-source.md) —
  transport check that ruled out direct browser access and picked the
  preprocess-into-a-static-PNG path.
- [`scripts/build-landcover-map.mjs`](../scripts/build-landcover-map.mjs)
  + `npm run build:landcover` — one-time preprocessing. Downloads all
  2,651 ESA WorldCover 2021 v200 COGs, reads each one's smallest pyramid
  overview, modal-class downsamples to 90 × 90 per tile, composites into
  a global 10800 × 5400 paletted PNG. Runs in ~14 minutes on a good
  connection.
- [`public/landcover-coarse.png`](../public/landcover-coarse.png) (6.7 MB)
  + [`public/landcover-coarse.json`](../public/landcover-coarse.json)
  (1.8 KB) — ship artifacts committed to the repo so the browser never
  needs to preprocess again. Regenerate only if WorldCover publishes a
  new version.
- [`src/lib/landCoverSource.js`](../src/lib/landCoverSource.js) — runtime
  pixel reader. Pure helpers (`latLonToMosaicPixel`, `classifyMosaicRgb`)
  are Node-testable; the factory takes an injected `imageReader` so the
  browser wires it to a canvas but tests use a fake. 12 tests.
- [`src/lib/fuelModels.js`](../src/lib/fuelModels.js) — versioned table
  (1.0.4) of Scott & Burgan 2005 fuel models plus the Anderson FM10 crown
  correlation fixture: GR1, GR2, GS1, SH2, TL1, TL3, TU2, FM10, plus
  experimental AG1 and NB (non-burnable). Every parameter
  converted to SI at the boundary. Every entry cites its published
  source. 10 tests.
- [`src/lib/landCoverToFuel.js`](../src/lib/landCoverToFuel.js) —
  deterministic crosswalk from WorldCover class code to fuel-model code
  with explicit confidence tier (`medium` / `low` / `experimental`).
  Missing land cover falls back to experimental default with a rationale
  string, per prompt § 10. 10 tests.
- [`src/lib/weatherInputs.js`](../src/lib/weatherInputs.js) — Open-Meteo
  `/forecast` current + 35-day hourly-history and three-day forecast ingest. Unit-labels every value, records wind
  measurement height (10 m) separately from the midflame-adjusted speed,
  applies published standard-model WAFs from RMRS-GTR-192 with a documented
  height conversion to the 10 m weather input, uses the equation fallback for
  experimental/custom models, and retains the explicit 0.4 open / 0.2
  sheltered fallback when structure is unavailable,
  converts compass to math-frame radians in one named place,
  and supplies a 72-hour timeline containing both raw 10 m and adjusted wind
  to the arrival solver.
- Focused weather/moisture tests cover equations, history, rainfall, and parsing.
  It is wired into the phase1 ignition path; explicit wind sliders remain
  intentional overrides.
- `npm run validate:waf` independently checks the RMRS-GTR-266 Table 8
  unsheltered WAF equation for all 13 original standard fuel models; every
  fixture passes within 0.005 absolute error.
- Fire-cell lifecycle now uses each burnable fuel model's Rothermel/Anderson
  residence time (`tau = 384 / sigma`) for physical burnout. The configured
  timestep controls the heating-state sampling window, while accelerated
  worker playback samples short physical flame intervals separately. The
  legacy `burnDurationMinutes` value remains a fallback for custom models
  whose residence time cannot be resolved; this is a physical
  flaming-residence approximation, not yet a full multi-phase
  fuel-consumption/heat-budget model.
- Accelerated worker playback temporally samples cells that physically burned
  between rendered frames, while ordinary `getFrame()` calls keep burned cells
  transparent. This preserves a continuous visual front without changing the
  solver's burned state or footprint metrics.
- `npm run validate:convergence` now compares one-minute and quarter-minute
  solver ticks at matched model times. Arrival times and physical burned masks
  must match exactly; the accepted perimeter tolerance is one raster cell and
  the accepted footprint tolerance is four cells, representing only the
  coarser tick's heating-state sampling band.
- [`src/lib/fuelMoistureModel.js`](../src/lib/fuelMoistureModel.js) — exact
  USFS/NFDRS equilibrium-moisture branches plus a transparent hourly
  1-h/10-h/100-h time-lag estimate. It is explicitly labeled an estimate,
  uses the slider values as initial conditions, and keeps live moisture manual.
  The UI toggle enables it for phase1; disabling the toggle clears the class
  map and returns to the manual dead-moisture control.
- [`src/lib/liveFuelMoistureModel.js`](../src/lib/liveFuelMoistureModel.js) —
  USNFDRS v4-style daily GSI ramps for minimum temperature, maximum VPD,
  day length, and a 28-day precipitation window, followed by separate
  herbaceous/woody live-moisture transforms. Local historical GSI maxima and
  field calibration remain explicit limitations.
- `firePropagation.js` evaluates the supplied forecast at each cell's arrival
  time and integrates changing wind/moisture across each edge in bounded
  10-minute Simpson sub-intervals, so a transition spanning multiple hourly
  records is timed from accumulated travel distance rather than one guessed
  midpoint. A conservative zero-rate interval veto prevents a fire from
  crossing fuel that has reached extinction. A non-zero wind slider
  intentionally disables the forecast timeline so manual scenario controls
  remain authoritative.
- The localhost Vite server exposes an optional ESA WorldCover 2021 10 m
  range-read adapter. The browser requests sixteen samples inside each 64 x
  64 local cell through ordered, bounded `/api/landcover/fine-field` batches,
  then majority-votes the reassembled result before building the fuel field;
  each batch has a small retry budget, while persistent incomplete data keeps
  the explicit coarse-source fallback. A failed batch no longer discards
  successful native samples: partial fields retain their valid samples and
  use the coarse mosaic only for missing cells, with the exact sample and
  batch coverage reported in metadata.
  Edge checks retain the nearest native sample instead of collapsing back to
  that majority, so narrow rivers and coastlines can block a transition even
  when land dominates the cell. The coarse global PNG remains the static-build
  fallback. Active metadata distinguishes `WorldCover 10 m COG · 16
  samples/cell` from the `Coarse WorldCover mosaic` path. Partial native
  coverage is labeled with its percentage and successful/total batch count;
  the coarse path is used only for missing cells.
- Fine cell aggregation now preserves valid-sample burnable fraction. The
  majority WorldCover class still chooses the fuel identity, while the
  sampled burnable fraction scales `fuelLoadScale` and is summarized in field
  metadata. This reduces mixed-cell overprediction without pretending to be
  biomass calibration.
- [`src/lib/waterAuthority.js`](../src/lib/waterAuthority.js) — tri-state
  water evidence contract. ESA WorldCover fine/coarse classes and Copernicus
  fractional water are authoritative; the rendered Earth texture is used as a
  fallback, propagation-edge veto, or conservative veto when no fine/fractional
  classified source is available. Fine classified land still prevents a
  basemap color from overriding an ignition decision, while an explicit
  fractional-land sample can suppress a false-positive edge veto.

Phase 3/4 integration landed:
- [`src/lib/surfaceSpread.js`](../src/lib/surfaceSpread.js) — pure
  Rothermel-style surface-spread kernel with explicit source-unit
  conversions, reaction intensity, propagating flux ratio, moisture and
  mineral damping, wind/slope factors, directional rates, and warnings.
  Thirteen focused tests cover the required monotonic, domain, and equation
  properties, including the published TU2 BehavePlus fixture.
- The surface kernel now exposes heat per unit area and computes Byram
  fireline intensity from the SI relationship `HPA * rate / 60`; a propagation
  regression asserts that the same Rothermel heading rate determines physical
  cell travel time. The published TU2 fixture remains an intensity check, not
  an independent rate-of-spread reference because Andrews (2014) does not
  publish rate values for that figure.
- [`src/lib/fireEllipse.js`](../src/lib/fireEllipse.js) — source-backed
  elliptical transformation from the local Rothermel heading/backing rates
  to each propagation azimuth. The arrival-time solver uses this for every
  edge, while preserving the kernel's heading and backing endpoints.
- [`src/lib/fuelModels.js`](../src/lib/fuelModels.js) — `getFuelModel()` now
  exposes the standard Rothermel particle density and mineral-content
  properties that were previously only implicit in comments.
- [`src/lib/firePropagation.js`](../src/lib/firePropagation.js) — first
  arrival-time propagation solver using Dijkstra relaxation over the local
  grid. It consumes the surface kernel for each cell-to-cell edge, respects
  non-burnable barriers, derives terrain slope/aspect on the same raster,
  and exposes compatible frames/metrics for the worker. It now reports whether
  a run ended because reachable fuel/barriers were exhausted, the finite local
  field boundary was reached, or the interactive time horizon hid additional
  reachable cells; the latter two are not labeled as natural fire exhaustion.
- [`src/lib/suppressionConstraints.js`](../src/lib/suppressionConstraints.js)
  — optional time-aware suppression/containment barrier contract. Callers can
  provide neighboring cell edges and the model minute at which each edge
  becomes unavailable; the propagation engine reports configured and actually
  blocked transitions and can terminate with `suppression_reached`. The
  default click workflow supplies no suppression data, so this is an explicit
  integration point rather than an invented containment assumption.
- `createPerimeterContainmentBarriers` and
  `npm run validate:progression:containment -- --weather-file <cached-json>`
  provide an opt-in historical data-assimilation diagnostic. It converts the
  first observed stall perimeter into eight-neighbor barriers from the stall
  start, reports the constrained replay separately, and explicitly warns that
  observed geometry is not part of the normal click forecast.
- [`src/lib/fireFieldInputs.js`](../src/lib/fireFieldInputs.js) — builds a
  location-specific fuel-model code for every propagation cell. Unsupported
  and uncovered cells are strict non-burnable barriers; the clicked cell is
  explicitly preserved as the ignition source.
- [`src/lib/phase1Runtime.js`](../src/lib/phase1Runtime.js) — resolves live
  weather values versus explicit slider overrides during worker reconfigure,
  including compass-to-math wind direction and slope controls.
- [`src/lib/simulationLifecycle.js`](../src/lib/simulationLifecycle.js) — keeps
  settlement and globe auto-rotation decisions pure and testable.
- `spatialGrid.js` and `elevationField.js` now use spherical/geodesic local
  coordinates, including near-pole tests, instead of stretching longitude
  with a cosine approximation.
- Independent source audit corrected several SI conversions against the
  published Scott & Burgan Table 7 rows, including live SAV/load values in
  GR1/GR2/GS1/SH2 and dead-load values in SH2/TL1/TL3. The audit is locked by
  a focused reference-row test in `fuelModels.test.js`.
- The current kernel has equation/intermediate fixtures and monotonic tests,
  plus a published BehavePlus TU2 fireline-intensity fixture within 5% at
  four wind speeds. It accepts separate dead/live moisture controls, applies
  surface-area-weighted characteristic moisture, and calculates live moisture
  of extinction from the dead/live mix. The kernel and propagation solver now
  accept explicit measured moisture for dead 1-h/10-h/100-h classes and live
  herbaceous/woody classes, falling back per class to the category controls.
  The propagation solver also applies a tested fire ellipse to crosswind and
  backing edges. Automated weather estimation now supplies the dead classes;
  direct global fuel-moisture observations, local GSI calibration, and a
  first public historical-perimeter fixture now exist; calibrated hindcast
validation remains outstanding.

An independent public perimeter baseline is now available with:

```bash
npm run validate:perimeter:independent
```

The Deer Fire (2016) GPS-ground perimeter is evaluated with the same
uncalibrated homogeneous TU2 diagnostic setup. It reports IoU `0.6064`, F1
`0.7550`, and centroid error `0.237 km` at the four-day containment time. The
source does not publish a verified ignition point, so the fixture records an
explicit center-coordinate assumption; these numbers are evidence of a
second reproducible check, not an operational accuracy claim.

The stronger archived-weather variant is available as
`npm run validate:perimeter:independent:archive`. It reports IoU `0.3628`, F1
`0.5325`, and predicted area `17.04 km²` versus `6.36 km²` observed. This
overprediction is retained as evidence that archived weather alone cannot
replace regional fuels, local moisture observations, or containment inputs.
- Fireline intensity now follows the USFS/Anderson residence-time form using
  reaction intensity, rate of spread, and `384 / SAV`, with an explicit SI
  conversion and a focused regression test.
- Water and no-data classes are hard non-burnable barriers at both the
  crosswalk and per-cell field-builder boundaries. Burned cells remain in
  metrics but leave the active-fire render frame; the worker stops once no
  active or future arrivals remain, and the globe resumes auto-rotation only
  after the fire has settled or been reset.
- The water mask samples the rendered Earth texture at 4096 × 2048 and is
  applied to every propagation-cell center before land-cover classification.
  The WorldCover 2021 class-80 permanent-water mask is now also exposed as a
  hard data barrier and used for ignition checks; the ignition override cannot
  make either mask burnable. WorldCover is still a ~3.3 km modal mosaic, so
  small or ambiguous coastal features are additionally checked at the three
  quarter-points of every local cell edge. Those water intersections are sent
  to the worker as a symmetric blocked-transition mask, so fire cannot cross a
  narrow water strip merely because both adjacent cell centers are land.
  Propagation edges also apply a conservative visible-water veto when a fine
  cell majority says land; ignition clicks retain classified-land precedence.

### Historical validation status

- The first final-perimeter harness remains available as `npm run validate:perimeter`.
- An independent Deer Fire perimeter baseline is available as
  `npm run validate:perimeter:independent`; it is documented with an explicit
  center-ignition assumption because the source record does not publish an
  ignition point.
- `npm run validate:progression` now scores 17 timestamped Rush Creek observations
  against one arrival field and prints per-observation plus aggregate metrics.
- `npm run validate:progression:archive` replays Open-Meteo archived hourly wind
  and dead-fuel moisture; `--weather-file` supports repeatable offline runs.
- `npm run validate:progression:mapped` exercises the shipped WorldCover PNG,
  crosswalk, and water barriers; `npm run validate:progression:hindcast` combines
  those inputs with the archived weather replay.
- The current progression run is deliberately diagnostic. It uses flat TU2 and
  calm weather, so it expands beyond the 128 x 128, 100 m window during the
  multi-week record. It does not yet represent a calibrated historical hindcast.
- The cached Rush Creek archive replay is now intentionally conservative under
  piecewise weather integration: the mapped tree-litter field extinguishes
  before the first neighboring cell. This exposes the need for direct regional
  fuel-load and moisture calibration, plus independent ignition-time checks,
  before historical IoU can be used as an acceptance target.
- The interactive app now applies a documented 72-hour propagation horizon so
  the visible scenario remains bounded; historical validation passes `Infinity`
  when replaying multi-week perimeter series. Run metadata distinguishes a
  horizon or field-boundary stop from actual exhaustion.
- Historical progression validation supports a larger explicit domain via
  `npm run validate:progression:large -- --archive --weather-file <file>` so
  long-running fires can be separated from artificial field-boundary effects.
- `npm run validate:progression:adaptive -- --weather-file <file>` derives a
  domain from observed geometry plus margin and records model termination
  provenance; it is a diagnostic against boundary truncation, not a fitted
  forecast-domain selector.
- The GPU fire overlay now consumes the same 4096 x 2048 water mask used for
  CPU land/water checks and retains the visible blue-pixel test as a second
  hard veto after mask loading, preventing an auxiliary-mask orientation or
  upload mismatch from showing fire over visible water.
- The WorldCover crosswalk now carries a `fuelLoadScale` prior into the
  Rothermel kernel. Sparse, wetland, mangrove, moss, and agricultural classes
  no longer inherit a full-density fuel bed by default; the scale is explicit
  and labeled heuristic rather than presented as a local measurement.
- The mapped Rush Creek replay reports the field as 100% WorldCover tree cover.
  That is a known resolution limit of the approximately 3.7 km global mosaic,
  not evidence that the real fire site was homogeneous. A finer regional fuel
  source is the next global-accuracy upgrade.
- The weather contract retains raw 10 m wind and the propagation solver
  applies fuel-bed depth and coarse tree/mangrove shelter per destination cell.
  Cross-cell travel now integrates the Rothermel rate in bounded 10-minute
  Simpson sub-intervals across each supplied weather breakpoint, with a
  conservative zero-rate veto when fuel reaches extinction mid-transition.
  The clicked-cell adjustment remains as a compatibility fallback and metadata
  baseline; callers without raw wind retain the prior midflame-only behavior.
- Remaining high-value work is wiring authoritative suppression observations
  into historical replay, larger or adaptive validation domains, additional
  independent fires with observed ignition times, and direct regional
  fuel/moisture calibration before defining acceptance thresholds. The
  propagation contract for time-aware barriers now exists, but no fire is
  silently treated as suppressed.

### Feature flag (Phase 1)

```js
// src/main.js
const SIMULATION_ENGINE = 'phase1'; // or 'legacy' for comparison
```

- Sent to the worker in the start message. The worker now branches on it;
  `phase1` uses the rate-based solver while `legacy` remains unchanged.
- Metadata line reads `Rothermel · phase1 · 1 min/tick` today.
- The interactive local field is 64 × 64 cells at 0.5 km per cell (32 km
  across). The worker advances multiple one-minute ticks per render frame
  for usability; this is playback acceleration, not a physics-rate change.
- The globe overlay is presentation-enlarged and independently masked against
  the Earth texture, so its visual glow cannot paint visible water.
- The phase1 branch is the live default: `'legacy'` stays the current
  cellular model for controlled comparison, while `'phase1'` runs the
  location-aware Rothermel kernel and arrival-time solver.

### Dev-only dependencies

Added in Phase 2 with the user's explicit approval (per prompt § 8):

```json
"devDependencies": {
  "geotiff": "^3.0.5",   // Node-side COG decoding for build:landcover
  "pngjs":   "^7.0.0"    // Node-side PNG write for build:landcover
}
```

Neither ships in the browser bundle. Both are only used by
`scripts/build-landcover-map.mjs`.

---

## Findings register

Living log — add new ones as they come up. Don't silently close old
ones; note when and where they were resolved.

### From Phase 0 audit (documented in [`phase-0-baseline.md`](phase-0-baseline.md) § 3)

| # | Finding | Status | Resolution |
|---|---|---|---|
| F1 | `cellSizeKm` inconsistency: worker default 4, metrics default 1 | ✅ resolved | Worker now passes the configured cell size or lets the active engine use its own authoritative default; phase1 area/distance metrics no longer fall back to 4 km |
| F2 | Wind direction is math-axis convention, labeled as compass | ✅ resolved (Phase 3) | phase1 consumes `compassToMathRadians`; explicit slider wind overrides weather wind with the same convention |
| F3 | No wind measurement height / midflame adjustment | ✅ resolved (Phase 2/4) | `weatherInputs.windToMidflame` applies fuel-bed-aware RMRS-GTR-266 WAF when depth is known, with explicit legacy fallback labels; measured LANDFIRE CH/CC now refine sheltered WAF when the 10 m reference height is valid, measured global canopy height refines mapped tree/mangrove shelter, and measured LANDFIRE CBH/CBD gate the guarded crown-fire path in CONUS |
| F4 | Real elevation fed through a hack term, not proper slope/aspect | ✅ resolved (Phase 1) | `terrainDerivatives.js` computes slope + aspect; Phase 3 must consume it in the kernel |
| F5 | Three arbitrary fuel presets, no fire-behavior fuel-model table | ✅ resolved (Phase 2) | `fuelModels.js` is the versioned SI-unit table with citations |
| F6 | Heat-accumulation spread, not rate-of-spread | ✅ resolved (Phase 3) | The app default now uses the arrival-time Rothermel solver; legacy remains opt-in for comparison |
| F7 | Elevation cache entries have no `fetchedAt` | ✅ resolved (Phase 1) | Cache now stores `{ heights, fetchedAt, source }` |
| F8 | Worker `update` message secretly restarts | ✅ resolved (Phase 1) | `update` renamed to `configure`; `update` kept as deprecated alias that emits `console.warn` |

### New in Phase 2

| # | Finding | Status | Notes |
|---|---|---|---|
| F9 | 4 km modal-class mosaic smears coastlines and small features | 🟡 coarse fallback documented; local fine path landed | Called out in [`land-cover-source.md`](research/land-cover-source.md) "What you actually lose". The localhost Vite path now reads the authoritative ESA WorldCover 2021 10 m COG by range request; static deployments still use the committed coarse mosaic unless they provide the same proxy. |
| F10 | `weatherInputs.js` written but not yet wired into `main.js` | ✅ resolved (Phase 3) | phase1 fetches Open-Meteo current + hourly history at ignition, consumes midflame speed + math-frame direction, and can consume the NFDRS-derived dead-moisture map; explicit wind/moisture toggles remain overrides |
| F11 | Cropland → `AG1` is experimental; real ag residues vary by crop and season | 📓 documented, acceptable | Explicit confidence label in [`landCoverToFuel.js`](../src/lib/landCoverToFuel.js). Real-crop model can land any time as a Phase 2.5 addition. |
| F12 | Mangroves / wetlands mapped to low-confidence stand-ins | 📓 documented, acceptable | Real moisture regimes usually keep them below ignition anyway; deferring to the moisture-of-extinction gate in the eventual kernel is correct behavior. |
| F13 | Rothermel directional response is not yet a full validated fire ellipse | ✅ resolved for this milestone | `fireEllipse.js` applies the source-backed ellipse transform to the arrival-time solver and preserves the local heading/backing rates. Historical perimeter validation is still outstanding. |
| F14 | Center-only water sampling could let fire cross narrow water strips | ✅ resolved for this milestone | `fireFieldInputs.js` samples sub-cell edge points and `firePropagation.js` rejects flagged transitions in both directions. |
| F15 | Water/no-data cells could appear burnable in the local field | ✅ resolved | WorldCover water and no-data are explicit `NB` crosswalk rows; the field builder also honors `landCover.burnable === false`, and browser ignition rejects non-burnable clicked fuel. |
| F16 | Burned cells visually persisted as active fire and settlement did not gate globe motion | ✅ resolved | Burned cells render transparent while remaining in burned-area metrics; settlement requires zero active and future arrivals; auto-rotation is disabled while `fireRunning`. |

---

The field builder now reports crosswalk confidence for every classified
propagation cell. The FIELD QUALITY metadata line distinguishes complete
coverage from experimental or unclassified cells and counts low-confidence
mappings, so the clicked pixel cannot hide a weak part of the 32 km domain.
This is tracked as finding F17 and is a data-quality diagnostic, not a
calibrated forecast interval.

Copernicus Global Dynamic Land Cover 100 m is the strongest openly documented
optional evidence layer because it supplies global fractional tree, shrub,
grass, crop, bare, moss/lichen, and permanent-water cover. Its documented BYOC
delivery requires a free Data Space account, so it remains an optional runtime
dependency. The adapter is implemented behind the local Vite server:
credentials are read only from COPERNICUS_CLIENT_ID and
COPERNICUS_CLIENT_SECRET, point and raster responses carry source/probability
metadata, and the no-credential response is explicit. The crosswalk uses the
documented 50% combined permanent-plus-seasonal water threshold as a hard
barrier and, when vegetation fractions are available, selects the dominant
vegetation family per cell and scales fuel availability by mapped vegetation
cover. That fuel adjustment is explicitly low confidence and is not a
calibrated global fuel-load measurement.

## Where the current-app UI signals what's real

- **`SCENARIO BASIS` panel `MODEL` line** — reads `Rothermel · phase1 · 1 min/tick`. The middle token is the active engine flag.
- **`FUEL` line** — composites the selected preset with the clicked WorldCover crosswalk: e.g. `Brush · WC Grassland → GR2 (medium)` or adds `100 m fractions` when the optional Copernicus evidence path is active. The worker additionally classifies every local propagation cell.
- **`TERRAIN` line** — reads `GLO-90 loaded`, `Cached GLO-90`, `Synthetic fallback`, `Ocean · no ignition`, etc.
- **Bottom-of-panel disclaimer** — `ROTHERMEL SURFACE MODEL · NOT A FORECAST`. Do not remove until prompt § 15 "definition of done" is met.

---

## How to run the baseline verify pass

```bash
   npm test           # → 217 pass
   npm run build      # → clean, ~623ms, chunk-size warning is Three.js
npm run validate:perimeter # → deterministic public Reservoir baseline report
npm run dev        # → http://127.0.0.1:5174
```

Manual smoke (matches what Phase 0 documented, extended for Phase 2):

1. Wait for the loading pill to disappear.
2. Console should log `[landcover] loaded ESA WorldCover 2021 v200 …`.
   The scenario metadata should show `WorldCover 2021 + Earth 4k` under Water.
3. Click any ocean pixel → panel shows the ocean name and
   `WATER SURFACE · NO IGNITION`; no worker start.
4. Click any land pixel:
   - Panel shows nearest place + DMS coordinates + ember marker
   - Worker starts, model time and burned area advance
   - `FUEL` line updates to include the WorldCover-derived crosswalk
   - Console logs `[landcover] <class name> (WC <code>) → <fuelCode> (<confidence>)`
5. Change any slider → confirm the `configure` message reaches the worker
   without a `deprecated` warning.

---

## Next phase: data wiring and validation

Phase 3 charter (from prompt § 14):
> Implement the pure Rothermel-style local kernel with citations and
> intermediate outputs. Test equations and monotonic properties against
> hand-calculated fixtures or trusted reference outputs. Add a debug
> mode that can inspect one cell's inputs and intermediate terms.

### Completed entry point

Before writing a single line of physics:

1. **Fetch the primary sources** referenced in prompt § 16 and cite them
   in code comments. Do not copy equations from memory (prompt rule 5).
   - Rothermel (1972), USDA INT-115 — the original paper.
   - Andrews (2018), *The Rothermel surface fire spread model and
     associated developments: a comprehensive explanation* — RMRS-GTR-371,
     the current USFS reference.
   - Scott & Burgan (2005) — RMRS-GTR-153 — the fuel-model table this
     project already ships in `fuelModels.js`.
2. **Add `src/lib/surfaceSpread.js`** — done as the first Phase 3 slice.
3. **Test directional monotonicity** — done for the current projected
   directional approximation; this is not yet a validation claim for a
   full operational fire model.
4. **Wire the real location inputs before enabling `phase1` by default.**
   Done for the current milestone: weather, elevation, geodesic grid mapping,
   and a per-cell WorldCover fuel field now reach the worker.
5. **Validate the propagation solver further.** Compare smaller timesteps,
   check diagonal-distance behavior, and replay a time-stamped historical
   perimeter series. A first public final-perimeter fixture and scoring
   harness now exist, but calibrated hindcast validation remains before
   calling the engine operationally accurate.
6. **Improve moisture provenance and validation.**
   The kernel accepts explicit size-class values, and the default UI now
   derives dead 1-h/10-h/100-h values from hourly Open-Meteo weather using an
   NFDRS-derived estimate and live herbaceous/woody values from the NFDRS v4
   GSI structure. The next accuracy step is direct station/remote-sensing
   fuel-moisture observations, local GSI calibration, and time-stamped
   historical perimeter replay before calling the engine operationally
   accurate.

### Things Phase 3 must reach into

- `scenarioInput.js` fuel + wind + moisture + slope blocks — this is the
  contract the kernel reads from.
- `weatherInputs.js` for the midflame speed and math-frame direction —
  wire it in when you actually consume it, not before.
- `terrainDerivatives.js` for slope magnitude and aspect vector.
- `fuelModels.js` for the parameter set the kernel needs. Every field on
  every model was chosen with Rothermel in mind.

### Stop conditions to respect

If you cannot verify an equation against Rothermel or Andrews, stop
and ask. If you cannot reproduce a hand-calculated fixture, stop and
ask. If a monotonic-property test fails and the "fix" is a coefficient
you invented, stop and ask. The prompt's whole point is that we do
not paper over gaps with tuning knobs.

---

## Codex regional benchmark update: 2026-07-24

The diagnostic perimeter evaluator now runs six frozen public cases: four calibration cases and two untouched holdouts. Four ArcGIS snapshots are bundled in `src/lib/officialBenchmarkFixtures.js` with source-response and geometry hashes. The Oregon Gulch ArcGIS record contains same-winding disjoint rings and is normalized to a `MultiPolygon` before rasterization.

Verification: `npm run validate:hackathon`, `npm run validate:regional-offline`, and `npm run calibrate:hackathon` all pass. The default six-case suite reports mean IoU `0.3084645982`, mean F1 `0.4406033446`, and worst-case IoU `0.0443956044` on Oregon Gulch. The calibration sweep tests 48 parameter combinations on the four calibration cases only; its untouched two-case holdout check reports mean IoU `0.3758546832`. These are diagnostic metrics only because every case still uses homogeneous TU2, flat terrain, calm synthetic weather, no suppression/spotting, and estimated ignition for the new fixtures.

The live LANDFIRE CONUS WCS probe remains blocked by upstream HTTP 502/empty response. Do not describe the benchmark as operationally accurate or nationally representative.

## Bugs / smells the next session should tidy up

None known. If you find one, add a finding row above and either fix
it in a clearly scoped commit or leave it open for a later phase.

## Files that would trip up a fresh reader

- **`src/main.js` is big (~1300 lines)** — half UI wiring, half Three.js
  scene setup. Search-first (`grep -n`) rather than reading start-to-end.
- **`src/lib/fireSimulation.js` is the legacy model** — do not "improve"
  it. If a change belongs in Phase 3, put it in `surfaceSpread.js` +
  `firePropagation.js`, not here.
- **`src/lib/coordinateMath.js` has an FBX-specific longitude offset
  (`-90`)**. This is right for the current Earth mesh; do not delete it
  without swapping the mesh.
- **`public/landcover-coarse.png` is committed** (6.7 MB) because
  regenerating it takes ~14 minutes of downloads. Do not remove it
  casually.
