import { runScenario } from './runScenario.js';
import { runScenarioEnsemble } from './scenarioEnsemble.js';

function finite(value, name, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`globeScenarioBridge: ${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function normalizeGlobeClick({ latitude, longitude, cameraAltitudeMeters = null } = {}) {
  return {
    ignition: {
      latitude: finite(latitude, 'latitude', -90, 90),
      longitude: finite(longitude, 'longitude', -180, 180)
    },
    viewHint: {
      altitudeMeters: cameraAltitudeMeters === null ? null : finite(
        cameraAltitudeMeters,
        'cameraAltitudeMeters',
        0,
        100_000_000
      )
    }
  };
}

// Development-only input source for exercising the complete backend before a
// globe implementation is ready. It returns fresh plain data on every call.
export function createMockGlobeClick(click = {
  latitude: 37.7749,
  longitude: -122.4194,
  cameraAltitudeMeters: 1_000
}) {
  const normalized = normalizeGlobeClick(click);
  return () => ({
    latitude: normalized.ignition.latitude,
    longitude: normalized.ignition.longitude,
    cameraAltitudeMeters: normalized.viewHint.altitudeMeters
  });
}

function supersededError() {
  const error = new Error('Globe ignition was superseded by a newer click');
  error.name = 'AbortError';
  return error;
}

// Values are renderer semantics, not colours: 0 unburned, 1 burned, 2 front.
export function fireOverlayFrame(scenario, atMinutes, { frontWindowMinutes = 1.5 } = {}) {
  if (!(scenario?.arrivalField instanceof Float32Array)) {
    throw new TypeError('globeScenarioBridge: scenario must contain a Float32Array arrivalField');
  }
  finite(atMinutes, 'atMinutes', 0, 100_000);
  finite(frontWindowMinutes, 'frontWindowMinutes', 0, 60);
  const { region } = scenario;
  const totalCells = region?.gridSize ** 2;
  if (!Number.isInteger(region?.gridSize) || totalCells !== scenario.arrivalField.length) {
    throw new RangeError('globeScenarioBridge: scenario region does not match its arrival field');
  }
  const state = new Uint8Array(totalCells);
  for (let index = 0; index < totalCells; index += 1) {
    const arrival = scenario.arrivalField[index];
    if (arrival < 0) continue;
    if (arrival >= atMinutes && arrival <= atMinutes + frontWindowMinutes) {
      state[index] = 2;
    } else if (arrival < atMinutes) {
      state[index] = 1;
    }
  }
  return {
    bbox: region.bbox,
    gridSize: region.gridSize,
    cellSizeMeters: region.cellSizeMeters,
    atMinutes,
    frontWindowMinutes,
    state
  };
}

export function createGlobeScenarioController({
  runScenarioImpl = runScenario,
  scenarioOptions = { propagation: 'rothermel' }
} = {}) {
  if (typeof runScenarioImpl !== 'function') {
    throw new TypeError('globeScenarioBridge: runScenarioImpl must be a function');
  }
  let scenario = null;
  let active = null;
  return {
    async ignite(globeClick, overrides = undefined) {
      const request = normalizeGlobeClick(globeClick);
      if (overrides !== undefined) request.overrides = overrides;
      active?.controller.abort();
      const controller = new AbortController();
      const token = Symbol('globe-ignition');
      active = { controller, token };
      try {
        const result = await runScenarioImpl(request, { ...scenarioOptions, signal: controller.signal });
        if (controller.signal.aborted || active?.token !== token) throw supersededError();
        scenario = result;
        return scenario;
      } finally {
        if (active?.token === token) active = null;
      }
    },
    cancel() {
      active?.controller.abort();
    },
    getScenario() {
      return scenario;
    },
    frame(atMinutes, options = undefined) {
      if (!scenario) throw new Error('globeScenarioBridge: ignite before requesting a frame');
      return fireOverlayFrame(scenario, atMinutes, options);
    }
  };
}

export function createGlobeEnsembleController({
  runEnsembleImpl = runScenarioEnsemble,
  ensembleOptions = undefined
} = {}) {
  if (typeof runEnsembleImpl !== 'function') {
    throw new TypeError('globeScenarioBridge: runEnsembleImpl must be a function');
  }
  let ensemble = null;
  let active = null;
  return {
    async ignite(globeClick, overrides = undefined) {
      const request = normalizeGlobeClick(globeClick);
      if (overrides !== undefined) request.overrides = overrides;
      active?.controller.abort();
      const controller = new AbortController();
      const token = Symbol('globe-ensemble');
      active = { controller, token };
      try {
        const result = await runEnsembleImpl(request, { ...ensembleOptions, signal: controller.signal });
        if (controller.signal.aborted || active?.token !== token) throw supersededError();
        ensemble = result;
        return ensemble;
      } finally {
        if (active?.token === token) active = null;
      }
    },
    cancel() {
      active?.controller.abort();
    },
    getEnsemble() {
      return ensemble;
    },
    frame(atMinutes, options = undefined) {
      if (!ensemble) throw new Error('globeScenarioBridge: ignite before requesting a frame');
      return {
        ...fireOverlayFrame({
          arrivalField: ensemble.consensusArrivalMinutes,
          region: ensemble.region
        }, atMinutes, options),
        burnFraction: ensemble.burnFraction
      };
    }
  };
}

