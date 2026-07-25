// Choose a validation raster from the observed perimeter extent rather than
// silently accepting a domain that truncates the fire. This is a diagnostic
// sizing helper; it never changes model coefficients or fits the domain to
// the predicted footprint.

const METERS_PER_DEGREE = 111_320;

export function estimateValidationGridSize({
  geometries,
  center,
  cellSizeMeters,
  minimumSize = 128,
  marginCells = 16,
  maximumSize = 1024
} = {}) {
  validateCenter(center);
  validatePositive('cellSizeMeters', cellSizeMeters);
  validateIntegerAtLeast('minimumSize', minimumSize, 3);
  validateIntegerAtLeast('marginCells', marginCells, 0);
  validateIntegerAtLeast('maximumSize', maximumSize, minimumSize);
  const points = [...walkCoordinates(geometries)];
  if (points.length === 0) {
    throw new RangeError('validationDomain: geometries must contain at least one coordinate');
  }

  const latitudeRadians = center.latitude * Math.PI / 180;
  const longitudeScale = Math.max(0.01, Math.cos(latitudeRadians));
  let maximumDistanceMeters = 0;
  for (const [longitude, latitude] of points) {
    validateCoordinate(latitude, 'geometry latitude', -90, 90);
    validateCoordinate(longitude, 'geometry longitude', -180, 180);
    const longitudeDelta = shortestLongitudeDelta(longitude, center.longitude);
    const eastMeters = longitudeDelta * longitudeScale * METERS_PER_DEGREE;
    const northMeters = (latitude - center.latitude) * METERS_PER_DEGREE;
    maximumDistanceMeters = Math.max(
      maximumDistanceMeters,
      Math.hypot(eastMeters, northMeters)
    );
  }

  const diameterMeters = maximumDistanceMeters * 2 + marginCells * 2 * cellSizeMeters;
  const requiredCells = Math.ceil(diameterMeters / cellSizeMeters) + 1;
  return Math.min(maximumSize, Math.max(minimumSize, requiredCells));
}

function* walkCoordinates(value) {
  if (Array.isArray(value)) {
    if (value.length >= 2
      && Number.isFinite(Number(value[0]))
      && Number.isFinite(Number(value[1]))) {
      yield [Number(value[0]), Number(value[1])];
      return;
    }
    for (const child of value) yield* walkCoordinates(child);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.type === 'Feature') {
    yield* walkCoordinates(value.geometry);
    return;
  }
  if (value.type === 'FeatureCollection') {
    for (const feature of value.features ?? []) yield* walkCoordinates(feature);
    return;
  }
  if ('coordinates' in value) yield* walkCoordinates(value.coordinates);
}

function shortestLongitudeDelta(longitude, centerLongitude) {
  let delta = longitude - centerLongitude;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function validateCenter(center) {
  if (!center || typeof center !== 'object') {
    throw new TypeError('validationDomain: center is required');
  }
  validateCoordinate(center.latitude, 'center latitude', -90, 90);
  validateCoordinate(center.longitude, 'center longitude', -180, 180);
}

function validateCoordinate(value, name, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`validationDomain: ${name} must be in [${minimum}, ${maximum}]`);
  }
}

function validatePositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`validationDomain: ${name} must be positive`);
  }
}

function validateIntegerAtLeast(name, value, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`validationDomain: ${name} must be an integer >= ${minimum}`);
  }
}
