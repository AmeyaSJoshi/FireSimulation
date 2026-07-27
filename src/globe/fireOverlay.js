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
// wide enough to show a 640m field. Volumetric flame sizing in fireLOD.js
// still keys off this; the base drape's own visual-minimum-size guarantee
// is VISUAL_DILATE_CELLS below (PFIX7b).
export const VISUAL_CELL_SCALE = 2.5; // demo scaling, not physical size

// PFIX7b: the base drape is a continuous field, not per-cell discs. A single
// burned cell still needs to read as more than a sub-pixel dot, so the arrival
// threshold is dilated (min-arrival over a ring) by this many cell-units
// instead of scaling a disc primitive.
const VISUAL_DILATE_CELLS = 1.5;

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
// PFIX7b: continuous field, not per-cell discs.
//   - arrivalMap is sampled NEAREST (see the Material's minificationFilter/
//     magnificationFilter below) — linear-filtering the encoded fixed-point
//     value would corrupt it. All smoothing happens here, after decode, via
//     a manual 4-tap bilinear.
//   - The old per-fragment 7x7 kernel search (which produced per-cell disc
//     artifacts, and mirrored/repeated blobs near grid edges) is gone. The
//     visual-minimum-size guarantee is now a small fixed ring of dilation
//     taps around the bilinear sample, not a distance-weighted splat.
function buildFireMaterialShader(gridSize) {
  return /* glsl */`
const float GRID_SIZE = ${gridSize.toFixed(1)};
const float VISUAL_DILATE_CELLS = ${VISUAL_DILATE_CELLS.toFixed(2)};
const float TEXEL = 1.0 / GRID_SIZE; // derived from gridSize, never hardcoded
const float HALF_TEXEL = TEXEL * 0.5;
const float NEVER_BURNS = 1.0e6;
const int RING_TAPS = 8;
const float TWO_PI = 6.28318530718;

// Every tap (primary bilinear corners, ring dilation samples) is clamped
// through this so edge/corner cells never wrap or bleed into the opposite
// side of the field.
vec2 clampUV(vec2 uv) {
  return clamp(uv, vec2(HALF_TEXEL), vec2(1.0 - HALF_TEXEL));
}

float decodeArrivalTexel(vec4 texel) {
  if (texel.a < 0.5) return NEVER_BURNS; // never-burnable cell — treat as arriving effectively never
  return (texel.r * 255.0 + texel.g * 255.0 * 256.0) / ${ARRIVAL_ENCODE_SCALE}.0;
}

// Manual 4-tap bilinear: decode each of the 4 nearest texels to minutes
// first, then interpolate the decoded scalars (never the raw encoded bytes).
void sampleBilinear(vec2 uv, out float arrival, out float intensity) {
  vec2 f = uv * GRID_SIZE - 0.5;
  vec2 base = floor(f);
  vec2 frac = f - base;

  vec4 t00 = texture(arrivalMap, clampUV((base + vec2(0.5, 0.5)) * TEXEL));
  vec4 t10 = texture(arrivalMap, clampUV((base + vec2(1.5, 0.5)) * TEXEL));
  vec4 t01 = texture(arrivalMap, clampUV((base + vec2(0.5, 1.5)) * TEXEL));
  vec4 t11 = texture(arrivalMap, clampUV((base + vec2(1.5, 1.5)) * TEXEL));

  float a0 = mix(decodeArrivalTexel(t00), decodeArrivalTexel(t10), frac.x);
  float a1 = mix(decodeArrivalTexel(t01), decodeArrivalTexel(t11), frac.x);
  arrival = mix(a0, a1, frac.y);

  float i0 = mix(t00.b, t10.b, frac.x);
  float i1 = mix(t01.b, t11.b, frac.x);
  intensity = mix(i0, i1, frac.y);
}

// Dev-only diagnostic (window.__ignis.fireDrape.setDebugCells(true)): raw
// nearest-texel state, no bilinear, no dilation — one look tells you whether
// a visual bug is in the sampling/dilation above or upstream in the texture.
vec4 debugCellColor(vec2 uv) {
  vec2 cell = floor(clampUV(uv) * GRID_SIZE);
  vec4 texel = texture(arrivalMap, clampUV((cell + 0.5) * TEXEL));
  if (texel.a < 0.5) return vec4(0.0);
  if (decodeArrivalTexel(texel) > uTime) return vec4(0.0);
  float hash = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
  return vec4(hash, 1.0 - hash, 0.5, 1.0);
}

czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 uv = clampUV(vec2(materialInput.st.x, 1.0 - materialInput.st.y));

  if (uDebugCells > 0.5) {
    vec4 debugColor = debugCellColor(uv);
    material.diffuse = debugColor.rgb;
    material.alpha = debugColor.a;
    return material;
  }

  float primaryArrival;
  float primaryIntensity;
  sampleBilinear(uv, primaryArrival, primaryIntensity);

  // Visual-minimum-size guarantee: take the minimum decoded arrival within a
  // VISUAL_DILATE_CELLS ring (offset derived from GRID_SIZE, not a hardcoded
  // pixel radius), so a single burned cell still reads as a small rounded
  // blob instead of a sub-pixel dot.
  float dilatedArrival = primaryArrival;
  float ringUV = VISUAL_DILATE_CELLS * TEXEL;
  for (int i = 0; i < RING_TAPS; i += 1) {
    float angle = (float(i) / float(RING_TAPS)) * TWO_PI;
    vec2 ringUv = clampUV(uv + vec2(cos(angle), sin(angle)) * ringUV);
    float ringArrival;
    float ringIntensity;
    sampleBilinear(ringUv, ringArrival, ringIntensity);
    dilatedArrival = min(dilatedArrival, ringArrival);
  }

  if (dilatedArrival > uTime) {
    material.alpha = 0.0;
    return material;
  }

  float age = uTime - dilatedArrival;
  float front = smoothstep(0.0, 1.0, 1.0 - clamp(age / uFrontWindow, 0.0, 1.0));
  float glow = pow(front, 2.2);

  // The front band stays visibly alive even when spread has stalled: pulse
  // its emission on uTime rather than relying purely on age.
  float pulse = 0.82 + 0.18 * sin(uTime * 5.5);
  float frontPulse = glow * pulse;

  // Static (time-independent) per-cell noise so the charcoal reads as a
  // textured scar rather than a flat fill. Never touches alpha.
  vec2 cell = floor(uv * GRID_SIZE);
  float cellHash = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
  float noise = 0.85 + 0.15 * cellHash;

  // Contrast floors: charcoal never disappears against pale dirt, and the
  // active front is near-white/yellow so it blooms over dark forest too.
  vec3 charColor = vec3(0.10, 0.085, 0.078) * noise;
  vec3 emberColor = vec3(0.9, 0.24, 0.05);
  vec3 flameColor = vec3(1.0, 0.93, 0.75);

  vec3 color = mix(charColor, emberColor, smoothstep(0.0, 1.0, frontPulse * 0.85));
  color = mix(color, flameColor, smoothstep(0.0, 1.0, pow(frontPulse, 2.0)));

  material.diffuse = color;
  material.emission = color * frontPulse * (1.6 + 2.0 * primaryIntensity);
  // Burned alpha is constant once ignited — it never decays with age. No
  // ember fade-out: the interior of a long run stays solid charcoal forever.
  material.alpha = 0.8;
  return material;
}
`;
}

