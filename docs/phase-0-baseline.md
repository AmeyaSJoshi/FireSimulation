# Phase 0 — Baseline audit

**Recorded:** 2026-07-22 · pre-Phase-1 · commit `a3ed692` plus uncommitted local work through the scenario-lab sprint

This document is the required Phase 0 deliverable from
[`docs/realistic-fire-model-claude-code-prompt.txt`](realistic-fire-model-claude-code-prompt.txt).
Its only job is to record what the app is *today*, before any Phase 1 code
lands. Nothing here is a change to the product. When Phase 1 begins, every
new decision references this document.

**Ground rules honored this phase**

- Zero product-code changes. Only this file was added.
- No new dependencies. No file deletions. No worker contract changes.
- The current cellular model stays exactly as-is; the feature flag arrives
  in Phase 1 alongside the first realistic module.
- Every audit finding below is a gap to *carry into Phase 1*, not a bug to
  patch out of order.

---

## 1. Baseline evidence

### Tests

`npm test` runs `node --test` across `src/lib/*.test.js`. Result at the
start of this phase:

```
ℹ tests 26
ℹ pass 26
ℹ fail 0
ℹ duration_ms 107.79
```

Coverage areas already exercised:

- Coordinate round-trip through the FBX mesh adapter
  ([`coordinateMath.test.js`](../src/lib/coordinateMath.test.js))
- Elevation request construction, bilinear expansion, response parsing,
  cache-key quantization, abort signal, malformed-value rejection
  ([`elevationField.test.js`](../src/lib/elevationField.test.js))
- Cellular fire behavior: seed cell, calm growth, wind bias, moisture
  suppression, zero-fuel barrier, footprint/perimeter metrics, model time,
  slope bias, elevation-field bias
  ([`fireSimulation.test.js`](../src/lib/fireSimulation.test.js))
- Ignition policy (`isOcean === false` gate) and status copy
  ([`ignitionPolicy.test.js`](../src/lib/ignitionPolicy.test.js))
- Interpretation formatters, elevation range, spread-driver labels
  ([`scenarioInterpretation.test.js`](../src/lib/scenarioInterpretation.test.js))
- Scenario history storage: newest-first, cap, malformed-JSON tolerance,
  metric deltas
  ([`scenarioRecords.test.js`](../src/lib/scenarioRecords.test.js))

**No tests exist yet for** the worker's start/pause/stop/update message
contract, the terrain-sampler pixel classifier, or `main.js` UI wiring.
Those are candidates for Phase 1 scaffolding, not remediation now.

### Build

`npm run build` (`vite build`):

```
dist/assets/fireWorker-pbdAegkr.js    4.45 kB
dist/index.html                       7.40 kB │ gzip:   2.03 kB
dist/assets/index-8dWYfh-g.css       13.20 kB │ gzip:   3.19 kB
dist/assets/index-O01FvQ0M.js       643.20 kB │ gzip: 171.47 kB
✓ built in 521ms
```

Vite reports the 643 kB main chunk (Three.js) exceeds the 500 kB warning
threshold. That is a *known* long-term optimization item, not a Phase 0
blocker. Recorded here so future bundle changes can be compared honestly.

### Browser smoke

Preview at `http://127.0.0.1:5174` renders the full mission-control UI:
globe + starfield + fresnel atmosphere + terminator + bloom, with the
ignition-target panel on the left and the scenario-controls panel on the
right (scenario / fuel / wind / direction / moisture / slope, pause/reset,
metric grid, scenario-basis metadata, interpretation block, `EDUCATIONAL
CELLULAR MODEL · NOT A FORECAST` disclaimer, recent-runs section, legend
and scale bar). Pixel-accurate terrain classification confirmed:

- Ocean clicks (Pacific 36°N/157°W, 43°N/125°W, Arctic 71°N/165°W) all
  produced `Water surface · no ignition` and prevented worker start.
- Land clicks (Arizona coastline lake edge, Colombia coast) succeeded in
  earlier sessions with correct label lookup and marker placement.

The auto-rotation moves the click target between hover and mousedown at
0.075 rad/s, which is intentional aesthetic behavior; note it as a small
UX friction, not a defect.

