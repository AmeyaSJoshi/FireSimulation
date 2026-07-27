import * as Cesium from 'cesium';

// Volumetric fire by raymarching.
//
// Billboards and particles draw *surfaces*, and fire has none — that is why a
// sprite flame always reads as a flat card no matter how it is tuned. Here,
// each pixel casts a ray into a box over the sim area, walks it in steps, and
// asks "how much fire is at this point in space?", accumulating emission and
// extinction along the way. No surface is ever drawn.
//
// Density at a point comes from three things:
//   height  — exponential falloff: dense at the base, thin as it rises
//   noise   — 3-octave fbm for wispy structure instead of a smooth blob
//   age     — from the arrival-time texture, so flame lives at the front and
//             dies behind it
//
// Colour is a blackbody ramp, not a hand-picked gradient: cool ~800 K edges
// are deep red, the ~2500 K core is near-white. That progression is what the
// eye actually reads as fire.
//
// THE detail that makes or breaks it: fbm is sampled at WORLD-SPACE position
// with the vertical component scrolled by -uTime * rise. Sampling in screen or
// UV space glues the noise to the screen and yields an expensive flat effect;
// world-space is what makes it parallax correctly when the camera orbits.
//
// Implemented as a PostProcessStage rather than a Primitive+Appearance:
// raymarching is inherently screen-space, and the stage gives documented
// uniform callbacks plus native scene-depth access for occlusion. A custom
// Appearance has no supported hook for per-frame uniforms.
//
// Reads the same arrival encoding fireOverlay.js writes (R+G 16-bit fixed
// point minutes, A = "ever burns"). Physics is untouched.

const ARRIVAL_ENCODE_SCALE = 60;
const BOX_HEIGHT_METERS = 40;
const MARCH_STEPS = 32;
const FRONT_WINDOW_MINUTES = 8.0;

