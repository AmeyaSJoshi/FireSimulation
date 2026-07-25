# Spotting / ember transport — implementation plan

**Why this one:** pure physics, works identically worldwide, needs no country's
dataset. Same category as crown fire, which was the biggest accuracy win so far.

## The key design decision (read first)

The solver is **deterministic** — `firePropagation.js` runs Dijkstra over
arrival times. Real spotting is stochastic. Do **not** add random ignitions:
that breaks reproducibility, and every benchmark comparison in `RESULTS.jsonl`
assumes a deterministic run.

**Instead, model spotting as extra graph edges.** A high-intensity cell gets
additional long-range downwind edges whose traversal cost is the ember flight
time. Dijkstra already handles this — no solver rewrite, determinism preserved,
and it composes with crown fire and persistence for free.

## Physics: Albini (1979/1983) firebrand transport

Three stages, all computable from fields already present:

1. **Loft** — ember rise height from fireline intensity + flame height.
   `surfaceSpread.js` already returns `firelineIntensityKwPerM`; `crownFire.js`
   already returns crown fraction burned (torching trees are the dominant
   ember source).
2. **Transport** — downwind drift during fall, from midflame/20-ft wind and
   loft height. Terrain matters: spotting uphill and across canyons is why
   large fires jump barriers.
3. **Ignition on landing** — receptor cell must be burnable and below its
   fuel's moisture of extinction. Reuse the existing moisture fields; do not
   invent a new ignition-probability constant.

Maximum spot distance is the standard Albini closed form. Start there — it is
one function, well documented, and citable. No Monte Carlo.

## Scope: smallest thing that could work

- New module `src/lib/spotting.js`, one exported function returning max spot
  distance + flight time from (intensity, wind, canopy height, slope).
- Wire into `firePropagation.js` where neighbour edges are built: when a cell's
  intensity exceeds the torching threshold, add downwind edges out to the
  computed distance.
- **Gate it behind a flag defaulting OFF**, like crown fire was. Land the module
  + tests first, wire second, so a regression is attributable.

Explicitly NOT in v1: ember size distributions, Monte Carlo ensembles, spot
fire merging logic, firebrand density. Add only if v1 measurably falls short.

## Cost control (the machine runs hot)

Spotting adds long-range edges, which can blow up edge count. Two cheap guards,
both required:
- Only high-intensity cells emit — most cells never qualify, so the early-out
  is cheap (same trick as the crown-fire intensity early-out).
- Cap spot distance to a physical maximum and reuse the crown-threshold cache
  pattern: key on **values**, never cell index (that bug cost ~3.8x last time).

Never run the full suite to check this — run `node --test src/lib/spotting.test.js`
and the affected files only.

## Validation

1. Unit tests against published Albini worked examples (real numbers, not
   self-generated expectations).
2. `npm run validate:rothermel`, `:rate`, `:waf`, `:convergence` — spotting must
   not perturb surface-fire reference results at all.
3. Benchmark: judge on the **freeBurningComparable tier** (deer-2016,
   oregon-gulch-2014, currently meanIoU 0.192). The suppression-confounded tier
   will get worse — spotting adds spread, those fires were stopped by people.
   That is expected and is not a regression.
4. Log as the next RUN in `RESULTS.jsonl` + `THREAD.md`, result as-is.

## Expected outcome, stated before running

Spotting should help large fires and do little for small ones — same signature
as crown fire. If the free-burning tier does not move, say so plainly; a null
result is a valid deliverable and must not be tuned away.
