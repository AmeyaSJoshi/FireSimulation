import * as Cesium from 'cesium';
import { createFireOverlay, VISUAL_CELL_SCALE } from './fireOverlay.js';
import { createVolumetricFire } from './volumetricFire.js';

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
// Reads only the scenario result contract (arrivalMinutes / fuelCodes /
// bbox / gridSize). No physics, no sim data touched.
// PFIX5: raised from 250 so the demo reaches volumetric flames without
// diving to near-ground altitude first.
export const CLOSE_ALTITUDE_M = 1_800;

const MAX_VOLUMETRIC_CELLS = 48;
const RENDER_DISTANCE_M = CLOSE_ALTITUDE_M;
const UPDATE_THROTTLE_MS = 140;
// Street-altitude diagnosis (why the old flame sprites were invisible):
// (1) they were gated to cells burned within the 8-min front window, so the
// moment playback passed an area — or finished — every sprite vanished;
// (2) the sprites were ~6 m wide, sub-pixel from any framing wide enough to
// see the field. Smoke fixes both: it trails the front on a 5-min window
// that follows uTime during replay, and its billows are 20-60 m.
const SMOKE_WINDOW_MINUTES = 5;
const EMBER_WINDOW_MINUTES = 2;
const FLAME_LIFT_METERS = 3;
// Sparse subset: 1 in 3 recently-burned cells emits smoke. Every cell
// smoking reads as a solid wall, not a fire.
const SMOKE_CELL_STRIDE = 3;
const SYSTEMS_PER_CELL = 2; // [smoke, ember]

// RenderState validates against limits populated by Cesium's WebGL Context.
// Building it at module import time runs before that context exists and throws
// a DeveloperError, aborting the whole app bootstrap. Create it lazily from
// preRender, once the viewer has initialized those limits.
let additiveDepthTestState = null;

const forceScratch = new Cesium.Cartesian3();
const curlScratch = new Cesium.Cartesian3();

// Shared update: buoyancy along geodetic up, plus a horizontal drift matching
// the scenario wind. The downwind lean is the single most recognizable fire
// silhouette. Smoke additionally gets a slow curl so columns billow.
function applyParticleForces(system, particle, dt) {
  if (!system._pUp) return;

  Cesium.Cartesian3.multiplyByScalar(system._pUp, system._pBuoyancy * dt, forceScratch);
  Cesium.Cartesian3.add(particle.velocity, forceScratch, particle.velocity);

  if (system._pWind) {
    Cesium.Cartesian3.multiplyByScalar(system._pWind, dt, forceScratch);
    Cesium.Cartesian3.add(particle.velocity, forceScratch, particle.velocity);
  }

  if (system._pCurl > 0) {
    const phase = system._pPhase + particle.age * 0.9
      + (particle.position.x + particle.position.y + particle.position.z) * 0.00012;
    Cesium.Cartesian3.multiplyByScalar(system._pEast, Math.sin(phase), curlScratch);
    Cesium.Cartesian3.multiplyByScalar(system._pNorth, Math.cos(phase * 1.37), forceScratch);
    Cesium.Cartesian3.add(curlScratch, forceScratch, curlScratch);
    Cesium.Cartesian3.multiplyByScalar(curlScratch, system._pCurl * dt, curlScratch);
    Cesium.Cartesian3.add(particle.velocity, curlScratch, particle.velocity);
  }
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

// Soft grey-brown puff. TRANSLUCENT composition (not additive): smoke blocks
// light, it does not emit it. Darker at the base via startColor in ensurePool.
function makeSmokeImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return canvas;
}

// Tiny hot dot for embers — additive, so overlap builds brightness.
function makeEmberImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  g.addColorStop(0, 'rgba(255,240,200,1)');
  g.addColorStop(0.4, 'rgba(255,150,40,0.8)');
  g.addColorStop(1, 'rgba(255,60,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 16);
  return canvas;
}

