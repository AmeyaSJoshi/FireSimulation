// A local equirectangular tangent-plane grid anchored at a WGS-84 lat/lon.
//
// Convention:
//   row 0        = northernmost row  (highest latitude in the field)
//   col 0        = westernmost col   (lowest longitude in the field)
//   (row, col) increases south / east respectively.
//   The origin lat/lon lands at the geometric center of the field,
//   which for gridSize=128 is row=63.5, col=63.5.
//
// Longitude conversion uses cos(originLatitude) as the scale factor. This
// is a first-order equirectangular approximation: it is accurate to well
// under 0.1% for a 128 km field at mid-latitudes but degrades near the
// poles (cos → 0) and stretches at very high latitudes. Callers should
// keep cellSize * gridSize modest relative to Earth's radius; this module
// does not enforce a hard limit but its accuracy assumptions above ~85°
// are no longer safe.

const METERS_PER_DEGREE_LATITUDE = 111320;

export function createSpatialGrid({ latitude, longitude, cellSizeMeters, gridSize }) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError(`spatialGrid: latitude must be a finite number in [-90, 90], got ${latitude}`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError(`spatialGrid: longitude must be a finite number in [-180, 180], got ${longitude}`);
  }
  if (!Number.isFinite(cellSizeMeters) || cellSizeMeters <= 0) {
    throw new RangeError(`spatialGrid: cellSizeMeters must be a positive finite number, got ${cellSizeMeters}`);
  }
  if (!Number.isInteger(gridSize) || gridSize < 2) {
    throw new RangeError(`spatialGrid: gridSize must be an integer ≥ 2, got ${gridSize}`);
  }

  const originLatitudeRad = latitude * Math.PI / 180;
  const metersPerDegreeLongitude = METERS_PER_DEGREE_LATITUDE * Math.max(Math.cos(originLatitudeRad), 1e-6);
  const halfIndex = (gridSize - 1) / 2; // for gridSize=128 → 63.5

  function cellCenterLatLon(row, col) {
    // Convention: north = smaller row, east = larger col
    const offsetNorthMeters = (halfIndex - row) * cellSizeMeters;
    const offsetEastMeters = (col - halfIndex) * cellSizeMeters;
    const cellLatitude = latitude + offsetNorthMeters / METERS_PER_DEGREE_LATITUDE;
    const cellLongitudeRaw = longitude + offsetEastMeters / metersPerDegreeLongitude;
    return {
      latitude: cellLatitude,
      longitude: normalizeLongitude(cellLongitudeRaw)
    };
  }

  function latLonToCell(cellLatitude, cellLongitude) {
    const northMeters = (cellLatitude - latitude) * METERS_PER_DEGREE_LATITUDE;
    // Antimeridian: choose the shorter arc for the longitude delta
    let lonDelta = cellLongitude - longitude;
    if (lonDelta > 180) lonDelta -= 360;
    else if (lonDelta <= -180) lonDelta += 360;
    const eastMeters = lonDelta * metersPerDegreeLongitude;
    return {
      row: halfIndex - northMeters / cellSizeMeters,
      col: halfIndex + eastMeters / cellSizeMeters
    };
  }

  return {
    gridSize,
    cellSizeMeters,
    origin: { latitude, longitude },
    metersPerDegreeLongitude,
    cellCenterLatLon,
    latLonToCell
  };
}

export function normalizeLongitude(longitude) {
  const wrapped = ((longitude + 180) % 360 + 360) % 360;
  return wrapped - 180;
}
