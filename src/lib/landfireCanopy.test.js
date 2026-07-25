import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LANDFIRE_CANOPY_COVERAGES,
  LANDFIRE_CANOPY_NODATA,
  createLandfireWcsRequest,
  hasUsableCanopyWindStructure,
  hasUsableCrownStructure,
  isWithinLandfireCanopyCoverage,
  normalizeLandfireCanopyRaster,
  normalizeLandfireCanopyValue
} from './landfireCanopy.js';

test('creates bounded WCS 1.0 requests with explicit GeoTIFF dimensions', () => {
  const request = createLandfireWcsRequest({
    bbox: [-115.041, 44.949, -115.039, 44.951],
    width: 2,
    height: 3,
    coverage: LANDFIRE_CANOPY_COVERAGES.canopyBaseHeight
  });
  assert.match(request.url, /service=WCS/);
  assert.match(request.url, /version=1\.0\.0/);
  assert.match(request.url, /coverage=LF2024_CBH_CONUS/);
  assert.match(request.url, /crs=EPSG:4326/);
  assert.match(request.url, /bbox=-115\.041,44\.949,-115\.039,44\.951/);
  assert.doesNotMatch(request.url, /%2C|%3A/);
  assert.match(request.url, /width=2/);
  assert.match(request.url, /height=3/);
  assert.equal(isWithinLandfireCanopyCoverage(request.bbox), true);
});

test('normalizes LANDFIRE product scale factors and nodata', () => {
  assert.equal(normalizeLandfireCanopyValue(180, 'canopyHeight'), 18);
  assert.equal(normalizeLandfireCanopyValue(75, 'canopyCover'), 0.75);
  assert.equal(normalizeLandfireCanopyValue(15, 'canopyBaseHeight'), 1.5);
  assert.equal(normalizeLandfireCanopyValue(6, 'canopyBulkDensity'), 0.06);
  assert.equal(normalizeLandfireCanopyValue(LANDFIRE_CANOPY_NODATA, 'canopyBaseHeight'), null);
  assert.deepEqual(
    normalizeLandfireCanopyRaster(new Uint16Array([15, LANDFIRE_CANOPY_NODATA, 20]), 'canopyBaseHeight'),
    [1.5, null, 2]
  );
});

test('requires measured canopy height and at least five percent cover for sheltered WAF', () => {
  assert.equal(hasUsableCanopyWindStructure({ canopyHeightMeters: 18, canopyCoverFraction: 0.75 }), true);
  assert.equal(hasUsableCanopyWindStructure({ canopyHeightMeters: 18, canopyCoverFraction: 0.04 }), false);
  assert.equal(hasUsableCanopyWindStructure({ canopyHeightMeters: null, canopyCoverFraction: 0.75 }), false);
});

test('requires both measured canopy structure values before crown behavior is eligible', () => {
  assert.equal(hasUsableCrownStructure({ canopyBaseHeightMeters: 2, canopyBulkDensityKgPerM3: 0.06 }), true);
  assert.equal(hasUsableCrownStructure({ canopyBaseHeightMeters: 2, canopyBulkDensityKgPerM3: null }), false);
  assert.equal(hasUsableCrownStructure({ canopyBaseHeightMeters: null, canopyBulkDensityKgPerM3: 0.06 }), false);
});
