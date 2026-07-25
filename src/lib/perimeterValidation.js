// Geometry-free validation metrics for comparing a simulated arrival field
// with an observed fire perimeter rasterized onto the same local grid.

function assertMask(name, mask, expectedLength) {
  if (!mask || typeof mask.length !== 'number' || mask.length !== expectedLength) {
    throw new RangeError(`${name} must have length ${expectedLength}`);
  }
}

function assertGridSize(size) {
  if (!Number.isInteger(size) || size < 2) {
    throw new RangeError(`perimeterValidation: size must be an integer >= 2, got ${size}`);
  }
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(x, y, rings) {
  if (!rings?.[0] || !pointInRing(x, y, rings[0])) return false;
  return !rings.slice(1).some((hole) => pointInRing(x, y, hole));
}

function geometryPolygons(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) {
    throw new TypeError('perimeterValidation: GeoJSON geometry is required');
  }
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  throw new TypeError(`perimeterValidation: unsupported geometry type ${geometry.type}`);
}

export function rasterizePerimeterGeometry({ geometry, grid } = {}) {
  if (!grid || typeof grid.cellCenterLatLon !== 'function') {
    throw new TypeError('perimeterValidation: a spatial grid is required');
  }
  const size = grid.gridSize;
  assertGridSize(size);
  const polygons = geometryPolygons(geometry).map((rings) => rings.map((ring) => ring.map(([longitude, latitude]) => (
    grid.latLonToCell(latitude, longitude)
  ))));
  const mask = new Uint8Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const index = row * size + col;
      const inside = polygons.some((rings) => pointInPolygon(col, row, rings.map((ring) => (
        ring.map(({ row: ringRow, col: ringCol }) => [ringCol, ringRow])
      ))));
      mask[index] = inside ? 1 : 0;
    }
  }
  return mask;
}

function boundaryIndices(mask, size) {
  const result = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const index = row * size + col;
      if (!mask[index]) continue;
      const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      if (neighbors.some(([dx, dy]) => {
        const nextRow = row + dy;
        const nextCol = col + dx;
        return nextRow < 0 || nextRow >= size || nextCol < 0 || nextCol >= size
          || !mask[nextRow * size + nextCol];
      })) result.push([row, col]);
    }
  }
  return result;
}

function meanNearestDistanceKm(from, to, cellSizeMeters) {
  if (from.length === 0 || to.length === 0) return Infinity;
  let total = 0;
  for (const [row, col] of from) {
    let nearestSquared = Infinity;
    for (const [otherRow, otherCol] of to) {
      nearestSquared = Math.min(
        nearestSquared,
        (row - otherRow) ** 2 + (col - otherCol) ** 2
      );
    }
    total += Math.sqrt(nearestSquared) * cellSizeMeters / 1000;
  }
  return total / from.length;
}

function centroid(mask, size) {
  let count = 0;
  let rowTotal = 0;
  let colTotal = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    count += 1;
    rowTotal += Math.floor(index / size);
    colTotal += index % size;
  }
  return count > 0
    ? { row: rowTotal / count, col: colTotal / count }
    : null;
}

