import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countSuppressionBarrierEdges,
  createPerimeterContainmentBarriers,
  createSuppressionBarrierTimes,
  PROPAGATION_NEIGHBORS
} from './suppressionConstraints.js';

test('creates symmetric directed suppression barriers for neighboring cells', () => {
  const barriers = createSuppressionBarrierTimes({
    size: 5,
    edges: [{ from: [2, 2], to: [2, 3], blockedFromMinutes: 90 }]
  });

  assert.equal(countSuppressionBarrierEdges(barriers, 5), 2);
  const east = PROPAGATION_NEIGHBORS.findIndex(([dx, dy]) => dx === 1 && dy === 0);
  const west = PROPAGATION_NEIGHBORS.findIndex(([dx, dy]) => dx === -1 && dy === 0);
  assert.equal(barriers[(2 * 5 + 2) * 8 + east], 90);
  assert.equal(barriers[(2 * 5 + 3) * 8 + west], 90);
});

test('takes the earliest time when the same edge is constrained repeatedly', () => {
  const barriers = createSuppressionBarrierTimes({
    size: 5,
    edges: [
      { from: { row: 2, col: 2 }, to: { row: 2, col: 3 }, blockedFromMinutes: 90 },
      { from: { row: 2, col: 2 }, to: { row: 2, col: 3 }, blockedFromMinutes: 30 }
    ]
  });
  assert.equal(countSuppressionBarrierEdges(barriers, 5), 2);
  const east = PROPAGATION_NEIGHBORS.findIndex(([dx, dy]) => dx === 1 && dy === 0);
  assert.equal(barriers[(2 * 5 + 2) * 8 + east], 30);
});

test('rejects non-neighbor and out-of-range containment edges', () => {
  assert.throws(
    () => createSuppressionBarrierTimes({
      size: 5,
      edges: [{ from: [0, 0], to: [0, 2] }]
    }),
    /neighboring cells/
  );
  assert.throws(
    () => createSuppressionBarrierTimes({
      size: 5,
      edges: [{ from: [0, 0], to: [5, 0] }]
    }),
    /in-bounds cell/
  );
});

test('converts an observed perimeter mask into symmetric eight-neighbor barriers', () => {
  const observedMask = new Uint8Array(25);
  observedMask[2 * 5 + 2] = 1;
  const barriers = createPerimeterContainmentBarriers({
    observedMask,
    size: 5,
    blockedFromMinutes: 120
  });

  assert.equal(countSuppressionBarrierEdges(barriers, 5), 8 * 2);
  const east = PROPAGATION_NEIGHBORS.findIndex(([dx, dy]) => dx === 1 && dy === 0);
  const center = (2 * 5 + 2) * 8 + east;
  const outside = (2 * 5 + 3) * 8 + PROPAGATION_NEIGHBORS.findIndex(([dx, dy]) => dx === -1 && dy === 0);
  assert.equal(barriers[center], 120);
  assert.equal(barriers[outside], 120);
});

test('perimeter containment helper rejects incomplete masks and invalid times', () => {
  assert.throws(
    () => createPerimeterContainmentBarriers({ observedMask: new Uint8Array(4), size: 5, blockedFromMinutes: 0 }),
    /observedMask must have length/
  );
  assert.throws(
    () => createPerimeterContainmentBarriers({ observedMask: new Uint8Array(25), size: 5, blockedFromMinutes: Infinity }),
    /blockedFromMinutes must be a non-negative finite number/
  );
});
