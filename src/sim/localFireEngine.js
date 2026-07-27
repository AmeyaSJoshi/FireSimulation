import { calculateSurfaceSpread } from '../lib/surfaceSpread.js';
import { ellipseRateFromHeadBacking } from '../lib/fireEllipse.js';

// The fire engine. Solves an arrival-time field in-process.
//
// Consumes the *same* snake_case request createFireRequest() already
// builds, and returns the same arrivalMinutes field, so every call site,
// contract test, and renderer stays untouched. The only thing that changes is
// that the solve happens here instead of over HTTP to a service that has to
// be running separately.
//
// Physics is not reimplemented: the request carries fuel models flattened
// into parallel arrays, so this rehydrates them and calls the project's own
// validated Rothermel implementation (surfaceSpread.js) and elliptical
// directional model (fireEllipse.js) — the same modules the regional
// benchmark and validate:rothermel score. Nothing in src/lib/ is modified.

const SQRT2 = Math.SQRT2;
// Eight-neighbour offsets with their unit direction vectors. East is +col,
// north is -row (row 0 = north, matching spatialGrid).
const NEIGHBORS = [
  [-1, 0, 0, 1], [1, 0, 0, -1], [0, -1, -1, 0], [0, 1, 1, 0],
  [-1, -1, -SQRT2 / 2, SQRT2 / 2], [-1, 1, SQRT2 / 2, SQRT2 / 2],
  [1, -1, -SQRT2 / 2, -SQRT2 / 2], [1, 1, SQRT2 / 2, -SQRT2 / 2]
];

function heapPush(heap, item) {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heap[parent][0] <= item[0]) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = item;
}

function heapPop(heap) {
  const first = heap[0];
  const tail = heap.pop();
  if (heap.length === 0) return first;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && heap[right][0] < heap[left][0] ? right : left;
    if (heap[child][0] >= tail[0]) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = tail;
  return first;
}

// Rebuild a fuelModel object of the shape surfaceSpread.js expects from the
// flattened per-model arrays in the request.
function rehydrateModels(request) {
  const count = request.fuel_bed_depths.length;
  const models = [];
  for (let m = 0; m < count; m += 1) {
    const deadLoads = request.dead_loads_by_model[m] ?? [];
    const liveLoads = request.live_loads_by_model[m] ?? [];
    models.push({
      burnable: request.burnable_by_model[m] === 1,
      fuelBedDepthMeters: request.fuel_bed_depths[m],
      particleDensityKgPerM3: request.particle_densities[m],
      totalMineralContentFraction: request.total_minerals[m],
      effectiveMineralContentFraction: request.effective_minerals[m],
      heatContentKjPerKg: request.heat_contents[m],
      moistureOfExtinctionFraction: request.dead_extinctions[m],
      deadFuel: deadLoads.map((loadKgPerM2, i) => ({
        loadKgPerM2,
        savRatioPerMeter: request.dead_savs_by_model[m][i]
      })),
      liveFuel: liveLoads.map((loadKgPerM2, i) => ({
        loadKgPerM2,
        savRatioPerMeter: request.live_savs_by_model[m][i]
      }))
    });
  }
  return models;
}

// Linear interpolation over the weather timeline, matching the contract's
// documented behaviour: speed interpolates linearly, direction comes from
// interpolated wind-vector components.
function weatherAtTime(request, minutes, modelCount) {
  const times = request.weather_minutes ?? [];
  if (times.length === 0) return null;
  let upper = times.findIndex((value) => value >= minutes);
  if (upper === -1) upper = times.length - 1;
  const lower = upper === 0 ? 0 : upper - 1;
  const span = times[upper] - times[lower];
  const t = span > 0 ? (minutes - times[lower]) / span : 0;
  const mix = (a, b) => a + (b - a) * Math.max(0, Math.min(1, t));

  const east = mix(request.weather_wind_easts_by_time[lower], request.weather_wind_easts_by_time[upper]);
  const north = mix(request.weather_wind_norths_by_time[lower], request.weather_wind_norths_by_time[upper]);
  const midflame = [];
  const deadMoistures = [];
  const liveMoistures = [];
  for (let m = 0; m < modelCount; m += 1) {
    midflame.push(mix(
      request.weather_midflame_winds_by_time[lower][m],
      request.weather_midflame_winds_by_time[upper][m]
    ));
    deadMoistures.push(request.weather_dead_moistures_by_time[upper][m]);
    liveMoistures.push(request.weather_live_moistures_by_time[upper][m]);
  }
  return {
    windDirectionRadians: Math.atan2(north, east),
    midflameByModel: midflame,
    deadMoisturesByModel: deadMoistures,
    liveMoisturesByModel: liveMoistures
  };
}

function slopeAt(heights, gridSize, cellSizeMeters, row, col) {
  const at = (r, c) => heights[
    Math.min(gridSize - 1, Math.max(0, r)) * gridSize + Math.min(gridSize - 1, Math.max(0, c))
  ];
  // Central differences; east is +col, north is -row.
  const dEast = (at(row, col + 1) - at(row, col - 1)) / (2 * cellSizeMeters);
  const dNorth = (at(row - 1, col) - at(row + 1, col)) / (2 * cellSizeMeters);
  const magnitude = Math.hypot(dEast, dNorth);
  if (magnitude === 0) return { slopeRadians: 0, slopeAspectEast: 0, slopeAspectNorth: 0 };
  return {
    slopeRadians: Math.atan(magnitude),
    // Aspect points uphill.
    slopeAspectEast: dEast / magnitude,
    slopeAspectNorth: dNorth / magnitude
  };
}

