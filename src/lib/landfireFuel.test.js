import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromArrayBuffer } from 'geotiff';
import {
  LANDFIRE_FUEL_COVERAGE,
  LANDFIRE_FUEL_MIN_VALID_FRACTION,
  LANDFIRE_FUEL_NODATA,
  createLandfireFuelWcsRequest,
  isWithinLandfireFuelCoverage,
  landfireFuelModelToFuelDecision,
  normalizeLandfireFuelRaster,
  normalizeLandfireFuelValue,
  summarizeLandfireFuelRaster,
  validateLandfireFuelRasterGeometry
} from './landfireFuel.js';

test('maps LANDFIRE FBFM40 integer values to the published standard codes', () => {
  assert.deepEqual(
    normalizeLandfireFuelRaster([91, 101, 109, 121, 124, 141, 149, 161, 165, 181, 189, 201, 204, 0]),
    ['NB', 'GR1', 'GR9', 'GS1', 'GS4', 'SH1', 'SH9', 'TU1', 'TU5', 'TL1', 'TL9', 'SB1', 'SB4', null]
  );
  assert.equal(normalizeLandfireFuelValue(999), null);
  assert.equal(normalizeLandfireFuelValue(LANDFIRE_FUEL_NODATA), null);
});

test('creates a bounded WCS request for the CONUS FBFM40 coverage', () => {
  const request = createLandfireFuelWcsRequest({
    bbox: [-115.041, 44.949, -115.039, 44.951],
    width: 32,
    height: 24
  });
  assert.match(request.url, new RegExp(`coverage=${LANDFIRE_FUEL_COVERAGE}`));
  assert.match(request.url, /version=1\.0\.0/);
  assert.match(request.url, /format=GeoTIFF/);
  assert.equal(isWithinLandfireFuelCoverage(request.bbox), true);
  assert.throws(() => createLandfireFuelWcsRequest({
    bbox: [-180, 0, -179, 1], width: 1, height: 1
  }), /outside LANDFIRE CONUS/);
});

test('returns a high-confidence direct decision for burnable FBFM40 cells', () => {
  const decision = landfireFuelModelToFuelDecision('TL9');
  assert.equal(decision.fuelCode, 'TL9');
  assert.equal(decision.fuelModelDefinition.code, 'TL9');
  assert.equal(decision.confidence, 'high');
  assert.equal(decision.fuelLoadScale, 1);
  assert.equal(decision.landfireFuelModelCode, 'TL9');
});

test('turns LANDFIRE non-burnable classes into hard barriers', () => {
  const decision = landfireFuelModelToFuelDecision('NB');
  assert.equal(decision.burnable, false);
  assert.equal(decision.fuelLoadScale, 0);
  assert.equal(decision.fuelCode, 'NB');
  assert.equal(landfireFuelModelToFuelDecision('not-a-model'), null);
});

test('summarizes valid regional cells without treating nodata as a fuel class', () => {
  const summary = summarizeLandfireFuelRaster([101, 91, 0, 999]);
  assert.equal(summary.totalCellCount, 4);
  assert.equal(summary.validCellCount, 2);
  assert.equal(summary.validCellFraction, 0.5);
  assert.deepEqual(summary.modelCounts, { GR1: 1, NB: 1 });
  assert.equal(LANDFIRE_FUEL_MIN_VALID_FRACTION, 0.95);
});

