// Deterministic arrival-time propagation over a common local raster.
//
// This module deliberately does not use neighbor ignition probabilities.
// It solves the earliest travel time to each burnable cell with a priority
// queue, using the local surface-spread kernel for the rate on each edge.
// Burnout is derived from the fuel model's Rothermel residence-time
// approximation. Animation interval sampling is kept separate from the
// physical lifetime so changing the solver timestep does not change fuel
// consumption semantics.

import { computeSlopeAspect } from './terrainDerivatives.js';
import { getFuelModel } from './fuelModels.js';
import { ellipseRateFromHeadBacking } from './fireEllipse.js';
import { calculateSurfaceSpread } from './surfaceSpread.js';
import {
  calculateRothermelActiveCrownSpread,
  activeCrownRequiredRateMPerMin,
  calculateCrownFractionBurned,
  classifyCrownFire,
  blendCrownRate,
  crownInitiationIntensityKwPerM
} from './crownFire.js';
import { windToMidflame } from './weatherInputs.js';
import {
  countSuppressionBarrierEdges,
  PROPAGATION_NEIGHBORS
} from './suppressionConstraints.js';

const NEIGHBORS = PROPAGATION_NEIGHBORS;
const WEATHER_INTEGRATION_STEP_MINUTES = 10;
const WEATHER_POST_WINDOW_POLICY = 'block';

class MinHeap {
  #items = [];

  get size() {
    return this.#items.length;
  }

  push(item) {
    this.#items.push(item);
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.#items[parent].time <= item.time) break;
      this.#items[index] = this.#items[parent];
      index = parent;
    }
    this.#items[index] = item;
  }

  pop() {
    if (this.#items.length === 0) return null;
    const first = this.#items[0];
    const last = this.#items.pop();
    if (this.#items.length === 0) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.#items.length) break;
      const right = left + 1;
      const child = right < this.#items.length && this.#items[right].time < this.#items[left].time
        ? right
        : left;
      if (this.#items[child].time >= last.time) break;
      this.#items[index] = this.#items[child];
      index = child;
    }
    this.#items[index] = last;
    return first;
  }
}

function validatePositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`firePropagation: ${name} must be a positive finite number, got ${value}`);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function dot(a, b) {
  return a.east * b.east + a.north * b.north;
}

function solveMonotonicThreshold(predicate, { maximumWindKmh = 120, iterations = 12 } = {}) {
  if (predicate(0)) return 0;
  if (!predicate(maximumWindKmh)) return Infinity;
  let lower = 0;
  let upper = maximumWindKmh;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (predicate(middle)) upper = middle;
    else lower = middle;
  }
  return upper;
}

function roundedKey(value, places = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(places)) : 'na';
}

function moistureKey(moistureByClass) {
  if (!moistureByClass) return 'na';
  return ['1h', '10h', '100h'].map((className) => roundedKey(moistureByClass[className])).join(',');
}

function normalizeWeatherTimeline(timeline) {
  if (!Array.isArray(timeline)) return [];
  return timeline
    .filter((entry) => (
      Number.isFinite(entry?.minutesFromIgnition)
      && entry.minutesFromIgnition >= 0
      && Number.isFinite(entry?.midflameWindKmh)
      && entry.midflameWindKmh >= 0
      && Number.isFinite(entry?.windDirectionRadians)
    ))
    .map((entry) => ({
      minutesFromIgnition: entry.minutesFromIgnition,
      tenMeterWindKmh: Number.isFinite(entry.tenMeterWindKmh) && entry.tenMeterWindKmh >= 0
        ? entry.tenMeterWindKmh
        : null,
      referenceHeightMeters: Number.isFinite(entry.referenceHeightMeters)
        && entry.referenceHeightMeters > 0
        ? entry.referenceHeightMeters
        : 10,
      midflameWindKmh: entry.midflameWindKmh,
      windDirectionRadians: entry.windDirectionRadians,
      deadMoistureByClass: entry.deadMoistureByClass ?? null,
      liveMoistureByClass: entry.liveMoistureByClass ?? null,
      deadMoistureFraction: Number.isFinite(entry.deadMoistureFraction)
        ? entry.deadMoistureFraction
        : null,
      liveMoistureFraction: Number.isFinite(entry.liveMoistureFraction)
        ? entry.liveMoistureFraction
        : null,
      sourceTime: entry.sourceTime ?? null
    }))
    .sort((a, b) => a.minutesFromIgnition - b.minutesFromIgnition);
}

