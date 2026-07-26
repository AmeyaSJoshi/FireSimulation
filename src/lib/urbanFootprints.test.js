import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOverpassQuery,
  classifyGreenTags,
  resolveBuildingHeightMeters,
  resolveRoadWidthMeters,
  projectLonLatToLocalMeters,
  bufferLineToQuads,
  parseOverpassElements
} from './urbanFootprints.js';

test('buildOverpassQuery uses S,W,N,E bbox order', () => {
  const query = buildOverpassQuery([1, 2, 3, 4]);
  assert.match(query, /\(1,2,3,4\)/);
  assert.match(query, /way\["building"\]/);
  assert.match(query, /way\["highway"\]/);
});

test('resolveBuildingHeightMeters prefers height tag, then levels, then default', () => {
  assert.deepEqual(resolveBuildingHeightMeters({ height: '12 m' }), { heightMeters: 12, isDefault: false });
  assert.deepEqual(resolveBuildingHeightMeters({ 'building:levels': '4' }), { heightMeters: 12, isDefault: false });
  assert.deepEqual(resolveBuildingHeightMeters({}), { heightMeters: 6, isDefault: true });
});

test('resolveRoadWidthMeters prefers width, then lanes, then highway type, then default', () => {
  assert.deepEqual(resolveRoadWidthMeters({ width: '8' }), { widthMeters: 8, isDefault: false });
  assert.deepEqual(resolveRoadWidthMeters({ lanes: '2' }), { widthMeters: 7, isDefault: false });
  assert.deepEqual(resolveRoadWidthMeters({ highway: 'residential' }), { widthMeters: 6, isDefault: true });
  assert.deepEqual(resolveRoadWidthMeters({ highway: 'unknown-type' }), { widthMeters: 5, isDefault: true });
});

test('classifyGreenTags maps OSM tags onto WorldCover-equivalent class codes', () => {
  assert.equal(classifyGreenTags({ natural: 'wood' }), 10);
  assert.equal(classifyGreenTags({ leisure: 'park' }), 30);
  assert.equal(classifyGreenTags({ building: 'yes' }), null);
});

test('projectLonLatToLocalMeters: east increases x, north decreases z', () => {
  const east = projectLonLatToLocalMeters(1, 0, 0, 0);
  assert.ok(east.x > 0);
  assert.ok(Math.abs(east.z) < 1e-6);
  const north = projectLonLatToLocalMeters(0, 1, 0, 0);
  assert.ok(north.z < 0);
});

test('bufferLineToQuads produces one quad per segment with the requested width', () => {
  const line = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
  const quads = bufferLineToQuads(line, 4);
  assert.equal(quads.length, 2);
  quads.forEach((quad) => assert.equal(quad.length, 4));
});

test('parseOverpassElements splits buildings, roads, and classified green space; ignores the rest', () => {
  const json = {
    elements: [
      { type: 'way', tags: { building: 'yes' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }] },
      { type: 'way', tags: { highway: 'residential' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }] },
      { type: 'way', tags: { natural: 'wood' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }] },
      { type: 'way', tags: { amenity: 'cafe' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }] }
    ]
  };
  const { buildings, roads, green } = parseOverpassElements(json);
  assert.equal(buildings.length, 1);
  assert.equal(roads.length, 1);
  assert.equal(green.length, 1);
  assert.equal(green[0].classCode, 10);
});