/**
 * Solve the arrival-time field for a fire request.
 * Returns { arrivalMinutes: Float32Array } with Infinity for unreached cells,
 * one entry per cell.
 */
export function solveFireRequest(request) {
  const gridSize = request.grid_size;
  const cellSizeMeters = request.cell_size_meters;
  const totalCells = gridSize * gridSize;
  const maxMinutes = request.max_propagation_minutes;
  const models = rehydrateModels(request);
  const modelIndices = request.fuel_model_indices;
  const heights = request.terrain_heights;
  const hasWeather = (request.weather_minutes ?? []).length > 0;

  const arrivals = new Float64Array(totalCells).fill(Infinity);
  arrivals[request.ignition_index] = 0;
  const heap = [[0, request.ignition_index]];

  // Rate lookups repeat heavily (same model + same weather slice + same
  // travel direction), so memoise per model/direction/time-bucket. Time is
  // bucketed to whole minutes; the weather timeline is hourly, so this cannot
  // skip a transition it would otherwise have resolved.
  const rateCache = new Map();

  while (heap.length > 0) {
    const [minutes, index] = heapPop(heap);
    if (minutes > arrivals[index]) continue;
    if (minutes >= maxMinutes) continue;
    const row = (index / gridSize) | 0;
    const col = index % gridSize;

    for (const [rowDelta, colDelta, dirEast, dirNorth] of NEIGHBORS) {
      const nextRow = row + rowDelta;
      const nextCol = col + colDelta;
      if (nextRow < 0 || nextRow >= gridSize || nextCol < 0 || nextCol >= gridSize) continue;
      const nextIndex = nextRow * gridSize + nextCol;

      const modelIndex = modelIndices[nextIndex];
      const model = models[modelIndex];
      if (!model.burnable) continue;

      const bucket = Math.round(minutes);
      const key = `${modelIndex}|${dirEast.toFixed(3)}|${dirNorth.toFixed(3)}|${nextIndex}|${hasWeather ? bucket : 0}`;
      let rate = rateCache.get(key);
      if (rate === undefined) {
        const weather = hasWeather ? weatherAtTime(request, minutes, models.length) : null;
        const midflameWindKmh = weather
          ? weather.midflameByModel[modelIndex]
          : request.midflame_winds_by_model[modelIndex];
        const windDirectionRadians = weather
          ? weather.windDirectionRadians
          : request.wind_direction_radians;
        const deadMoisture = weather
          ? weather.deadMoisturesByModel[modelIndex]
          : request.dead_moistures_by_model[modelIndex];
        const liveMoisture = weather
          ? weather.liveMoisturesByModel[modelIndex]
          : request.live_moistures_by_model[modelIndex];
        const slope = slopeAt(heights, gridSize, cellSizeMeters, nextRow, nextCol);

        const spread = calculateSurfaceSpread({
          fuelModel: model,
          deadMoistureByClass: null,
          liveMoistureByClass: null,
          deadMoistureFraction: averageOr(deadMoisture, request.dead_moisture),
          liveMoistureFraction: averageOr(liveMoisture, request.live_moisture),
          midflameWindKmh: Number.isFinite(midflameWindKmh) ? midflameWindKmh : 0,
          windDirectionRadians,
          slopeRadians: slope.slopeRadians,
          slopeAspectEast: slope.slopeAspectEast,
          slopeAspectNorth: slope.slopeAspectNorth,
          travelDirectionEast: dirEast,
          travelDirectionNorth: dirNorth
        });

        // surfaceSpread already resolves the directional rate when a travel
        // direction is supplied; fall back to the ellipse only if it did not.
        rate = Number(spread.rateMPerMin);
        if (!Number.isFinite(rate)) {
          const angle = Math.atan2(dirNorth, dirEast) - windDirectionRadians;
          rate = ellipseRateFromHeadBacking({
            headRateMPerMin: spread.headRateMPerMin,
            backingRateMPerMin: spread.backingRateMPerMin,
            angleRadians: angle
          });
        }
        rate = Math.max(0, rate || 0);
        rateCache.set(key, rate);
      }
      if (rate <= 0) continue;

      const distance = cellSizeMeters * (rowDelta !== 0 && colDelta !== 0 ? SQRT2 : 1);
      const candidate = minutes + distance / rate;
      if (candidate > maxMinutes) continue;
      if (candidate < arrivals[nextIndex]) {
        arrivals[nextIndex] = candidate;
        heapPush(heap, [candidate, nextIndex]);
      }
    }
  }

  return { arrivalMinutes: Float32Array.from(arrivals) };
}

// The contract carries per-size-class moisture rows; surfaceSpread takes a
// single fraction when no per-class map is given, so collapse to the mean.
function averageOr(rows, fallback) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return Number.isFinite(rows) ? rows : fallback;
  }
  const valid = rows.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return fallback;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}
