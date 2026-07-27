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

// Previously raced a Jac /walker/Propagate call against the JS solver and
// cross-checked them. With the service gone, the JS solver above IS the
// engine — it was already the reference the remote result had to match.
export async function propagateWithJac(request) {
  return {
    arrivalField: solveRateFieldInJavaScript(request),
    engine: 'javascript-rate',
    fallbackReason: null
  };
}

export async function propagateRothermelWithJac(request, { signal = undefined } = {}) {
  // The sole production RunFire path. Keeping this adapter tiny lets
  // runScenario retain its renderer-neutral result contract while every
  // caller shares identical validation and failure behaviour.
  const result = await runJacFire(request, { signal });
  return {
    arrivalField: Float32Array.from(result.arrivalMinutes, (arrival) => Number.isFinite(arrival) ? arrival : -1),
    engine: 'javascript-rothermel',
    fallbackReason: null
  };
}
