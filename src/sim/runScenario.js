import { createRateBasedFireSimulation } from '../lib/firePropagation.js';
import { getFuelModel } from '../lib/fuelModels.js';
import { createSpatialGrid } from '../lib/spatialGrid.js';
import { compassToMathRadians } from '../lib/weatherInputs.js';
import { resolutionForAltitude } from './resolutionLadder.js';
import { activeFireCells } from './scenarioContours.js';
import { createFallbackScenarioAdapters } from './scenarioAdapters.js';
import { createRateField } from './rateField.js';
import { propagateRothermel as defaultPropagateRothermel, propagateRateField } from './propagation.js';
import { createFireRequest } from './fireContract.js';

const DEFAULT_OVERRIDES = Object.freeze({
  windSpeedKmh: 18,
  windDirectionDeg: 45,
  moistureFraction: 0.08,
  horizonMinutes: 12 * 60
});

function finiteInRange(value, name, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`runScenario: ${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeRequest({ ignition, viewHint = {}, overrides = {} } = {}) {
  const latitude = finiteInRange(ignition?.latitude, 'ignition.latitude', -90, 90);
  const longitude = finiteInRange(ignition?.longitude, 'ignition.longitude', -180, 180);
  const optionalOverride = (key, minimum, maximum) => (
    overrides[key] === undefined || overrides[key] === null
      ? null
      : finiteInRange(overrides[key], `overrides.${key}`, minimum, maximum)
  );
  return {
    ignition: { latitude, longitude },
    altitudeMeters: viewHint.altitudeMeters ?? null,
    overrides: {
      windSpeedKmh: optionalOverride('windSpeedKmh', 0, 200),
      windDirectionDeg: optionalOverride('windDirectionDeg', 0, 360),
      moistureFraction: optionalOverride('moistureFraction', 0, 1),
      horizonMinutes: optionalOverride('horizonMinutes', 1, 10_080) ?? DEFAULT_OVERRIDES.horizonMinutes
    }
  };
}

function geographicBbox(grid) {
  const corners = [
    grid.cellCenterLatLon(-0.5, -0.5),
    grid.cellCenterLatLon(-0.5, grid.gridSize - 0.5),
    grid.cellCenterLatLon(grid.gridSize - 0.5, -0.5),
    grid.cellCenterLatLon(grid.gridSize - 0.5, grid.gridSize - 0.5)
  ];
  return {
    west: Math.min(...corners.map(({ longitude }) => longitude)),
    south: Math.min(...corners.map(({ latitude }) => latitude)),
    east: Math.max(...corners.map(({ longitude }) => longitude)),
    north: Math.max(...corners.map(({ latitude }) => latitude))
  };
}

function serializeArrivalTimes(arrivalTimes) {
  const field = new Float32Array(arrivalTimes.length);
  for (let index = 0; index < arrivalTimes.length; index += 1) {
    field[index] = Number.isFinite(arrivalTimes[index]) ? arrivalTimes[index] : -1;
  }
  return field;
}

export async function runScenario(request, {
  adapters = createFallbackScenarioAdapters(),
  signal = undefined,
  propagation = 'physical',
  propagate = propagateRateField,
  propagateRothermel = defaultPropagateRothermel
} = {}) {
  if (!adapters || typeof adapters.loadContext !== 'function') {
    throw new TypeError('runScenario: adapters.loadContext must be a function');
  }
  const normalized = normalizeRequest(request);
  if (!['physical', 'rate', 'rothermel'].includes(propagation)) {
    throw new RangeError('runScenario: propagation must be physical, rate, or rothermel');
  }
  const resolution = resolutionForAltitude(normalized.altitudeMeters);
  const grid = createSpatialGrid({
    ...normalized.ignition,
    cellSizeMeters: resolution.cellSizeMeters,
    gridSize: resolution.gridSize
  });
  const totalCells = resolution.gridSize ** 2;
  const ignitionIndex = Math.floor(resolution.gridSize / 2) * resolution.gridSize
    + Math.floor(resolution.gridSize / 2);
  const context = await adapters.loadContext({
    grid,
    totalCells,
    signal,
    includeWeatherMoisture: normalized.overrides.moistureFraction === null
  });
  if (!Array.isArray(context?.fuelCodes) || context.fuelCodes.length !== totalCells) {
    throw new RangeError('runScenario: adapter must return one fuel code per cell');
  }
  const conditions = {
    windSpeedKmh: normalized.overrides.windSpeedKmh ?? context.wind?.tenMeterSpeedKmh ?? context.weather?.wind?.tenMeterSpeedKmh ?? DEFAULT_OVERRIDES.windSpeedKmh,
    windDirectionDeg: normalized.overrides.windDirectionDeg ?? context.wind?.compassDirectionDeg ?? context.weather?.wind?.compassDirectionDeg ?? DEFAULT_OVERRIDES.windDirectionDeg,
    moistureFraction: normalized.overrides.moistureFraction ?? context.weather?.fuelMoisture?.byClass?.['1h'] ?? DEFAULT_OVERRIDES.moistureFraction,
    liveMoistureFraction: normalized.overrides.moistureFraction ?? context.weather?.liveFuelMoisture?.byClass?.woody
      ?? context.weather?.fuelMoisture?.byClass?.['1h'] ?? DEFAULT_OVERRIDES.moistureFraction,
    horizonMinutes: normalized.overrides.horizonMinutes
  };
  const moistureOverridden = normalized.overrides.moistureFraction !== null;
  const deadMoistureByClass = moistureOverridden ? null : context.weather?.fuelMoisture?.byClass ?? null;
  const liveMoistureByClass = moistureOverridden ? null : context.weather?.liveFuelMoisture?.byClass ?? null;
  const weatherTimeline = moistureOverridden ? null : context.weather?.windTimeline ?? null;
  let arrivalField = new Float32Array(totalCells).fill(-1);
  let rateField = null;
  const region = {
    bbox: geographicBbox(grid),
    origin: normalized.ignition,
    gridSize: resolution.gridSize,
    cellSizeMeters: resolution.cellSizeMeters,
    fieldWidthMeters: resolution.fieldWidthMeters,
    resolution: resolution.label
  };
  let engine = 'javascript-physical';
  let fallbackReason = null;
  if (propagation === 'physical') {
    rateField = createRateField({
      fuelCodes: context.fuelCodes,
      fuelModelDefinitionsByCode: context.fuelModelDefinitionsByCode,
      windSpeedKmh: conditions.windSpeedKmh,
      windDirectionDeg: conditions.windDirectionDeg,
      moistureFraction: conditions.moistureFraction
    });
    const simulation = createRateBasedFireSimulation({
      size: resolution.gridSize,
      cellSizeMeters: resolution.cellSizeMeters,
      ignition: { row: Math.floor(resolution.gridSize / 2), col: Math.floor(resolution.gridSize / 2) },
      fuelModel: getFuelModel(context.fuelCodes[ignitionIndex] ?? 'SH5'),
      fuelModelCodes: context.fuelCodes,
      fuelModelDefinitionsByCode: context.fuelModelDefinitionsByCode,
      terrainHeights: context.terrainHeights,
      moistureFraction: conditions.moistureFraction,
      deadMoistureFraction: conditions.moistureFraction,
      liveMoistureFraction: conditions.liveMoistureFraction,
      deadMoistureByClass,
      liveMoistureByClass,
      weatherTimeline,
      tenMeterWindKmh: conditions.windSpeedKmh,
      midflameWindKmh: conditions.windSpeedKmh * 0.4,
      windDirectionRadians: compassToMathRadians(conditions.windDirectionDeg),
      maxPropagationMinutes: conditions.horizonMinutes
    });
    arrivalField = serializeArrivalTimes(simulation.arrivalTimes);
  } else if (propagation === 'rate') {
    rateField = createRateField({
      fuelCodes: context.fuelCodes,
      fuelModelDefinitionsByCode: context.fuelModelDefinitionsByCode,
      windSpeedKmh: conditions.windSpeedKmh,
      windDirectionDeg: conditions.windDirectionDeg,
      moistureFraction: conditions.moistureFraction
    });
    const result = await propagate({
      rates: rateField,
      gridSize: region.gridSize,
      cellSizeMeters: region.cellSizeMeters,
      ignitionIndex
    }, { signal });
    if (!(result?.arrivalField instanceof Float32Array) || result.arrivalField.length !== totalCells) {
      throw new Error('runScenario: propagator returned an invalid arrival field');
    }
    arrivalField = result.arrivalField;
    engine = result.engine;
    fallbackReason = result.fallbackReason ?? null;
  } else if (propagation === 'rothermel') {
    const result = await propagateRothermel(createFireRequest({
      fuelCodes: context.fuelCodes,
      fuelModelDefinitionsByCode: context.fuelModelDefinitionsByCode,
      terrainHeights: context.terrainHeights,
      gridSize: region.gridSize,
      cellSizeMeters: region.cellSizeMeters,
      ignitionIndex,
      maxPropagationMinutes: conditions.horizonMinutes,
      deadMoistureFraction: conditions.moistureFraction,
      liveMoistureFraction: conditions.liveMoistureFraction,
      deadMoistureByClass,
      liveMoistureByClass,
      weatherTimeline,
      tenMeterWindKmh: conditions.windSpeedKmh,
      windDirectionRadians: compassToMathRadians(conditions.windDirectionDeg)
    }), { signal });
    if (result?.arrivalField instanceof Float32Array && result.arrivalField.length === totalCells) {
      arrivalField = result.arrivalField;
      engine = result.engine;
    }
    fallbackReason = result?.fallbackReason ?? null;
  }
  return {
    ignition: normalized.ignition,
    region,
    arrivalField,
    active: activeFireCells({ arrivalField, gridSize: region.gridSize, atMinutes: 0 }),
    context: {
      fuelCodes: context.fuelCodes,
      terrainHeights: context.terrainHeights ?? null,
      terrain: context.terrainHeights ? { available: true } : { available: false },
      wind: context.wind ?? null,
      weather: context.weather ?? null,
      buildings: context.buildings ?? [],
      roads: context.roads ?? []
    },
    evidence: context.evidence ?? { sources: [], fallbacks: [] },
    confidence: context.confidence ?? 'fallback',
    simulation: {
      engine,
      fallbackReason,
      rateField,
      ignitionIndex,
      horizonMinutes: conditions.horizonMinutes,
      windSpeedKmh: conditions.windSpeedKmh,
      windDirectionDeg: conditions.windDirectionDeg,
      moistureFraction: conditions.moistureFraction
    }
  };
}
