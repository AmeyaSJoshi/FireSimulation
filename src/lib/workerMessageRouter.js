// Pure dispatch decision for a fireWorker message.
//
// The worker imports this and calls it on every incoming message; the
// returned action tells the worker what to do without the worker itself
// having to know the message vocabulary. Extracting the router serves
// two goals from Phase 0's audit findings:
//
//   1. Makes the message contract testable in Node (workers use `self`,
//      which Node does not expose; this function does not).
//   2. Names `update` as an explicit deprecated alias for `configure`,
//      instead of a silently-restarting message (Finding F8).

export function routeWorkerMessage(message, { hasSimulation } = {}) {
  if (!message || typeof message.type !== 'string') {
    return { action: 'ignore', reason: 'Malformed worker message (missing type)' };
  }

  if (message.type === 'start') {
    return { action: 'start', config: message.config };
  }

  if (message.type === 'configure' || message.type === 'update') {
    if (!hasSimulation) {
      return {
        action: 'ignore',
        reason: `Received "${message.type}" with no active simulation to reconfigure`
      };
    }
    return {
      action: 'reconfigure',
      scenario: message.scenario,
      params: message.params,
      deprecated: message.type === 'update'
    };
  }

  if (message.type === 'pause') return { action: 'pause' };
  if (message.type === 'stop') return { action: 'stop' };

  return { action: 'ignore', reason: `Unknown worker message type "${message.type}"` };
}
