// A local tangent-plane grid anchored at a WGS-84 lat/lon.
//
// Convention:
//   row 0        = northernmost row  (highest latitude in the field)
//   col 0        = westernmost col   (lowest longitude in the field)
//   (row, col) increases south / east respectively.
//   The origin lat/lon lands at the geometric center of the field,
//   which for gridSize=128 is row=63.5, col=63.5.
//
// Cell centers use spherical destination and inverse-distance formulas. This
// avoids the longitude blow-up of an equirectangular approximation near the
// poles while retaining the local row/north and col/east contract.

const METERS_PER_DEGREE_LATITUDE = 111320;
const EARTH_RADIUS_METERS = 6371008.8;

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
    // Convention: north = smaller row, east = larger col.
    const northMeters = (halfIndex - row) * cellSizeMeters;
    const eastMeters = (col - halfIndex) * cellSizeMeters;
    return destinationPoint(latitude, longitude, northMeters, eastMeters);
  }

  function latLonToCell(cellLatitude, cellLongitude) {
    const { northMeters, eastMeters } = inversePoint(
      latitude, longitude, cellLatitude, cellLongitude
    );
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

function destinationPoint(latitude, longitude, northMeters, eastMeters) {
  const distanceMeters = Math.hypot(northMeters, eastMeters);
  if (distanceMeters === 0) return { latitude, longitude };
  const bearing = Math.atan2(eastMeters, northMeters);
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const lat1 = latitude * Math.PI / 180;
  const lon1 = longitude * Math.PI / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance)
      + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
  );
  return {
    latitude: lat2 * 180 / Math.PI,
    longitude: normalizeLongitude(lon2 * 180 / Math.PI)
  };
}

function inversePoint(originLatitude, originLongitude, latitude, longitude) {
  const lat1 = originLatitude * Math.PI / 180;
  const lat2 = latitude * Math.PI / 180;
  const lon1 = originLongitude * Math.PI / 180;
  const lon2 = longitude * Math.PI / 180;
  const deltaLongitude = Math.atan2(
    Math.sin(lon2 - lon1),
    Math.cos(lon2 - lon1)
  );
  if (Math.abs(lat2 - lat1) < 1e-12 && Math.abs(deltaLongitude) < 1e-12) {
    return { northMeters: 0, eastMeters: 0 };
  }
  const cosineDistance = Math.min(1, Math.max(-1,
    Math.sin(lat1) * Math.sin(lat2)
      + Math.cos(lat1) * Math.cos(lat2) * Math.cos(deltaLongitude)
  ));
  const distanceMeters = Math.acos(cosineDistance) * EARTH_RADIUS_METERS;
  if (distanceMeters < 1e-6) return { northMeters: 0, eastMeters: 0 };
  const bearing = Math.atan2(
    Math.sin(deltaLongitude) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2)
      - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLongitude)
  );
  return {
    northMeters: distanceMeters * Math.cos(bearing),
    eastMeters: distanceMeters * Math.sin(bearing)
  };
}

export function normalizeLongitude(longitude) {
  const wrapped = ((longitude + 180) % 360 + 360) % 360;
  return wrapped - 180;
}
