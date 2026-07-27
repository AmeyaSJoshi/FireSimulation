# Hackathon Backend Runbook

## Goal

`runScenario()` turns a geographic ignition into renderer-independent fire
data. It is callable before Cesium is finished and adaptable after its render
strategy is known.

## Data-First Build Order

1. `resolutionLadder.js`: choose 10 m, 100 m, or 500 m cells from an optional
   altitude hint. Keep the grid at 64 by 64.
2. Resolve data coverage before modelling. For a US point supported by
   LANDFIRE, request LANDFIRE fuel data. Otherwise request ESA WorldCover and
   crosswalk it to the same fuel-code contract.
3. Resolve terrain and weather independently: prefer a regional source when it
   covers the click, otherwise use global elevation and weather. At 10 m, add
   OSM buildings and roads everywhere they are available.
4. Normalize all branches to one `ScenarioContext`, including per-layer source,
   resolution, fallback reason, and confidence. Never make the renderer choose
   a data source.
5. `runScenario.js`: make a spatial grid and collect that context. Jac
   calculates directional base-Rothermel edge costs and traverses the graph;
   the existing physical solver remains the comparison oracle and outage
   fallback.
6. Derive contours and active-front helpers from the arrival field.
7. Test a US fixture and a non-US fixture, including a remote-data failure.
8. After the globe is available, add one bridge from its click output to
   `runScenario()` and one renderer adapter chosen by the globe implementation.

`scenarioGateway.js` is ready now for that bridge. It owns cancellation and
completed-result caching, so a new Cesium click only creates the canonical
geographic request and renders the returned field.

## Source Routing

| Layer | Preferred regional source | Global source | Fallback |
| --- | --- | --- | --- |
| Fuel / vegetation | LANDFIRE where it covers the US point | ESA WorldCover crosswalk | documented uniform fuel |
| Terrain | US terrain source where available | global DEM | flat terrain, marked low confidence |
| Weather | regional forecast / observation | global weather field | explicit demo defaults |
| Roads / buildings | not region-specific | OpenStreetMap at 10 m only | empty feature lists |

The Rothermel and Jac code must only receive normalized model values. It must
never know whether a rate originated from LANDFIRE, WorldCover, or a fallback.

## Non-Negotiables

- No Cesium imports in `src/sim/`.
- No per-cell network requests.
- Do not change `src/lib/` physics for this integration.
- Use `-1`, not `Infinity`, over JSON.
- Run only targeted physics validators after touching propagation.
- If the Jac walker is late or fails equivalence, use the JavaScript fallback
  and keep the interactive demo working.
- `npm run validate:jac` proves synthetic flat/slope/fuel/weather parity.
  `npm run validate:jac:snapshots` replays frozen real fuel/terrain/static
  weather inputs. Neither is an observed-perimeter accuracy claim.

