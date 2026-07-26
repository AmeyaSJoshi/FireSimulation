import { createFireSimulation } from '../lib/fireSimulation.js';
import { createRateBasedFireSimulation } from '../lib/firePropagation.js';
import { getFuelModel } from '../lib/fuelModels.js';
import { resolvePhase1RuntimeInputs } from '../lib/phase1Runtime.js';
import { runSeededArrivalEnsemble } from '../lib/uncertainty.js';
import { routeWorkerMessage } from '../lib/workerMessageRouter.js';

let simulation = null;
let timer = null;
let paused = false;
let config = null;
let ensembleReport = null;
let ensembleSent = false;
let lastRenderedModelTime = null;
let arrivalFieldSent = false;

function emitFrame() {
  if (!simulation) return;
  const frame = simulation.getFrame({ fromModelTime: lastRenderedModelTime });
  const snapshot = simulation.getState();
  // Let each engine use its own authoritative spatial default when the
  // message omits cellSizeKm. The old 4 km fallback could silently corrupt
  // area and distance metrics for a phase1 field.
  const metrics = simulation.getMetrics(
    config?.cellSizeKm,
    config?.timestepMinutes ?? 1
  );
  const ensemble = ensembleReport && !ensembleSent
    ? {
      version: ensembleReport.version,
      seed: ensembleReport.seed,
      memberCount: ensembleReport.memberCount,
      horizonMinutes: config?.ensemble?.horizonMinutes ?? config?.maxPropagationMinutes ?? null,
      footprintAtMinutes: ensembleReport.footprintAtMinutes,
      perturbations: ensembleReport.perturbations,
      interpretation: ensembleReport.interpretation,
      arrivalTimeQuantiles: ensembleReport.arrivalTimeQuantiles
    }
    : null;
  const transferables = [frame.buffer];
  if (ensemble) {
    transferables.push(
      ensemble.arrivalTimeQuantiles.low.buffer,
      ensemble.arrivalTimeQuantiles.median.buffer,
      ensemble.arrivalTimeQuantiles.high.buffer
    );
  }
  // The Dijkstra solve computes every cell's arrival time up front; step()
  // only advances modelTime and reclassifies against that already-solved
  // array (see firePropagation.js refreshState). Send it once, as a plain
  // clone — NOT a transferable — because the worker keeps reading
  // simulation.arrivalTimes on every subsequent step/getFrame call.
  const arrivalField = !arrivalFieldSent
    ? {
      size: snapshot.size,
      cellSizeMeters: config?.cellSizeKm != null ? config.cellSizeKm * 1000 : null,
      values: Float32Array.from(snapshot.arrivalTimes)
    }
    : null;
  self.postMessage({
    type: 'frame',
    runId: config?.runId,
    frame,
    size: snapshot.size,
    stepCount: snapshot.stepCount,
    burnedCount: snapshot.burnedCount,
    activeCount: snapshot.activeCount,
    pendingCount: snapshot.pendingCount,
    terrainAvailable: snapshot.terrainAvailable,
    metrics,
    ensemble,
    arrivalField,
    paused
  }, transferables);
  if (ensemble) ensembleSent = true;
  if (arrivalField) arrivalFieldSent = true;
  lastRenderedModelTime = metrics.elapsedMinutes;
  const hasNoFutureArrivals = snapshot.pendingCount === undefined || snapshot.pendingCount === 0;
  if (!paused && snapshot.activeCount === 0 && hasNoFutureArrivals && snapshot.stepCount > 10 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function createPhase1Simulation(nextConfig) {
  const runtime = resolvePhase1RuntimeInputs(nextConfig);
  // Block scale (640 m field) is 8x narrower than SPOTTING_MAX_DISTANCE_METERS
  // (5000 m, firePropagation.js) — a single ember flight could land off the
  // field entirely. Spotting stays off; state it explicitly rather than
  // relying on the function default, and assert it so a future change to
  // the config object can't silently flip it back on.
  const enableSpotting = nextConfig.enableSpotting === true;
  console.assert(enableSpotting === false, 'fireWorker: spotting must stay off at block scale');
  return createRateBasedFireSimulation({
    enableSpotting,
    size: nextConfig.size,
    cellSizeMeters: (nextConfig.cellSizeKm ?? 1) * 1000,
    ignition: nextConfig.ignition,
    fuelModel: nextConfig.fuelModel
      ?? (nextConfig.fuelModelDefinitionsByCode?.[nextConfig.fuelModelCode]
        ?? (nextConfig.fuelModelCode ? getFuelModel(nextConfig.fuelModelCode) : null)),
    fuelModelCodes: nextConfig.fuelModelCodes,
    fuelModelDefinitionsByCode: nextConfig.fuelModelDefinitionsByCode,
    moistureFraction: runtime.moistureFraction ?? nextConfig.moistureFraction ?? nextConfig.params?.moisture ?? 0.08,
    deadMoistureFraction: runtime.deadMoistureFraction ?? nextConfig.deadMoistureFraction,
    liveMoistureFraction: runtime.liveMoistureFraction ?? nextConfig.liveMoistureFraction,
    moistureByCell: nextConfig.moistureByCell,
    fuelLoadScaleByCell: nextConfig.fuelLoadScaleByCell,
    fuelPersistenceMinutesByCell: nextConfig.fuelPersistenceMinutesByCell,
    deadMoistureByCell: nextConfig.deadMoistureByCell,
    liveMoistureByCell: nextConfig.liveMoistureByCell,
    deadMoistureByClass: nextConfig.deadMoistureByClass,
    liveMoistureByClass: nextConfig.liveMoistureByClass,
    waterBarrierEdges: nextConfig.waterBarrierEdges,
    suppressionBarrierTimes: nextConfig.suppressionBarrierTimes,
    fuelBedDepthMeters: nextConfig.fuelBedDepthMeters,
    canopySheltered: nextConfig.canopySheltered,
    canopyShelteredByCell: nextConfig.canopyShelteredByCell,
    canopyCrownAvailableByCell: nextConfig.canopyCrownAvailableByCell,
    canopyHeightByCell: nextConfig.canopyHeightByCell,
    canopyCoverFractionByCell: nextConfig.canopyCoverFractionByCell,
    canopyBaseHeightByCell: nextConfig.canopyBaseHeightByCell,
    canopyBulkDensityByCell: nextConfig.canopyBulkDensityByCell,
    weatherTimeline: runtime.manualWind ? null : nextConfig.weatherTimeline,
    tenMeterWindKmh: runtime.manualWind ? runtime.tenMeterWindKmh : null,
    referenceHeightMeters: 10,
    midflameWindKmh: runtime.midflameWindKmh ?? (nextConfig.params?.windSpeed ?? 0) * 0.4,
    windDirectionRadians: runtime.windDirectionRadians,
    terrainHeights: nextConfig.terrainHeights,
    defaultSlopeRadians: runtime.defaultSlopeRadians ?? 0,
    defaultSlopeAspectEast: runtime.defaultSlopeAspectEast ?? 0,
    defaultSlopeAspectNorth: runtime.defaultSlopeAspectNorth ?? 0,
    timestepMinutes: nextConfig.timestepMinutes ?? 1,
    burnDurationMinutes: nextConfig.burnDurationMinutes ?? 30,
    maxPropagationMinutes: nextConfig.maxPropagationMinutes ?? Infinity
  });
}

function startSimulation(nextConfig) {
  if (timer) clearInterval(timer);
  config = nextConfig;
  ensembleReport = null;
  ensembleSent = false;
  arrivalFieldSent = false;
  lastRenderedModelTime = null;
  simulation = config.engine === 'phase1'
    ? createPhase1Simulation(config)
    : createFireSimulation(config);
  if (config.engine === 'phase1' && config.ensemble?.enabled) {
    ensembleReport = runSeededArrivalEnsemble({
      baseConfig: config,
      createSimulation: createPhase1Simulation,
      memberCount: Math.min(16, config.ensemble.memberCount ?? 8),
      seed: config.ensemble.seed ?? config.seed ?? 1,
      perturbations: config.ensemble.perturbations,
      horizonMinutes: config.ensemble.horizonMinutes ?? config.maxPropagationMinutes ?? Infinity
    });
  }
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
      params: { ...config.params, ...decision.params },
      deadMoistureByClass: decision.params?.useWeatherMoisture === false
        ? null
        : config.deadMoistureByClass,
      liveMoistureByClass: decision.params?.useWeatherMoisture === false
        ? null
        : config.liveMoistureByClass
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
    ensembleReport = null;
    ensembleSent = false;
  }
  // 'ignore' actions fall through silently — the router already stated the reason
};
