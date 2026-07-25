// GeoTIFF readers may return either a single typed array or an array of bands.
// Keep the server adapters explicit about the one-band shape they consume.

export function firstRasterBand(rasters) {
  if (ArrayBuffer.isView(rasters)) return rasters;
  return Array.isArray(rasters) ? rasters[0] ?? null : null;
}

export function rasterSampleValue(rasters, index) {
  const band = firstRasterBand(rasters);
  if (!band || !Number.isInteger(index) || index < 0) return NaN;
  return Number(band[index]);
}
