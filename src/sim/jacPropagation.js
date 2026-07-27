import { runJacFire } from './jacClient.js';

const SQRT2 = 1.41421356237;

function assertRequest({ rates, gridSize, cellSizeMeters, ignitionIndex }) {
  if (!rates || rates.length !== gridSize * gridSize) {
    throw new RangeError('jacPropagation: rates length must equal gridSize squared');
  }
  if (!Number.isInteger(gridSize) || gridSize < 2) {
    throw new RangeError('jacPropagation: gridSize must be an integer >= 2');
  }
  if (!Number.isFinite(cellSizeMeters) || cellSizeMeters <= 0) {
    throw new RangeError('jacPropagation: cellSizeMeters must be positive');
  }
  if (!Number.isInteger(ignitionIndex) || ignitionIndex < 0 || ignitionIndex >= rates.length) {
    throw new RangeError('jacPropagation: ignitionIndex is outside the field');
  }
}

function push(heap, item) {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent][0] <= item[0]) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = item;
}

function pop(heap) {
  const first = heap[0];
  const tail = heap.pop();
  if (heap.length === 0 || !tail) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    const child = right < heap.length && heap[right][0] < heap[left][0] ? right : left;
    if (heap[child][0] >= tail[0]) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = tail;
  return first;
}

export function solveRateFieldInJavaScript(request) {
  assertRequest(request);
  const { rates, gridSize, cellSizeMeters, ignitionIndex } = request;
  // Keep Dijkstra's working distances at full precision; the Jac runtime does
  // the same, then both engines compact the completed field to Float32.
  const arrivals = Array(rates.length).fill(-1);
  arrivals[ignitionIndex] = 0;
  const queue = [[0, ignitionIndex]];
  while (queue.length > 0) {
    const [minutes, index] = pop(queue);
    if (minutes !== arrivals[index]) continue;
    const row = Math.floor(index / gridSize);
    const col = index % gridSize;
    for (let rowDelta = -1; rowDelta <= 1; rowDelta += 1) {
      for (let colDelta = -1; colDelta <= 1; colDelta += 1) {
        if (rowDelta === 0 && colDelta === 0) continue;
        const nextRow = row + rowDelta;
        const nextCol = col + colDelta;
        if (nextRow < 0 || nextRow >= gridSize || nextCol < 0 || nextCol >= gridSize) continue;
        const nextIndex = nextRow * gridSize + nextCol;
        const rate = Number(rates[nextIndex]);
        if (!Number.isFinite(rate) || rate <= 0) continue;
        const distance = cellSizeMeters * (rowDelta !== 0 && colDelta !== 0 ? SQRT2 : 1);
        const candidate = minutes + distance / rate;
        if (arrivals[nextIndex] < 0 || candidate < arrivals[nextIndex]) {
          arrivals[nextIndex] = candidate;
          push(queue, [candidate, nextIndex]);
        }
      }
    }
  }
  return Float32Array.from(arrivals);
}

function extractJacArrivals(payload, expectedLength) {
  const report = payload?.data?.result?.reports?.[0] ?? payload?.data?.reports?.[0];
  const arrivals = report?.arrivalMinutes;
  if (!Array.isArray(arrivals) || arrivals.length !== expectedLength) {
    throw new Error('jacPropagation: Jac response did not contain a complete arrival field');
  }
  return Float32Array.from(arrivals, (value) => Number.isFinite(value) ? value : -1);
}

export async function propagateWithJac(request, {
  fetchImpl = globalThis.fetch,
  endpoint = 'http://127.0.0.1:8010/walker/Propagate',
  signal = undefined,
  toleranceMinutes = 0.001
} = {}) {
  const fallback = solveRateFieldInJavaScript(request);
  if (typeof fetchImpl !== 'function') {
    return { arrivalField: fallback, engine: 'javascript-rate', fallbackReason: 'fetch unavailable' };
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rates: Array.from(request.rates),
        grid_size: request.gridSize,
        cell_size_meters: request.cellSizeMeters,
        ignition_index: request.ignitionIndex
      }),
      signal
    });
    if (!response.ok) throw new Error(`Jac returned HTTP ${response.status}`);
    const jac = extractJacArrivals(await response.json(), fallback.length);
    for (let index = 0; index < jac.length; index += 1) {
      if (Math.abs(jac[index] - fallback[index]) > toleranceMinutes) {
        throw new Error(`Jac mismatch at cell ${index}`);
      }
    }
    return { arrivalField: jac, engine: 'jac', fallbackReason: null };
  } catch (error) {
    return { arrivalField: fallback, engine: 'javascript-rate', fallbackReason: error.message };
  }
}

export async function propagateRothermelWithJac(request, {
  fetchImpl = globalThis.fetch,
  endpoint = undefined,
  signal = undefined
} = {}) {
  // The sole production RunFire client. Keeping this adapter deliberately
  // tiny lets runScenario retain its renderer-neutral result contract while
  // ensuring Cesium and every scenario caller use identical transport,
  // validation, endpoint selection, and failure behavior.
  const result = await runJacFire(request, { fetchImpl, ...(endpoint ? { endpoint } : {}), signal });
  return {
    arrivalField: Float32Array.from(result.arrivalMinutes, (arrival) => Number.isFinite(arrival) ? arrival : -1),
    engine: 'jac-rothermel',
    fallbackReason: null
  };
}
