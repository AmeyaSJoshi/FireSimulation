# Handoff status — realistic fire model rewrite

**Last updated:** 2026-07-23 (America/Los_Angeles)
**Working branch:** `main`
**Head commit:** `6465498` (`git log --oneline -6` for context)

Read this before doing anything else with the fire-model rewrite. It is
the running status file for the phased plan defined in
[`realistic-fire-model-claude-code-prompt.txt`](realistic-fire-model-claude-code-prompt.txt).
Everything here is grounded in what's already in the repo; nothing is
aspirational. When you finish a phase, update this file.

---

## Status at a glance

| Phase | Charter (prompt § 14) | Status | Evidence |
|---|---|---|---|
| 0 | Audit and baseline | ✅ done | [`phase-0-baseline.md`](phase-0-baseline.md) · commit `7c58c0a` |
| 1 | Spatial + data contracts, feature flag | ✅ done | commit `7c58c0a` (bundled with the sprint-work-in-flight) |
| 2 | Fuel and weather inputs, land-cover crosswalk | ✅ done | commit `6465498` · [`land-cover-source.md`](research/land-cover-source.md) |
| 3 | Pure Rothermel surface-spread kernel | ⏳ not started | see "Next phase" below |
| 4 | Arrival-time spatial propagation | ⏳ not started | — |
| 5 | Uncertainty ensemble + historical validation | ⏳ not started | — |

**Baseline you must not regress:**
- `npm test` → **114 tests pass, 0 fail** (last verified at commit `6465498`).
- `npm run build` → clean, ~522 ms, 651 KB main chunk (Three.js dominates).
- Legacy cellular engine (`SIMULATION_ENGINE = 'legacy'`, default) behaves
  byte-identical to what the Phase 0 baseline recorded. If you make it
  behave differently, that is either a Phase 3+ change deliberately gated
  by flipping the flag to `phase1`, or a regression.

---

## What's actually in the repo today

### Modules landed (grouped by phase)

Phase 0 (audit only — no code shipped):
- [`docs/phase-0-baseline.md`](phase-0-baseline.md) — architecture map,
  data/unit/coord contract, worker message shapes, findings F1–F8, and
  the Phase 1 proposal.

Phase 1 modules (all TDD, all pure, all opt-in):
- [`src/lib/spatialGrid.js`](../src/lib/spatialGrid.js) — equirectangular
  tangent-plane grid, antimeridian handling, cos(lat) longitude scale.
  9 tests.
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
- [`src/main.js`](../src/main.js) — added `SIMULATION_ENGINE = 'legacy'`
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
  (1.0.0) of Scott & Burgan 2005 fuel models: GR1, GR2, GS1, SH2, TL1,
  TL3, plus experimental AG1 and NB (non-burnable). Every parameter
  converted to SI at the boundary. Every entry cites its published
  source. 8 tests.
- [`src/lib/landCoverToFuel.js`](../src/lib/landCoverToFuel.js) —
  deterministic crosswalk from WorldCover class code to fuel-model code
  with explicit confidence tier (`medium` / `low` / `experimental`).
  Missing land cover falls back to experimental default with a rationale
  string, per prompt § 10. 10 tests.
- [`src/lib/weatherInputs.js`](../src/lib/weatherInputs.js) — Open-Meteo
  `/forecast` (current) ingest. Unit-labels every value, records wind
  measurement height (10 m) separately from the midflame-adjusted speed,
  applies the Baughman & Albini 1980 midflame constant (0.4 open, 0.2
  sheltered), converts compass to math-frame radians in one named place.
  13 tests. **Not yet wired into `main.js`** — the module is complete;
  the wire-in is a Phase 3 (or 2.5) task alongside the physics kernel
  that actually consumes it.

### Feature flag (Phase 1)

```js
// src/main.js
const SIMULATION_ENGINE = 'legacy'; // or 'phase1'
```

- Sent to the worker in the start message. The worker doesn't branch on
  it yet because the phase1 engine is not implemented.
- Metadata line reads `Cellular · legacy · 1 min/tick` today.
- The Phase 3 kernel will branch on this flag: `'legacy'` stays the
  current cellular model, `'phase1'` runs the Rothermel kernel.

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
| F1 | `cellSizeKm` inconsistency: worker default 4, metrics default 1 | ⏳ open | Both call sites should reference an authoritative `spatialGrid.js` config in Phase 3 wiring |
| F2 | Wind direction is math-axis convention, labeled as compass | ⏳ open | `weatherInputs.compassToMathRadians` is ready but not yet consumed by the sim; Phase 3 must switch the sim's convention when the phase1 engine reads from `scenarioInput.wind` |
| F3 | No wind measurement height / midflame adjustment | ✅ resolved (Phase 2) | `weatherInputs.windToMidflame` implements the adjustment with explicit method labels |
| F4 | Real elevation fed through a hack term, not proper slope/aspect | ✅ resolved (Phase 1) | `terrainDerivatives.js` computes slope + aspect; Phase 3 must consume it in the kernel |
| F5 | Three arbitrary fuel presets, no fire-behavior fuel-model table | ✅ resolved (Phase 2) | `fuelModels.js` is the versioned SI-unit table with citations |
| F6 | Heat-accumulation spread, not rate-of-spread | ⏳ open | The whole point of Phase 3; do not partially fix by tweaking the current cellular engine |
| F7 | Elevation cache entries have no `fetchedAt` | ✅ resolved (Phase 1) | Cache now stores `{ heights, fetchedAt, source }` |
| F8 | Worker `update` message secretly restarts | ✅ resolved (Phase 1) | `update` renamed to `configure`; `update` kept as deprecated alias that emits `console.warn` |

