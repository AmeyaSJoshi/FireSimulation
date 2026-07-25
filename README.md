# IGNIS — Global Fire Simulation

A physics-based wildfire spread model with an interactive globe. Click anywhere
on Earth and it fetches real land cover, terrain, and weather for that location,
then propagates fire using published fire-science equations — not a game
heuristic or a cellular-automaton approximation.

**Status: research prototype.** Benchmarked against 9 historical US fire
perimeters. Honest about what it cannot do (see *Known limitations*).

---

## ⚠️ Read this first if you are an AI agent

**Accuracy today: ~0.27 IoU on free-burning fires** (recall 0.90–0.95, with a
consistent ~2.5–3× area over-prediction). Operational models sit at 0.40–0.60.
The headline blended figure is 0.0996 — see *Accuracy* for why the tiers matter.

**These avenues are CLOSED. Do not re-attempt them without new information —
each was investigated, measured, and logged.**

| avenue | outcome | where |
|---|---|---|
| Suppression modelling | No reachable dated perimeter-progression source. Engine exists, data does not | RUN-019/019b |
| Spotting / embers | Measured **harmful twice**, under opposite conditions (0.192→0.152 and 0.224→0.166). Module is sourced and correct; embers are not the constraint | RUN-021, RUN-023 |
| Active-burn duration from weather | Already handled — `surfaceSpread.js` zeroes rate above moisture of extinction and the solver skips those windows | RUN-022 |
| Global canopy bulk density | Not derivable — FCCS carries cover/height/crown-base but **no crown biomass load** | RUN-023 |
| Terrain wind downscaling | No usable closed form. WindNinja's effect emerges from a full PDE solve; Jackson & Hunt needs hill geometry not in the pipeline; Ryan (1977) is diurnal slope wind, a different phenomenon | RUN-024 |
| ML-fitted fuel crosswalk | Scoped, recommended **against**: too few fires, only 1–2 land-cover classes represented, and fitting would absorb the known ERA5 wind error into fuel parameters | RUN-024 era |
| Finer weather (HRRR) | Zero coverage for 2014–2018 dates | RUN-016 |

**The single biggest lesson, learned the hard way:** oregon-gulch-2014 scored
0.239 and was celebrated as the project's best result. It was **compensating
errors** — a spread rate ~5× too slow paired with a model window ~5× too long.
Satellite data contradicted an input nobody had questioned. *A good score is not
evidence of good physics.* Audit inputs, not just outputs.

**What actually improved accuracy this session:** adding benchmark cases. No
model change; measured accuracy went 0.19 → 0.27 because the old estimate rested
on two fires. Measurement, not mechanism, was the binding constraint.

**Known-suspect inputs still unaudited** (each could hide the same class of
compensating error): synthetic bbox-centroid ignition points on 5 of 6 default
cases; 2024-vintage LANDFIRE fuel applied to 2012–2018 fires; ERA5 wind averaged
over ~31 km.

**Current bottleneck:** spread *rate* is ~5× too slow on large fires. This is a
rate deficit, not a missing mechanism — adding spread-producing mechanisms has
been measured as counterproductive twice. Wind resolution is the leading
suspect and is unresolved (see *Next step*).

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

**An `expansion` split (RUN-023) adds three large free-burning wilderness
fires**, kept out of the default splits so the six-case numbers above stay
comparable across all prior runs:

| fire | acres | IoU | recall |
|---|---|---|---|
| trinity-ridge-2012 | 146,742 | 0.378 | 0.953 |
| chips-2012 | 76,350 | 0.307 | 0.900 |
| rough-2015 | 151,546 | 0.303 | 0.927 |

**On its intended regime the model is at roughly 0.27 IoU across five
free-burning fires, not the 0.19 the two-case tier implied** — recall 0.90–0.95,
with a consistent ~2.5–3× area over-prediction. The two-case estimate was
pessimistic; adding cases changed the number without changing the model.

### Correction: the crown-fire claim (RUN-023)

Earlier versions of this file cited crown fire taking oregon-gulch-2014 from IoU
0.016 → 0.239 as the project's largest accuracy win. **That was substantially an
artifact of compensating errors.** NASA FIRMS satellite detections (1,565 of
them — dense and trustworthy) show the real fire did 95% of its growth in
**3 days**, not the 15-day alarm-to-containment span the model was given. Given
its true 3-day window the model reaches **1% of the observed area**: it needs
~15 days to cover what the fire covered in 3, so its spread *rate* is roughly
**5× too slow** (~1.55 m/min required, ~0.29 m/min peak head rate available).

RUN-017's original verdict — that oregon-gulch is structurally impossible for
this model — was correct, and crown fire did not overturn it. A 5×-too-slow rate
paired with a 5×-too-long window merely made the total area look right. Crown
fire remains a real and necessary mechanism; it is the *headline number* that
was overstated.

## Known limitations (deliberate, not TODOs)

1. **No suppression model.** No reachable dated perimeter-progression data
   source exists — verified across multiple sources and networks (RUN-019/019b).
   This is why small contained fires are overpredicted.
2. **Spotting measured as harmful — considered settled.** `src/lib/spotting.js`
   (ELMFire empirical, sourced) is wired into the solver but **defaults OFF**.
   It was measured twice under opposite conditions and hurt both times: with
   calendar windows (free-burning 0.192 → 0.152) and again with corrected FIRMS
   windows (0.224 → 0.166). It does not move oregon-gulch at all. Embers are not
   this model's binding constraint.
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

**The remaining gap on large fires is spread RATE, not a missing mechanism.**
Matching oregon-gulch needs ~1.55 m/min sustained omnidirectional spread; the
model's peak head rate is ~0.29 m/min. Adding more spread-producing mechanisms
has now been measured as counterproductive twice (spotting), so the lever is
whatever makes the existing physics run faster and in the right direction.
Leading suspect: **wind**. ERA5's ~31 km grid was compared against RTMA's 2.5 km
for oregon-gulch and they disagree by up to **127° in direction and 4.3× in
speed** within one afternoon — but RTMA is US-only and a full-window ingest is
~20 GB, so this remains untested.

Also open, in rough value order:

- **FIRMS growth windows** (`scripts/firms-growth-window.py`) improve both tiers
  (+33% meanIoU) but destroy oregon-gulch, so they are kept as a reproducible
  experiment rather than written into the fixtures. A less crude rule — e.g.
  only applying them where detections are dense — may capture the gain without
  the loss.
- **Crown fire and spotting are both inert outside the US** — both gate on
  `canopyBulkDensityByCell`, which only LANDFIRE populates. A global canopy bulk
  density was investigated and found NOT derivable from the FCCS fuelbed (it
  carries cover, height, and crown base height, but no crown biomass load).
- **More free-burning benchmark cases.** Adding three changed the measured
  accuracy from 0.19 to 0.27 with no model change; the sample is still small.