---

## 2. Module architecture (as-implemented)

```
src/main.js  (1285 lines — UI wiring, worker owner, panel state,
             |  scenario preset dispatch, terrain fetch orchestration,
             |  Three.js scene, camera, marker, panels, history render)
             │
             ├── lib/coordinateMath.js       WGS-84 ↔ FBX-sphere cartesian
             │   lib/coordinateMath.test.js
             │
             ├── lib/terrainSampler.js       Pixel-accurate ocean classifier
             │                               (reads the visible day map)
             │
             ├── lib/locationLabel.js        Coord → nearest city/state/
             │                               continent/ocean name, gated on
             │                               ground-truth isOcean flag
             │
             ├── lib/ignitionPolicy.js       canIgniteSurface(isOcean)
             │                               + status copy
             │
             ├── lib/elevationField.js       Open-Meteo /v1/elevation
             │                               request build, bilinear
             │                               expansion, cache key, timeout
             │
             ├── lib/scenarioInterpretation  Compass, elevation range,
             │                               "spread is mostly radial"
             │                               copy generator
             │
             ├── lib/scenarioRecords.js      localStorage-backed run
             │                               history, delta comparator
             │
             └── workers/fireWorker.js  ─── postMessage bridge
                        │
                        └── lib/fireSimulation.js   The cellular model
                            lib/fireSimulation.test.js
```

`fireSimulation.js` is the incumbent physics module. Everything on the
prompt's realism ladder either replaces it or plugs around it under a
feature flag.

---

## 3. Data & convention contract (as-currently-observed)

The following is what the code actually does *today*. Any of it that
conflicts with a later realistic implementation must be resolved by
Phase 1's data contracts, not silently drifted.

### Grid & timestep

| Property | Value | Where set |
|---|---|---|
| Grid | 128 × 128 cells | `fireSimulation.js:54` (`size` default) |
| Cell size | **1 km** (metrics), **4 km** (worker default) | `fireWorker.js:12` uses `config?.cellSizeKm ?? 4`; `getMetrics(cellSizeKm=1)` default |
| Field extent | 128 × cellSizeKm km | `getMetrics` returns `fieldWidthKm = gridSize * cellSizeKm` |
| Timestep | 1 model minute per tick | `getMetrics(timestepMinutes=1)` default |
| Wall clock | 60 ms per interval, N steps per tick | `fireWorker.js:37`, N derived from `config.speed` |

> **⚠ Finding F1 (documented, unresolved).** `cellSizeKm` is not
> consistent between the worker default (`4`) and the metrics default
> (`1`). The metrics presented to the UI therefore use a 1 km cell while
> the worker labels its runs 4 km. Phase 1's `spatialGrid.js` owns the
> authoritative field extent and both call sites reference it.

### Coordinates

- `cartesianToLatitudeLongitude(point)` maps a point in FBX-mesh space to
  WGS-84 lat/lon, with a hardcoded `FBX_LONGITUDE_OFFSET_DEGREES = -90`
  offset for the mesh's zero-meridian orientation.
- `uvToLatitudeLongitude(uv)` treats `v` as running South → North after
  the FBX flipY, `u` as W → E.
- `terrainSampler.isOceanAtUv(u, v)` inverts `v` again (`row = (1-v)*H`)
  because the sampler works from the source image, where row 0 is the
  north pole. This inversion is the sampler's local concern, correct as
  wired.

### Wind

- Slider: `0..60` **km/h**, direction `0..359°`.
- `windDirection` is normalized into `[0, 360)` and consumed via
  `Math.cos(windDirection)` / `Math.sin(windDirection)` — this is a
  **math convention** (0 rad = +x, CCW), *not* the meteorological
  convention (0° = from north).
- Wind is a scenario knob only; no measurement height, no midflame
  adjustment.

> **⚠ Finding F2.** Wind direction convention is math-axis, not compass.
> `formatCompassDirection` labels the *spread bearing* correctly, but the
> user-facing slider labeled `DIRECTION 045°` is silently interpreted as
> "45° from +x axis in the tangent plane", not "from northeast" as a
> compass user would expect. Phase 1 unifies on the compass convention.
>
> **⚠ Finding F3.** No wind-measurement height is recorded and no
> midflame adjustment is applied. Rothermel expects midflame wind.
> Phase 2 `weatherInputs.js` owns this.

