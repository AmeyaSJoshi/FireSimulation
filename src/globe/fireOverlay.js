import * as Cesium from 'cesium';

// Fire overlay. Reads the frozen runFromClick() contract (arrivalMinutes /
// fuelCodes — see CLAUDE.md) and renders it as a single ground-draped
// primitive. NO physics here: this file only decides how an already-solved
// arrival time looks.
//
// The previous version had no clock at all (nothing ever advanced it) and
// rebuilt a canvas + a new ImageMaterialProperty on every update, pushing a
// fresh texture through the entity property system each time. Both are gone:
//
//   - Arrival times are baked into ONE RGBA texture, uploaded ONCE at
//     ignition, never rebuilt during playback.
//   - One GroundPrimitive with a custom Cesium.Material whose only mutable
//     input is a single float uniform, uTime.
//   - A clock tick advances uTime. Nothing else changes per frame — no
//     allocation, no texture upload, no geometry rebuild.
//
// Scrubbing is therefore free: setTime writes one float.

// Arrival minutes are packed into R+G as a 16-bit fixed-point value so the
// front band stays smooth at 10 m cells; B carries a normalized fuel index
// for tinting, A flags "this cell ever burns" (0 = never, arrival Infinity).
const ARRIVAL_ENCODE_SCALE = 60; // 1/60 min per unit => ~1s resolution
const FRONT_WINDOW_MINUTES = 1.5; // 90 s bright leading edge

// Denser fuel burns hotter/taller. Index into provenance.fuelCodeList; the
// leading GR*/GS* grass codes are short, SH* brush mid, TU*/TL* timber tallest.
function fuelIntensity(fuelIndex) {
  if (fuelIndex >= 18) return 1.0;  // TU*/TL* timber
  if (fuelIndex >= 10) return 0.72; // SH* brush
  return 0.45;                       // GR*/GS* grass
}

