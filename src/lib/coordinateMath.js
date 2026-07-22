const FULL_LONGITUDE = 360;
const FULL_LATITUDE = 180;
const HALF_LONGITUDE = 180;
const HALF_LATITUDE = 90;

// The Earth FBX is an equirectangular sphere whose longitude zero meridian is
// one quarter-turn from the local +Z axis. Keep this mesh-specific offset in
// the coordinate adapter rather than spreading it through the renderer.
const FBX_LONGITUDE_OFFSET_DEGREES = -90;

export function cartesianToLatitudeLongitude(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
    throw new TypeError('A finite Cartesian Earth point is required');
  }

  const radius = Math.hypot(point.x, point.y, point.z);
  if (radius <= Number.EPSILON) {
    throw new RangeError('A non-zero Cartesian Earth point is required');
  }

  return {
    latitude: clamp((Math.asin(clamp(point.y / radius, -1, 1)) * 180) / Math.PI, -HALF_LATITUDE, HALF_LATITUDE),
    longitude: normalizeLongitude(
      (Math.atan2(point.x, point.z) * 180) / Math.PI + FBX_LONGITUDE_OFFSET_DEGREES
    )
  };
}

export function uvToLatitudeLongitude(uv) {
  if (!uv || !Number.isFinite(uv.x) || !Number.isFinite(uv.y)) {
    throw new TypeError('A finite texture UV coordinate is required');
  }

  // Three.js flips this loaded texture vertically for the FBX material. After
  // that flip, v runs from the South Pole to the North Pole.
  return {
    latitude: clamp((uv.y - 0.5) * FULL_LATITUDE, -HALF_LATITUDE, HALF_LATITUDE),
    longitude: normalizeLongitude(uv.x * FULL_LONGITUDE - HALF_LONGITUDE)
  };
}

export function normalizeLongitude(longitude) {
  const wrapped = ((longitude + HALF_LONGITUDE) % FULL_LONGITUDE + FULL_LONGITUDE) % FULL_LONGITUDE;
  return wrapped - HALF_LONGITUDE;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