function buildArrivalTexture({ gridSize, arrivalMinutes }) {
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
      data[o + 3] = 0;
      continue;
    }
    const encoded = Math.min(65535, Math.max(0, Math.round(arrival * ARRIVAL_ENCODE_SCALE)));
    data[o] = encoded & 0xff;
    data[o + 1] = (encoded >> 8) & 0xff;
    data[o + 2] = 0;
    data[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

const FRAGMENT_SHADER = /* glsl */`
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
in vec2 v_textureCoordinates;

uniform float uTime;
uniform float uActive;
uniform sampler2D uArrivalMap;
// Box described in EYE space, rebuilt each frame from the camera matrix.
uniform vec3 uBoxCenterEC;
uniform vec3 uBoxEastEC;
uniform vec3 uBoxNorthEC;
uniform vec3 uBoxUpEC;
uniform vec3 uBoxHalfExtents; // metres along (east, north, up)

const float NEVER_BURNS = 1.0e6;
const float FRONT_WINDOW = ${FRONT_WINDOW_MINUTES.toFixed(1)};
const int STEPS = ${MARCH_STEPS};

float decodeArrival(vec4 texel) {
  if (texel.a < 0.5) return NEVER_BURNS;
  return (texel.r * 255.0 + texel.g * 255.0 * 256.0) / ${ARRIVAL_ENCODE_SCALE}.0;
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float valueNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x),
        mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
        mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y),
    f.z
  );
}

float fbm(vec3 p) {
  return 0.5 * valueNoise(p) + 0.25 * valueNoise(p * 2.03) + 0.125 * valueNoise(p * 4.01);
}

bool intersectBox(vec3 ro, vec3 rd, out float t0, out float t1) {
  vec3 d = ro - uBoxCenterEC;
  vec3 lo_ = vec3(dot(d, uBoxEastEC), dot(d, uBoxNorthEC), dot(d, uBoxUpEC));
  vec3 ld = vec3(dot(rd, uBoxEastEC), dot(rd, uBoxNorthEC), dot(rd, uBoxUpEC));
  vec3 inv = 1.0 / (ld + 1e-9);
  vec3 a = (-uBoxHalfExtents - lo_) * inv;
  vec3 b = (uBoxHalfExtents - lo_) * inv;
  vec3 tmin = min(a, b);
  vec3 tmax = max(a, b);
  t0 = max(max(tmin.x, tmin.y), tmin.z);
  t1 = min(min(tmax.x, tmax.y), tmax.z);
  return t1 > max(t0, 0.0);
}

// Deep red -> orange -> yellow -> near-white core.
vec3 blackbody(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(vec3(0.55, 0.02, 0.0), vec3(1.0, 0.28, 0.02), smoothstep(0.0, 0.35, t));
  c = mix(c, vec3(1.0, 0.65, 0.08), smoothstep(0.3, 0.65, t));
  c = mix(c, vec3(1.0, 0.92, 0.55), smoothstep(0.6, 0.88, t));
  c = mix(c, vec3(1.0, 0.99, 0.92), smoothstep(0.85, 1.0, t));
  return c;
}

void main() {
  vec4 sceneColor = texture(colorTexture, v_textureCoordinates);
  if (uActive < 0.5) { out_FragColor = sceneColor; return; }

  // Reconstruct the eye-space view ray for this pixel.
  vec2 ndc = v_textureCoordinates * 2.0 - 1.0;
  vec4 nearPlane = czm_inverseProjection * vec4(ndc, -1.0, 1.0);
  vec3 rd = normalize(nearPlane.xyz / nearPlane.w);
  vec3 ro = vec3(0.0);

  float t0, t1;
  if (!intersectBox(ro, rd, t0, t1)) { out_FragColor = sceneColor; return; }
  t0 = max(t0, 0.0);

  // Clamp the far end to scene depth so terrain and buildings in front of the
  // volume occlude it instead of fire drawing over them.
  float depth = czm_readDepth(depthTexture, v_textureCoordinates);
  if (depth < 1.0) {
    vec4 depthEC = czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, depth, 1.0));
    t1 = min(t1, length(depthEC.xyz / depthEC.w));
  }
  if (t1 <= t0) { out_FragColor = sceneColor; return; }

  float stepLen = (t1 - t0) / float(STEPS);
  float jitter = hash13(vec3(gl_FragCoord.xy, czm_frameNumber)); // kills banding

  vec3 accum = vec3(0.0);
  float transmittance = 1.0;

  for (int i = 0; i < STEPS; i += 1) {
    vec3 p = ro + rd * (t0 + (float(i) + jitter) * stepLen);
    vec3 d = p - uBoxCenterEC;

    float east = dot(d, uBoxEastEC);
    float north = dot(d, uBoxNorthEC);
    float up = dot(d, uBoxUpEC) + uBoxHalfExtents.z; // 0 at ground

    vec2 uv = vec2(east / (2.0 * uBoxHalfExtents.x) + 0.5,
                   north / (2.0 * uBoxHalfExtents.y) + 0.5);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;

    // Arrival canvas row 0 is north; rectangle v runs south->north.
    float arrival = decodeArrival(texture(uArrivalMap, vec2(uv.x, 1.0 - uv.y)));
    if (arrival > uTime) continue;

    float frontFalloff = 1.0 - smoothstep(0.0, FRONT_WINDOW, uTime - arrival);
    if (frontFalloff <= 0.001) continue;

    // WORLD-SPACE noise: built from the box's own east/north/up basis, so it
    // stays anchored to the ground as the camera orbits. Vertical scroll
    // makes the structure rise.
    vec3 worldish = vec3(east, north, up) + vec3(0.0, 0.0, -uTime * 2.0);
    float density = exp(-up / 15.0) * fbm(worldish * 0.15) * frontFalloff;
    density = max(density - 0.08, 0.0) * 2.2; // contrast floor carves wisps
    if (density <= 0.0) continue;

    // Denser => hotter; superlinear emission blows the core out bright.
    vec3 emission = blackbody(clamp(density * 1.9, 0.0, 1.0))
      * (density + 2.4 * density * density);

    accum += emission * transmittance * stepLen * 0.75;
    transmittance *= exp(-density * stepLen * 1.5);
    if (transmittance < 0.01) break;
  }

  out_FragColor = vec4(sceneColor.rgb + accum, sceneColor.a);
}
`;

export function createVolumetricFire(viewer) {
  let stage = null;
  let timeMinutes = 0;
  let enabled = false;
  let pending = null;

  // Rebuilt per ignition; read every frame by the uniform callbacks.
  let centreWC = Cesium.Cartesian3.ZERO.clone();
  let enu = Cesium.Matrix4.IDENTITY.clone();
  let halfExtents = new Cesium.Cartesian3(1, 1, 1);
  let arrivalCanvas = null;
  let active = false;

  const scratchAxis = new Cesium.Cartesian4();
  function axisToEye(columnIndex) {
    const axis = Cesium.Matrix4.getColumn(enu, columnIndex, scratchAxis);
    const dir = new Cesium.Cartesian3(axis.x, axis.y, axis.z);
    Cesium.Cartesian3.normalize(dir, dir);
    return Cesium.Matrix4.multiplyByPointAsVector(
      viewer.scene.camera.viewMatrix, dir, new Cesium.Cartesian3()
    );
  }

  function ensureStage() {
    if (stage) return;
    stage = viewer.scene.postProcessStages.add(new Cesium.PostProcessStage({
      name: 'ignis_volumetric_fire',
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uTime: () => timeMinutes,
        uActive: () => (active && enabled ? 1.0 : 0.0),
        uArrivalMap: () => arrivalCanvas,
        uBoxCenterEC: () => Cesium.Matrix4.multiplyByPoint(
          viewer.scene.camera.viewMatrix, centreWC, new Cesium.Cartesian3()
        ),
        uBoxEastEC: () => axisToEye(0),
        uBoxNorthEC: () => axisToEye(1),
        uBoxUpEC: () => axisToEye(2),
        uBoxHalfExtents: () => halfExtents
      }
    }));
  }

  function build(result) {
    const { gridSize, arrivalMinutes, bbox } = result;
    const [west, south, east, north] = bbox;
    const midLat = (south + north) / 2;
    const midLon = (west + east) / 2;

    let groundHeight = 0;
    if (typeof viewer.scene.sampleHeight === 'function') {
      try {
        const sampled = viewer.scene.sampleHeight(Cesium.Cartographic.fromDegrees(midLon, midLat));
        if (Number.isFinite(sampled)) groundHeight = sampled;
      } catch { /* no pickable surface yet */ }
    }

    const halfEast = Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromDegrees(west, midLat, groundHeight),
      Cesium.Cartesian3.fromDegrees(east, midLat, groundHeight)
    ) / 2;
    const halfNorth = Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromDegrees(midLon, south, groundHeight),
      Cesium.Cartesian3.fromDegrees(midLon, north, groundHeight)
    ) / 2;
    const halfUp = BOX_HEIGHT_METERS / 2;

    halfExtents = new Cesium.Cartesian3(halfEast, halfNorth, halfUp);
    centreWC = Cesium.Cartesian3.fromDegrees(midLon, midLat, groundHeight + halfUp);
    enu = Cesium.Transforms.eastNorthUpToFixedFrame(centreWC);
    arrivalCanvas = buildArrivalTexture({ gridSize, arrivalMinutes });
    active = true;

    ensureStage();
  }

  return {
    show(result) {
      pending = result;
      if (enabled) build(result);
    },
    setTime(minutes) {
      timeMinutes = minutes;
    },
    // Flagged off by default; toggle via window.__ignis.volumetric.
    setEnabled(next) {
      enabled = Boolean(next);
      if (enabled && pending) build(pending);
      if (!enabled) active = false;
      return enabled;
    },
    get enabled() { return enabled; },
    clear() {
      pending = null;
      active = false;
    }
  };
}