### Moisture & slope

- Moisture: `0..100%` slider, stored as `0..1`. It is a scenario knob —
  the code does not distinguish 1-h/10-h/100-h dead fuel moisture, live
  moisture, or measured vs. estimated.
- Slope: `0..100%` slider, stored as `0..1`. There is no per-cell slope
  or aspect derived from elevation; the "slope scenario" hard-codes
  `{x: 0, y: 1}` in `makeSlopeVector`.

> **⚠ Finding F4.** The real elevation field (Open-Meteo GLO-90) is
> passed to `fireSimulation` as `terrainHeights`, but its influence on
> spread goes through a single `terrainGradient` term (`(neighbor - self)
> / 20` clamped to ±1) — not through a proper slope/aspect derivation.
> Phase 1 `terrainDerivatives.js` computes slope magnitude in
> meters-per-meter and aspect as a unit vector.

### Fuel

- Three presets in `FUEL_PRESETS`: `grass` / `brush` / `timber`, with
  arbitrary `fuel` load values (1.28 / 1.0 / 0.76) and burn durations
  (8 / 13 / 21 minutes).
- No surface-area-to-volume ratio, no fuel-bed depth, no heat content,
  no moisture of extinction, no size-class breakdown. These are the
  parameters Rothermel requires.
- Land cover is **not** used. The same three presets apply globally.

> **⚠ Finding F5.** Fuel is three arbitrary tuning knobs, not a
> versioned fire-behavior fuel-model table with citations. Phase 2
> `fuelModels.js` replaces this.

### Spread math

`fireSimulation.js:133–163` is the hot loop. Neighbor spread is
```
0.24 * neighborFuel * dryness * windFactor * slopeFactor
     * terrainFactor * distanceWeight
```
with all factors bounded (`clamp(..., 0.24, 5.2)` for wind, etc). This
is a heat-accumulation model, not a rate-of-spread model. It produces
plausible-looking growth patterns and passes its own test suite for
directional properties (wind pushes downwind, moisture reduces area,
etc.), but the coefficients are tuned, not derived.

> **⚠ Finding F6.** Spread is probability-per-neighbor, not physical
> travel time between cells. Phase 4 replaces this with a documented
> arrival-time or front-propagation method built on the Rothermel local
> kernel from Phase 3.

### Weather / moisture data

Not fetched. Weather is scenario-preset only. The stack currently has
no Open-Meteo weather integration — only elevation.

### Elevation

- Endpoint: `https://api.open-meteo.com/v1/elevation`
- Grid: 10 × 10 samples, bilinearly expanded to the 128 × 128 field
- Cache key: `latitude.toFixed(2) : longitude.toFixed(2) : spanKm`
  (~1 km resolution at equator; coarser toward the poles)
- Source label: `"Copernicus GLO-90 via Open-Meteo"`
- Missing values throw and the simulation falls back to no-terrain
  (`terrainAvailable: false` in the frame)
- Bare-earth vs. digital-surface model distinction is documented in
  [`docs/research/elevation-source.md`](research/elevation-source.md)
  but not exposed to the UI

> **⚠ Finding F7.** No-data behavior is handled (fallback path exists),
> but a *stale-cache* return is currently indistinguishable from a fresh
> fetch — cache values have no timestamp. Phase 1 data contract adds a
> fetched-at timestamp to every terrain sample.

### Worker message contract

Main → worker:

```js
{ type: 'start',  config: { size, seed, params, scenario, ignition, terrainHeights, cellSizeKm, timestepMinutes, speed, runId } }
{ type: 'update', scenario?, params? }   // triggers a full restart (rebuilds grid)
{ type: 'pause' }                        // toggles paused flag
{ type: 'stop' }                         // clears timer + simulation
```

Worker → main:

```js
{ type: 'frame', runId, frame: Uint8Array(RGBA), size, stepCount,
  burnedCount, activeCount, terrainAvailable, metrics, paused }
```

