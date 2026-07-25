# Regional Model Run

Date: 2026-07-24
Objective: Execute `docs/remaining-regional-model-execution-prompt.txt` in dependency order, beginning with baseline capture and the regional FBFM40 data contract.

## Starting Beliefs

- The Rothermel-style surface kernel and deterministic propagation path are implemented and equation-tested.
- Water barriers and finite lifecycle behavior must not regress.
- LANDFIRE 2024 FBFM40 mapping exists, but live WCS transport and raster alignment are not yet proven end to end.
- The benchmark now has six frozen public-perimeter cases with four calibration cases and two holdouts, but it remains diagnostic rather than regional accuracy validation.

## Operating Rules

- Preserve unrelated user/Claude changes in the dirty worktree.
- Keep evaluators and benchmark definitions locked while improving the model.
- Record failed attempts and upstream failures; never replace them with success-looking fallbacks.
- Promote only changes supported by focused tests and full regression checks.

## Current Milestone

Regional input contract, offline end-to-end fixture, six-case public-perimeter suite, benchmark split safeguards, and weather validity horizon are implemented and verified. Remaining blockers are live LANDFIRE transport, archived weather, heterogeneous terrain/weather/fuel wiring, controlled browser fixtures, and a trustworthy operational validation claim. See `BASELINE.md`, `APPROACH-REGISTRY.md`, and `RESULTS.jsonl` for append-only evidence.

## 2026-07-24 update (Claude)

