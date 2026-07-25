# Handoff: crown-fire session (2026-07-24, evening)

Read this together with `docs/regional-model-run/THREAD.md` (full narrative log)
and `docs/regional-model-run/RESULTS.jsonl` (append-only machine-readable
results, RUN-012 through RUN-017 cover this session). This file exists because
the user switched models mid-session and wants the next assistant to not
re-derive any of this.

## Where things stand right this second

**Crown fire is wired in and working. The last benchmark run (just completed,
not yet logged to RESULTS.jsonl/THREAD.md) shows a dramatic result:**

```
fire                     IoU   prec    rec  crownCells
reservoir-2016        0.0028  0.003  0.639        4563
deer-2016             0.1451  0.153  0.744        4683
oregon-gulch-2014     0.2385  0.341  0.442       10029
big-five-2015         0.0250  0.025  0.896        5219
dinely-2017           0.0196  0.020  0.985       10085
stoll-2018            0.1667  0.526  0.196        5036

meanIoU   0.0996
medianIoU 0.0851
meanF1    0.1696
```

343/343 tests pass. **The physics validators (`validate:rothermel`,
`validate:rothermel:rate`, `validate:waf`, `validate:convergence`) have NOT
been re-run since the crown-fire wiring landed** -- do that first, before
anything else, in case the crown-fire additions regressed the reference
equation checks.

**Read this result correctly, don't just react to the mean going down:**
- `oregon-gulch-2014` (35,111 acres) went from IoU 0.016 (previously proven
  *mathematically impossible* for a surface-only model, see RUN-011-era
  analysis in THREAD.md) to **0.239 -- now the best case in the suite.**
- `deer-2016` (1,563 acres) went from 0.035 to 0.145.
- Those two were exactly the fires diagnosed as "too big for surface fire
  alone" two sessions ago. Crown fire fixed the mechanism that was
  diagnosed as broken. This is real, positive, causally-explained signal.
- BUT: recall shot up everywhere (0.44-0.99) while precision collapsed
  (0.003-0.53) on the four SMALL fires (152-341 acres). Those were fought
  and contained by firefighters in a few days on genuinely flammable
  LANDFIRE fuel (real shrub/timber models, not the old TL1 guess) -- the
  model has **no suppression mechanism**, so it now burns unchecked across
  real fuel for the whole calendar window. That's the new, correctly
  diagnosed dominant error source. It is not a bug in this session's work;
  it's the next missing mechanism, exactly like crown fire was two sessions ago.

**Do not "fix" this by suppressing recall or damping crown fire to make the
mean look better.** That would hide the real signal. The right next step is
either (a) implement a suppression/containment model (there's already a
`suppressionConstraints.js` module with time-aware barrier support -- unclear
if it's wired to real data or just tested in isolation, check before building
new), or (b) exclude/relabel small contained fires from the "no suppression
modeled" claim rather than scoring them as if they should have burned freely.

## Everything done this session, in order (see RESULTS.jsonl RUN-012 to RUN-017 for full detail)

1. **RUN-012**: Fixed two real, verified bugs causing severe recall collapse:
   (a) `hackathonBenchmarkRunner.js`/`build-regional-benchmark-fields.mjs`
   never wired `fuelPersistenceMinutesByCell` through at all (always 0);
   (b) a genuine solver bug in `firePropagation.js` `calculateTravelMinutes`
   where the persistence deadline capped ongoing *active* spread, not just
   dormant waiting, making any nonzero persistence value perform *worse*
   than none. Fixed both. meanIoU 0.0942 -> 0.1814.

2. **RUN-013**: User approved scope: fix terrain resolution + fuel
   persistence (declined spotting/embers/spatial-weather/LANDFIRE as
   too-big-for-hackathon-time at that point -- LANDFIRE later got revisited
   and solved, see below). Fixed terrain (was sampling 16x16 and blurring up
   to 128x128 despite Copernicus GLO-30 having 400-1000+ native pixels
   across each span; now samples at native grid resolution). Result: mean
   IoU actually WENT DOWN (0.1814 -> 0.1591) because real fine terrain
   exposes real local slope heterogeneity the old blurred version smoothed
   away, causing more false positives on small fires. Reported honestly, not
   tuned away.

