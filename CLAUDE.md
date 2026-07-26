# Fire Simulation — working notes for Claude Code

## Simulation contract — do not change without telling both devs

`src/sim/runFromClick.js` exports `runFromClick({ lat, lon })`, resolving to:

```js
{
  arrivalMinutes: Float32Array(4096),  // row-major gridSize x gridSize, minutes since ignition (non-finite = never burns)
  fuelCodes: Uint8Array(4096),         // index into provenance.fuelCodeList (= listFuelModelCodes())
  buildings: [{ ring, height }],       // ring: [{x,z}...] local meters from click origin; height: meters
  roads: [{ polygon }],                // polygon: [{x,z}...] quad, local meters (one entry per road segment)
  cellSizeMeters: 10,
  gridSize: 64,
  bbox: [west, south, east, north],    // degrees
  provenance: { worldCover, osm, fuelCrosswalk, fuelCodeList, weather, terrain }
}
```

640 m field (64 x 10 m cells), real ESA WorldCover + OSM Overpass data, `src/lib/`
untouched. Weather/terrain/canopy/LANDFIRE are flat defaults for now (calm,
no wind, no DEM) — see `provenance.weather`/`provenance.terrain`.

### Rendering (P3) — draped on the globe

`src/globe/fireDrape.js` consumes the contract above and paints it onto Cesium:
a rectangle over `bbox`, textured from a `gridSize`-square canvas that re-encodes
arrival times against the timeline clock (`burned = arrival <= t`,
`front = arrival within 90 s of t`). Driven by the existing scrub + worker clock
in `main.js`. No camera cut — fire appears on the terrain already in view.

Two Cesium gotchas cost real time here; do not "simplify" them back:
- The image material is re-created (`new ImageMaterialProperty`) on every paint
  with a **fresh canvas**. Redrawing one canvas, or feeding it via
  `CallbackProperty`, renders as blank white — Cesium caches by reference.
- The rectangle sits at `height: 2`, not 0, on the ellipsoid fallback. At 0 it
  z-fights the globe surface and vanishes. With real (Ion) terrain it uses
  `classificationType: TERRAIN` instead.

`DRAPE_ON_GLOBE` in `main.js` toggles this off and restores the old cut-to-block-scene
path; the block scene is still built either way and still owns metrics/timeline.

## Context bombs — never Read/cat these whole (measured sizes)

| File | Size | Hazard |
|---|---|---|
| `src/lib/regionalBenchmarkFields.generated.json` | 13.4 MB | 856k lines |
| `public/global-fuelbed-parameters.json` | 321 KB | **entire file is ONE line** |
| `src/lib/historicalProgressionFixtures.js` | 95 KB | **one 95k-char line** (inline geometry) |
| `src/lib/officialBenchmarkFixtures.js` | 64 KB | inline perimeter geometry |
| `docs/regional-model-run/RESULTS.jsonl` | 40 KB | append-only log, grows every run |

For the one-line files, a single `grep` match or `head -c` dumps the whole
thing. Query them instead:

```bash
# structure only
python3 -c "import json;print(list(json.load(open('public/global-fuelbed-parameters.json')))[:10])"
# one RESULTS.jsonl entry
python3 -c "import json;print([json.loads(l)['run'] for l in open('docs/regional-model-run/RESULTS.jsonl')])"
# fixture names, not contents
grep 'export const' src/lib/historicalProgressionFixtures.js
```

When querying ArcGIS/WCS endpoints, always pass `returnGeometry=false` unless
you actually need the shape — geometry is ~90 KB per feature.

**Do not gitignore `regionalBenchmarkFields.generated.json`.** It is a frozen
fixture, and regenerating it requires live LANDFIRE/USGS/Copernicus fetches
that are slow and intermittently unreachable. Offline benchmark
reproducibility depends on it being committed.

## History — grep it, don't re-read it

- `docs/regional-model-run/RESULTS.jsonl` — machine-readable per-run results (`run`, `change`, `verification`, `interpretation`).
- `docs/regional-model-run/THREAD.md` — narrative log, one section per run.
- `BASELINE.md`, `APPROACH-REGISTRY.md`, `REJECTED.md` — what was tried and what was ruled out.

Check these before re-deriving a past result. Things already settled: HRRR has
zero coverage for these 2014–2018 fire dates (RUN-016); no reachable
perimeter-progression data source exists, so suppression is a disclosed
limitation, not a TODO (RUN-019/019b).

## Network

USGS/USDA/LANDFIRE endpoints reject Node's `fetch`/undici — they return fake
500s and drop sockets on URLs that `curl` fetches successfully every time.
**Use `curl`** for these hosts. `apps.fs.usda.gov` currently hangs after TLS
handshake from every tested client and network; treat it as down.

## Rules for this project

- Never tune to make the benchmark score look better. Report results as-is,
  including regressions. A null or NO-GO result is a valid deliverable.
- Verify a data source exists before building against it (see the HRRR and
  EDW checks — both correctly killed work before it started).
- Run physics validators after touching spread/propagation code:
  `npm run validate:rothermel`, `validate:rothermel:rate`, `validate:waf`,
  `validate:convergence`.
- One `nice`d background job at a time — stacked unniced Node runs have
  overheated this machine before.
- `npm test` takes >5 min; run it backgrounded, don't block on it.