The `frame` buffer is **transferred**, not copied. Zero-length or missing
metrics are not guarded on the main-thread side.

> **⚠ Finding F8.** `type: 'update'` restarts the whole simulation with
> a new grid rather than mutating the running one. This is safe (idempotent
> given seed+params+ignition) but is **not** what "update" implies to a
> reader. Phase 1 renames or splits this into `configure` + explicit
> `restart`.

### Rendering

The 128 × 128 RGBA frame is rendered as a Three.js texture over the
tangent-plane region of the globe. Colors:

| Cell state | RGB | Alpha |
|---|---|---|
| 0 (unburned) | invisible | 0 |
| 1 (heating)  | (255, 62, 12) | 18–190 by heat |
| 2 (flaming)  | (255, 48+heat, 8+heat) | ≥80 |
| 3 (burned)   | (152, 26, 4) | 20–110 |

This palette is honored by the CSS legend swatches (`ember`, `ember-dim`,
`ember-soft`). Change one, change the other.

---

## 4. Prompt-rule compliance snapshot

Each row is a rule from
[the handoff prompt § 2](realistic-fire-model-claude-code-prompt.txt),
compared against today's code.

| # | Rule | Status | Note |
|---|---|---|---|
| 1 | Not called a forecast | ✅ | `EDUCATIONAL CELLULAR MODEL · NOT A FORECAST` visible |
| 2 | No LLM/NN as engine | ✅ | Deterministic cellular loop |
| 3 | No invented values silently filling in gaps | ⚠︎ | Moisture/wind/slope are scenario knobs *labeled as* measurements in the metadata block; F2/F3/F5 |
| 4 | No implied 90 m / 1 km precision beyond inputs | ⚠︎ | Metadata says `1 km cells · 128 km field` while inputs (weather) are absent and elevation is 90 m; F1 |
| 5 | No equations copied from memory | ✅ | No physics equations yet to copy |
| 6 | No silently mixed coord/direction systems | ⚠︎ | Wind direction convention is math-axis, labeled as compass; F2 |
| 7 | No crown / spot / ember / suppression / smoke | ✅ | None implemented |
| 8 | No new deps / deletions / model wholesale replacement w/o approval | ✅ | Phase 0 changes nothing |
| 9 | Existing model behind feature flag as fallback | ❌ | No flag exists yet — Phase 1 milestone |
| 10 | Insufficient evidence → experimental + explicit gaps | ⚠︎ | UI doesn't currently distinguish measured / modeled / estimated / synthetic per input; Phase 5 |

---

## 5. Documented limitations (goes into the UI eventually)

These are the honest current limits that Phase 5's limitations report
will inherit:

- **Global uniform fuel.** The same three presets apply everywhere on
  Earth. There is no land-cover / fuel-model crosswalk yet.
- **No weather fetch.** Wind, moisture, temperature, humidity are all
  operator-set sliders. Nothing is queried per-location.
- **Elevation is a coarse surface model.** ~90 m Copernicus GLO-90,
  including vegetation / structures, not bare earth. Fine for globe-scale
  behavior; not for building-scale terrain.
- **Cellular spread, not rate-of-spread.** Coefficients are tuned to
  behave directionally, not to reproduce Rothermel output.
- **No uncertainty.** A run is a single deterministic trajectory.
- **No historical validation.** Zero hindcast fixtures. Directional test
  properties are the only correctness signal today.
- **US-only naming fallback.** `locationLabel` has a US state catalog
  but no global admin-region catalog; non-US land clicks fall back to
  continent-name only.

---

## 6. Phase 1 proposal (for approval)

Phase 1's charter, per the prompt: *"Add spatial grid and terrain
derivative modules. Harden data schemas, timestamps, cache keys,
stale-data policy, no-data masks, and source attribution. Use feature
flags; keep the current model as fallback. Add tests and browser checks
before touching spread physics."*

**Concrete plan I'd propose, all test-first:**

