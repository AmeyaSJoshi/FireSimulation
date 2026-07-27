import { getFuelModel } from '../lib/fuelModels.js';
import { windToMidflame } from '../lib/weatherInputs.js';

function requiredArray(name, value, length) {
  if (!value || value.length !== length) throw new RangeError(`fireContract: ${name} must contain ${length} values`);
  return value;
}

function rows(model, key, property) {
  return (model[key] ?? []).map((row) => Number(row[property]) || 0);
}

function moistureRows(model, key, moistureByClass, fallback) {
  return (model[key] ?? []).map((row) => {
    const moisture = moistureByClass?.[row.className];
    return Number.isFinite(moisture) ? moisture : fallback;
  });
}

function normalizedWeatherTimeline(weatherTimeline, models, {
  deadMoistureFraction,
  liveMoistureFraction
}) {
  if (!Array.isArray(weatherTimeline)) return [];
  return weatherTimeline
    .filter((entry) => (
      Number.isFinite(entry?.minutesFromIgnition)
      && entry.minutesFromIgnition >= 0
      && Number.isFinite(entry?.windDirectionRadians)
      && (Number.isFinite(entry?.tenMeterWindKmh) || Number.isFinite(entry?.midflameWindKmh))
    ))
    .sort((left, right) => left.minutesFromIgnition - right.minutesFromIgnition)
    .map((entry) => {
      const midflameByModel = models.map((model) => Number.isFinite(entry.tenMeterWindKmh)
        ? windToMidflame({
          tenMeterWindKmh: entry.tenMeterWindKmh,
          referenceHeightMeters: entry.referenceHeightMeters,
          fuelBedDepthMeters: model.fuelBedDepthMeters,
          fuelModel: model
        }).speedKmh
        : entry.midflameWindKmh);
      const directionalMidflame = Number.isFinite(entry.midflameWindKmh)
        ? entry.midflameWindKmh
        : midflameByModel[0];
      return {
        minutes: entry.minutesFromIgnition,
        // Match weatherAtTime(): speed is linearly interpolated while the
        // direction is derived from interpolated wind-vector components.
        windEast: directionalMidflame * Math.cos(entry.windDirectionRadians),
        windNorth: directionalMidflame * Math.sin(entry.windDirectionRadians),
        midflameByModel,
        deadMoisturesByModel: models.map((model) => moistureRows(
          model, 'deadFuel', entry.deadMoistureByClass, entry.deadMoistureFraction ?? deadMoistureFraction
        )),
        liveMoisturesByModel: models.map((model) => moistureRows(
          model, 'liveFuel', entry.liveMoistureByClass, entry.liveMoistureFraction ?? liveMoistureFraction
        ))
      };
    });
}

export function createFireRequest({
  fuelCodes,
  fuelModelDefinitionsByCode = {},
  terrainHeights = null,
  gridSize,
  cellSizeMeters,
  ignitionIndex,
  maxPropagationMinutes,
  deadMoistureFraction,
  liveMoistureFraction,
  deadMoistureByClass = null,
  liveMoistureByClass = null,
  weatherTimeline = null,
  tenMeterWindKmh,
  midflameWindKmh = null,
  windDirectionRadians
} = {}) {
  if (!Number.isInteger(gridSize) || gridSize < 2) throw new RangeError('fireContract: gridSize must be an integer >= 2');
  const totalCells = gridSize ** 2;
  requiredArray('fuelCodes', fuelCodes, totalCells);
  if (!Number.isFinite(cellSizeMeters) || cellSizeMeters <= 0) throw new RangeError('fireContract: cellSizeMeters must be positive');
  if (!Number.isInteger(ignitionIndex) || ignitionIndex < 0 || ignitionIndex >= totalCells) throw new RangeError('fireContract: ignitionIndex is outside the grid');
  if (!Number.isFinite(maxPropagationMinutes) || maxPropagationMinutes <= 0) throw new RangeError('fireContract: maxPropagationMinutes must be positive');
  const modelIndexByCode = new Map();
  const models = [];
  const fuelModelIndices = fuelCodes.map((code) => {
    if (!modelIndexByCode.has(code)) {
      modelIndexByCode.set(code, models.length);
      models.push(fuelModelDefinitionsByCode[code] ?? getFuelModel(code));
    }
    return modelIndexByCode.get(code);
  });
  const heights = terrainHeights
    ? Array.from(requiredArray('terrainHeights', terrainHeights, totalCells), (value) => Number.isFinite(value) ? value : 0)
    : Array(totalCells).fill(0);
  const weather = normalizedWeatherTimeline(weatherTimeline, models, {
    deadMoistureFraction,
    liveMoistureFraction
  });
  return {
    fuel_model_indices: fuelModelIndices,
    terrain_heights: heights,
    dead_loads_by_model: models.map((model) => rows(model, 'deadFuel', 'loadKgPerM2')),
    dead_savs_by_model: models.map((model) => rows(model, 'deadFuel', 'savRatioPerMeter')),
    live_loads_by_model: models.map((model) => rows(model, 'liveFuel', 'loadKgPerM2')),
    live_savs_by_model: models.map((model) => rows(model, 'liveFuel', 'savRatioPerMeter')),
    dead_moistures_by_model: models.map((model) => moistureRows(
      model, 'deadFuel', deadMoistureByClass, deadMoistureFraction
    )),
    live_moistures_by_model: models.map((model) => moistureRows(
      model, 'liveFuel', liveMoistureByClass, liveMoistureFraction
    )),
    fuel_bed_depths: models.map((model) => model.fuelBedDepthMeters),
    particle_densities: models.map((model) => model.particleDensityKgPerM3),
    total_minerals: models.map((model) => model.totalMineralContentFraction),
    effective_minerals: models.map((model) => model.effectiveMineralContentFraction),
    heat_contents: models.map((model) => model.heatContentKjPerKg),
    dead_extinctions: models.map((model) => model.moistureOfExtinctionFraction),
    burnable_by_model: models.map((model) => model.burnable ? 1 : 0),
    midflame_winds_by_model: models.map((model) => Number.isFinite(tenMeterWindKmh)
      ? windToMidflame({
        tenMeterWindKmh,
        fuelBedDepthMeters: model.fuelBedDepthMeters,
        fuelModel: model
      }).speedKmh
      : midflameWindKmh),
    dead_moisture: deadMoistureFraction,
    live_moisture: liveMoistureFraction,
    wind_direction_radians: windDirectionRadians,
    weather_minutes: weather.map((entry) => entry.minutes),
    weather_wind_easts_by_time: weather.map((entry) => entry.windEast),
    weather_wind_norths_by_time: weather.map((entry) => entry.windNorth),
    weather_midflame_winds_by_time: weather.map((entry) => entry.midflameByModel),
    weather_dead_moistures_by_time: weather.map((entry) => entry.deadMoisturesByModel),
    weather_live_moistures_by_time: weather.map((entry) => entry.liveMoisturesByModel),
    grid_size: gridSize,
    cell_size_meters: cellSizeMeters,
    ignition_index: ignitionIndex,
    max_propagation_minutes: maxPropagationMinutes
  };
}

