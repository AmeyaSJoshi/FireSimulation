import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeWorkerMessage } from './workerMessageRouter.js';

test('start always dispatches a start action with the supplied config', () => {
  const decision = routeWorkerMessage({ type: 'start', config: { seed: 1 } }, { hasSimulation: false });
  assert.equal(decision.action, 'start');
  assert.deepEqual(decision.config, { seed: 1 });
});

test('configure dispatches a reconfigure action when a simulation exists', () => {
  const decision = routeWorkerMessage(
    { type: 'configure', scenario: 'wind', params: { windSpeed: 20 } },
    { hasSimulation: true }
  );
  assert.equal(decision.action, 'reconfigure');
  assert.equal(decision.scenario, 'wind');
  assert.deepEqual(decision.params, { windSpeed: 20 });
  assert.equal(decision.deprecated, false);
});

test('configure with no running simulation is ignored (nothing to reconfigure)', () => {
  const decision = routeWorkerMessage(
    { type: 'configure', params: { windSpeed: 20 } },
    { hasSimulation: false }
  );
  assert.equal(decision.action, 'ignore');
  assert.match(decision.reason, /no active simulation/i);
});

test('update is accepted as a deprecated alias for configure', () => {
  const decision = routeWorkerMessage(
    { type: 'update', params: { moisture: 0.5 } },
    { hasSimulation: true }
  );
  assert.equal(decision.action, 'reconfigure');
  assert.deepEqual(decision.params, { moisture: 0.5 });
  assert.equal(decision.deprecated, true, 'update alias must be flagged deprecated');
});

test('pause always dispatches a pause action', () => {
  const decision = routeWorkerMessage({ type: 'pause' }, { hasSimulation: true });
  assert.equal(decision.action, 'pause');
});

test('stop always dispatches a stop action', () => {
  const decision = routeWorkerMessage({ type: 'stop' }, { hasSimulation: true });
  assert.equal(decision.action, 'stop');
});

test('unknown message types are ignored with a stated reason', () => {
  const decision = routeWorkerMessage({ type: 'made-up' }, { hasSimulation: true });
  assert.equal(decision.action, 'ignore');
  assert.match(decision.reason, /unknown/i);
});

test('malformed messages (null, missing type) are ignored safely', () => {
  assert.equal(routeWorkerMessage(null, { hasSimulation: true }).action, 'ignore');
  assert.equal(routeWorkerMessage({}, { hasSimulation: true }).action, 'ignore');
});
