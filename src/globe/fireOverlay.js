import * as Cesium from 'cesium';

// Volumetric fire renderer. Reads the frozen runFromClick() contract
// (arrivalMinutes / fuelCodes — see CLAUDE.md) and maps it to geometry with
// real height above the terrain. NO physics here: this file only decides how
// an already-solved arrival time looks.
//
// Per cell, against the scrub clock t (minutes):
//   arrival <= t, within FRONT_WINDOW      -> active front: tall bright flame
//   arrival <= t, within SMOLDER_WINDOW    -> smoldering: short dim ember
//   arrival <= t, older                    -> burned: no geometry, char texture
//   arrival >  t (or non-finite)           -> nothing
//
// Perf: only the frontier ring gets point geometry (typically <10% of 4096).
// The burned scar is one static draped texture, redrawn only when it grows.

const FRONT_WINDOW_MINUTES = 90 / 60;
const SMOLDER_WINDOW_MINUTES = 60 / 60;
const MAX_LIVE_CELLS = 420;
const FLAME_BASE_METERS = 6;

// Denser fuel burns taller. Index into provenance.fuelCodeList; the leading
// GR*/GS* grass codes are short, SH* brush mid, TU*/TL* timber tallest.
function flameScaleForFuel(fuelIndex) {
  if (fuelIndex >= 18) return 2.2;  // TU*/TL* timber
  if (fuelIndex >= 10) return 1.5;  // SH* brush
  return 1.0;                        // GR*/GS* grass
}

export function createFireOverlay(viewer) {
  let points = null;
  let charEntity = null;
  let result = null;
  let timeMinutes = 0;
  let cellPositions = null;
  let lastCharCount = -1;
  let removeListener = null;

  function clear() {
    if (points) viewer.scene.primitives.remove(points);
    if (charEntity) viewer.entities.remove(charEntity);
    if (removeListener) removeListener();
    points = null;
    charEntity = null;
    removeListener = null;
    result = null;
    cellPositions = null;
    lastCharCount = -1;
    timeMinutes = 0;
  }

  // Precompute a world position per cell once, on the terrain/tileset surface.
  function buildCellPositions() {
    const { gridSize, bbox } = result;
    const [west, south, east, north] = bbox;
    cellPositions = new Array(gridSize * gridSize);
    for (let row = 0; row < gridSize; row += 1) {
      // row 0 = north (spatialGrid convention)
      const lat = north - ((row + 0.5) / gridSize) * (north - south);
      for (let col = 0; col < gridSize; col += 1) {
        const lon = west + ((col + 0.5) / gridSize) * (east - west);
        cellPositions[row * gridSize + col] = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
      }
    }
  }

  // Charcoal scar: cheap static draped canvas, only rebuilt when it grows.
  function refreshCharTexture() {
    const { gridSize, arrivalMinutes, bbox } = result;
    let burnedCount = 0;
    for (let i = 0; i < arrivalMinutes.length; i += 1) {
      const a = arrivalMinutes[i];
      if (Number.isFinite(a) && a <= timeMinutes) burnedCount += 1;
    }
    if (burnedCount === lastCharCount) return;
    lastCharCount = burnedCount;

    // A fresh canvas + fresh material each rebuild: Cesium caches image
    // uniforms by reference, so reusing either renders as blank white.
    const canvas = document.createElement('canvas');
    canvas.width = gridSize;
    canvas.height = gridSize;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(gridSize, gridSize);
    const data = image.data;
    for (let i = 0; i < arrivalMinutes.length; i += 1) {
      const a = arrivalMinutes[i];
      if (!Number.isFinite(a) || a > timeMinutes) continue;
      const o = i * 4;
      // Deterministic per-cell noise so the scar looks like char, not a block.
      const n = ((i * 2654435761) % 97) / 97;
      const v = 26 + n * 26;
      data[o] = v; data[o + 1] = v * 0.82; data[o + 2] = v * 0.72;
      data[o + 3] = 232;
    }
    ctx.putImageData(image, 0, 0);

    const material = new Cesium.ImageMaterialProperty({ image: canvas, transparent: true });
    if (charEntity) {
      charEntity.rectangle.material = material;
      return;
    }
    charEntity = viewer.entities.add({
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(bbox[0], bbox[1], bbox[2], bbox[3]),
        material,
        // Clamp to the photoreal mesh / terrain when there is one; on the bare
        // ellipsoid a height of exactly 0 z-fights the surface and vanishes.
        classificationType: Cesium.ClassificationType.BOTH,
        height: viewer.scene.globe.show ? 2 : undefined
      }
    });
  }

  // Rebuild the live (flame + ember) point set for the current t.
  function refreshLiveCells() {
    if (!points) return;
    const { arrivalMinutes, fuelCodes } = result;
    points.removeAll();
    let used = 0;
    for (let i = 0; i < arrivalMinutes.length && used < MAX_LIVE_CELLS; i += 1) {
      const arrival = arrivalMinutes[i];
      if (!Number.isFinite(arrival) || arrival > timeMinutes) continue;
      const age = timeMinutes - arrival;
      if (age > FRONT_WINDOW_MINUTES + SMOLDER_WINDOW_MINUTES) continue; // burned: char texture only

      const fuelScale = flameScaleForFuel(fuelCodes[i]);
      // Deterministic per-cell phase so flicker is uncorrelated between cells.
      const phase = ((i * 40503) % 628) / 100;
      const flicker = 0.78 + 0.22 * Math.sin(performance.now() * 0.006 + phase);

      let color;
      let sizeMeters;
      if (age <= FRONT_WINDOW_MINUTES) {
        // Active front: hot core, yellow-white -> orange across the window.
        const heat = 1 - age / FRONT_WINDOW_MINUTES;
        color = new Cesium.Color(1.0, 0.55 + 0.42 * heat, 0.12 + 0.55 * heat, 0.95);
        sizeMeters = FLAME_BASE_METERS * fuelScale * (0.75 + 0.55 * heat) * flicker;
      } else {
        // Smoldering: dim red-orange, shrinking into embers.
        const fade = 1 - (age - FRONT_WINDOW_MINUTES) / SMOLDER_WINDOW_MINUTES;
        color = new Cesium.Color(0.75, 0.19 * fade, 0.05, 0.5 + 0.4 * fade);
        sizeMeters = FLAME_BASE_METERS * fuelScale * 0.4 * fade * (0.9 + 0.1 * flicker);
      }
      if (sizeMeters <= 0.2) continue;

      points.add({
        position: cellPositions[i],
        color,
        pixelSize: Math.max(3, sizeMeters * 2.2),
        // Flame reads as a column: keep it visible over the tiles at range.
        scaleByDistance: new Cesium.NearFarScalar(200, 1.6, 6000, 0.35),
        translucencyByDistance: new Cesium.NearFarScalar(200, 1.0, 12000, 0.25),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      });
      used += 1;
    }
  }

  return {
    // result: the frozen contract object from runFromClick()
    show(nextResult) {
      clear();
      result = nextResult;
      buildCellPositions();

      points = new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT });
      viewer.scene.primitives.add(points);

      refreshCharTexture();
      refreshLiveCells();

      // Flicker + vertical motion are per-frame; the cell set only changes with t.
      const listener = viewer.scene.preRender.addEventListener(() => refreshLiveCells());
      removeListener = () => viewer.scene.preRender.removeEventListener(listener);
    },

    setTime(minutes) {
      if (!result) return;
      timeMinutes = minutes;
      refreshCharTexture();
      refreshLiveCells();
    },

    clear
  };
}
