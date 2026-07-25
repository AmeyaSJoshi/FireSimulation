import test from 'node:test';
import assert from 'node:assert/strict';
import { firstRasterBand, rasterSampleValue } from './rasterSampling.js';

test('reads a one-band GeoTIFF result when the reader returns band arrays', () => {
  const bands = [new Int32Array([11, 22, 33])];
  assert.equal(firstRasterBand(bands), bands[0]);
  assert.equal(rasterSampleValue(bands, 2), 33);
});

test('also accepts an already flattened typed raster band', () => {
  const band = new Float32Array([1.5, 2.5]);
  assert.equal(firstRasterBand(band), band);
  assert.equal(rasterSampleValue(band, 0), 1.5);
  assert.ok(Number.isNaN(rasterSampleValue(band, -1)));
});