function weatherAtTime(timeline, minutes, fallback) {
  if (timeline.length === 0) return fallback;
  if (minutes <= timeline[0].minutesFromIgnition) return timeline[0];
  if (timeline.length === 1) return timeline[0];
  if (minutes > timeline.at(-1).minutesFromIgnition + 1e-9) {
    return {
      ...timeline.at(-1),
      weatherExpired: true
    };
  }

  let lowerIndex = 0;
  let upperIndex = timeline.length - 1;
  while (upperIndex - lowerIndex > 1) {
    const middleIndex = Math.floor((lowerIndex + upperIndex) / 2);
    if (timeline[middleIndex].minutesFromIgnition < minutes) lowerIndex = middleIndex;
    else upperIndex = middleIndex;
  }
  const lower = timeline[lowerIndex];
  const upper = timeline[upperIndex];
  const span = upper.minutesFromIgnition - lower.minutesFromIgnition;
  const amount = span > 0
    ? (minutes - lower.minutesFromIgnition) / span
    : 0;
  const lowerEast = lower.midflameWindKmh * Math.cos(lower.windDirectionRadians);
  const lowerNorth = lower.midflameWindKmh * Math.sin(lower.windDirectionRadians);
  const upperEast = upper.midflameWindKmh * Math.cos(upper.windDirectionRadians);
  const upperNorth = upper.midflameWindKmh * Math.sin(upper.windDirectionRadians);
  const east = lowerEast + (upperEast - lowerEast) * amount;
  const north = lowerNorth + (upperNorth - lowerNorth) * amount;
  const interpolate = (key) => Number.isFinite(lower[key]) && Number.isFinite(upper[key])
    ? lower[key] + (upper[key] - lower[key]) * amount
    : (Number.isFinite(lower[key]) ? lower[key] : upper[key]);
  const classNames = ['1h', '10h', '100h'];
  const interpolateClasses = (key, classNames) => {
    if (!lower[key] || !upper[key]) return lower[key] ?? upper[key] ?? null;
    return Object.fromEntries(classNames.map((className) => [
      className,
      interpolateOptionalClassMoisture(lower[key], upper[key], className, amount)
    ]));
  };
  return {
    midflameWindKmh: Math.hypot(east, north),
    tenMeterWindKmh: interpolate('tenMeterWindKmh'),
    referenceHeightMeters: lower.referenceHeightMeters ?? upper.referenceHeightMeters ?? 10,
    windDirectionRadians: Math.atan2(north, east),
    deadMoistureByClass: interpolateClasses('deadMoistureByClass', ['1h', '10h', '100h']),
    liveMoistureByClass: interpolateClasses('liveMoistureByClass', ['herbaceous', 'woody']),
    deadMoistureFraction: interpolate('deadMoistureFraction'),
    liveMoistureFraction: interpolate('liveMoistureFraction'),
      sourceTime: upper.sourceTime ?? lower.sourceTime ?? null
  };
}

function nextWeatherBoundaryMinutes(timeline, minutes) {
  let lower = 0;
  let upper = timeline.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (timeline[middle].minutesFromIgnition <= minutes + 1e-9) lower = middle + 1;
    else upper = middle;
  }
  return timeline[lower]?.minutesFromIgnition ?? Infinity;
}

function interpolateOptionalClassMoisture(lower, upper, className, amount) {
  const lowerValue = lower[className];
  const upperValue = upper[className];
  if (Number.isFinite(lowerValue) && Number.isFinite(upperValue)) {
    return lowerValue + (upperValue - lowerValue) * amount;
  }
  return Number.isFinite(lowerValue) ? lowerValue : upperValue;
}

