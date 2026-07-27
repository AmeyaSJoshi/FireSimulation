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
const FLAME_LAYERS = Object.freeze([
  { height: 0.0, scale: 1.15, scrollRate: 4.1, phase: 0.0, buoyancy: 5.5, curl: 1.15 },
  { height: 4.5, scale: 0.88, scrollRate: 5.7, phase: 2.1, buoyancy: 6.8, curl: 1.45 },
  { height: 9.0, scale: 0.64, scrollRate: 7.3, phase: 4.4, buoyancy: 8.0, curl: 1.75 }
]);

// RenderState validates against limits populated by Cesium's WebGL Context.
// Building it at module import time runs before that context exists and throws
// a DeveloperError, aborting the whole app bootstrap. Create it lazily from
// preRender, once the viewer has initialized those limits.
let additiveDepthTestState = null;

const forceScratch = new Cesium.Cartesian3();
const curlScratch = new Cesium.Cartesian3();

function applyFlameForces(system, particle, dt) {
  if (!system._flameUp) return;

  // Buoyancy always follows geodetic up from the cell's ENU frame.
  Cesium.Cartesian3.multiplyByScalar(
    system._flameUp,
    system._flameBuoyancy * dt,
    forceScratch
  );
  Cesium.Cartesian3.add(particle.velocity, forceScratch, particle.velocity);

  // Two incommensurate waves make a cheap curl field. Each stacked layer has
  // a different phase and scroll rate, so the silhouettes never move as one.
  const phase = system._flamePhase
    + particle.age * system._flameScrollRate
    + (particle.position.x + particle.position.y + particle.position.z) * 0.00012;
  Cesium.Cartesian3.multiplyByScalar(system._flameEast, Math.sin(phase), curlScratch);
  Cesium.Cartesian3.multiplyByScalar(
    system._flameNorth,
    Math.cos(phase * 1.37 + system._flamePhase),
    forceScratch
  );
  Cesium.Cartesian3.add(curlScratch, forceScratch, curlScratch);
  Cesium.Cartesian3.multiplyByScalar(
    curlScratch,
    system._flameCurl * dt,
    curlScratch
  );
  Cesium.Cartesian3.add(particle.velocity, curlScratch, particle.velocity);
}

function configureAdditiveParticleLayer(system) {
  const collection = system._billboardCollection;
  if (!collection) return;
  if (!additiveDepthTestState) {
    additiveDepthTestState = Cesium.RenderState.fromCache({
      depthTest: { enabled: true, func: Cesium.WebGLConstants.LEQUAL },
      depthMask: false,
      blending: Cesium.BlendingState.ADDITIVE_BLEND
    });
  }
  collection.blendOption = Cesium.BlendOption.TRANSLUCENT;
  // ParticleSystem does not expose the wrapped billboard render state. Keep
  // its depth test, remove its depth write, and use additive color blending.
  collection._rsOpaque = undefined;
  collection._rsTranslucent = additiveDepthTestState;
}

function flameScaleForFuel(fuelIndex) {
  if (fuelIndex >= 18) return 2.2;  // TU*/TL* timber
  if (fuelIndex >= 10) return 1.5;  // SH* brush
  return 1.0;                        // GR*/GS* grass
}

// Tall premultiplied-looking flame sprite. Runtime composition is additive,
// so overlapping particles build a bright core instead of flat alpha cards.
function makeParticleImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.globalCompositeOperation = 'lighter';

  const body = ctx.createRadialGradient(24, 67, 1, 24, 58, 30);
  body.addColorStop(0, 'rgba(255,255,235,0.98)');
  body.addColorStop(0.26, 'rgba(255,226,92,0.90)');
  body.addColorStop(0.62, 'rgba(255,104,16,0.56)');
  body.addColorStop(1, 'rgba(255,40,0,0)');
  ctx.fillStyle = body;
  ctx.fillRect(0, 20, 48, 76);

  const tip = ctx.createRadialGradient(24, 42, 0, 24, 42, 23);
  tip.addColorStop(0, 'rgba(255,242,150,0.72)');
  tip.addColorStop(0.48, 'rgba(255,122,18,0.34)');
  tip.addColorStop(1, 'rgba(255,50,0,0)');
  ctx.fillStyle = tip;
  ctx.fillRect(4, 2, 40, 64);
  return canvas;
}