test('rejects a regional raster with wrong CRS, non-covering bounds, or unusable resolution', () => {
  const request = { bbox: [-105, 39, -104, 40], width: 4, height: 4 };
  const valid = {
    ...request,
    imageBoundingBox: [-105, 39, -104, 40],
    imageResolution: [0.25, -0.25],
    coordinateReferenceSystem: 'EPSG:4326',
    pixelIsArea: true
  };
  assert.deepEqual(validateLandfireFuelRasterGeometry(valid).resolution, [0.25, 0.25]);
  // A real WCS response commonly pads the returned extent outward past the
  // request; that is legitimate as long as it still covers the request.
  assert.deepEqual(validateLandfireFuelRasterGeometry({
    ...valid,
    imageBoundingBox: [-105.1, 38.95, -103.95, 40.05],
    imageResolution: [0.2875, -0.275]
  }).boundingBox, [-105.1, 38.95, -103.95, 40.05]);
  // A resolution sign of +0.25 (rather than -0.25) is also legitimate: it is
  // what geotiff.js reports for a genuinely north-up raster encoded with
  // ModelTransformation, which is what live LANDFIRE WCS responses use.
  assert.deepEqual(validateLandfireFuelRasterGeometry({
    ...valid,
    imageResolution: [0.25, 0.25]
  }).resolution, [0.25, 0.25]);
  // A raster that does not cover the requested extent is still rejected.
  assert.throws(() => validateLandfireFuelRasterGeometry({
    ...valid,
    imageBoundingBox: [-104.5, 39, -104, 40]
  }), /bounds do not cover/);
  // A raster far coarser than the requested resolution is rejected rather
  // than silently accepted as "just padding".
  assert.throws(() => validateLandfireFuelRasterGeometry({
    ...valid,
    imageResolution: [2.5, -2.5]
  }), /resolution/);
  // A degenerate (zero-width/height) bounding box is rejected.
  assert.throws(() => validateLandfireFuelRasterGeometry({
    ...valid,
    imageBoundingBox: [-105, 39, -105, 40]
  }), /valid west<east, south<north/);
  assert.throws(() => validateLandfireFuelRasterGeometry({
    ...valid,
    coordinateReferenceSystem: 'EPSG:3857'
  }), /EPSG:4326/);
  assert.throws(() => validateLandfireFuelRasterGeometry({
    ...valid,
    pixelIsArea: false
  }), /areas/);
});

test('decodes a real, once-successfully-fetched LANDFIRE FBFM40 GeoTIFF sample', async () => {
  // Bundled because the live CONUS WCS endpoint is intermittently unavailable
  // (HTTP 502 / empty reply on 3 of 4 attempts in the session that captured
  // this file). See public/fixtures/landfire/*.manifest.json for full
  // provenance: request URL, acquisition date, sha256, bbox, resolution.
  const fixturePath = fileURLToPath(
    new URL('../../public/fixtures/landfire/lf2024-fbfm40-clear-creek-co-sample.tif', import.meta.url)
  );
  const buffer = readFileSync(fixturePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage(0);
  const geoKeys = image.getGeoKeys();
  assert.equal(geoKeys.GeographicTypeGeoKey, 4326);
  assert.equal(image.pixelIsArea(), true);

  const raster = await image.readRasters({ interleave: true });
  const normalized = normalizeLandfireFuelRaster(raster);
  const summary = summarizeLandfireFuelRaster(raster);

  // Real terrain, unlike the synthetic contract fixture: many distinct
  // FBFM40 codes appear, and the valid-cell fraction clears the coverage gate.
  assert.ok(Object.keys(summary.modelCounts).length >= 5);
  assert.ok(summary.validCellFraction >= LANDFIRE_FUEL_MIN_VALID_FRACTION);
  assert.equal(normalized.length, raster.length);

  // Proves the real fix: this response's bbox pads outward past the request
  // (by more than a naive equality tolerance) and its resolution reports a
  // POSITIVE y-component (ModelTransformation encoding), both of which the
  // previous strict-equality/sign-based check incorrectly rejected. The
  // containment- and magnitude-based check now accepts it.
  const geometry = validateLandfireFuelRasterGeometry({
    bbox: [-105, 39, -104.9, 39.1],
    width: image.getWidth(),
    height: image.getHeight(),
    imageBoundingBox: image.getBoundingBox(),
    imageResolution: image.getResolution(),
    coordinateReferenceSystem: 'EPSG:4326',
    pixelIsArea: image.pixelIsArea()
  });
  assert.ok(geometry.resolution[1] > 0, 'library reports a positive y-resolution for this real north-up raster');
  assert.deepEqual(geometry.requestedBoundingBox, [-105, 39, -104.9, 39.1]);
  assert.ok(geometry.boundingBox[0] <= -105 && geometry.boundingBox[2] >= -104.9,
    'returned bbox must cover the requested bbox');
});

test('rejects a wildly wrong-location LANDFIRE response even with correct CRS/pixelIsArea', () => {
  assert.throws(() => validateLandfireFuelRasterGeometry({
    bbox: [-105, 39, -104.9, 39.1],
    width: 64,
    height: 64,
    imageBoundingBox: [-119.9, 34.9, -119.8, 35],
    imageResolution: [0.0016, 0.0016],
    coordinateReferenceSystem: 'EPSG:4326',
    pixelIsArea: true
  }), /bounds do not cover the requested bbox/);
});
