import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  latLonToMosaicPixel,
  classifyMosaicRgb,
  createLandCoverSource
} from './landCoverSource.js';

const mosaicMeta = {
  width: 10800,
  height: 5400,
  latitudeRange: [-90, 90],
  longitudeRange: [-180, 180]
};

const classCatalog = {
  0:  { code: 0,  name: 'No data',       burnable: false },
  10: { code: 10, name: 'Tree cover',    burnable: true  },
  30: { code: 30, name: 'Grassland',     burnable: true  },
  50: { code: 50, name: 'Built-up',      burnable: false }
};

const paletteByRgb = {
  '0,0,0':       0,
  '0,100,0':     10,
  '255,255,76':  30,
  '250,0,0':     50
};

test('latLonToMosaicPixel: (0, 0) maps to the mosaic center', () => {
  const { col, row } = latLonToMosaicPixel(0, 0, mosaicMeta);
  assert.equal(col, 5400);
  assert.equal(row, 2700);
});

test('latLonToMosaicPixel: (90N, -180) maps to top-left corner', () => {
  const { col, row } = latLonToMosaicPixel(90, -180, mosaicMeta);
  assert.equal(col, 0);
  assert.equal(row, 0);
});

test('latLonToMosaicPixel: (-90S, +180) maps to bottom-right corner', () => {
  const { col, row } = latLonToMosaicPixel(-90, 180, mosaicMeta);
  assert.equal(col, mosaicMeta.width - 1);
  assert.equal(row, mosaicMeta.height - 1);
});

test('latLonToMosaicPixel: an eastern point has a higher column than a western point at the same latitude', () => {
  const westCol = latLonToMosaicPixel(40, -120, mosaicMeta).col;
  const eastCol = latLonToMosaicPixel(40, -80, mosaicMeta).col;
  assert.ok(eastCol > westCol);
});

test('latLonToMosaicPixel: a southern point has a higher row than a northern point at the same longitude', () => {
  const northRow = latLonToMosaicPixel(60, 0, mosaicMeta).row;
  const southRow = latLonToMosaicPixel(-30, 0, mosaicMeta).row;
  assert.ok(southRow > northRow);
});

test('classifyMosaicRgb: known palette rgb returns full class info', () => {
  const result = classifyMosaicRgb(0, 100, 0, { paletteByRgb, classes: classCatalog });
  assert.equal(result.classCode, 10);
  assert.equal(result.className, 'Tree cover');
  assert.equal(result.burnable, true);
});

test('classifyMosaicRgb: rgb (250, 0, 0) is Built-up and non-burnable', () => {
  const result = classifyMosaicRgb(250, 0, 0, { paletteByRgb, classes: classCatalog });
  assert.equal(result.classCode, 50);
  assert.equal(result.burnable, false);
});

test('classifyMosaicRgb: unknown rgb returns null (never invents a class)', () => {
  const result = classifyMosaicRgb(123, 45, 67, { paletteByRgb, classes: classCatalog });
  assert.equal(result, null);
});

test('classifyMosaicRgb: fully transparent alpha returns null even if rgb matches', () => {
  const result = classifyMosaicRgb(0, 100, 0, { paletteByRgb, classes: classCatalog }, 0);
  assert.equal(result, null);
});

test('createLandCoverSource: uses injected reader and returns the classified pixel', async () => {
  // Fake reader returns Tree cover for one pixel, Built-up elsewhere
  const reader = {
    readPixel: (col, row) => {
      if (col === 5400 && row === 2700) return [0, 100, 0, 255];
      return [250, 0, 0, 255];
    }
  };
  const source = await createLandCoverSource({
    imageReader: async () => reader,
    meta: {
      source: 'ESA WorldCover 2021 v200',
      mosaic: mosaicMeta,
      paletteByRgb,
      classes: classCatalog
    }
  });
  const equatorial = source.classifyAtLatLon(0, 0);
  assert.equal(equatorial.classCode, 10);
  assert.equal(equatorial.source, 'ESA WorldCover 2021 v200');
  assert.equal(equatorial.confidence, 'medium');

  const elsewhere = source.classifyAtLatLon(40, -80);
  assert.equal(elsewhere.classCode, 50);
});

test('createLandCoverSource: returns null for out-of-coverage pixels (transparent)', async () => {
  const reader = { readPixel: () => [0, 0, 0, 0] }; // all pixels transparent
  const source = await createLandCoverSource({
    imageReader: async () => reader,
    meta: {
      source: 'test',
      mosaic: mosaicMeta,
      paletteByRgb,
      classes: classCatalog
    }
  });
  const result = source.classifyAtLatLon(20, 30);
  assert.equal(result, null);
});

test('createLandCoverSource: reports which points it can never classify (invalid lat/lon)', async () => {
  const reader = { readPixel: () => [0, 100, 0, 255] };
  const source = await createLandCoverSource({
    imageReader: async () => reader,
    meta: {
      source: 'test',
      mosaic: mosaicMeta,
      paletteByRgb,
      classes: classCatalog
    }
  });
  assert.throws(() => source.classifyAtLatLon(NaN, 0), /latitude/);
  assert.throws(() => source.classifyAtLatLon(0, NaN), /longitude/);
});
