// Slope magnitude and aspect (uphill direction) from an elevation field.
//
// Convention (matches spatialGrid.js):
//   row 0 = northernmost; row increases southward.
//   col 0 = westernmost;  col increases eastward.
//
// Slope is derived from central finite differences of elevation in meters
// per meter (i.e. dz/dx, dz/dy in the local tangent plane), then converted
// to a radian magnitude via atan(|∇z|).
//
// Aspect is the horizontal gradient direction, i.e. the unit vector that
// points *uphill*. It is returned as two components (aspectEast,
// aspectNorth) so downstream code can dot it with wind vectors or spread
// travel vectors without worrying about a scalar convention.
//
// No-data propagation: any cell whose central-difference neighborhood
// contains a non-finite elevation is marked no-data (`noData[i] = 1`) and
// its slope/aspect entries are set to NaN. Missing data must never be
// silently reported as measured flat terrain.

export function computeSlopeAspect(elevationField, { cellSizeMeters, gridSize }) {
  if (!Number.isFinite(cellSizeMeters) || cellSizeMeters <= 0) {
    throw new RangeError(`terrainDerivatives: cellSizeMeters must be a positive finite number, got ${cellSizeMeters}`);
  }
  if (!Number.isInteger(gridSize) || gridSize < 3) {
    throw new RangeError(`terrainDerivatives: gridSize must be an integer ≥ 3, got ${gridSize}`);
  }
  if (!elevationField || elevationField.length !== gridSize * gridSize) {
    throw new RangeError(
      `terrainDerivatives: elevationField length ${elevationField?.length} does not match gridSize² (${gridSize * gridSize})`
    );
  }

  const totalCells = gridSize * gridSize;
  const slopeRadians = new Float32Array(totalCells);
  const aspectEast = new Float32Array(totalCells);
  const aspectNorth = new Float32Array(totalCells);
  const noData = new Uint8Array(totalCells);

  for (let row = 0; row < gridSize; row += 1) {
    for (let col = 0; col < gridSize; col += 1) {
      const index = row * gridSize + col;

      const rowNorth = Math.max(0, row - 1);
      const rowSouth = Math.min(gridSize - 1, row + 1);
      const colWest = Math.max(0, col - 1);
      const colEast = Math.min(gridSize - 1, col + 1);

      const zHere = elevationField[index];
      const zEast = elevationField[row * gridSize + colEast];
      const zWest = elevationField[row * gridSize + colWest];
      const zNorth = elevationField[rowNorth * gridSize + col];
      const zSouth = elevationField[rowSouth * gridSize + col];

      if (
        !Number.isFinite(zHere) || !Number.isFinite(zEast) || !Number.isFinite(zWest) ||
        !Number.isFinite(zNorth) || !Number.isFinite(zSouth)
      ) {
        noData[index] = 1;
        slopeRadians[index] = Number.NaN;
        aspectEast[index] = Number.NaN;
        aspectNorth[index] = Number.NaN;
        continue;
      }

      // dz/dEast (east - west) / (2 * cellSize)
      // At edges, colEast === col or colWest === col, giving a one-sided
      // difference. This is the standard central-difference-with-clamped-
      // edges compromise; edge cells are less accurate but well-defined.
      const eastSpan = (colEast - colWest) * cellSizeMeters;
      const northSpan = (rowSouth - rowNorth) * cellSizeMeters;
      const dzEast = eastSpan > 0 ? (zEast - zWest) / eastSpan : 0;
      // Row increases southward, so dz/dNorth = (zNorth - zSouth) / (2 dy).
      const dzNorth = northSpan > 0 ? (zNorth - zSouth) / northSpan : 0;

      const gradMagnitude = Math.hypot(dzEast, dzNorth);
      slopeRadians[index] = Math.atan(gradMagnitude);

      if (gradMagnitude > 0) {
        aspectEast[index] = dzEast / gradMagnitude;
        aspectNorth[index] = dzNorth / gradMagnitude;
      } else {
        aspectEast[index] = 0;
        aspectNorth[index] = 0;
      }
    }
  }

  return { slopeRadians, aspectEast, aspectNorth, noData };
}
