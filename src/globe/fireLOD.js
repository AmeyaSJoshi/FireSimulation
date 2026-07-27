import * as Cesium from 'cesium';
import { createFireOverlay, VISUAL_CELL_SCALE } from './fireOverlay.js';

// Altitude-gated fire detail.
//
// P4's fireOverlay draws every live cell as a scaled point plus a draped char
// texture. That reads well from altitude and stays cheap, but a point primitive
// is a screen-facing sprite: fly down to walking height and the fire is a flat
// disc that turns with you.
//
// This module keeps P4's overlay as the always-on base layer and, below
// CLOSE_ALTITUDE_M, adds real volumetric flames on top of the nearest live
// cells that are actually inside the view frustum.
//
// Volume comes from pooled Cesium ParticleSystems rather than extruded meshes:
// a rising column of many particles holds its silhouette from any angle and
// animates on the GPU, where a static cone would need a per-frame shader
// rebuild to move at all. The pool is allocated once and slots are reassigned
// by modelMatrix, so a camera move never allocates.
//
// The base overlay is deliberately NOT hidden in close mode. The cap below
// means only the nearest cells get volume; hiding the flat layer would make
// every capped-out cell vanish as the camera moves. Layering instead gives a
// ground glow under the volume and guarantees no live cell disappears.
//
// Reads only the Jac scenario result contract (arrivalMinutes / fuelCodes /
// bbox / gridSize). No physics, no sim data touched.
// PFIX5: raised from 250 so the demo reaches volumetric flames without
// diving to near-ground altitude first.
export const CLOSE_ALTITUDE_M = 1_800;

const MAX_VOLUMETRIC_CELLS = 48;
const RENDER_DISTANCE_M = CLOSE_ALTITUDE_M;
const UPDATE_THROTTLE_MS = 140;
// Matches fireOverlay's active-front window: only the leading edge gets
// volume, smouldering cells stay as the base layer's dim points.
const FRONT_WINDOW_MINUTES = 8;
const FLAME_LIFT_METERS = 3;
function flameScaleForFuel(fuelIndex) {
  if (fuelIndex >= 18) return 2.2;  // TU*/TL* timber
  if (fuelIndex >= 10) return 1.5;  // SH* brush
  return 1.0;                        // GR*/GS* grass
}

// Soft radial blob. One canvas shared by every system in the pool.
function makeParticleImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,236,170,0.85)');
  gradient.addColorStop(1, 'rgba(255,180,60,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  return canvas;
}

