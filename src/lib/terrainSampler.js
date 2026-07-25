// Classifies a click as ocean or land by reading the actual pixel of the
// Earth day texture at that UV coordinate — the same image rendered on the
// globe — instead of hand-drawn lat/lng bounding boxes. Boxes can't respect
// real coastlines (e.g. a box for "North Pacific" and a box for "North
// America" will always overlap somewhere); a pixel read can't be wrong
// about what's actually drawn there.
export function createTerrainSampler(imageUrl, { sampleWidth = 4096, sampleHeight = 2048 } = {}) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = sampleWidth;
      canvas.height = sampleHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, sampleWidth, sampleHeight);
      const { data } = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
      const waterMaskData = new Uint8Array(sampleWidth * sampleHeight);
      for (let row = 0; row < sampleHeight; row += 1) {
        for (let col = 0; col < sampleWidth; col += 1) {
          const index = (row * sampleWidth + col) * 4;
          waterMaskData[row * sampleWidth + col] = classifyOceanPixel(
            data[index], data[index + 1], data[index + 2]
          ) ? 255 : 0;
        }
      }

      // u: 0..1 west→east. v: 0..1 south→north (matches the mesh UV space
      // used by cartesianToLatitudeLongitude, verified against this same
      // texture at build time). Row 0 of the source image is the north
      // pole, so a north-referenced v must be inverted to a row index.
      function isOceanAtUv(u, v) {
        const wrappedU = ((u % 1) + 1) % 1;
        const clampedV = Math.min(1, Math.max(0, v));
        const col = Math.min(sampleWidth - 1, Math.floor(wrappedU * sampleWidth));
        const row = Math.min(sampleHeight - 1, Math.floor((1 - clampedV) * sampleHeight));
        const i = (row * sampleWidth + col) * 4;
        return classifyOceanPixel(data[i], data[i + 1], data[i + 2]);
      }

      resolve({
        isOceanAtUv,
        waterMaskData,
        isWaterAtLatLon(latitude, longitude) {
          const { u, v } = latLonToTerrainUv(latitude, longitude);
          return isOceanAtUv(u, v);
        },
        resolution: { width: sampleWidth, height: sampleHeight }
      });
    };
    image.onerror = () => reject(new Error(`Failed to load terrain sampler image: ${imageUrl}`));
    image.src = imageUrl;
  });
}

export function latLonToTerrainUv(latitude, longitude) {
  return {
    u: (longitude + 180) / 360,
    v: latitude / 180 + 0.5
  };
}

// Deep ocean water in this basemap is a saturated blue: blue channel
// clearly dominant over red and green. Land — including desert, forest,
// snow, and ice — never has that dominance, even where it's pale or dark.
function classifyOceanPixel(r, g, b) {
  if (b < 55) return false; // too dark to be lit open ocean
  return (b - Math.max(r, g)) > 16;
}
