export const WATER_BLUE_MIN = 55;
export const WATER_BLUE_MARGIN = 16;

export function latitudeLongitudeToEarthUv(latitude, longitude) {
  return {
    u: (longitude + 180) / 360,
    v: latitude / 180 + 0.5
  };
}

export function isLikelyWaterRgb(red, green, blue) {
  return blue >= WATER_BLUE_MIN && blue - Math.max(red, green) > WATER_BLUE_MARGIN;
}