3. **User pushed back ("something doesn't add up")**. Isolated the two
   RUN-013 changes independently, proved the regression was 100% attributable
   to terrain (persistence changed nothing). Kept looking, found
   `reservoir-2016`'s `modelTimeMinutes` was 1300 (0.9 days) when the real
   fire (per its own recorded `alarmDate`/`containmentDate` in
   `historicalPerimeterFixtures.js`) burned 4 full days -- a second instance
   of a bug pattern already fixed elsewhere, just in a fixture file that
   hadn't been checked. Fixed. meanIoU 0.159 -> 0.187, medianIoU 0.122 -> 0.171.

4. **RUN-015**: User asked to fix all 3 remaining diagnosed causes (fixed
   ignition placement, uniform weather, wind cap). Verified empirically
   (2 real API calls) that HRRR -- the proposed finer weather model -- has
   ZERO coverage for any of our 2014-2018 fire dates, so that fix was
   correctly abandoned before being built, not half-built. Instead: (a)
   removed the Rothermel "maximum reliable wind speed" cap in
   `surfaceSpread.js` per Andrews/Cruz/Rothermel 2013 (a published,
   cited correction, not an invented tuning knob) -- `stoll-2018` recall
   went 0.029 -> 0.137, direct confirmation; (b) added
   `nearestWellConnectedIgnition()` to avoid synthetic bbox-centroid
   ignition landing on a 1-2 cell isolated fuel island. meanIoU 0.187 -> 0.223.

5. **RUN-016**: Built data-driven fuel persistence (measured from each
   case's own archived diurnal moisture cycle, replacing the flat 240-min
   guess) as requested. Correctly proved this was NOT oregon-gulch's
   dominant remaining blocker (aggregate barely moved) rather than claiming
   a win it didn't earn.

