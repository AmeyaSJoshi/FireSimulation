import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COPERNICUS_EVALSCRIPT,
  COPERNICUS_LAND_COVER_COLLECTION_ID,
  COPERNICUS_OUTPUT_BANDS,
  createCopernicusLandCoverRequest,
  createPointBbox,
  parseCopernicusLandCoverResponse
} from './copernicusLandCover.js';

test('builds an authenticated-ready 100 m BYOC Process API request', () => {
  const request = createCopernicusLandCoverRequest({
    bbox: [-115.1, 44.9, -115, 45],
    width: 4,
    height: 3
  });
  assert.match(request.body.input.data[0].type, new RegExp(COPERNICUS_LAND_COVER_COLLECTION_ID));
  assert.equal(request.body.input.data[0].dataFilter.timeRange.to, '2019-12-31T23:59:59Z');
  assert.equal(request.body.output.width, 4);
  assert.equal(request.body.output.height, 3);
  assert.equal(request.body.output.responses[0].format.type, 'application/json');
  assert.match(COPERNICUS_EVALSCRIPT, /Tree_Cover_Fraction/);
  assert.equal(COPERNICUS_OUTPUT_BANDS.length, 10);
});

test('creates a bounded point extent for a 100 m sample', () => {
  assert.deepEqual(createPointBbox(45, -115), [-115.0005, 44.9995, -114.9995, 45.0005]);
  assert.throws(() => createPointBbox(91, 0), /latitude/);
});

test('normalizes a Process API sample into provenance-rich cover fractions', () => {
  const values = [80, 10, 5, 0, 2, 0, 0, 0, 92, 10];
  const [sample] = parseCopernicusLandCoverResponse({ data: [{ bands: values }] });
  assert.equal(sample.coverFractions.treeCoverFraction, 80);
  assert.equal(sample.coverFractions.permanentWaterCoverFraction, 0);
  assert.equal(sample.discreteClassification, 10);
  assert.equal(sample.discreteClassificationProbability, 92);
  assert.equal(sample.sourceConfidence, 'high');
  assert.equal(sample.resolutionMeters, 100);
});

test('accepts the flat 1-pixel JSON form returned by some Process API formats', () => {
  const [sample] = parseCopernicusLandCoverResponse({
    data: [80, 10, 5, 0, 2, 0, 0, 0, 92, 10]
  });
  assert.equal(sample.coverFractions.treeCoverFraction, 80);
  assert.equal(sample.discreteClassification, 10);
});

test('rejects incomplete or out-of-range Process API samples', () => {
  assert.throws(
    () => parseCopernicusLandCoverResponse({ data: [{ bands: [1, 2] }] }),
    /incomplete/
  );
  const [sample] = parseCopernicusLandCoverResponse({
    data: [{ bands: [255, 0, 0, 0, 0, 0, 255, 0, 255, 255] }]
  });
  assert.equal(sample.coverFractions.treeCoverFraction, null);
  assert.equal(sample.coverFractions.permanentWaterCoverFraction, null);
  assert.equal(sample.sourceConfidence, 'low');
});