export function createFireLOD(viewer) {
  const base = createFireOverlay(viewer);
  // Raymarched volume (the flame element; enabled at startup by main.js).
  const volumetric = createVolumetricFire(viewer);
  const smokeImage = makeSmokeImage();
  const emberImage = makeEmberImage();
  // ENU wind drift (m/s^2-ish accel), rebuilt per show() from the UI sliders.
  // Compass direction is where wind comes FROM; drift is toward FROM+180.
  let windEastAccel = 0;
  let windNorthAccel = 0;

  function refreshWindFromSliders() {
    const speedKmh = Number(document.querySelector('#wind-speed')?.value) || 0;
    const directionDeg = Number(document.querySelector('#wind-direction')?.value) || 0;
    // Slider 0 = live-weather mode; a gentle default lean still reads better
    // than a perfectly vertical column, which never happens in reality.
    const speedMs = speedKmh > 0 ? speedKmh / 3.6 : 2.2;
    const towardRad = ((directionDeg + 180) * Math.PI) / 180;
    const accel = Math.min(speedMs * 0.35, 6);
    windEastAccel = Math.sin(towardRad) * accel;
    windNorthAccel = Math.cos(towardRad) * accel;
  }

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
      // slot 0: smoke — large, soft, translucent, long-lived, slow.
      let smoke;
      smoke = new Cesium.ParticleSystem({
        image: smokeImage,
        // Grey-brown, darker at the base; lighter and thinner as it rises.
        startColor: new Cesium.Color(0.23, 0.205, 0.185, 0.42),
        endColor: new Cesium.Color(0.58, 0.57, 0.555, 0.0),
        // Widen with age so the column billows instead of staying a tube.
        startScale: 1.0,
        endScale: 3.2,
        minimumParticleLife: 15,
        maximumParticleLife: 30,
        minimumSpeed: 1.2,
        maximumSpeed: 2.8,
        imageSize: new Cesium.Cartesian2(20, 20), // 20m birth -> ~60m at end scale
        emissionRate: 2.2,
        sizeInMeters: true,
        loop: true,
        modelMatrix: Cesium.Matrix4.IDENTITY,
        emitterModelMatrix: Cesium.Matrix4.IDENTITY,
        emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(9)),
        updateCallback: (particle, dt) => applyParticleForces(smoke, particle, dt),
        show: false
      });
      smoke._pKind = 'smoke';
      smoke._pBuoyancy = 2.6;
      smoke._pCurl = 0.5;
      smoke._pPhase = cell * 0.618;
      viewer.scene.primitives.add(smoke);
      pool.push(smoke);

      // slot 1: embers — small, sparse, bright, short-lived, rising fast.
      let ember;
      ember = new Cesium.ParticleSystem({
        image: emberImage,
        startColor: new Cesium.Color(1.0, 0.85, 0.5, 0.95),
        endColor: new Cesium.Color(1.0, 0.25, 0.02, 0.0),
        startScale: 1.0,
        endScale: 0.4,
        minimumParticleLife: 0.5,
        maximumParticleLife: 1.2,
        minimumSpeed: 8,
        maximumSpeed: 16,
        imageSize: new Cesium.Cartesian2(0.8, 0.8),
        emissionRate: 5,
        sizeInMeters: true,
        loop: true,
        modelMatrix: Cesium.Matrix4.IDENTITY,
        emitterModelMatrix: Cesium.Matrix4.IDENTITY,
        emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(14)),
        updateCallback: (particle, dt) => applyParticleForces(ember, particle, dt),
        show: false
      });
      ember._pKind = 'ember';
      ember._pBuoyancy = 9.0;
      ember._pCurl = 0;
      ember._pPhase = 0;
      viewer.scene.primitives.add(ember);
      pool.push(ember);
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
      // Smoke trails the front: anything burned within the smoke window.
      if (age > SMOKE_WINDOW_MINUTES) continue;
      // Sparse subset — every cell smoking is a wall, not a fire.
      if ((i * 2654435761 >>> 0) % SMOKE_CELL_STRIDE !== 0) continue;

      const position = cellPositions[i];
      const distance = Cesium.Cartesian3.distance(camera.position, position);
      if (distance > RENDER_DISTANCE_M) continue;

      candidates.push({ index: i, distance, age });
    }
    candidates.sort((a, b) => a.distance - b.distance);

    const usedCells = Math.min(candidates.length, MAX_VOLUMETRIC_CELLS);
    for (let cellSlot = 0; cellSlot < usedCells; cellSlot += 1) {
      const { index, age } = candidates[cellSlot];
      const scale = flameScaleForFuel(fuelCodes[index]);
      const enuFrame = Cesium.Transforms.eastNorthUpToFixedFrame(cellPositions[index]);
      const east = Cesium.Matrix4.multiplyByPointAsVector(enuFrame, Cesium.Cartesian3.UNIT_X, new Cesium.Cartesian3());
      const north = Cesium.Matrix4.multiplyByPointAsVector(enuFrame, Cesium.Cartesian3.UNIT_Y, new Cesium.Cartesian3());
      const up = Cesium.Matrix4.multiplyByPointAsVector(enuFrame, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3());
      // ENU wind accel vector in world coordinates for this cell.
      const wind = new Cesium.Cartesian3(
        east.x * windEastAccel + north.x * windNorthAccel,
        east.y * windEastAccel + north.y * windNorthAccel,
        east.z * windEastAccel + north.z * windNorthAccel
      );

      for (let kindIndex = 0; kindIndex < SYSTEMS_PER_CELL; kindIndex += 1) {
        const system = pool[cellSlot * SYSTEMS_PER_CELL + kindIndex];
        system.modelMatrix = Cesium.Matrix4.IDENTITY;
        system.emitterModelMatrix = enuFrame;
        system._pEast = Cesium.Cartesian3.clone(east, system._pEast);
        system._pNorth = Cesium.Cartesian3.clone(north, system._pNorth);
        system._pUp = Cesium.Cartesian3.clone(up, system._pUp);
        system._pWind = Cesium.Cartesian3.clone(wind, system._pWind);

        if (system._pKind === 'smoke') {
          // Older cells smoke harder than the leading edge (flame there, not
          // smoke yet); fade back out near the window's end.
          const smokeAge = Math.min(age / 1.5, 1) * (1 - Math.max(0, (age - 3.5) / (SMOKE_WINDOW_MINUTES - 3.5)) * 0.6);
          system.emissionRate = (1.2 + 2.4 * smokeAge) * scale;
          system.show = true;
        } else {
          // Embers only at the actively burning leading edge.
          system.emissionRate = 4 + 4 * scale;
          system.show = age <= EMBER_WINDOW_MINUTES;
        }
      }
    }
    hideAll(usedCells * SYSTEMS_PER_CELL);
  }

  function onPreRender() {
    const now = performance.now();
    if (!dirty && now - lastUpdate < UPDATE_THROTTLE_MS) return;
    lastUpdate = now;
    dirty = false;
    updateVolumetric();
    // Additive blending is for embers only. Smoke must stay TRANSLUCENT
    // (depth test on, depth write off — billboard default): additive smoke
    // would glow instead of blocking light.
    for (const system of pool) {
      if (system._pKind === 'ember') configureAdditiveParticleLayer(system);
    }
  }

  return {
    show(nextResult) {
      refreshWindFromSliders();
      base.show(nextResult);
      volumetric.show(nextResult);
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
      volumetric.setTime(minutes);
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
        volumetric.setTime(minutes);
        timeMinutes = minutes;
        dirty = true;
        cb?.(minutes);
      });
    },

    // Raymarched volumetric fire. Off by default: it is a full-screen
    // post-process, so it is opt-in until validated on the target machine.
    setVolumetric(next) {
      return volumetric.setEnabled(next);
    },

    get volumetricEnabled() {
      return volumetric.enabled;
    },

    // PFIX7b dev diagnostic passthrough — see fireOverlay.js.
    setDebugCells(enabled) {
      base.setDebugCells(enabled);
    },

    clear() {
      base.clear();
      volumetric.clear();
      if (removeListener) removeListener();
      removeListener = null;
      destroyPool();
      result = null;
      cellPositions = null;
      timeMinutes = 0;
    }
  };
}
