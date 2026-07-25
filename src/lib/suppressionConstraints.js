// Time-aware containment constraints for the arrival-time solver.
//
// A barrier time means that the directed transition is unavailable when the
// fire reaches its source cell at or after that model time. The default app
// supplies no suppression constraints; this contract is for historical
// replay, operational inputs, and future UI/data adapters.

export const PROPAGATION_NEIGHBORS = Object.freeze([
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1]
]);

export function createSuppressionBarrierTimes({
  size,
  edges = [],
  defaultBlockedFromMinutes = 0
} = {}) {
  validateSize(size);
  if (!Array.isArray(edges)) {
    throw new TypeError('suppressionConstraints: edges must be an array');
  }
  validateBlockedTime(defaultBlockedFromMinutes, 'defaultBlockedFromMinutes');

  const result = new Float64Array(size * size * PROPAGATION_NEIGHBORS.length);
  result.fill(Infinity);
  for (const [edgeIndex, edge] of edges.entries()) {
    const from = normalizeCell(edge?.from, size, `edges[${edgeIndex}].from`);
    const to = normalizeCell(edge?.to, size, `edges[${edgeIndex}].to`);
    const deltaRow = to.row - from.row;
    const deltaCol = to.col - from.col;
    // PROPAGATION_NEIGHBORS uses the solver's [dx, dy] order: east/west
    // first, then south/north. Public cell coordinates remain [row, col].
    const directionIndex = PROPAGATION_NEIGHBORS.findIndex(([dx, dy]) => (
      dx === deltaCol && dy === deltaRow
    ));
    if (directionIndex < 0) {
      throw new RangeError(
        `suppressionConstraints: edges[${edgeIndex}] must connect neighboring cells`
      );
    }
    const blockedFromMinutes = edge?.blockedFromMinutes ?? defaultBlockedFromMinutes;
    validateBlockedTime(blockedFromMinutes, `edges[${edgeIndex}].blockedFromMinutes`);
    const fromIndex = from.row * size + from.col;
    const toIndex = to.row * size + to.col;
    const reverseDirectionIndex = PROPAGATION_NEIGHBORS.findIndex(([dx, dy]) => (
      dx === -deltaCol && dy === -deltaRow
    ));
    const forwardOffset = fromIndex * PROPAGATION_NEIGHBORS.length + directionIndex;
    const reverseOffset = toIndex * PROPAGATION_NEIGHBORS.length + reverseDirectionIndex;
    result[forwardOffset] = Math.min(result[forwardOffset], blockedFromMinutes);
    result[reverseOffset] = Math.min(result[reverseOffset], blockedFromMinutes);
  }
  return result;
}

export function countSuppressionBarrierEdges(barrierTimes, size) {
  validateSize(size);
  const expectedLength = size * size * PROPAGATION_NEIGHBORS.length;
  if (!barrierTimes || barrierTimes.length !== expectedLength) {
    throw new RangeError(`suppressionConstraints: expected ${expectedLength} barrier times`);
  }
  let count = 0;
  for (const blockedFromMinutes of barrierTimes) {
    if (blockedFromMinutes === Infinity) continue;
    validateBlockedTime(blockedFromMinutes, 'barrier time');
    count += 1;
  }
  return count;
}

// Convert one observed perimeter snapshot into an explicit containment line.
// This is intentionally a diagnostic/data-assimilation helper: it may explain
// a historical growth stall, but it must never be inferred from the observed
// perimeter and silently injected into an operational forecast.
export function createPerimeterContainmentBarriers({
  observedMask,
  size,
  blockedFromMinutes
} = {}) {
  validateSize(size);
  const expectedLength = size * size;
  if (!observedMask || observedMask.length !== expectedLength) {
    throw new RangeError(`suppressionConstraints: observedMask must have length ${expectedLength}`);
  }
  validateBlockedTime(blockedFromMinutes, 'blockedFromMinutes');

  const edges = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const fromIndex = row * size + col;
      for (const [dx, dy] of PROPAGATION_NEIGHBORS) {
        const nextRow = row + dy;
        const nextCol = col + dx;
        if (nextRow < 0 || nextRow >= size || nextCol < 0 || nextCol >= size) continue;
        const toIndex = nextRow * size + nextCol;
        if (toIndex <= fromIndex || Boolean(observedMask[fromIndex]) === Boolean(observedMask[toIndex])) {
          continue;
        }
        edges.push({
          from: [row, col],
          to: [nextRow, nextCol],
          blockedFromMinutes
        });
      }
    }
  }
  return createSuppressionBarrierTimes({ size, edges });
}

function normalizeCell(cell, size, name) {
  const row = Array.isArray(cell) ? cell[0] : cell?.row;
  const col = Array.isArray(cell) ? cell[1] : cell?.col;
  if (!Number.isInteger(row) || !Number.isInteger(col)
    || row < 0 || row >= size || col < 0 || col >= size) {
    throw new RangeError(`suppressionConstraints: ${name} must be an in-bounds cell`);
  }
  return { row, col };
}

function validateBlockedTime(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`suppressionConstraints: ${name} must be a non-negative finite number`);
  }
}

function validateSize(size) {
  if (!Number.isInteger(size) || size < 3) {
    throw new RangeError(`suppressionConstraints: size must be an integer >= 3, got ${size}`);
  }
}
