import { createFireSimulation } from '../lib/fireSimulation.js';
import { routeWorkerMessage } from '../lib/workerMessageRouter.js';

let simulation = null;
let timer = null;
let paused = false;
let config = null;

function emitFrame() {
  if (!simulation) return;
  const frame = simulation.getFrame();
  const snapshot = simulation.getState();
  const metrics = simulation.getMetrics(config?.cellSizeKm ?? 4, config?.timestepMinutes ?? 1);
  self.postMessage({
    type: 'frame',
    runId: config?.runId,
    frame,
    size: snapshot.size,
    stepCount: snapshot.stepCount,
    burnedCount: snapshot.burnedCount,
    activeCount: snapshot.activeCount,
    terrainAvailable: snapshot.terrainAvailable,
    metrics,
    paused
  }, [frame.buffer]);
  if (!paused && snapshot.activeCount === 0 && snapshot.stepCount > 10 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function startSimulation(nextConfig) {
  if (timer) clearInterval(timer);
  config = nextConfig;
  simulation = createFireSimulation(config);
  paused = false;
  emitFrame();
  timer = setInterval(() => {
    if (!paused && simulation) {
      const steps = Math.max(1, Math.round((config.speed ?? 1) * 2));
      for (let step = 0; step < steps; step += 1) simulation.step();
      emitFrame();
    }
  }, 60);
}

self.onmessage = (event) => {
  const decision = routeWorkerMessage(event.data, { hasSimulation: Boolean(simulation) });
  if (decision.action === 'start') {
    startSimulation(decision.config);
    return;
  }
  if (decision.action === 'reconfigure') {
    if (decision.deprecated) {
      console.warn('fireWorker: message type "update" is deprecated; use "configure"');
    }
    startSimulation({
      ...config,
      scenario: decision.scenario ?? config.scenario,
      params: { ...config.params, ...decision.params }
    });
    return;
  }
  if (decision.action === 'pause') {
    paused = !paused;
    emitFrame();
    return;
  }
  if (decision.action === 'stop') {
    if (timer) clearInterval(timer);
    timer = null;
    simulation = null;
  }
  // 'ignore' actions fall through silently — the router already stated the reason
};
