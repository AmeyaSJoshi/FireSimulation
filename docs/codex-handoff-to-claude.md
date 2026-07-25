# Codex handoff to Claude Code

Date: 2026-07-23
Project: /Users/ameyajoshi/Claude Projects/Fire Simulation

Purpose: Give Claude Code the complete current status before it changes the fire simulation. Read this file together with docs/handoff-status.md, docs/realistic-fire-model-claude-code-prompt.txt, and docs/remaining-regional-model-execution-prompt.txt. The latter is the current execution brief for the remaining regional-model work.

## Executive Summary

The project has moved from a visual globe demo with a simple cellular fire effect to a deterministic, equation-based, location-aware surface fire model. The live app defaults to the phase1 Rothermel worker path. A user can click a confirmed land location, assemble a local data field, and run a bounded simulation.

The current hackathon objective is now explicit: make CONUS/U.S. the high-confidence showcase region, keep the globe globally explorable with lower-confidence fallbacks, and demonstrate repeatable benchmark evidence rather than claiming equal global accuracy.

The core engineering foundation is substantially complete and heavily tested. The model is not yet a trustworthy operational or globally accurate predictor. The largest remaining issues are the quality and completeness of location-specific inputs and missing mechanisms such as spotting and suppression.

Honest status:

- Core engineering implementation: substantially complete.
- Reference-equation validation: passing.
- Local browser workflow: working.
- Water exclusion: implemented with authoritative/fine barriers.
- Fire termination: implemented and browser-tested.
- Global predictive accuracy: incomplete and explicitly low confidence.
- Rush Creek replay: underpredicts observed growth and remains a calibration failure.
- CONUS showcase benchmark: two independent California perimeters are now scored together by a reproducible runner.

## Localhost

The verified Vite server was running at:

http://127.0.0.1:5187/

Port 5186 was already occupied, so Vite selected 5187. The root endpoint returned successfully during the final smoke check. The new `/api/fuel/landfire-field` route reports an explicit fallback when the public LANDFIRE WCS transport is unavailable. If the old process is gone, use:

npm run dev -- --port 5187

Use another port if necessary.

## What Codex and the earlier work built

### Product workflow

- Three.js global Earth with click-to-ignite behavior.
- Location selection reports latitude/longitude and rejects obvious ocean/non-burnable clicks.
- phase1 is the default worker engine; legacy remains available for comparison.
- UI controls include scenario, fuel, wind, direction, moisture, live moisture, slope, pause, reset, metrics, interpretation, run history, replay, and experimental sensitivity.
- Globe auto-rotation stops while a fire is running and resumes after reset/settlement.
- Web Worker owns simulation stepping; the main thread receives frames and metrics.
- Missing data and synthetic fallbacks are visible in scenario metadata.
- UI retains the educational disclaimer: Rothermel surface model, not a forecast.

### Spatial, terrain, and elevation

- src/lib/spatialGrid.js maps WGS-84 locations into local geodesic grids with explicit row/column semantics, antimeridian handling, and high-latitude tests.
- src/lib/elevationField.js requests bounded Open-Meteo/Copernicus GLO-90 elevation fields, batches requests, caches timestamps, and preserves no-data/fallback metadata.
- terrain derivatives calculate slope/aspect from the elevation field.
- Interactive terrain is coarse global elevation, not tactical or building-scale terrain.
- If elevation is unavailable, the app uses an explicit synthetic fallback and says so.

### Land cover, fuels, and water

- ESA WorldCover 2021 v200 provides global land-cover classification.
- Coarse WorldCover artifacts and a fine COG reader/field path are present.
- src/lib/landCoverToFuel.js maps supported classes to versioned Scott/Burgan-style models with confidence/rationale.
- src/lib/fuelModels.js contains the cited, SI-normalized complete Scott & Burgan FBFM40 family plus agricultural, non-burnable, and FM10 parameters.
- src/lib/landfireFuel.js maps LANDFIRE 2024 CONUS FBFM40 raster values to direct regional fuel-model codes and builds bounded WCS requests.
- `/api/fuel/landfire-field` streams a bounded 30 m LANDFIRE FBFM40 field when the official WCS responds; the app keeps an explicit FCCS/WorldCover fallback when the upstream transport fails.
- src/lib/worldCoverFine.js supports within-cell sampling, majority class, burnable fraction, and narrow-water-edge detection.
- src/lib/waterAuthority.js combines classified water, fractional water, fine samples, visual fallback, and edge checks.
- src/lib/fireFieldInputs.js produces aligned per-cell fuel codes, model definitions, fuel-load scales, water barriers, canopy fields, and persistence.
- Water, built-up, snow/ice, no-data, unsupported, and fine-water edges become non-burnable barriers. Fire must not cross ocean, lake, river, or authoritative fine-water edges.