export function createFireLOD(viewer) {
  const base = createFireOverlay(viewer);
  const particleImage = makeParticleImage();

  let result = null;
  let cellPositions = null;
  let timeMinutes = 0;
  let pool = [];
  let removeListener = null;
  let lastUpdate = 0;
  let dirty = false;

  function ensurePool() {
    if (pool.length > 0) return;
    for (let cell = 0; cell < MAX_VOLUMETRIC_CELLS; cell += 1) {
      for (const layer of FLAME_LAYERS) {
        let system;
        system = new Cesium.ParticleSystem({
          image: particleImage,
          startColor: new Cesium.Color(1.0, 0.88, 0.38, 0.78),
          endColor: new Cesium.Color(1.0, 0.08, 0.01, 0.0),
          startScale: 0.72,
          endScale: 2.35,
          minimumParticleLife: 0.65,
          maximumParticleLife: 1.5,
          minimumSpeed: 2.8,
          maximumSpeed: 7.5,
          imageSize: new Cesium.Cartesian2(2.0 * VISUAL_CELL_SCALE, 4.0 * VISUAL_CELL_SCALE),
          emissionRate: 18,
          sizeInMeters: true,
          loop: true,
          modelMatrix: Cesium.Matrix4.IDENTITY,
          emitterModelMatrix: Cesium.Matrix4.IDENTITY,
          emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(13)),
          updateCallback: (particle, dt) => applyFlameForces(system, particle, dt),
          show: false
        });
        system._flameLayer = layer;
        system._flameScrollRate = layer.scrollRate;
        system._flamePhase = layer.phase + cell * 0.618;
        system._flameBuoyancy = layer.buoyancy;
        system._flameCurl = layer.curl;
        viewer.scene.primitives.add(system);
        pool.push(system);
      }
    }
  }

  function destroyPool() {
    for (const system of pool) viewer.scene.primitives.remove(system);
    pool = [];
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

    const usedCells = Math.min(candidates.length, MAX_VOLUMETRIC_CELLS);
    for (let cellSlot = 0; cellSlot < usedCells; cellSlot += 1) {
      const { index, heat } = candidates[cellSlot];
      const scale = flameScaleForFuel(fuelCodes[index]);
      const enuFrame = Cesium.Transforms.eastNorthUpToFixedFrame(cellPositions[index]);
      const east = Cesium.Matrix4.multiplyByPointAsVector(enuFrame, Cesium.Cartesian3.UNIT_X, new Cesium.Cartesian3());
      const north = Cesium.Matrix4.multiplyByPointAsVector(enuFrame, Cesium.Cartesian3.UNIT_Y, new Cesium.Cartesian3());
      const up = Cesium.Matrix4.multiplyByPointAsVector(enuFrame, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3());

      for (let layerIndex = 0; layerIndex < FLAME_LAYERS.length; layerIndex += 1) {
        const layer = FLAME_LAYERS[layerIndex];
        const systemSlot = cellSlot * FLAME_LAYERS.length + layerIndex;
        const system = pool[systemSlot];
        const localOffset = new Cesium.Cartesian3(0, 0, layer.height * scale);

        // Keep the ParticleSystem frame in world coordinates and explicitly
        // orient its emitter with ENU. Cone +Z is therefore geodetic up at any
        // latitude instead of inheriting identity/world-axis orientation.
        system.modelMatrix = Cesium.Matrix4.IDENTITY;
        system.emitterModelMatrix = Cesium.Matrix4.multiplyByTranslation(
          enuFrame,
          localOffset,
          new Cesium.Matrix4()
        );
        system._flameEast = Cesium.Cartesian3.clone(east, system._flameEast);
        system._flameNorth = Cesium.Cartesian3.clone(north, system._flameNorth);
        system._flameUp = Cesium.Cartesian3.clone(up, system._flameUp);
        system.imageSize = new Cesium.Cartesian2(
          2.4 * scale * layer.scale * VISUAL_CELL_SCALE,
          5.4 * scale * layer.scale * VISUAL_CELL_SCALE
        );
        system.emissionRate = (10 + 15 * heat * scale) * layer.scale;
        system.maximumSpeed = (5.0 + 4.0 * scale) * (0.9 + 0.12 * layerIndex);
        system.minimumSpeed = 2.5 * scale;
        system.show = true;
      }
    }
    hideAll(usedCells * FLAME_LAYERS.length);
  }

  function onPreRender() {
    const now = performance.now();
    if (!dirty && now - lastUpdate < UPDATE_THROTTLE_MS) return;
    lastUpdate = now;
    dirty = false;
    updateVolumetric();
    for (const system of pool) configureAdditiveParticleLayer(system);
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