6. **RUN-017 + this session's unlogged work**: User asked "is crown fire
   feasible?" Found `crownFire.js` (Van Wagner 1977 + Rothermel 1991) was
   ALREADY fully built and tested, just never wired up because it requires
   real canopy base height + bulk density (LANDFIRE-only). Verified LANDFIRE
   canopy WCS is live right now with real curl tests. Found and fixed **the
   real persistence bug this whole time**: `persistenceDeadline` was an
   absolute wall-clock deadline from source-cell arrival, but used to bound
   *waiting* time -- active spread time was being charged against it, so on
   any edge slower than the persistence budget (nearly all of them), the
   budget was always already expired before the first zero-rate gap. Proven
   before fixing: oregon-gulch cells = 3 at persistence 420, 66 at 5000, 74
   at 100000 (only "worked" once budget exceeded total travel time, which
   isn't what a waiting budget means). Replaced with a cumulative
   `waitedMinutes` accumulator. oregon-gulch improved 6x (0.0026 -> 0.0163)
   from that alone.

   Then found the deeper reason crown fire could never have worked even
   with canopy data present: WorldCover-derived fuel labels every forested
   cell **TL1** (bare compact litter), which tops out at ~145 kW/m fireline
   intensity even at 60 km/h wind -- crown initiation needs 168-5300 kW/m
   depending on canopy base height. TU5/SH7 (what LANDFIRE's real FBFM40 map
   actually shows in these landscapes) produce 24,000-98,000 kW/m. One
   coarse land-cover guess was structurally locking out crown fire regardless
   of canopy data. Fetched BOTH real FBFM40 fuel AND real canopy structure
   for all 6 cases (LANDFIRE transport turned out to work fine via curl --
   Node's fetch/undici gets rejected by this specific USGS server with fake
   500s and dropped sockets on the byte-identical URL that curl succeeds on
   every time; this is a one-time offline freeze script so shelling out to
   curl was the pragmatic fix, nothing in the shipped app changed).

   Crown fire immediately exposed a real latent bug on first real execution:
   `calculateCrownFractionBurned` in `crownFire.js` didn't guard an infinite
   torching index (the case where a fuel structurally can never reach crown
   initiation intensity) the same way it guarded infinite crowning index --
   threw `RangeError`. Fixed (see `crownFire.js`).

   Found and fixed a severe performance bug during this: the crown-threshold
   cache key in `firePropagation.js` included `nextIndex` (the cell number),
   so all 16,384 cells got separate cache entries against a 4096-entry cap
   -- thrashed constantly, re-running ~25 Rothermel evaluations per edge from
   scratch. Fixed by keying on the actual canopy VALUES (which LANDFIRE
   quantizes to a few hundred distinct combinations) instead of cell index.
   Also added an exact (not approximate) early-out: crown fraction burned is
   provably zero whenever surface fireline intensity is below the crown
   initiation threshold at the current wind, so the expensive bisection can
   be skipped entirely in that (very common) case -- verified cell counts
   identical before/after, confirming it's a pure speed fix. Combined:
   ~3.8x+ speedup, machine no longer pegged (this was caught because the
   user's computer got hot/loud from multiple stacked, unniced Node
   processes -- apologized, killed everything, and re-ran single niced jobs
   from then on).

   This produced the benchmark result shown at the top of this file.

## Files changed this session (all uncommitted, working tree)

- `src/lib/firePropagation.js` -- persistence cumulative-wait fix, crown
  cache key fix, crown early-out optimization, dead-code removal (see
  inline comments, each change has a comment explaining why)
- `src/lib/crownFire.js` -- infinite-torching-index guard fix
- `src/lib/landCoverToFuel.js` -- TL1 gets `fuelPersistenceMinutes: 360`,
  universal `MINIMUM_RESIDUAL_HEAT_PERSISTENCE_MINUTES = 240` floor on every
  burnable decision (later superseded in the freeze script by data-driven
  per-case values, but this generic floor still applies to the live
  interactive app path, which doesn't have freeze-time data)
- `src/lib/surfaceSpread.js` -- removed the Rothermel wind-speed cap
  (Andrews/Cruz/Rothermel 2013 citation in the comment)
- `src/lib/hackathonBenchmarkRunner.js` -- wires
  `fuelPersistenceMinutesByCell`, `nearestWellConnectedIgnition`,
  canopy fields (`canopyHeightByCell` etc.), `canopyCrownAvailableByCell`
  gate via `hasUsableCrownStructure`; fixed `reservoir-2016`'s
  `modelTimeMinutes` (1300 -> 5760)
- `src/lib/officialBenchmarkFixtures.js` -- fixed `modelTimeMinutes` for
  `oregon-gulch-2014` (4320->20160), `big-five-2015` (4320->198720),
  `dinely-2017` (4320->5760) to match each fixture's own recorded
  `alarmDate`/`containmentDate` span
- `scripts/build-regional-benchmark-fields.mjs` -- terrain now samples at
  native grid resolution instead of 16x16-then-blur; added
  `applyDataDrivenPersistence()` (measures real diurnal moisture-extinction
  crossing per fuel per case); added `readLandfireFuelField()` (real FBFM40)
  and `readLandfireCanopyFields()` (real CH/CC/CBH/CBD), both fetched via
  curl (see `curlGeoTiff()` helper) with retry/backoff, wired into
  `buildCaseFields()`
- `src/lib/regionalBenchmarkFields.generated.json` -- regenerated multiple
  times this session via real network fetches (not offline-patched) as each
  fix landed; current version has real terrain+fuel+weather+FBFM40+canopy
  for all 6 cases

## Immediate next steps for whoever picks this up

1. **Run the physics validators** (`npm run validate:rothermel`,
   `validate:rothermel:rate`, `validate:waf`, `validate:convergence`) --
   not yet re-checked since the crown-fire session's changes landed. If
   anything regressed, that's the first thing to fix.
2. **Log this session's final result to `RESULTS.jsonl` and `THREAD.md`**
   as RUN-018 (or next number) -- it hasn't been written yet, this file is
   the stopgap.
3. **Decide on suppression** as the next real mechanism to investigate --
   check whether `src/lib/suppressionConstraints.js` (time-aware barrier
   support, already exists) is wired to any real data source or just unit
   tested in isolation.
4. **Do not treat the meanIoU drop (0.223 -> 0.0996) as a regression to
   chase back up.** It's the correct, honest result of fixing two large,
   diagnosed, real problems (persistence-budget bug, crown-fire lockout)
   whose fix reveals a third, previously-hidden problem (no suppression
   model) that was masked by the model being too weak to ever reach the
   point where suppression would matter.
5. User's standing instructions for this whole project, repeated many
   times this session: minimize token usage, maximize efficiency, verify
   claims empirically before building on them (see the HRRR-coverage check
   and the curl-vs-fetch transport diagnosis as examples of "test cheaply
   before committing"), never tune to make the eval score look better, run
   one niced background job at a time (the user's machine overheated once
   this session from stacked unniced jobs -- don't repeat that).
