import test from 'node:test';
import assert from 'node:assert/strict';
import { isSimulationSettled, shouldAutoRotate } from './simulationLifecycle.js';

test('simulation settles only after active and future cells are exhausted', () => {
  assert.equal(isSimulationSettled({ activeCount: 0, pendingCount: 4, stepCount: 100 }), false);
  assert.equal(isSimulationSettled({ activeCount: 2, pendingCount: 0, stepCount: 100 }), false);
  assert.equal(isSimulationSettled({ activeCount: 0, pendingCount: 0, stepCount: 10 }), false);
  assert.equal(isSimulationSettled({ activeCount: 0, pendingCount: 0, stepCount: 11 }), true);
});

test('globe auto-rotation is disabled while a fire is running', () => {
  assert.equal(shouldAutoRotate({ fireRunning: true }), false);
  assert.equal(shouldAutoRotate({ fireRunning: false }), true);
});
