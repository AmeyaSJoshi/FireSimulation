# Baseline Evidence

This file records the pre-change verification for the regional-model run. Add command results below; do not rewrite prior records.

## Environment

- Workspace: `/Users/ameyajoshi/Claude Projects/Fire Simulation`
- Date: 2026-07-24
- Node/npm: Node v24.16.0 / npm 11.13.0
- Git head: `d4c809b` at run start

## Commands

Results will be appended after each command completes:

- `npm test`
- `npm run build`
- `npm run validate:rothermel`
- `npm run validate:rothermel:rate`
- `npm run validate:waf`
- `npm run validate:convergence`
- `npm run validate:global-fuelbed`
- `npm run validate:hackathon`
- `npm run validate:progression:fine-hindcast:global`
- `git diff --check`

## Pre-change Results

- `npm test`: **335 pass, 0 fail**.
- `npm run build`: **pass**; Vite emitted the existing large-chunk warning.
- `npm run validate:rothermel`: **pass**; four published TU2 reference rows under 5% relative error.
- `npm run validate:rothermel:rate`: **pass**; independent rate/reaction/intensity oracle.
- `npm run validate:waf`: **pass**; 13 published WAF rows.
- `npm run validate:convergence`: **pass**; one-minute/quarter-minute arrivals matched.
- `npm run validate:global-fuelbed`: **pass**; 359 rows, 353 usable fuelbeds, 1059 scenarios.
- `npm run validate:hackathon`: **pass**; two-case diagnostic mean IoU 0.4886, mean F1 0.6480.
- `npm run validate:progression:fine-hindcast:global`: **blocked** by DNS failure resolving `archive-api.open-meteo.com`; this is preserved as an external-data blocker, not treated as a model pass.
- `git diff --check`: **pass**.

## Post-contract Verification

- `npm test`: **337 pass, 0 fail** after the LANDFIRE contract patch.
- `npm run build`: **pass**; existing large-chunk warning remains.
- `node --check vite.config.js && node --check src/main.js`: **pass**.
- `curl http://127.0.0.1:5188/`: **HTTP 200**.
- Out-of-coverage `POST /api/fuel/landfire-field`: **HTTP 200**, explicit `available:false`, `reason:outside_conus_coverage`.
- Live CONUS `POST /api/fuel/landfire-field`: **HTTP 502** because the upstream WCS returned `curl: (52) Empty reply from server`; no fallback raster was fabricated.

## Current Run Results

- `npm test`: **339 pass, 0 fail** after weather-validity and offline-contract changes.
- `npm run validate:regional-inputs`: **pass**; asymmetric GeoTIFF decode, geometry/orientation validation, direct FBFM40 field alignment, propagation, lifecycle metrics, and provenance all exercised offline.
- `npm run validate:regional-offline`: **pass**; network-independent regional contract plus two-case diagnostic benchmark.
- `npm run validate:hackathon`: **pass**; still two California diagnostic cases, mean IoU 0.4886 and mean F1 0.6480, with calibration/holdout roles now explicit.
- `npm run calibrate:hackathon`: **pass**; calibration is restricted to Reservoir and checked on untouched Deer, but this remains too small and homogeneous to accept as a regional default.
- `npm run build`: **pass**; existing large-chunk warning remains.
- Weather policy: multi-entry historical timelines block new spread strictly after their final observation; one-entry snapshot timelines remain usable. The policy is exposed in simulation params.
## RUN-005 perimeter benchmark expansion

The diagnostic perimeter suite now contains six frozen cases: four calibration cases (`reservoir-2016`, `oregon-gulch-2014`, `big-five-2015`, `stoll-2018`) and two holdouts (`deer-2016`, `dinely-2017`). Four new ArcGIS snapshots are bundled with source-response and decoded-geometry SHA-256 values in `src/lib/officialBenchmarkFixtures.js`; the Oregon ArcGIS record is normalized from same-winding disjoint rings to a `MultiPolygon` before rasterization.

The default six-case run is deterministic and reports mean IoU `0.3084645982`, mean F1 `0.4406033446`, and worst-case IoU `0.0443956044` for Oregon Gulch. These are diagnostic metrics only: all cases still use homogeneous TU2, flat synthetic terrain, calm synthetic weather, and no suppression or spotting. The public perimeter expansion improves evaluator coverage but does not establish regional accuracy.