function buildArrivalTexture({ gridSize, arrivalMinutes, fuelCodes }) {
  const canvas = document.createElement('canvas');
  canvas.width = gridSize;
  canvas.height = gridSize;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(gridSize, gridSize);
  const data = image.data;

  for (let i = 0; i < arrivalMinutes.length; i += 1) {
    const arrival = arrivalMinutes[i];
    const o = i * 4;
    if (!Number.isFinite(arrival)) {
      data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0;
      continue;
    }
    const encoded = Math.min(65535, Math.max(0, Math.round(arrival * ARRIVAL_ENCODE_SCALE)));
    data[o] = encoded & 0xff;           // low byte
    data[o + 1] = (encoded >> 8) & 0xff; // high byte
    data[o + 2] = Math.round(fuelIntensity(fuelCodes[i]) * 255);
    data[o + 3] = 255;                   // burns at some point
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

// Row 0 of the sim grid is north (spatialGrid convention), but a Cesium
// Rectangle's v axis runs south->north, so the shader flips v when sampling.
const FIRE_MATERIAL_SHADER = /* glsl */`
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 uv = vec2(materialInput.st.x, 1.0 - materialInput.st.y);
  vec4 texel = texture(arrivalMap, uv);

  // Cells that never ignite stay fully transparent.
  if (texel.a < 0.5) {
    material.alpha = 0.0;
    return material;
  }

  float arrival = (texel.r * 255.0 + texel.g * 255.0 * 256.0) / ${ARRIVAL_ENCODE_SCALE}.0;
  float intensity = texel.b;

  // Not yet reached by the front.
  if (arrival > uTime) {
    material.alpha = 0.0;
    return material;
  }

  float age = uTime - arrival;
  // 1.0 exactly at the front, falling to 0.0 by the end of the window.
  float front = 1.0 - clamp(age / uFrontWindow, 0.0, 1.0);
  // Sharpen so the leading edge reads as a band, not a broad gradient, and
  // give it an emissive falloff so it looks like fire rather than a polygon.
  float glow = pow(front, 2.2);

  vec3 charColor = vec3(0.10, 0.085, 0.078);
  vec3 emberColor = vec3(0.85, 0.22, 0.04);
  vec3 flameColor = vec3(1.0, 0.75, 0.25);

  vec3 color = mix(charColor, emberColor, glow * 0.85);
  color = mix(color, flameColor, pow(glow, 3.0));

  material.diffuse = color;
  // Emission is what makes the front band bloom instead of reading flat.
  material.emission = color * glow * (1.2 + 1.6 * intensity);
  material.alpha = mix(0.82, 1.0, glow);
  return material;
}
`;

export function createFireOverlay(viewer) {
  let primitive = null;
  let material = null;
  let removeTick = null;
  let result = null;
  let timeMinutes = 0;
  let playing = false;
  let endMinutes = 0;
  let onTimeChange = null;
  let lastRealMs = 0;
  // A tab that was backgrounded (or a slow first frame) can hand back a delta
  // of many seconds, which would jump the whole run in a single tick.
  const MAX_TICK_SECONDS = 0.25;

  // 120 sim-minutes over ~20 real seconds.
  const PLAYBACK_SIM_MINUTES = 120;
  const PLAYBACK_REAL_SECONDS = 20;
  const SIM_MINUTES_PER_REAL_SECOND = PLAYBACK_SIM_MINUTES / PLAYBACK_REAL_SECONDS;

  function clear() {
    if (removeTick) removeTick();
    if (primitive) viewer.scene.primitives.remove(primitive);
    removeTick = null;
    primitive = null;
    material = null;
    result = null;
    timeMinutes = 0;
    endMinutes = 0;
    playing = false;
  }

  function applyTime(minutes) {
    timeMinutes = minutes;
    if (material) material.uniforms.uTime = minutes;
    onTimeChange?.(minutes);
  }

  return {
    // result: the frozen contract object from runFromClick()
    show(nextResult) {
      clear();
      result = nextResult;
      const { gridSize, arrivalMinutes, fuelCodes, bbox } = result;

      endMinutes = 0;
      for (let i = 0; i < arrivalMinutes.length; i += 1) {
        const a = arrivalMinutes[i];
        if (Number.isFinite(a) && a > endMinutes) endMinutes = a;
      }

      material = new Cesium.Material({
        fabric: {
          type: 'FireArrival',
          uniforms: {
            arrivalMap: buildArrivalTexture({ gridSize, arrivalMinutes, fuelCodes }),
            uTime: 0,
            uFrontWindow: FRONT_WINDOW_MINUTES
          },
          source: FIRE_MATERIAL_SHADER
        },
        translucent: true
      });

      // GroundPrimitive drapes onto whatever surface is actually rendered —
      // photoreal tiles or terrain — so the fire follows the ground instead of
      // floating at a fixed height.
      primitive = new Cesium.GroundPrimitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.RectangleGeometry({
            rectangle: Cesium.Rectangle.fromDegrees(bbox[0], bbox[1], bbox[2], bbox[3]),
            vertexFormat: Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT
          })
        }),
        appearance: new Cesium.EllipsoidSurfaceAppearance({
          material,
          translucent: true,
          aboveGround: false
        }),
        classificationType: Cesium.ClassificationType.BOTH
      });
      viewer.scene.primitives.add(primitive);

      applyTime(0);
      playing = true;
      lastRealMs = performance.now();

      // One subscription for the whole run. The handler only advances a float.
      const listener = viewer.clock.onTick.addEventListener(() => {
        const now = performance.now();
        const deltaSeconds = Math.min((now - lastRealMs) / 1000, MAX_TICK_SECONDS);
        lastRealMs = now;
        if (!playing || !material) return;
        const next = timeMinutes + deltaSeconds * SIM_MINUTES_PER_REAL_SECOND;
        if (next >= endMinutes) {
          playing = false;
          applyTime(endMinutes);
          return;
        }
        applyTime(next);
      });
      removeTick = () => viewer.clock.onTick.removeEventListener(listener);
    },

    // Scrubbing: writes one uniform, no recompute, no upload.
    setTime(minutes) {
      if (!result) return;
      playing = false;
      applyTime(Math.max(0, Math.min(minutes, endMinutes)));
    },

    play() {
      if (!result) return;
      // Re-baseline the clock: time spent paused/scrubbing is not playback
      // time, and folding it into the next delta would jump the whole run.
      lastRealMs = performance.now();
      playing = true;
    },

    get durationMinutes() {
      return endMinutes;
    },

    // Lets the UI mirror playback position onto a scrub slider.
    onTime(cb) {
      onTimeChange = cb;
    },

    clear
  };
}