export function createRateBasedFireSimulation({
  size = 128,
  cellSizeMeters = 1000,
  ignition = null,
  fuelModel = null,
  fuelModelCodes = null,
  fuelModelDefinitionsByCode = null,
  moistureFraction = 0.08,
  deadMoistureFraction = null,
  liveMoistureFraction = null,
  moistureByCell = null,
  fuelLoadScaleByCell = null,
  deadMoistureByCell = null,
  liveMoistureByCell = null,
  fuelPersistenceMinutesByCell = null,
  deadMoistureByClass = null,
  liveMoistureByClass = null,
  waterBarrierEdges = null,
  suppressionBarrierTimes = null,
  midflameWindKmh = 0,
  tenMeterWindKmh = null,
  referenceHeightMeters = 10,
  canopySheltered = false,
  canopyShelteredByCell = null,
  canopyCrownAvailableByCell = null,
  canopyHeightByCell = null,
  canopyCoverFractionByCell = null,
  canopyBaseHeightByCell = null,
  canopyBulkDensityByCell = null,
  canopyFoliarMoistureFraction = 1,
  windDirectionRadians = 0,
  terrainHeights = null,
  defaultSlopeRadians = 0,
  defaultSlopeAspectEast = 0,
  defaultSlopeAspectNorth = 0,
  timestepMinutes = 1,
  burnDurationMinutes = 30,
  weatherTimeline = null,
  maxPropagationMinutes = Infinity
} = {}) {
  if (!Number.isInteger(size) || size < 3) {
    throw new RangeError(`firePropagation: size must be an integer >= 3, got ${size}`);
  }
  validatePositive('cellSizeMeters', cellSizeMeters);
  validatePositive('timestepMinutes', timestepMinutes);
  validatePositive('burnDurationMinutes', burnDurationMinutes);
  if (maxPropagationMinutes !== Infinity
    && (!Number.isFinite(maxPropagationMinutes) || maxPropagationMinutes < 0)) {
    throw new RangeError('firePropagation: maxPropagationMinutes must be non-negative or Infinity');
  }
  if (!fuelModel && !fuelModelCodes) {
    throw new TypeError('firePropagation: fuelModel or fuelModelCodes is required');
  }

  const totalCells = size * size;
  const expectedEdgeCount = totalCells * NEIGHBORS.length;
  if (suppressionBarrierTimes !== null
    && (!suppressionBarrierTimes || suppressionBarrierTimes.length !== expectedEdgeCount)) {
    throw new RangeError(`firePropagation: suppressionBarrierTimes must have length ${expectedEdgeCount}`);
  }
  const suppressionBarrierEdgeCount = suppressionBarrierTimes
    ? countSuppressionBarrierEdges(suppressionBarrierTimes, size)
    : 0;
  const terrainField = terrainHeights && terrainHeights.length === totalCells
    ? terrainHeights
    : null;
  const fuelPersistence = fuelPersistenceMinutesByCell
    && fuelPersistenceMinutesByCell.length === totalCells
    ? fuelPersistenceMinutesByCell
    : null;
  const terrain = terrainField
    ? computeSlopeAspect(terrainField, { cellSizeMeters, gridSize: size })
    : null;
  const modelCache = new Map();
  const crownThresholdCache = new Map();
  const modelForIndex = (index) => {
    const code = fuelModelCodes ? fuelModelCodes[index] : fuelModel?.code;
    if (!code) return fuelModel;
    if (!modelCache.has(code)) {
      const definition = fuelModelDefinitionsByCode?.[code];
      modelCache.set(code, definition ?? (code === fuelModel?.code ? fuelModel : getFuelModel(code)));
    }
    return modelCache.get(code);
  };
  const burnDurationMinutesByCell = new Float32Array(totalCells);
  burnDurationMinutesByCell.fill(burnDurationMinutes);
  const residenceTimeCache = new Map();
  const burnDurationForIndex = (index) => {
    const model = modelForIndex(index);
    if (!model?.burnable) return burnDurationMinutes;
    if (!residenceTimeCache.has(model)) {
      const spread = calculateSurfaceSpread({
        fuelModel: model,
        moistureFraction: 0.08,
        deadMoistureFraction: 0.08,
        liveMoistureFraction: 0.08,
        midflameWindKmh: 0,
        windDirectionRadians: 0,
        slopeRadians: 0
      });
      const residenceTimeMinutes = spread.intermediate?.residenceTimeMinutes;
      residenceTimeCache.set(model, Number.isFinite(residenceTimeMinutes)
        ? residenceTimeMinutes
        : burnDurationMinutes);
    }
    return residenceTimeCache.get(model);
  };
  for (let index = 0; index < totalCells; index += 1) {
    burnDurationMinutesByCell[index] = burnDurationForIndex(index);
  }
  const resolvedDeadMoisture = deadMoistureFraction === null ? moistureFraction : deadMoistureFraction;
  const resolvedLiveMoisture = liveMoistureFraction === null ? moistureFraction : liveMoistureFraction;
  const normalizedWeatherTimeline = normalizeWeatherTimeline(weatherTimeline);
  const hasTimeVaryingWeather = normalizedWeatherTimeline.length > 1;
  const initialWeather = weatherAtTime(normalizedWeatherTimeline, 0, {
    midflameWindKmh,
    tenMeterWindKmh,
    referenceHeightMeters,
    windDirectionRadians
  });
  const moistureForIndex = (index) => ({
    dead: deadMoistureByCell?.[index] ?? moistureByCell?.[index] ?? resolvedDeadMoisture,
    live: liveMoistureByCell?.[index] ?? moistureByCell?.[index] ?? resolvedLiveMoisture
  });
  const arrivalTimes = new Float64Array(totalCells);
  arrivalTimes.fill(Infinity);
  const state = new Uint8Array(totalCells);
  const intensity = new Uint8Array(totalCells);
  const heap = new MinHeap();
  const horizonLimitedCells = new Set();
  let suppressionBlockedTransitionCount = 0;
  // Spatial-grid callers naturally use { row, col }; browser callers use
  // { x, y }. Accept both at the solver boundary so a coordinate naming
  // mismatch cannot silently move ignition to the default center cell.
  const ignitionXValue = Number.isFinite(ignition?.x) ? ignition.x : ignition?.col;
  const ignitionYValue = Number.isFinite(ignition?.y) ? ignition.y : ignition?.row;
  const ignitionX = clamp(
    Math.floor(Number.isFinite(ignitionXValue) ? ignitionXValue : (size - 1) / 2),
    0,
    size - 1
  );
  const ignitionY = clamp(
    Math.floor(Number.isFinite(ignitionYValue) ? ignitionYValue : (size - 1) / 2),
    0,
    size - 1
  );
  const ignitionIndex = ignitionY * size + ignitionX;
  const ignitionModel = modelForIndex(ignitionIndex);

  if (ignitionModel?.burnable) {
    arrivalTimes[ignitionIndex] = 0;
    heap.push({ time: 0, index: ignitionIndex });
  }

  // Dijkstra's algorithm is appropriate here because all edge travel times
  // are non-negative. The resulting arrival field is independent of the
  // animation timestep, which makes the simulation deterministic.
  while (heap.size > 0) {
    const current = heap.pop();
    if (!current || current.time !== arrivalTimes[current.index]) continue;
    const row = Math.floor(current.index / size);
    const col = current.index % size;
    const currentSlope = terrain && !terrain.noData[current.index]
      ? terrain.slopeRadians[current.index]
      : defaultSlopeRadians;
    const currentAspectEast = terrain && !terrain.noData[current.index]
      ? terrain.aspectEast[current.index]
      : defaultSlopeAspectEast;
    const currentAspectNorth = terrain && !terrain.noData[current.index]
      ? terrain.aspectNorth[current.index]
      : defaultSlopeAspectNorth;

    for (let directionIndex = 0; directionIndex < NEIGHBORS.length; directionIndex += 1) {
      if (waterBarrierEdges?.[current.index * NEIGHBORS.length + directionIndex] === 1) continue;
      const suppressionTime = suppressionBarrierTimes?.[
        current.index * NEIGHBORS.length + directionIndex
      ];
      if (Number.isFinite(suppressionTime) && current.time >= suppressionTime) {
        suppressionBlockedTransitionCount += 1;
        continue;
      }
      const [dx, dy] = NEIGHBORS[directionIndex];
      const nextCol = col + dx;
      const nextRow = row + dy;
      if (nextCol < 0 || nextCol >= size || nextRow < 0 || nextRow >= size) continue;
      const nextIndex = nextRow * size + nextCol;
      const nextModel = modelForIndex(nextIndex);
      if (!nextModel?.burnable) continue;

      const distanceCells = Math.hypot(dx, dy);
      const nextMoisture = moistureForIndex(nextIndex);
      const nextFuelLoadScale = fuelLoadScaleByCell?.[nextIndex] ?? 1;
      const localCanopySheltered = canopyShelteredByCell
        ? canopyShelteredByCell[nextIndex] === 1
        : canopySheltered;
      const travelDirection = {
        east: dx / distanceCells,
        north: -dy / distanceCells
      };
      const calculateEdgeRate = (weather) => {
        if (weather?.weatherExpired) return 0;
        const surfaceInputs = {
          fuelModel: nextModel,
          moistureFraction: weather.deadMoistureFraction ?? nextMoisture.dead,
          deadMoistureFraction: weather.deadMoistureFraction ?? nextMoisture.dead,
          liveMoistureFraction: weather.liveMoistureFraction ?? nextMoisture.live,
          deadMoistureByClass: weather.deadMoistureByClass ?? deadMoistureByClass,
          liveMoistureByClass: weather.liveMoistureByClass ?? liveMoistureByClass,
          fuelLoadScale: nextFuelLoadScale,
          windDirectionRadians: weather.windDirectionRadians,
          slopeRadians: currentSlope,
          slopeAspectEast: currentAspectEast,
          slopeAspectNorth: currentAspectNorth
        };
        const calculateSurfaceAtOpenWind = (openWindKmh) => calculateSurfaceSpread({
          ...surfaceInputs,
          midflameWindKmh: windToMidflame({
          tenMeterWindKmh: openWindKmh,
          referenceHeightMeters: weather.referenceHeightMeters,
          canopySheltered: localCanopySheltered,
            canopyHeightMeters: canopyHeightByCell?.[nextIndex],
            canopyCoverFraction: canopyCoverFractionByCell?.[nextIndex],
            fuelBedDepthMeters: nextModel.fuelBedDepthMeters,
            fuelModel: nextModel
          }).speedKmh
        });
        const spread = Number.isFinite(weather.tenMeterWindKmh)
          ? calculateSurfaceAtOpenWind(weather.tenMeterWindKmh)
          : calculateSurfaceSpread({
            ...surfaceInputs,
            midflameWindKmh: weather.midflameWindKmh
          });
        if (!(spread.headRateMPerMin > 0)) return 0;
        const forcingMagnitude = Math.hypot(
          spread.effectiveForcing.east,
          spread.effectiveForcing.north
        );
        const forcingDirection = forcingMagnitude > 0
          ? {
            east: spread.effectiveForcing.east / forcingMagnitude,
            north: spread.effectiveForcing.north / forcingMagnitude
          }
          : { east: 1, north: 0 };
        const angleRadians = Math.acos(clamp(
          dot(forcingDirection, travelDirection),
          -1,
          1
        ));
        const surfaceDirectionalRate = ellipseRateFromHeadBacking({
          headRateMPerMin: spread.headRateMPerMin,
          backingRateMPerMin: spread.backingRateMPerMin,
          angleRadians
        });
        if (!canopyCrownAvailableByCell?.[nextIndex]
          || !Number.isFinite(weather.tenMeterWindKmh)
          || !Number.isFinite(canopyBaseHeightByCell?.[nextIndex])
          || !Number.isFinite(canopyBulkDensityByCell?.[nextIndex])) {
          return surfaceDirectionalRate;
        }

        // Exact early-out before any threshold solving. Crown fraction burned
        // is zero whenever the open wind is at or below the torching index,
        // and fireline intensity rises monotonically with wind, so
        // "surface intensity <= initiation intensity at this wind" is
        // equivalent to "at or below the torching index" -- without running
        // the bisection. This matters enormously for cost: the thresholds
        // otherwise get re-solved at every 10-minute weather step of every
        // edge (~25 Rothermel evaluations each), and the overwhelming
        // majority of cell-times never come close to torching.
        if (!(spread.firelineIntensityKwPerM > crownInitiationIntensityKwPerM({
          canopyBaseHeightMeters: canopyBaseHeightByCell[nextIndex],
          foliarMoistureFraction: canopyFoliarMoistureFraction
        }))) {
          return surfaceDirectionalRate;
        }

        const activeCrown = calculateRothermelActiveCrownSpread({
          openWindKmh: weather.tenMeterWindKmh,
          referenceHeightMeters: weather.referenceHeightMeters,
          windDirectionRadians: weather.windDirectionRadians,
          slopeRadians: currentSlope,
          slopeAspectEast: currentAspectEast,
          slopeAspectNorth: currentAspectNorth,
          deadMoistureFraction: weather.deadMoistureFraction ?? nextMoisture.dead,
          liveMoistureFraction: weather.liveMoistureFraction ?? nextMoisture.live
        });
        const activeDirectionalRate = ellipseRateFromHeadBacking({
          headRateMPerMin: activeCrown.activeHeadRateMPerMin,
          backingRateMPerMin: activeCrown.activeBackingRateMPerMin,
          angleRadians
        });
        const thresholdKey = [
          // Keyed on the canopy VALUES rather than the cell index: the
          // thresholds are a pure function of the physical inputs, and
          // LANDFIRE quantizes canopy base height (0.1 m) and bulk density
          // (0.01 kg/m3), so a few hundred distinct combinations cover the
          // whole grid. Keying on nextIndex instead gave every one of the
          // 16384 cells its own entry, thrashing the bounded cache and
          // re-running ~25 Rothermel solves per edge.
          roundedKey(canopyBaseHeightByCell[nextIndex]),
          roundedKey(canopyBulkDensityByCell[nextIndex]),
          roundedKey(canopyHeightByCell?.[nextIndex]),
          roundedKey(canopyCoverFractionByCell?.[nextIndex]),
          nextModel.code,
          roundedKey(nextFuelLoadScale),
          roundedKey(currentSlope),
          roundedKey(currentAspectEast),
          roundedKey(currentAspectNorth),
          roundedKey(weather.referenceHeightMeters),
          roundedKey(weather.windDirectionRadians),
          roundedKey(surfaceInputs.deadMoistureFraction),
          roundedKey(surfaceInputs.liveMoistureFraction),
          moistureKey(surfaceInputs.deadMoistureByClass),
          JSON.stringify(surfaceInputs.liveMoistureByClass ?? null),
          localCanopySheltered ? 1 : 0,
          roundedKey(canopyFoliarMoistureFraction)
        ].join('|');
        let crownThresholds = crownThresholdCache.get(thresholdKey);
        if (!crownThresholds) {
          const initiationIntensityKwPerM = crownInitiationIntensityKwPerM({
            canopyBaseHeightMeters: canopyBaseHeightByCell[nextIndex],
            foliarMoistureFraction: canopyFoliarMoistureFraction
          });
          const requiredActiveRateMPerMin = activeCrownRequiredRateMPerMin({
            canopyBulkDensityKgPerM3: canopyBulkDensityByCell[nextIndex]
          });
          const torchingIndexWindKmh = solveMonotonicThreshold(
            (openWindKmh) => calculateSurfaceAtOpenWind(openWindKmh).firelineIntensityKwPerM
              > initiationIntensityKwPerM
          );
          const crowningIndexWindKmh = solveMonotonicThreshold(
            (openWindKmh) => calculateRothermelActiveCrownSpread({
              openWindKmh,
              referenceHeightMeters: weather.referenceHeightMeters,
              windDirectionRadians: weather.windDirectionRadians,
              slopeRadians: currentSlope,
              slopeAspectEast: currentAspectEast,
              slopeAspectNorth: currentAspectNorth,
              deadMoistureFraction: surfaceInputs.deadMoistureFraction,
              liveMoistureFraction: surfaceInputs.liveMoistureFraction
            }).activeHeadRateMPerMin >= requiredActiveRateMPerMin
          );
          crownThresholds = { torchingIndexWindKmh, crowningIndexWindKmh };
          crownThresholdCache.set(thresholdKey, crownThresholds);
          while (crownThresholdCache.size > 4096) {
            crownThresholdCache.delete(crownThresholdCache.keys().next().value);
          }
        }
        const crownFractionBurned = calculateCrownFractionBurned({
          openWindKmh: weather.tenMeterWindKmh,
          ...crownThresholds
        });
        const crownState = classifyCrownFire({
          surfaceFirelineIntensityKwPerM: spread.firelineIntensityKwPerM,
          surfaceRateMPerMin: surfaceDirectionalRate,
          surfaceHeatPerUnitAreaKjPerM2: spread.heatPerUnitAreaKjPerM2,
          canopyBaseHeightMeters: canopyBaseHeightByCell[nextIndex],
          canopyBulkDensityKgPerM3: canopyBulkDensityByCell[nextIndex],
          foliarMoistureFraction: canopyFoliarMoistureFraction,
          activeCrownRateMPerMin: activeCrown.activeHeadRateMPerMin,
          crownFractionBurned
        });
        return blendCrownRate({
          surfaceRateMPerMin: surfaceDirectionalRate,
          activeRateMPerMin: activeDirectionalRate,
          crownFractionBurned: crownState.crownFractionBurned
        });
      };
      const distanceMeters = distanceCells * cellSizeMeters;
      const calculateTravelMinutes = () => {
        const rateAtMinutes = (minutes) => calculateEdgeRate(weatherAtTime(
          normalizedWeatherTimeline,
          minutes,
          initialWeather
        ));
        const startWeather = weatherAtTime(
          normalizedWeatherTimeline,
          current.time,
          initialWeather
        );
        const startRateMPerMin = calculateEdgeRate(startWeather);
        if (!hasTimeVaryingWeather) return distanceMeters / startRateMPerMin;

        // A cell with supported slow-fuel evidence can retain a finite
        // ignition memory after flaming spread is suppressed by weather. It
        // may wait for the next positive-rate window, but it cannot travel
        // while the rate is zero and the memory never extends past this cap.
        // Ignition memory bounds how long this edge may sit DORMANT waiting
        // for the next positive-rate window -- it is a cumulative waiting
        // budget, not a wall-clock deadline measured from the source cell's
        // arrival. Charging active spread time against it made the budget
        // expire before the first zero-rate gap on any edge slower than the
        // budget itself (a 250 m cell in grass takes ~2000 min to cross, so
        // no realistic persistence value could ever engage), which silently
        // reduced every slow-fuel landscape to a dead frontier.
        const persistenceMinutes = Math.max(0, fuelPersistence?.[current.index] ?? 0);
        let waitedMinutes = 0;
        const findNextPositiveRate = (fromMinutes, toMinutes) => {
          if (!Number.isFinite(toMinutes) || toMinutes <= fromMinutes + 1e-9) return Infinity;
          const sampleCount = Math.max(
            1,
            Math.ceil((toMinutes - fromMinutes) / WEATHER_INTEGRATION_STEP_MINUTES)
          );
          let lowerMinutes = fromMinutes;
          let lowerRate = rateAtMinutes(lowerMinutes);
          for (let sample = 1; sample <= sampleCount; sample += 1) {
            const upperMinutes = fromMinutes
              + (toMinutes - fromMinutes) * sample / sampleCount;
            const upperRate = rateAtMinutes(upperMinutes);
            if (upperRate > 0) {
              if (lowerRate > 0) return lowerMinutes;
              let lower = lowerMinutes;
              let upper = upperMinutes;
              for (let iteration = 0; iteration < 20; iteration += 1) {
                const middle = (lower + upper) / 2;
                if (rateAtMinutes(middle) > 0) upper = middle;
                else lower = middle;
              }
              return upper;
            }
            lowerMinutes = upperMinutes;
            lowerRate = upperRate;
          }
          return Infinity;
        };

        let remainingDistanceMeters = distanceMeters;
        let cursorMinutes = current.time;
        for (let segment = 0; segment < 100000 && remainingDistanceMeters > 1e-9; segment += 1) {
          const currentRateMPerMin = rateAtMinutes(cursorMinutes);
          if (!(currentRateMPerMin > 0)) {
            const remainingWaitMinutes = persistenceMinutes - waitedMinutes;
            if (!(remainingWaitMinutes > 1e-9)) return Infinity;
            const waitDeadlineMinutes = cursorMinutes + remainingWaitMinutes;
            const boundaryMinutes = nextWeatherBoundaryMinutes(
              normalizedWeatherTimeline,
              cursorMinutes
            );
            const searchEndMinutes = Math.min(boundaryMinutes, waitDeadlineMinutes);
            const nextPositiveMinutes = findNextPositiveRate(cursorMinutes, searchEndMinutes);
            if (!Number.isFinite(nextPositiveMinutes)) {
              // A dormant source may have to cross several fully
              // extinguished forecast intervals before the next usable
              // window. Advance over the known interval only while the
              // finite ignition-memory budget still has room, charging
              // every dormant minute against that budget.
              if (Number.isFinite(boundaryMinutes)
                && boundaryMinutes < waitDeadlineMinutes - 1e-9) {
                waitedMinutes += boundaryMinutes - cursorMinutes;
                cursorMinutes = boundaryMinutes;
                continue;
              }
              return Infinity;
            }
            waitedMinutes += nextPositiveMinutes - cursorMinutes;
            cursorMinutes = nextPositiveMinutes;
            continue;
          }

          const boundaryMinutes = nextWeatherBoundaryMinutes(
            normalizedWeatherTimeline,
            cursorMinutes
          );
          // No analytic close-out when no further weather boundary exists:
          // WEATHER_POST_WINDOW_POLICY blocks new spread past the final
          // observation, so the stepped loop must reach the expired-weather
          // zero rate and stop rather than extrapolating the last rate
          // forward forever.
          //
          // The ignition-memory budget bounds only dormant waiting (handled
          // above, before this branch). Once the rate is positive the front
          // is actively spreading, not relying on stored memory, so this
          // step must not be capped by that budget too.
          const plannedEndMinutes = Math.min(
            cursorMinutes + WEATHER_INTEGRATION_STEP_MINUTES,
            boundaryMinutes
          );
          if (!(plannedEndMinutes > cursorMinutes)) return Infinity;
          let segmentEndMinutes = plannedEndMinutes;
          let endpointRateMPerMin = rateAtMinutes(segmentEndMinutes);
          let hitZeroBeforePlannedEnd = false;
          if (!(endpointRateMPerMin > 0)) {
            let lower = cursorMinutes;
            let upper = segmentEndMinutes;
            for (let iteration = 0; iteration < 20; iteration += 1) {
              const middle = (lower + upper) / 2;
              if (rateAtMinutes(middle) > 0) lower = middle;
              else upper = middle;
            }
            segmentEndMinutes = lower;
            endpointRateMPerMin = rateAtMinutes(segmentEndMinutes);
            hitZeroBeforePlannedEnd = true;
          }
          if (!(segmentEndMinutes > cursorMinutes)
            || !(endpointRateMPerMin > 0)) return Infinity;
          const segmentMinutes = segmentEndMinutes - cursorMinutes;
          const midpointRateMPerMin = rateAtMinutes(cursorMinutes + segmentMinutes / 2);
          if (!(midpointRateMPerMin > 0)) return Infinity;
          const averageRateMPerMin = (
            currentRateMPerMin + 4 * midpointRateMPerMin + endpointRateMPerMin
          ) / 6;
          const segmentDistanceMeters = averageRateMPerMin * segmentMinutes;
          if (!(segmentDistanceMeters > 0)) return Infinity;
          if (remainingDistanceMeters <= segmentDistanceMeters) {
            let lower = 0;
            let upper = segmentMinutes;
            for (let iteration = 0; iteration < 20; iteration += 1) {
              const candidate = (lower + upper) / 2;
              const candidateMidpointRate = rateAtMinutes(cursorMinutes + candidate / 2);
              const candidateEndpointRate = rateAtMinutes(cursorMinutes + candidate);
              if (!(candidateMidpointRate > 0) || !(candidateEndpointRate > 0)) return Infinity;
              const candidateDistance = candidate * (
                currentRateMPerMin + 4 * candidateMidpointRate + candidateEndpointRate
              ) / 6;
              if (candidateDistance >= remainingDistanceMeters) upper = candidate;
              else lower = candidate;
            }
            return (cursorMinutes - current.time) + (lower + upper) / 2;
          }
          remainingDistanceMeters -= segmentDistanceMeters;
          // Skip the known zero-rate tail of this weather segment. This is
          // important at a dry/wet/dry transition: returning to the exact
          // extinction root can otherwise make the positive-rate search
          // revisit the same floating-point boundary forever.
          cursorMinutes = hitZeroBeforePlannedEnd ? plannedEndMinutes : segmentEndMinutes;
        }
        return Infinity;
      };
      const travelMinutes = calculateTravelMinutes();
      if (!Number.isFinite(travelMinutes)) continue;
      const candidateTime = current.time + travelMinutes;
      if (candidateTime > maxPropagationMinutes) {
        if (maxPropagationMinutes !== Infinity) horizonLimitedCells.add(nextIndex);
        continue;
      }
      if (candidateTime < arrivalTimes[nextIndex]) {
        arrivalTimes[nextIndex] = candidateTime;
        heap.push({ time: candidateTime, index: nextIndex });
      }
    }
  }

  // The bounded solve records the first reachable cells beyond the horizon
  // without eagerly solving territory the interactive scenario will never
  // display. This is enough to distinguish a time cap from true exhaustion.
  const horizonLimitedCellCount = horizonLimitedCells.size;

  let fieldBoundaryCellCount = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (row !== 0 && row !== size - 1 && col !== 0 && col !== size - 1) continue;
      if (Number.isFinite(arrivalTimes[row * size + col])) fieldBoundaryCellCount += 1;
    }
  }
  const terminationReason = horizonLimitedCellCount > 0
    ? 'horizon_reached'
    : (fieldBoundaryCellCount > 0
      ? 'field_boundary_reached'
      : (suppressionBlockedTransitionCount > 0
        ? 'suppression_reached'
        : 'fuel_or_barriers_exhausted'));

  let modelTime = 0;
  let stepCount = 0;
  let burnedCount = 0;
  let activeCount = 0;
  let pendingCount = 0;

  function refreshState() {
    burnedCount = 0;
    activeCount = 0;
    pendingCount = 0;
    for (let index = 0; index < totalCells; index += 1) {
      const arrival = arrivalTimes[index];
      if (!Number.isFinite(arrival)) {
        state[index] = 0;
        intensity[index] = 0;
        continue;
      }
      if (arrival > modelTime) pendingCount += 1;
      const age = modelTime - arrival;
      if (age < -timestepMinutes) {
        state[index] = 0;
        intensity[index] = 0;
      } else if (age >= burnDurationMinutesByCell[index]) {
        state[index] = 3;
        intensity[index] = 28;
        burnedCount += 1;
      } else {
        state[index] = age < 0 ? 1 : 2;
        intensity[index] = age < 0
          ? Math.round(clamp((timestepMinutes + age) / timestepMinutes, 0, 1) * 180)
          : Math.round(clamp(
            255 * (1 - age / burnDurationMinutesByCell[index]),
            60,
            255
          ));
        activeCount += 1;
      }
    }
  }

  refreshState();

  function step() {
    stepCount += 1;
    modelTime += timestepMinutes;
    refreshState();
    return getState();
  }

  function getState() {
    return {
      size,
      state,
      intensity,
      arrivalTimes,
      burnedCount,
      activeCount,
      pendingCount,
      stepCount,
      terrainAvailable: Boolean(terrainField),
      horizonLimitedCellCount,
      fieldBoundaryCellCount,
      terminationReason,
      suppressionBarrierEdgeCount,
      suppressionBlockedTransitionCount
    };
  }

  function getFrame({ fromModelTime = null } = {}) {
    const frame = new Uint8Array(totalCells * 4);
    for (let index = 0; index < totalCells; index += 1) {
      const offset = index * 4;
      if (state[index] === 0) continue;
      if (state[index] === 1) {
        frame[offset] = 255;
        frame[offset + 1] = 62;
        frame[offset + 2] = 12;
        frame[offset + 3] = Math.max(18, intensity[index]);
      } else if (state[index] === 2) {
        frame[offset] = 255;
        frame[offset + 1] = Math.round(48 + intensity[index] * 0.55);
        frame[offset + 2] = Math.round(8 + intensity[index] * 0.18);
        frame[offset + 3] = Math.max(80, intensity[index]);
      } else {
        // The solver can advance many one-minute ticks between animation
        // frames. Temporally sample cells that genuinely burned during that
        // interval so accelerated playback does not skip the entire flame
        // front. A normal frame still renders burned cells as transparent.
        const arrival = arrivalTimes[index];
        const burnEnd = arrival + burnDurationMinutesByCell[index];
        const capturedDuringInterval = Number.isFinite(fromModelTime)
          && burnEnd > fromModelTime
          && arrival <= modelTime;
        if (capturedDuringInterval) {
          frame[offset] = 255;
          frame[offset + 1] = 86;
          frame[offset + 2] = 10;
          frame[offset + 3] = 96;
        } else {
          frame[offset + 3] = 0;
        }
      }
    }
    return frame;
  }

  function getBurnDurationMinutes(index) {
    if (!Number.isInteger(index) || index < 0 || index >= totalCells) return null;
    return burnDurationMinutesByCell[index];
  }

  function getMetrics(cellSizeKm = cellSizeMeters / 1000) {
    let footprintCells = 0;
    let perimeterCells = 0;
    let maxSpreadDistanceKm = 0;
    let dominantEast = 0;
    let dominantNorth = 0;
    const cellAreaKm2 = cellSizeKm * cellSizeKm;

    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const index = row * size + col;
        if (state[index] === 0) continue;
        footprintCells += 1;
        const east = col - ignitionX;
        const north = ignitionY - row;
        const distanceKm = Math.hypot(east, north) * cellSizeKm;
        if (distanceKm > maxSpreadDistanceKm) {
          maxSpreadDistanceKm = distanceKm;
          dominantEast = east;
          dominantNorth = north;
        }
        for (const [dx, dy] of NEIGHBORS.slice(0, 4)) {
          const neighborCol = col + dx;
          const neighborRow = row + dy;
          if (
            neighborCol < 0 || neighborCol >= size ||
            neighborRow < 0 || neighborRow >= size ||
            state[neighborRow * size + neighborCol] === 0
          ) perimeterCells += 1;
        }
      }
    }

      return {
      footprintCells,
      perimeterCells,
      footprintAreaKm2: footprintCells * cellAreaKm2,
      burnedAreaKm2: burnedCount * cellAreaKm2,
      perimeterKm: perimeterCells * cellSizeKm,
      elapsedMinutes: modelTime,
      maxSpreadDistanceKm,
      averageSpreadRateKmh: modelTime > 0
        ? maxSpreadDistanceKm / (modelTime / 60)
        : 0,
        dominantSpreadDirectionDeg: dominantEast || dominantNorth
          ? (Math.atan2(dominantNorth, dominantEast) * 180 / Math.PI + 360) % 360
          : 0,
        horizonLimitedCellCount,
        fieldBoundaryReached: fieldBoundaryCellCount > 0,
        terminationReason,
        suppressionBarrierEdgeCount,
        suppressionBlockedTransitionCount,
        cellSizeKm,
      fieldWidthKm: size * cellSizeKm
    };
  }

  return {
    step,
    getState,
    getFrame,
    getBurnDurationMinutes,
    getMetrics,
    arrivalTimes,
    terrain,
    params: {
      moistureFraction: resolvedDeadMoisture,
      deadMoistureFraction: resolvedDeadMoisture,
      liveMoistureFraction: resolvedLiveMoisture,
      midflameWindKmh,
      tenMeterWindKmh,
      referenceHeightMeters,
      canopySheltered,
      canopyShelteredByCell,
      windDirectionRadians,
      weatherTimeline: normalizedWeatherTimeline,
      weatherTimelineEndMinutes: normalizedWeatherTimeline.length > 1
        ? normalizedWeatherTimeline.at(-1).minutesFromIgnition
        : null,
      weatherPostWindowPolicy: WEATHER_POST_WINDOW_POLICY,
      fuelPersistenceMinutesByCell: fuelPersistence,
      timestepMinutes,
      maxPropagationMinutes,
      suppressionBarrierEdgeCount,
      suppressionBlockedTransitionCount
    },
    seed: 0
  };
}
