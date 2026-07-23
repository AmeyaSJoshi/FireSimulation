// Runtime reader for the preprocessed WorldCover mosaic PNG.
//
// The mosaic PNG and its metadata JSON are produced offline by
// scripts/build-landcover-map.mjs from the smallest pyramid overview of
// each ESA WorldCover 2021 v200 tile. This module reads a single pixel
// from that mosaic at a given lat/lon and returns the corresponding
// WorldCover class + provenance.
//
// Design:
//   - Pure helpers (latLonToMosaicPixel, classifyMosaicRgb) are exported
//     so they can be tested in Node without a browser Image / canvas.
//   - createLandCoverSource is the composed factory: it depends only on
//     an injected `imageReader` interface with a synchronous
//     `readPixel(col, row) -> [r, g, b, a]`. The browser wires this to
//     an HTMLImageElement drawn onto an off-screen canvas.
//
// Confidence level:
//   The mosaic aggregates ~30 x 30 native 10 m WorldCover pixels into
//   one ~530-4000 m mosaic pixel using modal-class downsampling. The
//   result is reliable in homogeneous terrain (forest, desert, ocean)
//   but smears coastlines and mixed urban/wildland edges. Every
//   classification returned is labeled `confidence: 'medium'` so
//   downstream code (crosswalk, UI) can qualify accordingly.

export const LAND_COVER_CONFIDENCE = 'medium';

export function latLonToMosaicPixel(latitude, longitude, mosaic) {
  const [latMin, latMax] = mosaic.latitudeRange;
  const [lonMin, lonMax] = mosaic.longitudeRange;
  const normalizedX = (longitude - lonMin) / (lonMax - lonMin);
  const normalizedY = (latMax - latitude) / (latMax - latMin);
  const col = clampIndex(Math.floor(normalizedX * mosaic.width), mosaic.width);
  const row = clampIndex(Math.floor(normalizedY * mosaic.height), mosaic.height);
  return { col, row };
}

function clampIndex(index, size) {
  if (index < 0) return 0;
  if (index >= size) return size - 1;
  return index;
}

export function classifyMosaicRgb(red, green, blue, meta, alpha = 255) {
  if (alpha === 0) return null;
  const key = `${red},${green},${blue}`;
  const classCode = meta.paletteByRgb[key];
  if (classCode === undefined) return null;
  const entry = meta.classes[classCode] ?? meta.classes[String(classCode)];
  if (!entry) return null;
  return {
    classCode,
    className: entry.name,
    burnable: entry.burnable,
    source: meta.source,
    confidence: LAND_COVER_CONFIDENCE
  };
}

export async function createLandCoverSource({ imageReader, meta, pngUrl }) {
  const reader = await imageReader(pngUrl);

  function classifyAtLatLon(latitude, longitude) {
    if (!Number.isFinite(latitude)) {
      throw new RangeError(`landCover: latitude must be finite, got ${latitude}`);
    }
    if (!Number.isFinite(longitude)) {
      throw new RangeError(`landCover: longitude must be finite, got ${longitude}`);
    }
    const { col, row } = latLonToMosaicPixel(latitude, longitude, meta.mosaic);
    const [r, g, b, a] = reader.readPixel(col, row);
    return classifyMosaicRgb(r, g, b, meta, a);
  }

  return {
    classifyAtLatLon,
    meta
  };
}

// Browser-side helper: given an HTMLImageElement (already loaded), return
// a reader that reads pixels from an off-screen canvas. Kept out of the
// pure module surface so it stays Node-testable.
export function createCanvasImageReader(image) {
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(image.naturalWidth, image.naturalHeight)
    : Object.assign(document.createElement('canvas'), {
      width: image.naturalWidth,
      height: image.naturalHeight
    });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return {
    readPixel(col, row) {
      const { data } = ctx.getImageData(col, row, 1, 1);
      return [data[0], data[1], data[2], data[3]];
    }
  };
}
