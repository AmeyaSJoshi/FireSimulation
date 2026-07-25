import assert from 'node:assert/strict';
import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';
import {
  LANDFIRE_FUEL_MIN_VALID_FRACTION,
  normalizeLandfireFuelRaster,
  summarizeLandfireFuelRaster,
  validateLandfireFuelRasterGeometry
} from '../src/lib/landfireFuel.js';
import { buildFuelModelCodeField } from '../src/lib/fireFieldInputs.js';
import { crosswalkLandCoverToFuel } from '../src/lib/landCoverToFuel.js';
import { createRateBasedFireSimulation } from '../src/lib/firePropagation.js';

// This is a deterministic contract fixture, not a regional accuracy sample.
// Its asymmetric codes make transposition and north/south reversal visible.
const width = 4;
const height = 4;
const rawRaster = [
  101, 102, 103, 104,
  121, 122, 123, 124,
  141, 142, 143, 144,
  181, 182, 183, 184
];
const bbox = [-105, 39, -104, 40];
const normalizedRaster = normalizeLandfireFuelRaster(rawRaster);
const tiffBuffer = await writeArrayBuffer(new Uint16Array(rawRaster), {
  width,
  height,
  GeographicTypeGeoKey: 4326,
  GTRasterTypeGeoKey: 1,
  ModelPixelScale: [0.25, 0.25, 0],
  ModelTiepoint: [0, 0, 0, -105, 40, 0]
});
const tiff = await fromArrayBuffer(tiffBuffer);
const image = await tiff.getImage(0);
const decodedRaster = await image.readRasters({ interleave: true });
const summary = summarizeLandfireFuelRaster(decodedRaster);
const geometry = validateLandfireFuelRasterGeometry({
  bbox,
  width,
  height,
  imageBoundingBox: image.getBoundingBox(),
  imageResolution: image.getResolution(),
  coordinateReferenceSystem: image.getGeoKeys().GeographicTypeGeoKey === 4326 ? 'EPSG:4326' : null,
  pixelIsArea: image.pixelIsArea()
});

assert.deepEqual(normalizeLandfireFuelRaster(decodedRaster), normalizedRaster);
assert.equal(summary.validCellFraction, 1);
assert.ok(summary.validCellFraction >= LANDFIRE_FUEL_MIN_VALID_FRACTION);
assert.deepEqual(geometry.boundingBox, bbox);
assert.deepEqual(geometry.resolution, [0.25, 0.25]);

const grid = {
  gridSize: width,
  cellCenterLatLon(row, col) {
    return { latitude: row, longitude: col };
  }
};
const field = buildFuelModelCodeField({
  grid,
  classifyAtCell: (row, col) => ({
    classCode: 10,
    className: 'Tree cover',
    burnable: true,
    landfireFuelModelCode: normalizedRaster[row * width + col]
  }),
  crosswalk: crosswalkLandCoverToFuel
});

assert.deepEqual(field.fuelModelCodes, normalizedRaster);
assert.equal(field.summary.regionalFuelCellCount, width * height);
assert.equal(field.summary.globalFuelbedCellCount, 0);

const simulation = createRateBasedFireSimulation({
  size: width,
  cellSizeMeters: 100,
  ignition: { row: 1, col: 1 },
  fuelModelCodes: field.fuelModelCodes,
  fuelLoadScaleByCell: field.fuelLoadScaleByCell,
  moistureFraction: 0.05,
  deadMoistureFraction: 0.05,
  liveMoistureFraction: 0.5,
  midflameWindKmh: 0,
  windDirectionRadians: 0,
  timestepMinutes: 1,
  burnDurationMinutes: 30,
  maxPropagationMinutes: 4000
});
for (let step = 0; step < 4000; step += 1) {
  simulation.step();
  if (simulation.getState().pendingCount === 0) break;
}
const simulationState = simulation.getState();
const simulationMetrics = simulation.getMetrics();
assert.equal(simulationState.arrivalTimes[1 * width + 1], 0);
assert.ok(simulationState.burnedCount > 0);
assert.ok(simulationMetrics.footprintCells > 0);
assert.ok(Number.isFinite(simulationMetrics.elapsedMinutes));
assert.ok(simulationState.arrivalTimes[1 * width + 2] > 0);

const provenance = {
  source: 'offline synthetic GeoTIFF contract fixture',
  product: 'LANDFIRE 2024 FBFM40-shaped codes',
  acquiredAt: '2026-07-24T00:00:00Z',
  bbox,
  resolutionMeters: 30,
  sourceHash: 'synthetic-fixture-not-a-live-source-hash',
  modelDefinitionVersion: 'Scott-Burgan FBFM40 published family',
  accuracyClaim: false
};
assert.equal(field.summary.unknownOrUnclassifiedCellCount, 0);

console.log(JSON.stringify({
  validator: 'regional-input-contract',
  status: 'pass',
  accuracyClaim: false,
  raster: { width, height, rawRaster, normalizedRaster, decodedRaster: Array.from(decodedRaster) },
  geometry,
  coverage: summary,
  field: {
    regionalFuelCellCount: field.summary.regionalFuelCellCount,
    regionalFuelModelCounts: field.summary.regionalFuelModelCounts,
    fuelModelCodes: field.fuelModelCodes
  },
  propagation: {
    ignitionIndex: 1 * width + 1,
    burnedCount: simulationState.burnedCount,
    footprintCells: simulationMetrics.footprintCells,
    elapsedMinutes: simulationMetrics.elapsedMinutes,
    finiteNeighborArrival: simulationState.arrivalTimes[1 * width + 2]
  },
  provenance,
  interpretation: 'Offline end-to-end contract proof only; this fixture does not validate LANDFIRE transport or fire-spread accuracy.'
}, null, 2));