export function createFireLOD(viewer) {
  const base = createFireOverlay(viewer);
  const particleImage = makeParticleImage();

  let result = null;
  let cellPositions = null;
  let timeMinutes = 0;
  let pool = [];
  let billboardPool = null;
  let removeListener = null;
  let lastUpdate = 0;
  let dirty = false;

  function ensurePool() {
    if (pool.length > 0) return;
    billboardPool = viewer.scene.primitives.add(new Cesium.BillboardCollection({ scene: viewer.scene }));
    for (let i = 0; i < MAX_VOLUMETRIC_CELLS; i += 1) {
      const system = new Cesium.ParticleSystem({
        image: particleImage,
        startColor: new Cesium.Color(1.0, 0.86, 0.38, 0.85),
        endColor: new Cesium.Color(0.8, 0.16, 0.02, 0.0),
        startScale: 0.9,
        endScale: 2.8,
        minimumParticleLife: 0.6,
        maximumParticleLife: 1.4,
        minimumSpeed: 3.0,
        maximumSpeed: 8.0,
        imageSize: new Cesium.Cartesian2(2.0 * VISUAL_CELL_SCALE, 2.0 * VISUAL_CELL_SCALE),
        emissionRate: 24,
        // Metres, not pixels — flames must keep physical size as you approach.
        sizeInMeters: true,
        loop: true,
        emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(16)),
        show: false
      });
      viewer.scene.primitives.add(system);
      pool.push(system);
      billboardPool.add({
        image: particleImage,
        show: false,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(0, 1.4, 2_500, 0.55)
      });
    }
  }

  function destroyPool() {
    for (const system of pool) viewer.scene.primitives.remove(system);
    pool = [];
    if (billboardPool) viewer.scene.primitives.remove(billboardPool);
    billboardPool = null;
  }

  // Same cell-centre derivation and single-sample surface lift P4 uses. Kept
  // local so this module adds to fireOverlay without modifying it.
  function buildCellPositions() {
    const { gridSize, bbox } = result;
    const [west, south, east, north] = bbox;
    const positions = new Array(gridSize * gridSize);
    const lift = (Number.isFinite(result.groundHeightMeters) ? result.groundHeightMeters : 0)
      + FLAME_LIFT_METERS;
    for (let row = 0; row < gridSize; row += 1) {
      const lat = north - ((row + 0.5) / gridSize) * (north - south);
      for (let col = 0; col < gridSize; col += 1) {
        const lon = west + ((col + 0.5) / gridSize) * (east - west);
        positions[row * gridSize + col] = Cesium.Cartesian3.fromDegrees(lon, lat, lift);
      }
    }
    cellPositions = positions;
  }

  function hideAll(fromIndex = 0) {
    for (let i = fromIndex; i < pool.length; i += 1) {
      pool[i].show = false;
      if (billboardPool) billboardPool.get(i).show = false;
    }
  }

  function updateVolumetric() {
    if (!result || !cellPositions) return;

    // Cartographic height is height above the ellipsoid, not height above the
    // local surface. In mountains it can be > 1 km while the camera is only a
    // few hundred metres from the fire, so gating on it hid every flame. Use
    // physical range to the simulated field instead.
    const centreCell = Math.floor(result.gridSize / 2);
    const fieldCentre = cellPositions[centreCell * result.gridSize + centreCell];
    if (Cesium.Cartesian3.distance(viewer.camera.position, fieldCentre) > CLOSE_ALTITUDE_M) {
      if (pool.length > 0) hideAll();
      return;
    }
    ensurePool();

    const camera = viewer.camera;
    const { arrivalMinutes, fuelCodes } = result;

    // Nearest-first so the cap spends its budget on the flames the camera is
    // closest to, which are the ones whose flatness would be obvious.
    const candidates = [];
    for (let i = 0; i < arrivalMinutes.length; i += 1) {
      const arrival = arrivalMinutes[i];
      if (!Number.isFinite(arrival) || arrival > timeMinutes) continue;
      const age = timeMinutes - arrival;
      if (age > FRONT_WINDOW_MINUTES) continue;

      const position = cellPositions[i];
      const distance = Cesium.Cartesian3.distance(camera.position, position);
      if (distance > RENDER_DISTANCE_M) continue;

      candidates.push({ index: i, distance, heat: 1 - age / FRONT_WINDOW_MINUTES });
    }
    candidates.sort((a, b) => a.distance - b.distance);

    const used = Math.min(candidates.length, pool.length);
    for (let slot = 0; slot < used; slot += 1) {
      const { index, heat } = candidates[slot];
      const system = pool[slot];
      const scale = flameScaleForFuel(fuelCodes[index]);
      system.modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(cellPositions[index]);
      system.imageSize = new Cesium.Cartesian2(4 * scale * VISUAL_CELL_SCALE, 4 * scale * VISUAL_CELL_SCALE);
      system.emissionRate = 14 + 22 * heat * scale;
      system.maximumSpeed = 5.0 + 5.0 * scale;
      system.minimumSpeed = 2.5 * scale;
      system.show = true;
      const billboard = billboardPool.get(slot);
      billboard.position = cellPositions[index];
      billboard.width = 18 + 8 * scale;
      billboard.height = 38 + 18 * scale;
      billboard.color = Cesium.Color.fromBytes(255, Math.round(150 + 55 * heat), 45, 235);
      billboard.show = true;
    }
    hideAll(used);
  }

  function onPreRender() {
    const now = performance.now();
    if (!dirty && now - lastUpdate < UPDATE_THROTTLE_MS) return;
    lastUpdate = now;
    dirty = false;
    updateVolumetric();
  }

  return {
    show(nextResult) {
      base.show(nextResult);
      result = nextResult;
      timeMinutes = 0;
      buildCellPositions();
      dirty = true;
      if (!removeListener) {
        const listener = viewer.scene.preRender.addEventListener(onPreRender);
        removeListener = () => viewer.scene.preRender.removeEventListener(listener);
      }
      updateVolumetric();
    },

    setTime(minutes) {
      base.setTime(minutes);
      timeMinutes = minutes;
      dirty = true;
    },

    // Playback lives in the base overlay (one clock, one uTime uniform).
    // These pass through so the UI drives a single clock, and the volumetric
    // layer stays in step with whatever time the overlay is showing.
    play() {
      base.play();
    },

    get durationMinutes() {
      return base.durationMinutes;
    },

    onTime(cb) {
      base.onTime((minutes) => {
        timeMinutes = minutes;
        dirty = true;
        cb?.(minutes);
      });
    },

    // PFIX7b dev diagnostic passthrough — see fireOverlay.js.
    setDebugCells(enabled) {
      base.setDebugCells(enabled);
    },

    clear() {
      base.clear();
      if (removeListener) removeListener();
      removeListener = null;
      destroyPool();
      result = null;
      cellPositions = null;
      timeMinutes = 0;
    }
  };
}