export function comparePerimeterMasks({
  predictedMask,
  observedMask,
  size,
  cellSizeMeters = 1000
} = {}) {
  assertGridSize(size);
  if (!Number.isFinite(cellSizeMeters) || cellSizeMeters <= 0) {
    throw new RangeError('perimeterValidation: cellSizeMeters must be positive');
  }
  const expectedLength = size * size;
  assertMask('predictedMask', predictedMask, expectedLength);
  assertMask('observedMask', observedMask, expectedLength);

  let predictedCount = 0;
  let observedCount = 0;
  let intersectionCount = 0;
  for (let index = 0; index < expectedLength; index += 1) {
    const predicted = predictedMask[index] > 0;
    const observed = observedMask[index] > 0;
    if (predicted) predictedCount += 1;
    if (observed) observedCount += 1;
    if (predicted && observed) intersectionCount += 1;
  }

  const unionCount = predictedCount + observedCount - intersectionCount;
  const precision = predictedCount > 0 ? intersectionCount / predictedCount : 0;
  const recall = observedCount > 0 ? intersectionCount / observedCount : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const predictedBoundary = boundaryIndices(predictedMask, size);
  const observedBoundary = boundaryIndices(observedMask, size);
  const predictedCentroid = centroid(predictedMask, size);
  const observedCentroid = centroid(observedMask, size);
  const centroidErrorKm = predictedCentroid && observedCentroid
    ? Math.hypot(
      predictedCentroid.row - observedCentroid.row,
      predictedCentroid.col - observedCentroid.col
    ) * cellSizeMeters / 1000
    : Infinity;

  return {
    predictedCellCount: predictedCount,
    observedCellCount: observedCount,
    intersectionCellCount: intersectionCount,
    iou: unionCount > 0 ? intersectionCount / unionCount : 0,
    precision,
    recall,
    f1,
    predictedAreaKm2: predictedCount * (cellSizeMeters / 1000) ** 2,
    observedAreaKm2: observedCount * (cellSizeMeters / 1000) ** 2,
    centroidErrorKm,
    meanBoundaryDistanceKm: meanNearestDistanceKm(predictedBoundary, observedBoundary, cellSizeMeters),
    meanObservedBoundaryDistanceKm: meanNearestDistanceKm(observedBoundary, predictedBoundary, cellSizeMeters)
  };
}