// A 2s expanding ring + glow at the ignition cell. Purely cosmetic — guides
// the eye to the click point even when the eventual burn stays tiny.
function playIgnitionFlare(viewer, { latitude, longitude, groundHeightMeters }) {
  const startJulian = Cesium.JulianDate.clone(viewer.clock.currentTime);
  const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, groundHeightMeters + 1);
  // Semi-major/minor MUST be numerically identical for a valid ellipse.
  // Two separate CallbackPropertys each reading performance.now() can
  // disagree by microseconds between calls (Cesium invokes them
  // independently), which threw "semiMajorAxis must be >= semiMinorAxis"
  // and halted rendering. Deriving t from the `time` argument Cesium passes
  // to the callback — the same JulianDate for both axes on a given tick —
  // makes this a pure function, so both reads are bit-identical.
  const progressAt = (time) => Math.min(
    1,
    Math.max(0, Cesium.JulianDate.secondsDifference(time, startJulian)) / (IGNITION_FLARE_MS / 1000)
  );
  const radiusAt = (time) => 4 + Cesium.Math.lerp(0, IGNITION_FLARE_MAX_RADIUS_M, 1 - Math.pow(1 - progressAt(time), 2));
  const entity = viewer.entities.add({
    position,
    ellipse: {
      semiMinorAxis: new Cesium.CallbackProperty((time) => radiusAt(time), false),
      semiMajorAxis: new Cesium.CallbackProperty((time) => radiusAt(time), false),
      height: groundHeightMeters + 1,
      outline: true,
      outlineWidth: 2,
      outlineColor: new Cesium.CallbackProperty((time) => {
        const t = progressAt(time);
        return Cesium.Color.fromBytes(255, 240, 200, Math.round((1 - t) * 255));
      }, false),
      material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty((time) => {
        const t = progressAt(time);
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
  // Persists across ignitions (material is rebuilt each show()) so toggling
  // the debug view once keeps it on for the rest of the session.
  let debugCellsEnabled = false;
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
            uFrontWindow: FRONT_WINDOW_MINUTES,
            uDebugCells: debugCellsEnabled ? 1.0 : 0.0
          },
          source: buildFireMaterialShader(gridSize)
        },
        translucent: true,
        // arrivalMap is encoded fixed-point data (PFIX7b) — the GPU must
        // never linear-filter it. All smoothing happens in-shader, after
        // decode, via the manual bilinear above.
        minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
        magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST
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

    // Dev-only diagnostic: window.__ignis.fireDrape.setDebugCells(true).
    // Renders raw per-cell nearest-sample state instead of the smoothed
    // field, so a sampling/dilation bug is diagnosable in one screenshot.
    setDebugCells(enabled) {
      debugCellsEnabled = Boolean(enabled);
      if (material) material.uniforms.uDebugCells = debugCellsEnabled ? 1.0 : 0.0;
    },

    clear
  };
}