1. **`src/lib/spatialGrid.js`** (new)
   - `createSpatialGrid({ latitude, longitude, cellSizeMeters, gridSize })`
   - Owns: tangent-plane origin, cell-center coordinates, row/col
     convention, cell → lat/lon and lat/lon → cell round-trips,
     antimeridian & polar edge cases.
   - Tests: round-trip within tolerance, antimeridian window at ±180°,
     high-latitude cell aspect ratio, cell-center vs. cell-edge disambig.

2. **`src/lib/terrainDerivatives.js`** (new)
   - `computeSlopeAspect(elevationField, spatialGrid)` → per-cell
     `{ slopeRadians, aspectVector }` from finite differences in meters.
   - Explicit no-data propagation; missing DEM cells produce `NaN` slope,
     never a measured zero.
   - Tests: flat terrain → 0 slope, planar N/S/E/W slopes → correct
     aspect, one-cell ridge, missing-cell mask preserved.

3. **`src/lib/scenarioInput.js`** (new, versioned schema)
   - The location-dependent object described in the prompt § 4:
     WGS-84 point, grid origin/orientation, resolutions, elevation
     source+timestamp+datum, land-cover/weather placeholders, model
     version, feature flag, seed.
   - This is the object every downstream module reads from; Phase 2
     fills in fuel and weather fields, Phase 3 consumes them.

4. **Feature flag plumbing**
   - `SIMULATION_ENGINES = { legacy: current, phase1: new-with-grid }`
   - Main thread selects one, worker gets it in `config.engine`.
   - The current cellular model runs unchanged behind `engine: 'legacy'`
     and stays the app default until Phase 4 finishes.

5. **Elevation cache hardening**
   - Add `fetchedAt` timestamp and `source` block to cache entries.
   - `isStale({ fetchedAt, ttlMs })` helper.
   - Metadata line in the UI shows the timestamp (defer to Phase 2).

6. **Worker message rename**
   - `type: 'update'` → `type: 'configure'` (restart-in-place semantics
     stay identical; just remove the reader's surprise).
   - `type: 'restart'` becomes explicit.

7. **Tests before touching UI**
   - Every new module gets its own `.test.js` with the properties above.
   - `main.js` gains no new behavior in Phase 1 beyond reading the flag
     and passing the scenario-input object.

**Definition of done for Phase 1:**

- All existing 26 tests still green.
- New modules add ~15–25 more tests, all green.
- `npm run build` passes with no new warnings.
- Browser smoke: existing scenario-lab run behaves *identically* on
  `engine: 'legacy'` (compared byte-for-byte where possible; visual
  parity otherwise).
- No user-facing UI change except a tiny `Engine: legacy` line in
  scenario-basis metadata so the flag is visible.

**Stop conditions:**

- If any elevation-source or wind-direction rework would silently
  change legacy-engine output, I stop and ask.
- If a Phase 1 test would require an equation I have not verified
  against Rothermel/Behave sources, I stop and defer it to Phase 3.

---

## 7. What is *not* in scope this phase or next

Just so the boundary is legible:

- No Rothermel kernel (Phase 3).
- No arrival-time propagation (Phase 4).
- No ensembles / uncertainty (Phase 5).
- No crown fire, spotting, embers, suppression, smoke (deferred until
  the surface core passes its gates).
- No LANDFIRE ingest or global land-cover crosswalk (Phase 2, and only
  as a *low-confidence* map with explicit source labeling).
- No visual redesign. The mission-control skin stays.

---

## 8. Reproducing this baseline

```bash
npm test       # → 26 pass
npm run build  # → clean, 521ms, 643 KB main chunk warning (Three.js)
npm run dev    # → http://127.0.0.1:5174
```

Manual smoke:

1. Wait for the globe to load (loading pill disappears).
2. Click any ocean pixel → panel shows the ocean name and
   `WATER SURFACE · NO IGNITION`; no worker start.
3. Click any land pixel → panel shows the nearest place label + DMS
   coordinates; ember marker is placed; if visible on a coastline the
   land/ocean flip happens within one pixel of the shore.
4. Click on land → scenario controls activate, model time and burned
   area advance, interpretation copy names the dominant driver.

If any of the above regresses in a Phase 1 change, that change is
wrong. Roll back and diagnose before advancing.