### New in Phase 2

| # | Finding | Status | Notes |
|---|---|---|---|
| F9 | 4 km modal-class mosaic smears coastlines and small features | 📓 documented, acceptable | Called out in [`land-cover-source.md`](research/land-cover-source.md) "What you actually lose". Example: NYC's ~4 km pixel lands on the Hudson River and reads as `Permanent water (WC 80)`. Every classification is labeled `confidence: medium` so consumers can qualify. A higher-resolution regional variant is a natural Phase 5 refinement. |
| F10 | `weatherInputs.js` written but not yet wired into `main.js` | ⏳ open | Complete module + tests exist. The Phase 3 kernel implementation should read `scenarioInput.weather` and consume the midflame speed. Wiring should happen when a downstream consumer needs it, not before. |
| F11 | Cropland → `AG1` is experimental; real ag residues vary by crop and season | 📓 documented, acceptable | Explicit confidence label in [`landCoverToFuel.js`](../src/lib/landCoverToFuel.js). Real-crop model can land any time as a Phase 2.5 addition. |
| F12 | Mangroves / wetlands mapped to low-confidence stand-ins | 📓 documented, acceptable | Real moisture regimes usually keep them below ignition anyway; deferring to the moisture-of-extinction gate in the eventual kernel is correct behavior. |

---

## Where the current-app UI signals what's real

- **`SCENARIO BASIS` panel `MODEL` line** — reads `Cellular · legacy · 1 min/tick`. The middle token is the active engine flag.
- **`FUEL` line** — composites the legacy dropdown with the WorldCover crosswalk: e.g. `Brush · WC Grassland → GR2 (medium)`. When land cover is unavailable, appends `· WC unavailable → GR1 (experimental)`.
- **`TERRAIN` line** — reads `GLO-90 loaded`, `Cached GLO-90`, `Synthetic fallback`, `Ocean · no ignition`, etc.
- **Bottom-of-panel disclaimer** — `EDUCATIONAL CELLULAR MODEL · NOT A FORECAST`. Do not remove until prompt § 15 "definition of done" is met.

---

## How to run the baseline verify pass

```bash
npm test           # → 114 pass
npm run build      # → clean, ~522ms, chunk-size warning is Three.js
npm run dev        # → http://127.0.0.1:5174
```

Manual smoke (matches what Phase 0 documented, extended for Phase 2):

1. Wait for the loading pill to disappear.
2. Console should log `[landcover] loaded ESA WorldCover 2021 v200 …`.
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

## Next phase: 3

Phase 3 charter (from prompt § 14):
> Implement the pure Rothermel-style local kernel with citations and
> intermediate outputs. Test equations and monotonic properties against
> hand-calculated fixtures or trusted reference outputs. Add a debug
> mode that can inspect one cell's inputs and intermediate terms.

### Recommended entry point

Before writing a single line of physics:

1. **Fetch the primary sources** referenced in prompt § 16 and cite them
   in code comments. Do not copy equations from memory (prompt rule 5).
   - Rothermel (1972), USDA INT-115 — the original paper.
   - Andrews (2018), *The Rothermel surface fire spread model and
     associated developments: a comprehensive explanation* — RMRS-GTR-371,
     the current USFS reference.
   - Scott & Burgan (2005) — RMRS-GTR-153 — the fuel-model table this
     project already ships in `fuelModels.js`.
2. **Add `src/lib/surfaceSpread.js`** (per prompt § 3 recommended module
   boundary). Pure function. SI units internally. Every intermediate
   quantity — reaction intensity, propagating flux ratio, wind factor,
   slope factor, effective wind — exposed for tests and debug.
3. **Test directional monotonicity** (prompt § 8 lists the seven
   properties: isotropic-under-calm, head > flank, backing > 0, upslope
   > downslope, moisture suppresses, non-burnable → 0, wind reversal
   reverses bias).
4. **Wire behind the `phase1` engine flag only.** Legacy engine stays
   untouched. The worker's `startSimulation` gains a branch on
   `config.engine`. Do not remove the legacy model until Phase 5 finishes
   its validation gates.

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