### Global FCCS bridge

The bridge lives in src/lib/globalFuelbed.js.

- Source: Pettinari and Chuvieco Global Fuelbed Dataset, v1.2, approximately 300 m.
- DOI: https://doi.org/10.1594/PANGAEA.849808
- Methods paper: https://doi.org/10.5194/bg-13-2061-2016
- Committed parameters: public/global-fuelbed-parameters.json
- Bridge version: global-fccs-bridge-0.3.0.
- The server reads/caches the intersecting WGS-84 tile and resolves numeric JOIN_VALUE values.
- Supported grass and dead 1/10/100-hour loads become custom Rothermel models.
- FCCS G_live splits grass into dead and live herbaceous fuel when available.
- Grass height or woody depth supplies a documented depth approximation.
- Missing physical parameters use standard particle properties and remain low confidence.
- Litter chemistry, duff, 1000-hour mass, live woody fuel, and crown fuel are not silently inserted into the flaming surface rate.
- FCCS tree cover/height can provide conservative wind shelter.
- FCCS height-to-live-crown is retained as a diagnostic and does not alone enable crown fire.
- Slow-fuel evidence gets a bounded fuelPersistenceMinutes value, capped at 48 hours. This is finite ignition memory, not a complete smoldering/1000-hour model.
- If unavailable, the app reports Global FCCS unavailable - WorldCover fallback.

### Rothermel and propagation

- src/lib/surfaceSpread.js is a pure deterministic SI-boundary Rothermel-style surface kernel.
- src/lib/firePropagation.js uses a priority-queue arrival-time solver over the local raster.
- It uses directional head/flank/backing rates, fire ellipse travel, wind, slope, fuel availability, dead/live class moisture, canopy shelter, and time-varying weather.
- It handles water barriers, suppression barriers, field boundaries, no-data fuel, finite persistence, and finite horizons.
- Burn duration uses the Anderson residence approximation tau = 384 / sigma where the model has enough information.
- Burned cells remain in metrics but stop rendering as active flame after burnout.
- Accelerated playback changes display sampling only; it does not change physical arrival times.
- Zero-rate weather intervals are not crossed as if they had positive spread. A finite persistence source can wait for a later positive window only before its deadline.
- The interactive horizon is 72 hours, preventing an unbounded UI loop.

### Weather and moisture

- src/lib/weatherInputs.js handles Open-Meteo current/history/forecast data, provenance, raw 10 m wind, direction conversion, and wind adjustment.
- Timelines preserve changing wind and dead-fuel moisture.
- src/lib/fuelMoistureModel.js estimates dead 1/10/100-hour moisture with NFDRS-style equilibrium and time-lag behavior.
- src/lib/liveFuelMoistureModel.js estimates herbaceous and woody live moisture using a documented seasonal/GSI-style model.
- src/lib/historicalWeather.js builds archive timelines with pre-ignition spin-up and time-varying live herbaceous/woody moisture.
- A major replay bug was fixed: the entire July-September archive previously used a late-season live moisture value at ignition.

### Canopy and crown

- canopyHeight.js, landfireCanopy.js, and adapters handle measured/global canopy height and LANDFIRE CH/CC/CBH/CBD where available.
- crownFire.js contains guarded Van Wagner/Rothermel crown coupling.
- Crown behavior requires usable canopy base height and canopy bulk density.
- Global FCCS remains surface-only for crown behavior when measured bulk density is unavailable.

### Validation and uncertainty

