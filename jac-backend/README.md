# Jac Propagation Workspace

Jac owns weighted graph traversal and the base Rothermel surface-spread path.
The 64 by 64 raster is an eight-neighbour graph; Jac runs a native priority
queue over those transitions to expose the fire-arrival field. `Propagate`
also materializes `FireCell` nodes for the precomputed-rate graph endpoint.

Input to the walker:

```text
rates: temporary precomputed rate per grid cell during the migration
gridSize: 64
cellSizeMeters
ignitionIndex
```

Output:

```text
arrivalMinutes: one arrival time per grid cell, with -1 for unreachable cells
```

## Full Fire Path

`SurfaceRate` exposes the base Rothermel kernel for a single edge. `RunFire`
is the production backend endpoint: it accepts raw dead/live fuel-particle
arrays, a per-cell fuel-model index, terrain, per-model midflame wind, and
per-particle moisture (1 h, 10 h, 100 h, herbaceous, woody), plus wind direction
and the scenario horizon. It derives local slope/aspect,
calculates directional head/backing rates, applies the elliptical perimeter
transform, and traverses all eight-neighbour transitions in Jac.

The browser creates this frozen request in `src/sim/jacFireContract.js`. It
applies the existing per-model 10 m-to-midflame wind adjustment before posting
to Jac, so LANDFIRE and WorldCover remain source-neutral. The Cesium client
uses `RunFire` as its only propagation engine: an unavailable Jac service is
reported to the user and never substituted with a JavaScript solver.

`RunFire` accepts a time-indexed wind/moisture timeline. It linearly
interpolates scalar wind speed, wind-vector direction, and fuel-class moisture
between observations, then integrates each transition in short segments. The
offline Jac parity check covers both a static timeline and a changing wind and
moisture timeline. Historical-perimeter skill remains a separate question from
solver parity.

The 64x64 endpoint accepts the complete field as one request and returns all
4,096 arrival values. This validates the base surface-fire path only; crown
fire, spotting, time-varying weather, and suppression stay outside this Jac
endpoint.

## Cesium client

Start Jac from its own directory. Jac keeps generated user and persistence
stores relative to the current directory, so this keeps them aligned:

```bash
npm run dev:jac
```

Then run the Cesium app normally. Vite proxies `/jac` to that local server,
so Cesium posts to `/jac/walker/RunFire` without a CORS dependency. For a
deployed service, set `VITE_JAC_ENDPOINT` to its full
`/walker/RunFire` URL at build time.

Do not start `jac-backend/main.jac` directly from the repository root.

In a second terminal, run the repeatable parity suite:

```bash
JAC_ENDPOINT=http://127.0.0.1:8010/walker/RunFire npm run validate:jac
```

It compares Jac and JavaScript on flat fuel, a synthetic slope, mixed fuel
with non-burnable barriers, calm conditions, and moisture at extinction. It
makes no live data-provider requests.

To check time-varying weather and moisture, run:

```bash
JAC_ENDPOINT=http://127.0.0.1:8010/walker/RunFire npm run validate:jac:weather
JAC_ENDPOINT=http://127.0.0.1:8010/walker/RunFire npm run validate:jac:regional-timeline
```

The first is a discriminating offline weather-transition fixture. The second
uses frozen Reservoir and Deer terrain, mapped fuel, and archived weather;
both compare Jac arrivals with the reference solver and make no API calls.

For frozen real fuel, terrain, and weather snapshots already committed to this
repository, run:

```bash
JAC_ENDPOINT=http://127.0.0.1:8010/walker/RunFire npm run validate:jac:snapshots
```

This compares three varied historical landscapes with JavaScript using the
same first weather observation, including the fuel-class moisture values, and a
12-hour horizon. It proves input parity, not real-world perimeter accuracy or
time-varying-weather behavior.

For a Jac-service execution against a real, GPS-ground Deer Fire final
perimeter, run:

```bash
JAC_ENDPOINT=http://127.0.0.1:8010/walker/RunFire npm run validate:jac:perimeter
```

The command fails if `RunFire` is unavailable, then reports IoU, F1, area,
centroid, and boundary-distance metrics plus Jac-to-reference parity. Its
homogeneous fuel, flat terrain, calm weather, and assumed ignition make it a
reproducible diagnostic, not an operational hindcast or a general accuracy
claim.

For the browser build, set `VITE_JAC_ENDPOINT` to the full deployed
`/walker/RunFire` URL. In local development, Vite proxies
`/jac/walker/RunFire` to the local Jac server. An unavailable Jac service is
reported to the user; the browser never substitutes a second solver.

The production endpoint is `POST /walker/RunFire` (full base surface-fire
path). The browser-side transport is `src/sim/jacClient.js`, reached through
the renderer-neutral scenario gateway.

Implementation:

1. Build a 64 by 64 fuel/terrain request at click time.
2. Calculate each destination edge's Rothermel rate in Jac.
3. Use Dijkstra traversal across eight valid neighbours.
4. Return one arrival time per cell, with `-1` outside the scenario horizon.
5. Keep JavaScript comparison tools out of the production request path.

The browser owns input preparation and visualization only. Jac owns all
propagation and arrival-time computation.
