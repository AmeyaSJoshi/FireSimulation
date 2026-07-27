# Simulation Module Map

This directory is the renderer-independent hackathon seam. It must not import
Cesium, DOM, canvas, or WebGL code.

Modules:

- `runScenario.js` owns the single public interface. It creates a grid, gathers
  context through internal adapters, runs propagation, and returns a semantic
  result.
- `resolutionLadder.js` maps an optional camera altitude to model resolution.
  It always uses a 64 by 64 grid, so the solver cost stays stable.
- `scenarioAdapters.js` holds source adapters for land cover, terrain, weather,
  and OSM context. Fuel routing prefers LANDFIRE when the complete grid is in
  CONUS coverage, otherwise ESA WorldCover; each adapter returns provenance or
  a documented fallback. Terrain and current/forecast weather use the existing
  Open-Meteo adapters; OSM buildings and roads are requested only at 10 m.
  Terrain responses cache for one hour; weather and OSM responses cache for ten
  minutes, while failed providers cool down for one minute.
- `scenarioContours.js` derives GeoJSON contours and an active front from a raw
  arrival field. Renderers may use it, but it is not Cesium-specific.
- `rateField.js` turns each cell's existing fuel and weather inputs into a
  rate-in-metres-per-minute field for the traversal contract.
- `fireClient.js` is the single `RunFire` transport. `propagation.js` is a
  thin scenario-result adapter over that client; it does not own a second HTTP
  path or fallback.
- `globeScenarioBridge.js` is the Cesium-ready seam. It accepts a precise globe
  click, calls `runScenario`, and returns semantic unburned/burned/front raster
  frames for any scrub time. It imports no renderer code.
- `scenarioEnsemble.js` reuses one resolved landscape context for nine nearby
  wind/moisture scenarios, then returns a median consensus arrival field and a
  per-cell burn fraction. It never makes nine provider requests and caches a
  completed ensemble for five minutes per adapter/click/control combination.
- `scenarioGateway.js` is the application boundary for any unfinished globe.
  It normalizes the geographic request, cancels a stale click, caches completed
  results, and exposes one renderer-neutral result shape plus an explicit JSON
  transport serializer.

## External Interface

```js
runScenario({
  ignition: { latitude, longitude },
  viewHint: { altitudeMeters }, // optional
  overrides: { windSpeedKmh, windDirectionDeg, moistureFraction } // optional
})
```

By default, `runScenario` uses the existing validated physical propagation
engine. The Cesium app passes `{ propagation: 'rothermel' }`, which invokes
`propagateRothermel` as the required solver. `{ propagation: 'rate' }`
remains available for the simpler precomputed-rate traversal demonstration.

The result describes the fire, rather than choosing its visual representation:

```js
{
  ignition,
  region: { bbox, gridSize, cellSizeMeters },
  arrivalField,
  contours,
  context: { fuelCodes, terrain, buildings, roads },
  evidence: { sources, fallbacks },
  confidence
}
```

Only a later renderer adapter decides whether `arrivalField` becomes a texture,
GeoJSON, particles, or a block-scene overlay.

## Application Gateway

```js
import { createScenarioGateway } from './scenarioGateway.js';
import { createViteScenarioAdapters } from './scenarioAdapters.js';

const gateway = createScenarioGateway({
  adapters: createViteScenarioAdapters()
});
const result = await gateway.submit({
  ignition: { latitude, longitude },
  viewHint: { altitudeMeters: cameraAltitudeMeters }
});
```

`result` keeps `Float32Array` fields for rendering. At an HTTP boundary only,
call `serializeScenarioResult(result)` to send `arrivalMinutes` with `-1` for
unreachable cells. This is the contract Cesium will consume after its current
implementation is replaced.

## Live Cesium Path

There is one production ignition path:

```
Cesium click -> scenarioGateway -> runScenario -> fireClient -> local engine
```

The gateway is configured with `createViteScenarioAdapters()` and
`propagation: 'rothermel'`. An invalid solve result is presented
to the user as an error; it is never replaced by browser-side propagation.

## Globe Integration

```js
const bridge = createGlobeScenarioController();
await bridge.ignite({ latitude, longitude, cameraAltitudeMeters });
const frame = bridge.frame(minutes);
```

Until Cesium is ready, `createMockGlobeClick()` supplies a repeatable precise
click for the same bridge. Both bridge controllers cancel an older ignition
when a newer globe click arrives.

`frame` contains the scenario bounding box, fixed grid dimensions, and a
`Uint8Array` whose values are `0` unburned, `1` burned, and `2` active front.
Cesium can map those values to a canvas or ground primitive without learning
about fuel models or weather providers.

For one polished uncertainty-aware fire instead of nine visible runs, use
`createGlobeEnsembleController()`. Its result includes
`consensusArrivalMinutes` (burned in at least half the scenarios) and
`burnFraction` (0 through 1) for an optional translucent uncertainty band.
Its `frame(minutes)` method returns the consensus burned/front raster plus the
matching per-cell `burnFraction` field.