- src/lib/uncertainty.js provides deterministic seeded perturbations for wind, direction, moisture, fuel availability, and forest alternatives.
- Ranges are labeled low/median/high and are not calibrated probabilities.
- scripts/validate-historical-progression.mjs replays Rush Creek with archived weather and observed perimeters.
- Independent perimeter fixtures and comparison metrics are in historicalPerimeterFixtures.js and perimeterValidation.js.
- src/lib/hackathonBenchmarkRunner.js runs the two-case CONUS showcase baseline.
- src/lib/scenarioEvidence.js classifies each run as CONUS showcase, CONUS regional, or global exploratory from the input sources that actually arrived; it is a provenance signal, not an accuracy claim.
- scripts/validate-hackathon-benchmarks.mjs prints per-case metrics and an
  aggregate summary.
- scripts/calibrate-hackathon-benchmarks.mjs sweeps a deliberately small set of
  fuel/moisture assumptions; its output is diagnostic and must not be treated
  as trained calibration.

## Verification evidence

These commands passed against the current working tree:

- npm test: 335 pass, 0 fail, including direct FBFM40 and scenario-evidence profile tests.
- npm run build: passed; only the existing Vite bundle-size warning remains.
- npm run validate:rothermel: passed four TU2 BehavePlus reference points, 4.38% to 4.74% relative error, under the 5% gate.
- npm run validate:rothermel:rate: passed independent equation oracle.
- npm run validate:waf: passed 13 published WAF cases.
- npm run validate:convergence: passed one-minute versus quarter-minute matched arrivals/perimeters.
- npm run validate:global-fuelbed: passed 359 rows, 353 usable fuelbeds, 6 rejected, 1059 scenario checks.
- npm run validate:progression:fine-hindcast:global: completed with public replay inputs.
- git diff --check: passed.
- npm run validate:hackathon: passed the two-case CONUS baseline with mean IoU
  0.4886 and mean F1 0.6480.
- npm run calibrate:hackathon: passed 48 diagnostic parameter combinations;
  the top mean-IoU result was 0.4958. The small improvement is evidence that
  a single global fuel/moisture tweak is not enough.
- Browser smoke: opened localhost, clicked Montana land, loaded the local field, ran the worker, settled at the finite horizon, and produced no console errors.
- The smoke run received an elevation HTTP 429, and the app correctly displayed/use synthetic terrain fallback rather than crashing.

## Latest Rush Creek replay

Configuration:

- 128 x 128 grid.
- 100 m cells.
- Fine WorldCover, 16 samples per cell.
- Global FCCS definitions.
- Archived Open-Meteo wind and moisture.
- Seven days of pre-ignition weather spin-up.
- Fine water barriers.
- Global canopy/persistence fields.

Result:

- Classified: 16,383 / 16,384.
- Water cells: 1.
- Water barrier edges: 16.
- FCCS fuelbed cells: 16,383.
- Persistence cells: 13,912.
- Maximum persistence: 2,479 minutes.
- Final predicted cells: 338.
- Final predicted area: 3.38 km2.
- Final observed area: 38.42 km2.
- Final IoU: 0.0661.
- Mean IoU: 0.1025.
- Final precision: 0.7663.
- Final recall: 0.0674.
- Mean predicted/observed growth ratio: 0.4027.
- Termination: fuel_or_barriers_exhausted.

Interpretation: local equation behavior and barriers are functioning, but the global replay underpredicts observed growth. This is a calibration failure, not an accuracy claim. Do not hide it with a global speed multiplier.

## Important findings

1. Water must be a propagation barrier, not just a visual overlay. Texture-only masking previously allowed coastal/lake fires to appear over water. The current solution samples authoritative/fine edges and passes directed barriers to the solver.

2. Global land cover is not a complete fuel model. FCCS is traceable and useful, but local fuel continuity, litter/duff chemistry, heavy fuels, live woody fuel, crown fuel, and local calibration are incomplete.

3. Raw weather cannot be passed directly to Rothermel. The pipeline preserves measurement height and resolves wind adjustment for the destination fuelbed. Moisture is class-specific and time-varying where supported.

4. Positive spread cannot leak through extinction. The arrival solver integrates weather windows and rejects transitions that cannot complete before a zero-rate interval, with finite persistence waiting only when justified.

