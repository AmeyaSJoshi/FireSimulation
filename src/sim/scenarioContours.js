import { createSpatialGrid } from '../lib/spatialGrid.js';

function assertArrivalField(arrivalField, gridSize) {
  if (!arrivalField || arrivalField.length !== gridSize * gridSize) {
    throw new RangeError('scenarioContours: arrivalField length must equal gridSize squared');
  }
}

function cellPolygon(grid, row, col) {
  const corners = [
    grid.cellCenterLatLon(row - 0.5, col - 0.5),
    grid.cellCenterLatLon(row - 0.5, col + 0.5),
    grid.cellCenterLatLon(row + 0.5, col + 0.5),
    grid.cellCenterLatLon(row + 0.5, col - 0.5)
  ].map(({ longitude, latitude }) => [longitude, latitude]);
  corners.push(corners[0]);
  return corners;
}

export function activeFireCells({ arrivalField, gridSize, atMinutes, frontWindowMinutes = 1.5 }) {
  assertArrivalField(arrivalField, gridSize);
  if (!Number.isFinite(atMinutes) || atMinutes < 0) {
    throw new RangeError('scenarioContours: atMinutes must be non-negative and finite');
  }
  if (!Number.isFinite(frontWindowMinutes) || frontWindowMinutes <= 0) {
    throw new RangeError('scenarioContours: frontWindowMinutes must be positive and finite');
  }
  const burnedIndices = [];
  const frontIndices = [];
  for (let index = 0; index < arrivalField.length; index += 1) {
    const arrival = arrivalField[index];
    if (!Number.isFinite(arrival) || arrival < 0 || arrival > atMinutes) continue;
    burnedIndices.push(index);
    if (arrival >= atMinutes - frontWindowMinutes) frontIndices.push(index);
  }
  return { burnedIndices, frontIndices };
}

export function cellsToGeoJson({ indices, region }) {
  const { gridSize, cellSizeMeters, origin } = region ?? {};
  if (!Array.isArray(indices)) throw new TypeError('scenarioContours: indices must be an array');
  const grid = createSpatialGrid({
    latitude: origin?.latitude,
    longitude: origin?.longitude,
    cellSizeMeters,
    gridSize
  });
  return {
    type: 'FeatureCollection',
    features: indices.map((index) => {
      const row = Math.floor(index / gridSize);
      const col = index % gridSize;
      return {
        type: 'Feature',
        properties: { index, row, col },
        geometry: { type: 'Polygon', coordinates: [cellPolygon(grid, row, col)] }
      };
    })
  };
}