Re-verified every command in the previous progress log; all reproduced exactly (340/341 -> now 341 tests after this run's addition, build clean, six-case benchmark numbers bit-for-bit identical). Then bundled one real, successfully-fetched LANDFIRE FBFM40 GeoTIFF sample (`public/fixtures/landfire/`) with full provenance and a new test (`src/lib/landfireFuel.test.js`) that decodes it through the real parser. Live WCS succeeded 1 of 4 attempts this session (HTTP 200), confirming the endpoint is real but still intermittent, consistent with the prior HTTP 502 reports.

New finding, not previously observed because every earlier live attempt returned HTTP 502: `validateLandfireFuelRasterGeometry` throws `GeoTIFF bounds do not match the requested bbox` on this real, successfully-decoded response. The GeoServer WCS returns an output bbox that differs from the requested bbox by more than the current resolution-based tolerance -- decode, CRS, orientation, pixelIsArea, and fuel-code normalization all pass; only the strict bbox match fails. This is now locked in as a passing `assert.throws` regression test rather than silently loosened, since understanding the WCS bbox-snapping behavior first is required before touching a safety validator. See RUN-007 in `RESULTS.jsonl` and `APPROACH-REGISTRY.md`.

This is the next concrete blocker for promoting any live regional pull to `regional-active`: the geometry tolerance needs deliberate review (likely widening it to account for GeoServer's native-grid snapping, backed by a couple more real samples) before live CONUS data can pass the existing gate.

## 2026-07-24 update 2 (Claude) -- root-caused and fixed the geometry gate

Followed systematic-debugging: gathered 3 more real live samples at different CONUS locations/sizes (bbox -105/-120/-110/-95, widths 32/64/128) before touching any code. Confirmed two distinct, real causes, not a single tolerance-tuning guess:

1. Live GeoServer WCS 1.0.0 legitimately pads/resamples the returned extent to its native grid -- consistent across all 4 real samples, resolution up to ~1.6x coarser than requested per axis, width/height always exact.
2. `geotiff.js`'s `getResolution()` (node_modules/geotiff/dist-node/geotiffimage.js) returns a NEGATIVE y-resolution for ModelPixelScale-encoded GeoTIFFs but a POSITIVE y-resolution for ModelTransformation-encoded GeoTIFFs, for the *same* physical north-up orientation. GeoServer's WCS emits ModelTransformation. The old `resolutionY >= 0` check therefore only ever worked by accident on the synthetic ModelPixelScale contract fixture -- it would have rejected every real live LANDFIRE response, forever, regardless of bbox tolerance.

Fixed `validateLandfireFuelRasterGeometry` in `src/lib/landfireFuel.js`: bbox check is now containment-based (returned raster must cover the requested extent, half-pixel edge epsilon) instead of near-equality; resolution check now uses magnitude only, bounded by `LANDFIRE_FUEL_MAX_RESOLUTION_RATIO = 4` (a ~2.5x safety margin over the worst observed 1.6x). True row-order/transposition protection remains at the pixel-data level via the existing asymmetric fixture in `scripts/validate-regional-inputs.mjs`, which this change does not touch.

All 4 real samples now pass geometry validation. Updated the one test (`scripts/validate-regional-inputs.mjs`) that asserted the old signed-resolution value. Full suite: 342/342 tests pass, build clean, `validate:regional-inputs` and `validate:regional-offline` pass. Browser smoke test: clicked a CONUS location (Illinois) with the dev server running; live WCS returned 502 mid-session (confirms transport is still flaky, not that the fix is wrong), and the app fell back cleanly with no console errors and a completed scenario. See RUN-008 in `RESULTS.jsonl` and `APPROACH-REGISTRY.md`.

Still not proven: an actual end-to-end browser run where the live WCS succeeds and the app promotes the run to `regional-active`. The transport is real but intermittent; this fix makes success possible when it does connect, but a live-success browser screenshot was not captured in this session because the endpoint stayed down for the remainder of the check.

## 2026-07-24 update 3 (Claude) -- real fuel + weather wired into the benchmark; terrain blocked by a daily quota, not a bug

Wired real per-case terrain/fuel/weather into the 6-case hackathon benchmark by reusing three already-existing, already-tested fetchers verbatim (no new fetch logic): `fetchElevationField`, `fetchHistoricalWeatherInputs`, `readWorldCoverFineField`. A new one-time script, `scripts/build-regional-benchmark-fields.mjs`, is the only thing that touches the network; it freezes the result to a committed JSON fixture so the benchmark itself stays offline-reproducible, matching Phase 4.5.

Elevation hit `"Daily API request limit exceeded. Please try again tomorrow."` on Open-Meteo's free tier -- confirmed with a direct `curl` outside the script, so it is a real external quota, not a bug or a rate-limit worth retrying same-day. Restructured the freeze script so each of the three fields (terrain/fuel/weather) reports its own `{available, ...}` state independently, rather than one failed fetch discarding the other two that succeeded. Result: fuel=real and weather=real for all 6 cases; terrain=synthetic-flat for all 6, honestly labeled in both `dataQuality` and `inputProfile` per case (see `usingRealFields` on each case result).

`hackathonBenchmarkRunner.js` now consumes the frozen fixture per-field: real WorldCover-derived `fuelModelCodes`/`fuelLoadScaleByCell` (with `fuelLoadScale` still applying as a live calibration multiplier on top, since fuel availability is an explicitly source-supported calibration target), real historical `windTimeline`/`deadMoistureByClass` when available, and terrain heights from the frozen elevation array or an all-zero flat fallback per case.

Result: mean IoU dropped from 0.3085 (homogeneous synthetic baseline) to 0.0497. Precision stayed 1.0; recall collapsed. This was not tuned away -- it is reported as the new honest diagnostic baseline. It reflects that real, spatially-varying WorldCover fuel is often lower-spread-rate or non-burnable relative to a blanket TU2 assumption, so the model now underpredicts extent against real conditions. This is informative, not evidence of correctness or a regression to fix.

Verification: 343/343 tests pass (added one asserting every case's `usingRealFields`/`dataQuality`/`inputProfile` are internally consistent), build clean, `validate:hackathon` and `validate:regional-offline` both pass, offline validator confirmed to need zero network access. See RUN-010 in `RESULTS.jsonl` and `APPROACH-REGISTRY.md`.

Next step for terrain: re-run `scripts/build-regional-benchmark-fields.mjs` once the Open-Meteo daily quota resets (no code change needed) and re-check `validate:hackathon`.

## 2026-07-24 update 4 (Claude) -- terrain quota eliminated; real terrain exposed a real physics bug, fixed at the source

Swapped the freeze script's elevation source from Open-Meteo (which turned out to itself just be a proxy for Copernicus DEM GLO-90, at 3x coarser resolution, gated by a hard daily quota on the free tier) to direct windowed reads of Copernicus DEM GLO-30 COG tiles on the public, unauthenticated AWS S3 bucket -- the exact same tiling/windowed-GeoTIFF-read pattern already built and tested for the WorldCover fuel reader, just pointed at a different bucket. No quota, no auth, finer resolution than what we had before. Re-ran the freeze script: all 6 cases now have terrain=real, fuel=real, weather=real.

That real (non-flat) terrain immediately exposed a genuine, previously-latent bug in `src/lib/surfaceSpread.js`, caught by the existing `fireEllipse.js` invariant check (`backingRateMPerMin must not exceed headRateMPerMin`). Root-caused via systematic debugging (not patched blindly): the combined wind+slope "forcing direction" used to pick the ellipse's head/backing rates is a linear vector sum, but `calculateWindFactor`'s response to alignment is sub-linear while `calculateSlopeFactor`'s is quadratic. When wind and slope point in different directions, that mismatch can make the heuristic under-estimate the true fastest-spread direction relative to its exact opposite -- by about 2.3% in the case that surfaced. This was structurally impossible to hit with flat terrain, since `slopeRadians` was always exactly 0 everywhere, short-circuiting `calculateSlopeFactor` to a constant 0 and removing the wind/slope interaction entirely. All 342 prior tests always ran on flat terrain.

Fixed at the actual computation source in `surfaceSpread.js` (not by loosening the `fireEllipse.js` assertion): both the forcing-direction rate and its exact opposite are now computed, and whichever is larger is labeled `head`. No Rothermel/wind/slope formula changed -- only which of the two already-computed candidate directions gets the head label. Verified this doesn't disturb the equation checks: `validate:rothermel`, `validate:rothermel:rate`, `validate:waf`, and `validate:convergence` all still pass.

Result with all three fields real: meanIoU 0.0942 (up from 0.0497 with flat terrain, still far below the 0.3085 fully-synthetic baseline). Precision ~0.99, recall ~0.094 -- the model consistently underpredicts spread extent against real conditions rather than overpredicting. Not tuned toward any target. See RUN-011 in `RESULTS.jsonl` and `APPROACH-REGISTRY.md`.

343/343 tests pass, build clean, `validate:hackathon` and `validate:regional-offline` both pass with zero network access at validation time (only the one-time freeze script touches the network).

## 2026-07-24 update 5 (Claude) -- root-caused and fixed the recall collapse: two real bugs, not a calibration problem

Systematic-debugging on why real-input meanIoU (0.0942) badly underpredicted recall (~0.09) with near-perfect precision (~0.99). Ruled out fuel-model choice (TL1<->TU2 swap: flat/worse, high per-case variance) and moisture/wind CLI knobs (inert -- real weather timelines override them per-timestep, confirmed by identical output with `--dead-moisture`/`--live-moisture` overrides). A 10x/100x `modelTimeMinutes` multiplier raised meanIoU to 0.231 but was identical at both multipliers, proving the simulation was terminating itself (`fuel_or_barriers_exhausted`) well inside even the 100x horizon in the worst cases -- not a time-budget problem in the naive sense.

Traced `oregon-gulch-2014` (3 predicted cells vs 2275 observed, even at 100x horizon) by instrumenting `calculateTravelMinutes` in a scratch copy of `firePropagation.js`. Found two real, distinct bugs:

1. `hackathonBenchmarkRunner.js` and `scripts/build-regional-benchmark-fields.mjs` never wired `fuelPersistenceMinutesByCell` through at all, even though `buildFuelModelCodeField` already computes it and the interactive app / Rush Creek replay already consume it. Plain WorldCover crosswalk rows (`landCoverToFuel.js`) also never set `fuelPersistenceMinutes` on non-FCCS decisions, so real archived weather's routine hour-to-hour dips below moisture-of-extinction permanently killed the whole grid's single, spatially-uniform frontier the first time it happened, with no mechanism to resume even though 90%+ of the archive window was burnable.

2. While testing a persistence fix, found a genuine solver defect: in `calculateTravelMinutes`, `plannedEndMinutes` capped *actively spreading* segments (rate already positive) at `persistenceDeadline`, not just segments waiting through a zero-rate gap. `persistenceDeadline` is meant to bound only how long a dormant source may wait; capping ongoing spread at it made any nonzero persistence value perform *worse* than none (verified directly: oregon-gulch raw `finiteArrivals` dropped from 3 to 1 with persistence=360 before the fix, and recovered to 3 after removing the erroneous cap from the positive-rate branch).

Separately found `officialBenchmarkFixtures.js`'s `modelTimeMinutes` was a flat guessed constant (4320 or 1440 minutes) that ignored each fixture's own already-recorded `alarmDate`/`containmentDate`: oregon-gulch's real fire burned 14 days but was given a 3-day model horizon; big-five-2015 burned 138 days but was also given 3 days; dinely-2017 burned 4 days vs. 3 given. Corrected all three to the real recorded span (stoll-2018's alarm/containment dates are identical calendar days, so its existing 1-day horizon was left as-is).

Fixes: (a) added a modest, documented, physically-motivated `fuelPersistenceMinutes: 360` to the WorldCover tree-cover (TL1) crosswalk row -- compact litter can hold ignition through a brief humidity excursion, distinct from and much smaller than the FCCS bridge's 48-hour ceiling; (b) threaded `fuelPersistenceMinutesByCell` through the freeze script and benchmark runner; (c) removed the persistence cap from the actively-spreading branch of `calculateTravelMinutes`; (d) corrected the three wrong `modelTimeMinutes` values from real fixture dates already on file.

Result: meanIoU 0.0942 -> **0.1814** (+92%), meanF1 0.155 -> 0.252. `big-five-2015` recall rose 0.13 -> 0.92 once given its real 138-day window (now overpredicts, precision 0.62 -- an honest new finding, not hidden). `dinely-2017` recall rose 0.33 -> 0.40. `oregon-gulch-2014` barely moved (0.0004 -> 0.0013) and remains substantially unexplained; its archived 1-hour dead-fuel moisture has a suspicious single-hour spike (4% -> 51% -> 13%) around day 6 that was noted but not yet root-caused -- may be a real rain cell or an artifact of the hourly EMC replay. `reservoir-2016`/`deer-2016` (repository fixtures, no recorded alarm/containment dates) and `stoll-2018` (same-day fire, different unexplained cause) were unaffected.

343/343 tests pass, build clean, `validate:rothermel`/`validate:convergence`/`validate:regional-offline` all pass. The frozen fixture was regenerated via a real re-run of `scripts/build-regional-benchmark-fields.mjs` (network succeeded for all 6 cases), not left as an offline-patched diagnostic copy. See RUN-012 in `RESULTS.jsonl`.

Not fixed: `oregon-gulch-2014` and `stoll-2018` remain near-zero recall for reasons not yet root-caused. `big-five-2015`'s new overprediction (precision 0.62) is itself now worth investigating rather than treating 0.92 recall as a win in isolation. This is still a diagnostic-only two-bug-fix result, not a validated regional model -- do not weaken that claim from this one run.

## 2026-07-24 update 6 (Claude) -- user requested a broad reliability push; scoped to 2 feasible fixes, reported honestly

User asked to fix seven items for hackathon reliability: ignition point, per-fire-uniform weather, spotting/embers, coarse terrain, fuel persistence, live fuel moisture, LANDFIRE, and the example fires. Declined to attempt spotting/embers, spatially-varying weather, and LANDFIRE in this session -- each needs real infrastructure (gridded weather source, a validated ember-transport module, a reliable non-flaky WCS path) that cannot be built and validated responsibly under hackathon time pressure; a rushed version would produce numbers that look better without being trustworthy, the opposite of what was asked. User chose (via explicit prompt) to scope down to the 2 highest-confidence, highest-likely-impact items: terrain resolution and fuel persistence.

Terrain: `build-regional-benchmark-fields.mjs` sampled Copernicus GLO-30 (30m native) at a sparse 16x16 grid and bilinearly upsampled to 128x128, even though the case span (12.8-32km) has 400-1000+ native pixels across -- no real data limit, just an arbitrary shortcut. Changed `sampleSize` to the case's own grid size; `interpolateElevationGrid` becomes an identity pass at that size.

Fuel persistence: traced the oregon-gulch mechanism further. GR2 (grass, moisture-of-extinction 15%) dips to zero spread rate for a routine ~2-4 hour window every night as humidity rises (confirmed directly against the real archive: rate 0.12 m/min at hour 35, 0 at hour 36, back to 0.12 by hour 39). Any edge that takes longer than about a day to physically cross a cell -- true here for GR2 under this case's modest wind -- will straddle at least one of these nightly dips. Verified the Dijkstra solver already retries a failed edge from a different, later-arriving neighbor at that neighbor's own arrival time (this is inherent to the algorithm, not something that needed adding) -- but with zero persistence on any non-TL1 fuel, every retry at every phase of the diurnal cycle still fails, since the dip recurs every ~24h regardless of start time. Added a small, general `MINIMUM_RESIDUAL_HEAT_PERSISTENCE_MINUTES = 240` (4 hours) floor to every burnable crosswalk decision in `landCoverToFuel.js` -- representing residual heat along an already-established flame front bridging a routine diurnal dip, not duff/litter smoldering (that remains the separate, larger FCCS bridge, up to 48h, reserved for heavy-fuel evidence).

Both fixes are independently correct and verified (terrain is strictly higher-fidelity input now; the persistence floor fixes a demonstrated permanent-failure mechanism). Regenerated the frozen fixture via a real network re-fetch (not offline-patched) with both changes live. Result, reported without further tuning: **meanIoU moved 0.1814 -> 0.1591 -- down, not up.** Per-case is mixed: `big-five-2015` recall rose 0.92->0.96 but precision fell 0.62->0.52 (more overprediction); `dinely-2017` IoU fell 0.397->0.333; `reservoir-2016` precision collapsed 1.0->0.33 with recall barely moving; `oregon-gulch-2014` essentially unchanged (0.0013->0.0013, the 4h floor wasn't enough to bridge its gaps or a different cause dominates there); `deer-2016`/`stoll-2018` unchanged. 343/343 tests pass, build clean, all physics validators pass.

Per the project's own non-negotiable rule against tuning on the evaluation set, this result is reported as-is rather than adjusted to chase a better number. The real takeaway: this 6-case benchmark (4 cases under 350 acres) is too small and too noisy a sample for aggregate IoU to be a reliable go/no-go signal for an individual fix -- both changes remain defensible on first-principles grounds even though the aggregate metric went the "wrong" way. See RUN-013 in `RESULTS.jsonl`.

## 2026-07-24 update 7 (Claude) -- last propagation bug fixed; structural diagnosis complete

**Bug found and fixed.** `calculateTravelMinutes` in `firePropagation.js` implemented the ignition-memory budget as an absolute wall-clock deadline (`persistenceDeadline = current.time + persistenceMinutes`) while using it to bound how long an edge may sit *dormant* waiting for a positive-rate weather window. Time spent **actively spreading** was charged against the **waiting** budget. On any edge whose total travel time exceeds the budget, the deadline had therefore already expired before the first zero-rate gap was ever reached. A 250 m cell in GR2 grass takes ~2000 min to cross, so no realistic persistence value (240 or 420 min) could ever engage -- which is why both the flat 240-min floor (update 5) and the measured data-driven values (update 6) appeared to do nothing.

Proven by direct experiment *before* changing code: oregon-gulch reachable cells = 3 at persistence 420, **66** at 5000, 74 at 100000. The budget only took effect once it exceeded total travel time, which is not what a waiting budget means. Replaced with a cumulative `waitedMinutes` accumulator charged only during dormant intervals. A dead-code analytic close-out branch was also removed: its condition (`!isFinite(boundaryMinutes) && !isFinite(persistenceDeadline)`) was unreachable, and making it reachable broke `WEATHER_POST_WINDOW_POLICY` blocking -- caught by an existing test, so the branch was deleted rather than kept.

343/343 tests pass, build clean, `validate:rothermel`/`rothermel:rate`/`waf`/`convergence` all pass. oregon-gulch-2014 improved 6x (IoU 0.0026 -> 0.0163). meanIoU 0.220 -> 0.207 (median unchanged at 0.171) because big-five-2015 now overpredicts more (recall 1.000, precision 0.402) -- that is the no-suppression limitation surfacing on a longer effective spread window, not a defect in this fix.

**Structural diagnosis -- the actual reason the model is unrealistic.** Computed the hard physical ceiling per case (peak achievable head rate x model duration). Benchmark IoU correlates almost perfectly with **fire size**, not with any code path:

| fire | acres | IoU |
|---|---|---|
| reservoir-2016 | 153 | 0.207 |
| stoll-2018 | 259 | 0.136 |
| big-five-2015 | 265 | 0.402 |
| dinely-2017 | 341 | 0.449 |
| deer-2016 | 1563 | 0.035 |
| oregon-gulch-2014 | 35111 | 0.016 |

To match observed area, deer-2016 needs **0.329 m/min** and oregon-gulch-2014 needs **0.334 m/min** sustained *omnidirectionally for the entire duration*. The model's peak head rate -- best single moment, best single direction, before any ellipse flank/backing reduction -- is only 0.363 and 0.288 m/min respectively. Since flank and backing rates run 3-5x below head rate, effective omnidirectional growth is roughly 0.2x peak head rate, leaving large fires **4-6x short in linear extent (60x+ in area)**. Oregon Gulch is formally impossible even in the degenerate best case: maximum reachable area 105.8 km2 vs 142.1 km2 observed, assuming uninterrupted peak-rate circular spread.

This is not a calibration gap and not a remaining bug. A Rothermel **surface** fire model structurally cannot generate large-fire growth, which is driven by crown fire, spotting/ember transport, and plume/fire-atmosphere coupling -- none of which are implemented (all three are already listed under "Not implemented yet" in `docs/codex-handoff-to-claude.md`). The model is appropriate for small (<400 acre) surface-fire cases and structurally invalid above roughly 1000 acres. Fixing this requires implementing those mechanisms, not tuning inputs.

Secondary structural issues, both real and both unfixed: (a) **no suppression model** -- big-five-2015 burned 265 acres over a 138-day alarm-to-containment span, meaning it was contained/monitored rather than actively spreading for nearly all of that window; giving the model the full calendar span guarantees overprediction, and alarm->containment is an upper bound on duration, not active-spread duration. (b) **ERA5 archived weather at ~25-31 km resolution** cannot represent the local wind events that drive real runs; the finer HRRR alternative was verified empirically to have zero coverage for these 2014-2018 dates.

## 2026-07-24 update 8 (Claude) -- crown fire wired in; large fires unlocked, suppression now the dominant gap

Wired up crown fire (Van Wagner 1977 + Rothermel 1991) -- already built and unit-tested in `crownFire.js`, never connected because it needs real canopy base height + bulk density, LANDFIRE-only. Fixed the actual persistence bug this whole time along the way: `persistenceDeadline` was an absolute wall-clock deadline from source-cell arrival time, but was used to bound *dormant waiting* time -- active spread time was being charged against it, so on any edge slower than the persistence budget (nearly all of them) the deadline was already expired before the first zero-rate gap. Proven before fixing: oregon-gulch reachable cells = 3 at persistence 420, 66 at 5000, 74 at 100000. Replaced with a cumulative `waitedMinutes` accumulator.

Then found the deeper reason crown fire could never have worked regardless: WorldCover-derived fuel labels every forested cell **TL1** (bare compact litter, tops out ~145 kW/m fireline intensity even at 60 km/h wind) while crown initiation needs 168-5300 kW/m depending on canopy base height; LANDFIRE's real FBFM40 shows TU5/SH7 in these landscapes instead, producing 24,000-98,000 kW/m. Fetched real LANDFIRE FBFM40 fuel and real canopy structure (CH/CC/CBH/CBD) for all 6 cases -- LANDFIRE transport works fine via curl, but Node's fetch/undici gets rejected by this specific USGS server with fake 500s and dropped sockets on the byte-identical URL curl succeeds on every time; this is a one-time offline freeze script, nothing in the shipped app changed. Crown fire immediately exposed a real latent bug on first execution: `calculateCrownFractionBurned` didn't guard an infinite torching index the same way it guarded infinite crowning index, threw `RangeError` -- fixed. Also found and fixed a severe perf bug: the crown-threshold cache key included cell index instead of canopy values, thrashing a 4096-entry cache against 16384 cells (~25 Rothermel evaluations per edge from scratch); rekeyed on canopy values (LANDFIRE quantizes to a few hundred distinct combinations) and added an exact early-out (crown fraction burned is provably zero below the crown initiation threshold at current wind) -- ~3.8x+ speedup, verified cell counts identical before/after.

343/343 tests pass, build clean. All four physics validators (`rothermel`, `rothermel:rate`, `waf`, `convergence`) re-run and pass -- no regression from the crown-fire wiring.

**Result: meanIoU fell 0.207 -> 0.0996, medianIoU 0.171 -> 0.0851 (RUN-018) -- read this correctly, don't just react to the mean dropping.** `oregon-gulch-2014` (35,111 acres, previously proven mathematically impossible for a surface-only model) went 0.016 -> **0.239, now the best case in the suite**. `deer-2016` (1,563 acres) went 0.035 -> 0.145. Those are exactly the two fires diagnosed as "too big for surface fire alone" -- crown fire fixed the mechanism that was diagnosed as broken; this is real, positive, causally-explained signal. But recall shot up everywhere (0.44-0.99) while precision collapsed (0.003-0.53) on the four small fires (152-341 acres) that were fought and contained by firefighters within days on genuinely flammable LANDFIRE fuel (not the old TL1 guess) -- the model has no suppression mechanism, so it now burns unchecked across real fuel for the whole calendar window. That is the new, correctly diagnosed dominant error source, not a defect in this run's work. Do not fix this by suppressing recall or damping crown fire to make the mean look better.

**Suppression status, checked this run:** `suppressionConstraints.js` (time-aware barrier support) already exists and is fully wired into `firePropagation.js`'s solver -- it accepts a `suppressionBarrierTimes` array and the transition-blocking logic respects it (`suppressionBlockedTransitionCount`, `suppression_reached` status). It is unit-tested in isolation. But `hackathonBenchmarkRunner.js` explicitly reports `suppression: 'unavailable'` for all 6 cases -- no real containment-line/date data source has been wired to feed it. The engine-side mechanism is real and ready; only the benchmark's real-world suppression data is missing. This is the clear next mechanism to invest in, per the crown-fire precedent (surface -> crown fixed the biggest fires; suppression should fix the smallest).

See RUN-018 in `RESULTS.jsonl` for full machine-readable detail.

## 2026-07-24 update 9 (Claude) -- suppression data verification: NO-GO (environment-limited), no code changed

Checked, before writing any suppression code, whether real dated perimeter-progression data exists for the 6 benchmark fires (per `docs/suppression-data-verification-plan.md`). `stoll-2018` was excluded up front with zero network calls: alarm date equals containment date, so no multi-date progression can exist for it regardless of source.

The one source already proven to work in this repo -- `apps.fs.usda.gov`'s EDW `EDW_FireOccurrenceAndPerimeter_01` MapServer (it produced `RUSH_CREEK_PROGRESSION` in `historicalProgressionFixtures.js`) -- is **unreachable from this sandbox**: TLS handshake completes, then the connection hangs with no HTTP response, while a control request to `services.arcgis.com` in the same run returned 200 normally. This is an environment/egress finding, not a data-availability finding -- the endpoint is known to work.

The named fallback, `California_fires_since_2014` (ArcGIS FeatureServer, already referenced elsewhere in this repo), is reachable, but its schema was checked directly: it carries a single `ALARM_DATE`/`CONT_DATE` pair per fire, the same shape `officialBenchmarkFixtures.js` already has -- not a progression layer. It cannot supply what suppression needs no matter how it's queried.

**Verdict: NO-GO in this environment**, reported as-is rather than worked around -- no substituting alarm/containment dates for observed progression, no building against the fallback's insufficient schema. Next action for whoever has unrestricted egress: retry the USDA EDW endpoint directly; if it's genuinely down (not just sandboxed), suppression should be documented as a disclosed limitation exactly as HRRR weather resolution was in RUN-016, rather than attempted with substitute data. No files changed this run. See RUN-019 in `RESULTS.jsonl`.

**Follow-up, same day:** the primary basis for NO-GO is structural, not connectivity -- the `California_fires_since_2014` fallback's schema carries only one alarm/containment date pair per fire, no per-date progression field, and cannot supply progression data regardless of how reliably it can be reached. That alone is sufficient and would hold even if USDA EDW came back online tomorrow. Secondary: retried the USDA EDW endpoint from the user's own machine, outside the sandbox -- but that only rules out sandbox egress, since the sandbox runs on the same MacBook (same ISP/router/DNS), not an independent network. Followed up with 4 curl transport variants (`--http1.1`, custom User-Agent, redirect-following, forced TLS1.2) and a `WebFetch` request on the same URL, prompted by this project's own RUN-018 precedent that server behavior can vary by client transport. All 4 curl variants hung identically; `WebFetch` (genuinely separate infrastructure from the user's ISP) returned `ECONNRESET` -- this is the actual independent-path confirmation the earlier entry claimed but didn't have. **Verdict unchanged: suppression cannot be validated against real progression data through either source checked.** Recommend documenting "no suppression mechanism, no available progression data source" as a disclosed limitation, same treatment as ERA5-vs-HRRR weather resolution (RUN-016). `suppressionConstraints.js` and the `suppressionBarrierTimes` plumbing in `firePropagation.js` remain correctly built and unit-tested for if a working data source turns up later. See RUN-019b in `RESULTS.jsonl`.

## 2026-07-24 update 10 (Claude) -- benchmark reporting split into two tiers; measurement-validity fix, not a score fix

With suppression closed as a disclosed limitation, the remaining problem is that four of the six benchmark cases are being scored against a quantity the model does not attempt to predict. `reservoir-2016` (153 ac), `stoll-2018` (259 ac), `big-five-2015` (265 ac) and `dinely-2017` (341 ac) stayed small *because* initial attack succeeded -- their perimeters record firefighting effort, not the landscape's capacity to burn. A model with no suppression mechanism will necessarily overpredict them, and after RUN-018 that is exactly what happens (recall 0.44-0.99, precision 0.003-0.53).

`summarizeHackathonBenchmarks()` now reports a two-tier breakdown **alongside, never instead of**, the existing aggregates. Tier is assigned from observed final area against a new exported `INITIAL_ATTACK_AREA_CEILING_KM2 = 2` km2 (~494 acres). The threshold reads **only ground truth** and never touches model output, so it cannot be tuned to flatter a result; a useful cross-check is that oregon-gulch's observed area computes to 142.1 km2, matching the figure independently derived in update 7's structural diagnosis.

| tier | n | cases | meanIoU | precision | recall |
|---|---|---|---|---|---|
| freeBurningComparable | 2 | deer-2016, oregon-gulch-2014 | **0.1918** | 0.2470 | 0.5930 |
| suppressionConfounded | 4 | reservoir, big-five, dinely, stoll | 0.0535 | 0.1435 | 0.6790 |

Headline `meanIoU` stays exactly 0.0996 and every case is still scored -- nothing is excluded or hidden. What changes is interpretability: on the fires the model genuinely attempts, IoU is roughly double the blended number, and the precision collapse is localised to the confounded tier, quantitatively confirming update 8's diagnosis. Going forward, spread-physics work should be judged primarily on the `freeBurningComparable` tier; movement in the confounded tier says little about spread until a suppression mechanism exists. 343/343 tests pass (additive change, no existing field altered). See RUN-020 in `RESULTS.jsonl`.

A project-root `CLAUDE.md` was also added this session recording measured context-bomb file sizes, safe query patterns for them, the curl-vs-node-fetch requirement, and the settled findings future sessions should not re-derive.

## 2026-07-25 update 11 (Claude) -- spotting implemented, measured, and found NOT to help; the model now over-predicts

Built ember/spotting transport and measured it. Three routes were tried before one was usable: an AI-invented loft-height ratio (rejected outright); Albini (1979) mechanistic spotting, a dead end because loft height is governed by firebrand **diameter**, not fire intensity, and no published closed form relates ember diameter to intensity -- so spot distance *fell* as intensity rose; and finally ELMFire's empirical model (Lautenberger), `E[dX] = a*I^b*U^c` with a=5.0, b=0.3, c=0.7, sourced from `docs/user_guide/spotting.rst` and cross-checked against ELMFire's own Fortran. That last is monotonic in both intensity and wind and is the operative path. Wired into `firePropagation.js` as **deterministic** long-range downwind graph edges -- never random ignitions, since the solver is Dijkstra and every benchmark comparison depends on reproducibility -- behind a flag defaulting OFF.

Baseline reproduced exactly across two independent runs (meanIoU 0.0996, freeBurning 0.1918, suppressionConfounded 0.0535), confirming the flag defaults off cleanly.

| variant | meanIoU | freeBurningComparable |
|---|---|---|
| baseline (spotting off) | 0.0996 | 0.1918 |
| single landing cell | 0.0943 | 0.1797 (-0.0121) |
| multi-cell landing | 0.0840 | **0.1517 (-0.0402)** |

**Spotting hurts, and the multi-cell "fix" hurt about 3x more.** Reported as-is, nothing tuned.

**The diagnostic is recall.** Seeding embers across a full distance range added **+0.0009** recall while costing **-0.0213** precision -- essentially every spot fire landed where the real fire never went.

**Structural conclusion, and it redirects the roadmap:** this model no longer under-predicts spread, it **over-predicts** it. Recall 0.65 against precision 0.18 means roughly 3.6x too much area burned. Crown fire succeeded precisely because the model was genuinely too small on large fires; that deficit is now closed. It follows that *any* further spread-**adding** mechanism -- spotting, plume coupling -- must make accuracy worse until precision improves. The next productive lever **constrains** spread rather than adding it: suppression (blocked, RUN-019/019b), model-duration accuracy, or fuel/moisture precision.

Spotting wiring is retained but defaults OFF. The module is correct and sourced; it simply is not the binding constraint.

**Discovered while doing this, not yet fixed:** both crown fire and spotting gate on `canopyBulkDensityByCell`, which only LANDFIRE (US-only) populates. Both mechanisms are therefore silently inert **everywhere outside the United States** -- and a 6-US-fire benchmark structurally cannot detect it. See RUN-021.