5. Burnout is separate from arrival. The solver derives a physical flaming residence where possible, while the worker also has a finite 72-hour horizon.

6. Reference equation correctness does not prove fire prediction accuracy. The kernel can match published cases while the global replay remains poor because inputs and omitted mechanisms remain poor.

7. Do not add a neural-network multiplier as a shortcut. A learned calibration layer would require real labeled data, holdouts, provenance, and strict validation.

## Not implemented yet

- Regional/global fuel calibration validated across many fires.
- Complete smoldering, litter, duff, and 1000-hour heat-budget model.
- Validated firebrand/ember generation, transport, and ignition.
- Reliable global crown bulk density and foliar moisture.
- Suppression, containment, and firefighting actions.
- Plume-dominated fire-atmosphere coupling.
- Smoke transport.
- Broad multi-continent hindcast suite.
- Operational or forecast use.

## Recommended next work

1. Build a sensitivity harness around the historical progression validator. Compare persistence 0/24/48 hours, regional fuel-load scales, moisture initialization, live-moisture variants, ignition uncertainty, and containment diagnostics. Emit metrics for every variant. Do not change app defaults until multiple cases improve.

2. Add independent public fires across continents, fuel families, climates, and coastal environments. A single US fire cannot justify global parameters.

3. Implement spotting as a separate experimental module, never as a hidden surface-rate multiplier. It needs explicit source intensity, wind-vector transport, finite landing/lifetime, destination fuel/moisture/land checks, deterministic sampling, water rejection, and tests for downwind bias and finite extent. Enable by default only when required source inputs exist.

4. Improve regional data fidelity with LANDFIRE or equivalent fuel/canopy inputs where available, better live-fuel moisture, regional terrain, and per-cell resolution/confidence metadata. Keep FCCS as fallback.

5. Add explicit time-aware suppression/containment scenario inputs. Do not infer suppression automatically from a stalled observed perimeter.

6. Re-run all physics, replay, build, and browser checks after every meaningful change.

Minimum regression commands:

- npm test
- npm run build
- npm run validate:rothermel
- npm run validate:rothermel:rate
- npm run validate:waf
- npm run validate:convergence
- npm run validate:global-fuelbed
- npm run validate:progression:fine-hindcast:global

## Key files

Read first:

- docs/codex-handoff-to-claude.md
- docs/handoff-status.md
- docs/realistic-fire-model-claude-code-prompt.txt
- docs/research/rothermel-validation.md
- docs/research/global-fuelbed-source.md
- docs/research/historical-perimeter-validation.md
- docs/research/crown-fire-coupling.md

Core runtime:

- src/main.js
- src/workers/fireWorker.js
- src/lib/firePropagation.js
- src/lib/surfaceSpread.js
- src/lib/fireFieldInputs.js
- src/lib/globalFuelbed.js
- src/lib/landCoverToFuel.js
- src/lib/waterAuthority.js
- src/lib/historicalWeather.js
- src/lib/fuelMoistureModel.js
- src/lib/liveFuelMoistureModel.js
- src/lib/crownFire.js
- src/lib/uncertainty.js

Validation scripts:

- scripts/validate-rothermel.mjs
- scripts/validate-rothermel-rate.mjs
- scripts/validate-waf.mjs
- scripts/validate-convergence.mjs
- scripts/validate-global-fuelbed.mjs
- scripts/validate-historical-progression.mjs
- scripts/validate-historical-perimeter.mjs
- scripts/validate-independent-perimeter.mjs

## Git safety

The working tree is intentionally dirty and contains the uncommitted rewrite from earlier Claude/Codex work. The latest committed baseline is d4c809b, but many current modules and docs are newer than that commit.

Do not run git reset --hard, git checkout --, or broad cleanup. Read current files and diffs first. Preserve user changes. Add focused tests and update this file plus docs/handoff-status.md when a meaningful phase changes.

## Final instruction to Claude

Continue from the actual working tree, not the old commit and not this prose alone. Verify current code and rerun relevant tests before trusting any claim. Preserve deterministic equation-based behavior, water barriers, finite termination, provenance, and low-confidence labels. Improve accuracy with measured data and validation, not opaque multipliers or invented parameters.
