const CARDINAL_NEIGHBORS = [
  [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
  [-1, -1, 0.72], [1, -1, 0.72], [-1, 1, 0.72], [1, 1, 0.72]
];

const FUEL_PRESETS = {
  grass: { fuel: 1.28, burnDuration: 8 },
  brush: { fuel: 1.0, burnDuration: 13 },
  timber: { fuel: 0.76, burnDuration: 21 }
};

const DEFAULT_PARAMS = {
  windSpeed: 18,
  windDirection: 45,
  moisture: 0.32,
  slopeStrength: 0.2,
  fuelPreset: 'brush'
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function radians(degrees) {
  return degrees * Math.PI / 180;
}

function normalizeParams(params = {}) {
  const merged = { ...DEFAULT_PARAMS, ...params };
  return {
    windSpeed: clamp(Number(merged.windSpeed) || 0, 0, 60),
    windDirection: ((Number(merged.windDirection) || 0) % 360 + 360) % 360,
    moisture: clamp(Number(merged.moisture) || 0, 0, 1),
    slopeStrength: clamp(Number(merged.slopeStrength) || 0, 0, 1),
    fuelPreset: FUEL_PRESETS[merged.fuelPreset] ? merged.fuelPreset : 'brush'
  };
}

function makeRandom(seed) {
  let value = (seed >>> 0) || 1;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function makeSlopeVector(scenario, params) {
  if (scenario === 'slope') return { x: 0, y: 1 };
  const direction = radians(params.slopeDirection ?? 90);
  return { x: Math.cos(direction), y: Math.sin(direction) };
}

export function createFireSimulation({
  size = 128,
  seed = 17,
  params = {},
  scenario = 'calm',
  ignition = null,
  terrainHeights = null
} = {}) {
  const gridSize = Math.max(9, Math.floor(size));
  const totalCells = gridSize * gridSize;
  const random = makeRandom(seed);
  const state = new Uint8Array(totalCells);
  const intensity = new Uint8Array(totalCells);
  const fuel = new Float32Array(totalCells);
  const moisture = new Float32Array(totalCells);
  const heat = new Float32Array(totalCells);
  const burnAge = new Uint16Array(totalCells);
  const normalizedParams = normalizeParams(params);
  const fuelPreset = FUEL_PRESETS[normalizedParams.fuelPreset];
  const slope = makeSlopeVector(scenario, normalizedParams);
  const terrainField = terrainHeights && terrainHeights.length === totalCells
    ? terrainHeights
    : null;
  let burnedCount = 0;
  let activeCount = 0;
  let stepCount = 0;

  const ignitionX = clamp(Math.floor(ignition?.x ?? (gridSize - 1) / 2), 1, gridSize - 2);
  const ignitionY = clamp(Math.floor(ignition?.y ?? (gridSize - 1) / 2), 1, gridSize - 2);
  const barrierX = Math.floor(gridSize * 0.58);

  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const index = y * gridSize + x;
      const noise = 0.97 + random() * 0.06;
      const isBarrier = scenario === 'barrier' && x === barrierX;
      fuel[index] = isBarrier ? 0 : fuelPreset.fuel * noise;
      moisture[index] = normalizedParams.moisture;
      if (isBarrier) moisture[index] = 1;
    }
  }

  const ignitionIndex = ignitionY * gridSize + ignitionX;
  state[ignitionIndex] = 2;
  intensity[ignitionIndex] = 255;
  activeCount = 1;

  function step() {
    stepCount += 1;
    const windDirection = radians(normalizedParams.windDirection);
    const windX = Math.cos(windDirection);
    const windY = Math.sin(windDirection);
    const windStrength = normalizedParams.windSpeed / 60;
    const dryness = 1 - normalizedParams.moisture * 0.78;
    const nextIgnitions = [];
    let nextActiveCount = 0;

    for (let y = 1; y < gridSize - 1; y += 1) {
      for (let x = 1; x < gridSize - 1; x += 1) {
        const index = y * gridSize + x;
        const cellState = state[index];
        if (cellState === 1) {
          heat[index] *= 0.93;
          if (heat[index] >= 1) nextIgnitions.push(index);
          continue;
        }
        if (cellState !== 2) continue;

        burnAge[index] += 1;
        const burnLimit = fuelPreset.burnDuration * (0.72 + moisture[index] * 0.7);
        intensity[index] = Math.round(255 * clamp(1 - burnAge[index] / burnLimit, 0.08, 1));
        if (burnAge[index] >= burnLimit) {
          state[index] = 3;
          intensity[index] = 28;
          burnedCount += 1;
          activeCount -= 1;
          continue;
        }
        nextActiveCount += 1;

        for (const [dx, dy, distanceWeight] of CARDINAL_NEIGHBORS) {
          const neighborX = x + dx;
          const neighborY = y + dy;
          const neighborIndex = neighborY * gridSize + neighborX;
          if (fuel[neighborIndex] <= 0 || state[neighborIndex] >= 2) continue;

          const distance = Math.hypot(dx, dy);
          const directionX = dx / distance;
          const directionY = dy / distance;
          const downwind = Math.max(0, directionX * windX + directionY * windY);
          const upwind = Math.max(0, -directionX * windX - directionY * windY);
          const windFactor = clamp(
            1 + windStrength * (4.2 * downwind - 0.28 * upwind),
            0.24,
            5.2
          );
          const uphill = directionX * slope.x + directionY * slope.y;
          const slopeFactor = clamp(
            1 + normalizedParams.slopeStrength * (1.35 * Math.max(0, uphill) - 0.35 * Math.max(0, -uphill)),
            0.45,
            2.35
          );
          const terrainGradient = terrainField
            ? clamp((terrainField[neighborIndex] - terrainField[index]) / 20, -1, 1)
            : 0;
          const terrainFactor = terrainField
            ? clamp(1 + terrainGradient * 1.4, 0.35, 2.4)
            : 1;
          const spread = 0.24 * fuel[neighborIndex] * dryness * windFactor * slopeFactor * terrainFactor * distanceWeight;
          heat[neighborIndex] += spread;
          if (state[neighborIndex] === 0) state[neighborIndex] = 1;
        }
      }
    }

    for (const index of nextIgnitions) {
      if (state[index] !== 1 || heat[index] < 1 || fuel[index] <= 0) continue;
      state[index] = 2;
      intensity[index] = 220;
      burnAge[index] = 0;
      activeCount += 1;
      nextActiveCount += 1;
    }

    // A dormant ember that is no longer fed by a burning cell cools away.
    for (let index = 0; index < totalCells; index += 1) {
      if (state[index] === 1 && heat[index] < 0.08) state[index] = 0;
    }

    return getState();
  }

  function getState() {
    return {
      size: gridSize,
      state,
      intensity,
      fuel,
      moisture,
      burnedCount,
      activeCount,
      stepCount,
      terrainAvailable: Boolean(terrainField)
    };
  }

  function getFrame() {
    const frame = new Uint8Array(totalCells * 4);
    for (let index = 0; index < totalCells; index += 1) {
      const offset = index * 4;
      const cellState = state[index];
      const heatAmount = intensity[index];
      if (cellState === 0) continue;
      if (cellState === 1) {
        frame[offset] = 255;
        frame[offset + 1] = 62;
        frame[offset + 2] = 12;
        frame[offset + 3] = Math.min(190, Math.max(18, Math.round(heat[index] * 145)));
      } else if (cellState === 2) {
        frame[offset] = 255;
        frame[offset + 1] = Math.round(48 + heatAmount * 0.55);
        frame[offset + 2] = Math.round(8 + heatAmount * 0.18);
        frame[offset + 3] = Math.max(80, heatAmount);
      } else {
        frame[offset] = 152;
        frame[offset + 1] = 26;
        frame[offset + 2] = 4;
        frame[offset + 3] = Math.min(90, heatAmount + 20);
      }
    }
    return frame;
  }

  function getMetrics(cellSizeKm = 1, timestepMinutes = 1) {
    let footprintCells = 0;
    let perimeterCells = 0;
    let maxSpreadDistanceKm = 0;
    let dominantDirectionX = 0;
    let dominantDirectionY = 0;
    const cellAreaKm2 = cellSizeKm * cellSizeKm;

    for (let y = 0; y < gridSize; y += 1) {
      for (let x = 0; x < gridSize; x += 1) {
        const index = y * gridSize + x;
        if (state[index] === 0) continue;
        footprintCells += 1;
        const offsetX = x - ignitionX;
        const offsetY = y - ignitionY;
        const spreadDistanceKm = Math.hypot(offsetX, offsetY) * cellSizeKm;
        if (spreadDistanceKm > maxSpreadDistanceKm) {
          maxSpreadDistanceKm = spreadDistanceKm;
          dominantDirectionX = offsetX;
          dominantDirectionY = offsetY;
        }
        for (const [dx, dy] of CARDINAL_NEIGHBORS.slice(0, 4)) {
          const neighborX = x + dx;
          const neighborY = y + dy;
          if (
            neighborX < 0 || neighborX >= gridSize ||
            neighborY < 0 || neighborY >= gridSize ||
            state[neighborY * gridSize + neighborX] === 0
          ) {
            perimeterCells += 1;
          }
        }
      }
    }

    return {
      footprintCells,
      perimeterCells,
      footprintAreaKm2: footprintCells * cellAreaKm2,
      burnedAreaKm2: burnedCount * cellAreaKm2,
      perimeterKm: perimeterCells * cellSizeKm,
      elapsedMinutes: stepCount * timestepMinutes,
      maxSpreadDistanceKm,
      averageSpreadRateKmh: stepCount > 0
        ? maxSpreadDistanceKm / (stepCount * timestepMinutes / 60)
        : 0,
      dominantSpreadDirectionDeg: dominantDirectionX || dominantDirectionY
        ? (Math.atan2(dominantDirectionY, dominantDirectionX) * 180 / Math.PI + 360) % 360
        : 0,
      cellSizeKm,
      fieldWidthKm: gridSize * cellSizeKm
    };
  }

  return {
    step,
    getState,
    getFrame,
    getMetrics,
    params: normalizedParams,
    slope,
    seed
  };
}

export { DEFAULT_PARAMS, FUEL_PRESETS };
