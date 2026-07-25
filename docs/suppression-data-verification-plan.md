# Suppression data verification — execution plan

**Goal:** decide GO / NO-GO on suppression modeling. This is a *verification*
task, not a build task. Ship an answer, not code. Budget: ~45 min.

**Do not** write suppression code, edit `suppressionConstraints.js`, or touch
`hackathonBenchmarkRunner.js` during this task. Verification only.

---

## Why this is small (read first, do not re-derive)

The data source is **already proven in this repo**. `historicalProgressionFixtures.js`
contains `RUSH_CREEK_PROGRESSION` — dated perimeter observations
(`capturedAt`, `reportedAcres`, geometry) successfully fetched from:

```
https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_FireOccurrenceAndPerimeter_01/MapServer/11
```

That is exactly the data shape suppression needs (a perimeter that stops
growing = containment observed). So the question is **not** "does containment
data exist anywhere" — it is **"does this already-working endpoint return
multi-date perimeters for our 6 fires?"**

Do not survey NIFC, GeoMAC, or InciWeb. Only fall back to another source if
step 2 fails, and only the one named in step 4.

## The 6 cases

| id | state | alarm → containment | span |
|---|---|---|---|
| oregon-gulch-2014 | OR | 2014-07-30 → 2014-08-13 | 14 d |
| deer-2016 | — | (in `historicalPerimeterFixtures.js`) | — |
| reservoir-2016 | — | (in `historicalPerimeterFixtures.js`) | 4 d |
| big-five-2015 | CA | 2015-06-17 → 2015-11-02 | 138 d |
| dinely-2017 | CA | 2017-06-07 → 2017-06-11 | 4 d |
| stoll-2018 | CA | 2018-06-24 → 2018-06-24 | **0 d** |

**Pre-filter, free, no network:** `stoll-2018` has alarm == containment. A
same-day fire cannot have a multi-date progression — exclude it from
progression-based suppression now and say so. Do not spend a request on it.

---

## Steps

### 1. Get real field names (1 request, no guessing)

```bash
curl -s "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_FireOccurrenceAndPerimeter_01/MapServer/11?f=json" | python3 -c "import sys,json;print([f['name'] for f in json.load(sys.stdin)['fields']])"
```

Guessing field names then debugging a 400 costs more than this one call.

### 2. Query the 5 remaining fires by name + year

One request per fire. **`returnGeometry=false` is mandatory** — geometry blobs
are ~90 KB each and will blow the context for zero decision value. You are
counting dated records, not reading shapes.

```bash
curl -s "<layer11>/query?where=FIRENAME%20LIKE%20'%25<NAME>%25'%20AND%20FIREYEAR=<YYYY>&outFields=<name,date,acres,id fields from step 1>&returnGeometry=false&f=json"
```

Record per fire: **number of distinct perimeter dates**, and the date range.

### 3. Apply the decision rule

| Fires with ≥3 distinct perimeter dates | Verdict |
|---|---|
| 3 or more | **GO** — build suppression against real progression |
| 1–2 | **PARTIAL** — report which; do not build a 6-case mechanism on 2 fires |
| 0 | **NO-GO via this source** → step 4 |

### 4. Single fallback, only if step 3 = NO-GO

`California_fires_since_2014` (already referenced in this repo) covers 3 of 6:

```
https://services.arcgis.com/V6ZHFr6zdgNZuVG0/ArcGIS/rest/services/California_fires_since_2014/FeatureServer/0
```

Same query pattern, same decision rule. If this also returns 0 → **final
NO-GO**: report that suppression cannot be validated against these 6 cases,
recommend documenting it as a disclosed limitation (exactly as HRRR was), and
**stop**. A documented limitation is a valid, correct outcome here.

---

## Guardrails (this project's own hard-won rules)

- **Node `fetch` is unreliable against these USGS/USDA servers** — it gets fake
  500s and dropped sockets on byte-identical URLs that `curl` succeeds on every
  time. Use `curl`. This is documented in RUN-018; do not re-diagnose it.
- **Never print geometry.** Pipe every response through `python3 -c` to extract
  counts/dates only. One careless `curl | head` costs 90 KB of context.
- **Verify before building** (the HRRR precedent: 2 cheap API calls proved zero
  coverage and correctly killed a fix before it was half-built). Same here.
- **NO-GO is a real, acceptable answer.** Do not manufacture a data source, do
  not substitute alarm/containment dates for a progression and call it
  observed, do not proceed to build on 1–2 fires to avoid reporting a null.
- One niced background job at a time if anything long-running is needed.

## Deliverable

Append the result to `docs/regional-model-run/RESULTS.jsonl` as **RUN-019**
(match the existing entry schema exactly; `accuracyClaim: false`), plus a short
`THREAD.md` update. State the verdict, the per-fire date counts, and — if GO —
which fires qualify. Nothing else.
