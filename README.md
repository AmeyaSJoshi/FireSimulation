# IGNIS — Global Fire Simulation

A physics-based wildfire spread model with an interactive globe. Click anywhere
on Earth and it fetches real land cover, terrain, and weather for that location,
then propagates fire using published fire-science equations — not a game
heuristic or a cellular-automaton approximation.

**Status: research prototype.** Validated against 6 historical US fire
perimeters. Honest about what it cannot do (see *Known limitations*).

---

## How fire spread is calculated

Four stages, each a real published model:

| stage | model | file |
|---|---|---|
| Surface rate of spread | **Rothermel (1972)** | `src/lib/surfaceSpread.js` |
| Wind at flame height | log wind profile + canopy adjustment (WAF) | `src/lib/weatherInputs.js` |
| Directional shape | elliptical head/flank/backing | `src/lib/fireEllipse.js` |
| Crown fire | **Van Wagner (1977)** initiation + **Rothermel (1991)** crown rate | `src/lib/crownFire.js` |

**Propagation is a shortest-path solve, not a cellular automaton.**
`src/lib/firePropagation.js` runs Dijkstra over the grid computing *arrival
time* per cell; each edge costs distance ÷ directional spread rate at that
moment. This is why time-varying weather works naturally, and why a cell can lie
dormant through a zero-spread night and reignite later (`waitedMinutes`
accumulator).

Two details that cause most confusion:

- **Canopy sheltering is strong.** Wind adjustment factor under closed canopy is
  **0.2** — 25 km/h open wind becomes 5 km/h at flame height. Forests genuinely
  need high wind to spread.
- **A 0 km² result is usually correct physics**, not a bug: either the ignition
  cell is non-burnable (rock/water), or spread rate is too low to cross one
  500 m cell inside the model window. The UI now states which.

## Data sources

| input | source | coverage |
|---|---|---|
| Land cover | ESA WorldCover 2021 (10 m) | 🌍 global |
| Terrain | Copernicus GLO-30 | 🌍 global |
| Weather | ERA5 reanalysis (~31 km, hourly) | 🌍 global |
| Fuel model (benchmark) | LANDFIRE FBFM40 | 🇺🇸 US only |
| Canopy structure (benchmark) | LANDFIRE CH/CC/CBH/CBD | 🇺🇸 US only |

The global path crosswalks 11 WorldCover classes → Scott & Burgan fuel models
(`src/lib/landCoverToFuel.js`). The benchmark path uses real LANDFIRE data.
**Finer weather (RTMA, RAWS, gridMET) is deliberately not used — all are US-only
and would not improve a global model.** ERA5's coarseness is the price of
worldwide coverage.

## Accuracy

Benchmarked against 6 historical fires. Results are reported in **two tiers**,
because four of the six were contained by firefighters and this model has no
suppression mechanism — scoring them as free-burning compares against a quantity
the model does not attempt to predict.

| tier | cases | meanIoU |
|---|---|---|
| **Free-burning** (model actually attempts these) | deer-2016, oregon-gulch-2014 | **0.192** |
| Suppression-confounded | reservoir, big-five, dinely, stoll | 0.054 |
| Headline (all 6, blended) | | 0.0996 |

Tier assignment uses **observed final area only** (< 2 km² ceiling) and never
reads model output, so it cannot be tuned to flatter a result. Nothing is
excluded — both tiers are reported alongside the blended figure.

Biggest win so far: crown fire took oregon-gulch-2014 (35,111 acres) from IoU
0.016 → **0.239**, a fire previously proven *mathematically impossible* for a
surface-only model.

## Known limitations (deliberate, not TODOs)

1. **No suppression model.** No reachable dated perimeter-progression data
   source exists — verified across multiple sources and networks (RUN-019/019b).
   This is why small contained fires are overpredicted.
2. **Spotting / ember transport not wired in.** `src/lib/spotting.js` exists and
   is tested but is NOT connected to the solver. It contains one **invented
   constant** (`LOFT_HEIGHT_TO_FLAME_LENGTH_RATIO = 30`), labelled as such —
   being replaced with a sourced plume-rise formulation.
3. **No plume / fire-atmosphere coupling.**
4. **ERA5 at ~31 km** cannot resolve local wind events that drive real runs.
   HRRR was checked and has zero coverage for these 2014–2018 dates.
5. **The benchmark is 6 US fires**, so global improvements are currently
   unfalsifiable.

## Running it

```bash
npm install
npm run dev          # http://127.0.0.1:5174
```

Click the globe to ignite. **Raise the wind slider above ~20 km/h** — at the
default calm setting almost nothing crosses a 500 m cell in the model window.

### Validation

```bash
npm run validate:rothermel        # vs BehavePlus reference points
npm run validate:rothermel:rate
npm run validate:waf
npm run validate:convergence
```

Run these after touching any spread/propagation code.

⚠️ **`npm test` takes 8+ minutes and runs hot.** Prefer targeted files:
`node --test src/lib/<file>.test.js`

## Project rules (these are enforced, not aspirational)

- **Never tune to make the benchmark look better.** Report results as-is,
  including regressions. A null or NO-GO result is a valid deliverable.
- **Verify a data source exists before building against it.** The HRRR and USDA
  EDW checks both correctly killed work before it started.
- **Never invent physical constants.** If one is unavoidable, label it clearly
  as unsourced (see the spotting ratio above).
- Use `curl`, not Node `fetch`, for USGS/USDA/LANDFIRE hosts — they reject
  undici with fake 500s on URLs curl fetches fine.
- One `nice`d background job at a time.

## Where the history lives

Don't re-derive past results — grep these first:

- `docs/regional-model-run/RESULTS.jsonl` — machine-readable per-run log
  (`run`, `change`, `verification`, `interpretation`)
- `docs/regional-model-run/THREAD.md` — narrative, one section per run
- `docs/regional-model-run/{BASELINE,APPROACH-REGISTRY,REJECTED}.md`
- `CLAUDE.md` — context-bomb file list + safe query patterns. **Read before
  opening large files**; several are single-line multi-hundred-KB blobs that
  will flood a context window.

## Next step

Wire spotting into `firePropagation.js` as deterministic long-range downwind
graph edges (never random ignitions — the solver is deterministic and every
benchmark comparison depends on that). Plan: `docs/spotting-implementation-plan.md`.
Judge it on the free-burning tier; the suppression-confounded tier will get
worse, which is expected.
