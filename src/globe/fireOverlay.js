import * as Cesium from 'cesium';

// Fire overlay. Reads the frozen runFromClick() contract (arrivalMinutes /
// fuelCodes — see CLAUDE.md) and renders it as a single ground-draped
// primitive. NO physics here: this file only decides how an already-solved
// arrival time looks.
//
//   - Arrival times are baked into ONE RGBA texture, uploaded ONCE at
//     ignition, never rebuilt during playback.
//   - One GroundPrimitive with a custom Cesium.Material whose only mutable
//     input is a single float uniform, uTime.
//   - A clock tick advances uTime. Nothing else changes per frame — no
//     allocation, no texture upload, no geometry rebuild.
//
// Scrubbing is therefore free: setTime writes one float.
//
// PFIX5 (demo visibility): a real 10m cell is imperceptible at any framing
// wide enough to show a 640m field. The fragment shader now splats each
// live cell across a VISUAL_CELL_SCALE-cell radius with soft falloff, so a
// 1-cell fire still reads as an organic blob rather than a single pixel.
export const VISUAL_CELL_SCALE = 2.5; // demo scaling, not physical size

// Arrival minutes are packed into R+G as a 16-bit fixed-point value so the
// front band stays smooth at 10 m cells; B carries a normalized fuel index
// for tinting, A flags "this cell ever burns" (0 = never, arrival Infinity).
const ARRIVAL_ENCODE_SCALE = 60; // 1/60 min per unit => ~1s resolution
// Widened from the original 1.5 min: combined with the splat radius above,
// this keeps the leading edge a visibly thick, slow-pulsing band instead of
// a thin line that vanishes between ticks on a slow-spreading fire.
const FRONT_WINDOW_MINUTES = 3.0;
const IGNITION_FLARE_MS = 2000;
const IGNITION_FLARE_MAX_RADIUS_M = 60;

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
//
// gridSize is baked in as a compile-time constant (not a uniform) because it
// never changes mid-run and GLSL's `for` loop bounds need to stay simple.
function buildFireMaterialShader(gridSize) {
  return /* glsl */`
const float GRID_SIZE = ${gridSize.toFixed(1)};
const float VISUAL_CELL_SCALE = ${VISUAL_CELL_SCALE.toFixed(2)};
const int KERNEL = 3; // ceil(VISUAL_CELL_SCALE) + 1 margin cell

float decodeArrival(vec4 texel) {
  return (texel.r * 255.0 + texel.g * 255.0 * 256.0) / ${ARRIVAL_ENCODE_SCALE}.0;
}

czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 uv = vec2(materialInput.st.x, 1.0 - materialInput.st.y);
  vec2 cellPos = uv * GRID_SIZE;
  vec2 baseCell = floor(cellPos);
  vec2 texel1 = vec2(1.0) / GRID_SIZE;

  // Splat: search a fixed neighbourhood and take the nearest cell (by burn
  // age) that has already ignited within VISUAL_CELL_SCALE cells of this
  // fragment. This is what turns a single burning pixel into a visible blob,
  // and lets adjacent blobs merge into one organic shape instead of a grid
  // of squares.
  float bestAge = 1.0e6;
  float bestIntensity = 0.0;
  float bestWeight = 0.0;

  for (int dx = -KERNEL; dx <= KERNEL; dx += 1) {
    for (int dy = -KERNEL; dy <= KERNEL; dy += 1) {
      vec2 neighborCell = baseCell + vec2(float(dx), float(dy));
      if (neighborCell.x < 0.0 || neighborCell.y < 0.0 ||
          neighborCell.x >= GRID_SIZE || neighborCell.y >= GRID_SIZE) continue;
      float dist = length(cellPos - (neighborCell + 0.5));
      if (dist > VISUAL_CELL_SCALE) continue;
      vec2 nuv = (neighborCell + 0.5) * texel1;
      vec4 ntex = texture(arrivalMap, nuv);
      if (ntex.a < 0.5) continue;
      float narrival = decodeArrival(ntex);
      if (narrival > uTime) continue;
      float age = uTime - narrival;
      if (age < bestAge) {
        bestAge = age;
        bestIntensity = ntex.b;
        // Soft falloff at the splat edge so overlapping splats merge.
        bestWeight = 1.0 - smoothstep(VISUAL_CELL_SCALE * 0.55, VISUAL_CELL_SCALE, dist);
      }
    }
  }

  if (bestWeight <= 0.0) {
    material.alpha = 0.0;
    return material;
  }

  float front = 1.0 - clamp(bestAge / uFrontWindow, 0.0, 1.0);
  float glow = pow(front, 2.2);

  // The front band stays visibly alive even when spread has stalled: pulse
  // its emission on uTime rather than relying purely on age.
  float pulse = 0.82 + 0.18 * sin(uTime * 5.5);
  float frontPulse = glow * pulse;

  // Per-cell hash so the charcoal ember flicker doesn't read as one uniform
  // strobe across the whole burn scar.
  float cellHash = fract(sin(dot(baseCell, vec2(12.9898, 78.233))) * 43758.5453);
  float emberFlicker = 0.85 + 0.15 * sin(uTime * 3.0 + cellHash * 6.2831);

  // Contrast floors: charcoal never disappears against pale dirt, and the
  // active front is near-white/yellow so it blooms over dark forest too.
  vec3 charColor = vec3(0.10, 0.085, 0.078) * emberFlicker;
  vec3 emberColor = vec3(0.9, 0.24, 0.05);
  vec3 flameColor = vec3(1.0, 0.93, 0.75);

  vec3 color = mix(charColor, emberColor, frontPulse * 0.85);
  color = mix(color, flameColor, pow(frontPulse, 2.0));

  material.diffuse = color;
  material.emission = color * frontPulse * (1.6 + 2.0 * bestIntensity);
  float baseAlpha = mix(0.75, 1.0, frontPulse);
  material.alpha = baseAlpha * bestWeight;
  return material;
}
`;
}