export function validateArrivalAgainstPerimeter({
  arrivalTimes,
  observedMask,
  size,
  modelTimeMinutes,
  cellSizeMeters = 1000
} = {}) {
  assertGridSize(size);
  if (!Number.isFinite(modelTimeMinutes) || modelTimeMinutes < 0) {
    throw new RangeError('perimeterValidation: modelTimeMinutes must be non-negative');
  }
  const predictedMask = new Uint8Array(size * size);
  assertMask('arrivalTimes', arrivalTimes, predictedMask.length);
  for (let index = 0; index < predictedMask.length; index += 1) {
    predictedMask[index] = Number.isFinite(arrivalTimes[index])
      && arrivalTimes[index] <= modelTimeMinutes ? 1 : 0;
  }
  return comparePerimeterMasks({ predictedMask, observedMask, size, cellSizeMeters });
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function finiteReportedAreaKm2(observation) {
  if (!Number.isFinite(observation?.reportedAcres)) return null;
  return observation.reportedAcres * 0.0040468564224;
}

const OBSERVED_STALL_RATE_KM2_PER_HOUR = 0.002;

export function validateArrivalAgainstPerimeterSeries({
  arrivalTimes,
  observations,
  grid,
  size,
  modelStartTime,
  cellSizeMeters = 1000
} = {}) {
  assertGridSize(size);
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new RangeError('perimeterValidation: at least one perimeter observation is required');
  }
  const startTimeMs = Date.parse(modelStartTime);
  if (!Number.isFinite(startTimeMs)) {
    throw new RangeError('perimeterValidation: modelStartTime must be a valid date');
  }
  assertMask('arrivalTimes', arrivalTimes, size * size);

  let previousTimeMs = startTimeMs;
  const reports = observations.map((observation, index) => {
    const capturedAtMs = Date.parse(observation?.capturedAt);
    if (!Number.isFinite(capturedAtMs) || capturedAtMs < previousTimeMs) {
      throw new RangeError(`perimeterValidation: observation ${index} is out of chronological order`);
    }
    previousTimeMs = capturedAtMs;
    const modelTimeMinutes = (capturedAtMs - startTimeMs) / 60000;
    const observedMask = observation.observedMask ?? rasterizePerimeterGeometry({
      geometry: observation.geometry,
      grid
    });
    const metrics = validateArrivalAgainstPerimeter({
      arrivalTimes,
      observedMask,
      size,
      modelTimeMinutes,
      cellSizeMeters
    });
    return {
      capturedAt: new Date(capturedAtMs).toISOString(),
      modelTimeMinutes,
      reportedAcres: Number.isFinite(observation.reportedAcres) ? observation.reportedAcres : null,
      reportedAreaKm2: finiteReportedAreaKm2(observation),
      ...metrics
    };
  });

  const growthIntervals = reports.slice(1).map((report, index) => {
    const previous = reports[index];
    const elapsedHours = (report.modelTimeMinutes - previous.modelTimeMinutes) / 60;
    const observedAreaKm2 = report.reportedAreaKm2 ?? report.observedAreaKm2;
    const previousObservedAreaKm2 = previous.reportedAreaKm2 ?? previous.observedAreaKm2;
    const observedGrowthKm2 = observedAreaKm2 - previousObservedAreaKm2;
    const predictedGrowthKm2 = report.predictedAreaKm2 - previous.predictedAreaKm2;
    const observedGrowthRateKm2PerHour = elapsedHours > 0
      ? observedGrowthKm2 / elapsedHours
      : null;
    const predictedGrowthRateKm2PerHour = elapsedHours > 0
      ? predictedGrowthKm2 / elapsedHours
      : null;
    return {
      from: previous.capturedAt,
      to: report.capturedAt,
      elapsedHours,
      observedAreaKm2,
      predictedAreaKm2: report.predictedAreaKm2,
      observedGrowthKm2,
      predictedGrowthKm2,
      observedGrowthRateKm2PerHour,
      predictedGrowthRateKm2PerHour,
      observedStall: observedGrowthRateKm2PerHour !== null
        && observedGrowthRateKm2PerHour <= OBSERVED_STALL_RATE_KM2_PER_HOUR,
      modelContinuedSpread: predictedGrowthKm2 > 0,
      likelyContainmentOrSuppressionSignal: observedGrowthRateKm2PerHour !== null
        && observedGrowthRateKm2PerHour <= OBSERVED_STALL_RATE_KM2_PER_HOUR
        && predictedGrowthKm2 > 0
    };
  });

  const ious = reports.map((report) => report.iou);
  const f1Scores = reports.map((report) => report.f1);
  const centroidErrors = reports
    .map((report) => report.centroidErrorKm)
    .filter((value) => Number.isFinite(value));
  const mean = (values) => values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
  const growthRatios = growthIntervals
    .filter((interval) => interval.observedGrowthKm2 > 0 && interval.predictedGrowthKm2 >= 0)
    .map((interval) => interval.predictedGrowthKm2 / interval.observedGrowthKm2);
  const firstContainmentIndex = growthIntervals.findIndex(
    (interval) => interval.likelyContainmentOrSuppressionSignal
  );
  const preSuppressionReports = reports.slice(
    0,
    firstContainmentIndex >= 0 ? firstContainmentIndex + 1 : reports.length
  );

  return {
    modelStartTime: new Date(startTimeMs).toISOString(),
    observationCount: reports.length,
    reports,
    growthIntervals,
    summary: {
      meanIou: mean(ious),
      medianIou: median(ious),
      meanF1: mean(f1Scores),
      meanCentroidErrorKm: mean(centroidErrors),
      observedStallIntervals: growthIntervals.filter((interval) => interval.observedStall).length,
      likelyContainmentOrSuppressionIntervals: growthIntervals
        .filter((interval) => interval.likelyContainmentOrSuppressionSignal).length,
      firstLikelyContainmentOrSuppressionInterval: firstContainmentIndex >= 0
        ? growthIntervals[firstContainmentIndex]
        : null,
      // This window is a diagnostic for calibrating natural spread. It must
      // not be read as a proof that the observed perimeter was unsuppressed.
      preSuppression: {
        observationCount: preSuppressionReports.length,
        meanIou: mean(preSuppressionReports.map((report) => report.iou)),
        meanF1: mean(preSuppressionReports.map((report) => report.f1)),
        final: preSuppressionReports.at(-1)
      },
      meanPredictedToObservedGrowthRatio: mean(growthRatios),
      final: reports.at(-1)
    }
  };
}