// A 2s expanding ring + glow at the ignition cell. Purely cosmetic — guides
// the eye to the click point even when the eventual burn stays tiny.
function playIgnitionFlare(viewer, { latitude, longitude, groundHeightMeters }) {
  const startMs = performance.now();
  const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, groundHeightMeters + 1);
  const radius = () => {
    const t = Math.min(1, (performance.now() - startMs) / IGNITION_FLARE_MS);
    return 4 + Cesium.Math.lerp(0, IGNITION_FLARE_MAX_RADIUS_M, 1 - Math.pow(1 - t, 2));
  };
  const entity = viewer.entities.add({
    position,
    ellipse: {
      semiMinorAxis: new Cesium.CallbackProperty(radius, false),
      semiMajorAxis: new Cesium.CallbackProperty(radius, false),
      height: groundHeightMeters + 1,
      outline: true,
      outlineWidth: 2,
      outlineColor: new Cesium.CallbackProperty(() => {
        const t = Math.min(1, (performance.now() - startMs) / IGNITION_FLARE_MS);
        return Cesium.Color.fromBytes(255, 240, 200, Math.round((1 - t) * 255));
      }, false),
      material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => {
        const t = Math.min(1, (performance.now() - startMs) / IGNITION_FLARE_MS);
        return Cesium.Color.fromBytes(255, 225, 150, Math.round((1 - t) * 140));
      }, false))
    }
  });
  setTimeout(() => viewer.entities.remove(entity), IGNITION_FLARE_MS + 100);
}

// Cesium caches Material fabrics by `type` and, on a cache hit, clones the
// cached template's uniform defaults to build the new instance. Reusing one
// fixed type string across ignitions made it try to clone the PREVIOUS
// run's arrivalMap canvas — `new HTMLCanvasElement()` is an illegal
// constructor, so the second click on any session threw here. A unique
// type per ignition guarantees a fresh (uncached) material every time.
let fireMaterialTypeCounter = 0;

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
          type: `FireArrival_${fireMaterialTypeCounter++}`,
          uniforms: {
            arrivalMap: buildArrivalTexture({ gridSize, arrivalMinutes, fuelCodes }),
            uTime: 0,
            uFrontWindow: FRONT_WINDOW_MINUTES
          },
          source: buildFireMaterialShader(gridSize)
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

      // Ignition is always at the field centre (see runFromClick's FIELD_CENTER),
      // which is exactly the bbox centre.
      let groundHeightMeters = 0;
      if (typeof viewer.scene.sampleHeight === 'function') {
        try {
          const centre = Cesium.Cartographic.fromDegrees(
            (bbox[0] + bbox[2]) / 2,
            (bbox[1] + bbox[3]) / 2
          );
          const sampled = viewer.scene.sampleHeight(centre);
          if (Number.isFinite(sampled)) groundHeightMeters = sampled;
        } catch { /* no pickable surface; flare draws at ellipsoid height */ }
      }
      playIgnitionFlare(viewer, {
        latitude: (bbox[1] + bbox[3]) / 2,
        longitude: (bbox[0] + bbox[2]) / 2,
        groundHeightMeters
      });

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
