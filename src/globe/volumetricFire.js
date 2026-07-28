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
// Module-level: PostProcessStage names must be unique across the whole
// collection, so a per-instance counter would collide if two overlays ever
// shared one viewer.
let stageCounter = 0;

function buildArrivalTexture({ gridSize, arrivalMinutes, terrainHeights, groundBase, groundSpan }) {
  const canvas = document.createElement('canvas');
  canvas.width = gridSize;
  canvas.height = gridSize;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(gridSize, gridSize);
  const data = image.data;
  for (let i = 0; i < arrivalMinutes.length; i += 1) {
    const arrival = arrivalMinutes[i];
    const o = i * 4;
    // B: per-cell ground height above the box base, for ALL cells — the
    // shader needs terrain under never-burn cells too, so bilinear ground
    // stays sane at burn/non-burn boundaries.
    const cellGround = Number.isFinite(terrainHeights?.[i]) ? terrainHeights[i] : groundBase;
    data[o + 2] = Math.min(255, Math.max(0, Math.round(((cellGround - groundBase) / groundSpan) * 255)));
    if (!Number.isFinite(arrival)) {
      data[o + 3] = 0;
      continue;
    }
    const encoded = Math.min(65535, Math.max(0, Math.round(arrival * ARRIVAL_ENCODE_SCALE)));
    data[o] = encoded & 0xff;
    data[o + 1] = (encoded >> 8) & 0xff;
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
uniform float uDebug;
uniform sampler2D uArrivalMap;
// Box described in EYE space, rebuilt each frame from the camera matrix.
uniform vec3 uBoxCenterEC;
uniform vec3 uBoxEastEC;
uniform vec3 uBoxNorthEC;
uniform vec3 uBoxUpEC;
uniform vec3 uBoxHalfExtents; // metres along (east, north, up)
uniform float uGroundSpan;    // metres of terrain relief encoded in B

const float NEVER_BURNS = 1.0e6;
const float FRONT_WINDOW = ${FRONT_WINDOW_MINUTES.toFixed(1)};
const int STEPS = ${MARCH_STEPS};

float decodeArrival(vec4 texel) {
  if (texel.a < 0.5) return NEVER_BURNS;
  return (texel.r * 255.0 + texel.g * 255.0 * 256.0) / ${ARRIVAL_ENCODE_SCALE}.0;
}

// Manual 4-tap bilinear, decoding each texel FIRST and interpolating the
// decoded scalars — the same pattern fireOverlay.js uses. A single NEAREST
// tap made every 10 m cell a hard-edged prism: the checkerboard columns.
// Ground (B) interpolates too, so flame bases follow the hillside smoothly.
void sampleField(vec2 uv, out float arrival, out float ground) {
  vec2 ts = vec2(textureSize(uArrivalMap, 0));
  vec2 halfTexel = 0.5 / ts;
  vec2 f = clamp(uv, halfTexel, 1.0 - halfTexel) * ts - 0.5;
  vec2 base = floor(f);
  vec2 fr = f - base;
  vec2 c00 = clamp((base + vec2(0.5, 0.5)) / ts, halfTexel, 1.0 - halfTexel);
  vec2 c10 = clamp((base + vec2(1.5, 0.5)) / ts, halfTexel, 1.0 - halfTexel);
  vec2 c01 = clamp((base + vec2(0.5, 1.5)) / ts, halfTexel, 1.0 - halfTexel);
  vec2 c11 = clamp((base + vec2(1.5, 1.5)) / ts, halfTexel, 1.0 - halfTexel);
  vec4 t00 = texture(uArrivalMap, c00);
  vec4 t10 = texture(uArrivalMap, c10);
  vec4 t01 = texture(uArrivalMap, c01);
  vec4 t11 = texture(uArrivalMap, c11);
  float a0 = mix(decodeArrival(t00), decodeArrival(t10), fr.x);
  float a1 = mix(decodeArrival(t01), decodeArrival(t11), fr.x);
  arrival = mix(a0, a1, fr.y);
  float g0 = mix(t00.b, t10.b, fr.x);
  float g1 = mix(t01.b, t11.b, fr.x);
  ground = mix(g0, g1, fr.y) * uGroundSpan;
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

  // Debug, BEFORE the depth clamp: magenta = ray hits the box AND at least
  // one march sample passes the arrival gate (geometry AND decode good);
  // dim blue = box hit but every sample culled by arrival (geometry good,
  // decode/uv/texture wrong). One glance splits the two failure classes.
  if (uDebug > 0.5) {
    float dt0 = max(t0, 0.0);
    float dStep = (t1 - dt0) / float(STEPS);
    int passes = 0;
    for (int i = 0; i < STEPS; i += 1) {
      vec3 dp = ro + rd * (dt0 + (float(i) + 0.5) * dStep);
      vec3 dd = dp - uBoxCenterEC;
      vec2 duv = vec2(dot(dd, uBoxEastEC) / (2.0 * uBoxHalfExtents.x) + 0.5,
                      dot(dd, uBoxNorthEC) / (2.0 * uBoxHalfExtents.y) + 0.5);
      if (duv.x < 0.0 || duv.x > 1.0 || duv.y < 0.0 || duv.y > 1.0) continue;
      if (decodeArrival(texture(uArrivalMap, vec2(duv.x, 1.0 - duv.y))) <= uTime) passes += 1;
    }
    out_FragColor = passes > 0 ? vec4(1.0, 0.0, 1.0, 1.0) : vec4(0.1, 0.15, 0.6, 1.0);
    return;
  }

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
    // Bilinear-decoded: near a never-burns neighbour the interpolated arrival
    // climbs toward NEVER_BURNS, so the flame edge SHRINKS smoothly instead
    // of snapping off at the cell border.
    float arrival;
    float cellGround;
    sampleField(vec2(uv.x, 1.0 - uv.y), arrival, cellGround);
    if (arrival > uTime) continue;

    float frontFalloff = 1.0 - smoothstep(0.0, FRONT_WINDOW, uTime - arrival);
    if (frontFalloff <= 0.001) continue;

    // Height above the LOCAL terrain, not the box base — one flat base put
    // uphill flames underground (depth-clipped into floating caps) and left
    // downhill flames hovering on any slope.
    float h = up - cellGround;
    if (h < 0.0) continue;

    // WORLD-SPACE noise: built from the box's own east/north/up basis, so it
    // stays anchored to the ground as the camera orbits. Vertical scroll
    // makes the structure rise.
    vec3 worldish = vec3(east, north, up) + vec3(0.0, 0.0, -uTime * 2.0);
    float density = exp(-h / 15.0) * fbm(worldish * 0.15) * frontFalloff;
    density = max(density - 0.08, 0.0) * 2.2; // contrast floor carves wisps
    if (density <= 0.0) continue;

    // Denser => hotter; superlinear emission blows the core out bright.
    vec3 emission = blackbody(clamp(density * 1.9, 0.0, 1.0))
      * (density + 2.4 * density * density);

    // Tuned for the HDR+ACES pipeline: the old 0.75 was compensating for a
    // clipping LDR target and read as muddy orange once values stopped
    // saturating. Filmic rolloff wants real energy to work with.
    accum += emission * transmittance * stepLen * 1.5;
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
  let debug = false;
  let pending = null;

  // Rebuilt per ignition; read every frame by the uniform callbacks.
  let centreWC = Cesium.Cartesian3.ZERO.clone();
  let enu = Cesium.Matrix4.IDENTITY.clone();
  let halfExtents = new Cesium.Cartesian3(1, 1, 1);
  let arrivalTexture = null;
  let groundSpan = 1;
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

  // The arrival field MUST be sampled NEAREST. With the default LINEAR
  // sampler the filter blends across the boundary between a burnable cell
  // (alpha 255, real arrival) and a never-burns cell (alpha 0, RG 0); the
  // blended texel decodes as "arrival ~ 0", which ignites a phantom ring
  // around the whole field perimeter. Building the Texture explicitly is the
  // only way to control the sampler here — a raw canvas uniform gets Cesium's
  // linear default. (fireOverlay.js documents the same hazard.)
  //
  // The stage is rebuilt per ignition rather than reused. A sampler uniform
  // must be a concrete value, not a per-frame callback, or Cesium re-resolves
  // the texture every frame. Scalar/vector uniforms stay callbacks by design.
  function rebuildStage() {
    // Only the stage — NOT the texture, which build() has just created and
    // is about to hand to this stage as a uniform.
    if (stage) {
      viewer.scene.postProcessStages.remove(stage);
      stage = null;
    }
    stage = viewer.scene.postProcessStages.add(new Cesium.PostProcessStage({
      name: `ignis_volumetric_fire_${stageCounter++}`,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uArrivalMap: arrivalTexture,
        uTime: () => timeMinutes,
        uActive: () => (active && enabled ? 1.0 : 0.0),
        uDebug: () => (debug ? 1.0 : 0.0),
        uBoxCenterEC: () => Cesium.Matrix4.multiplyByPoint(
          viewer.scene.camera.viewMatrix, centreWC, new Cesium.Cartesian3()
        ),
        uBoxEastEC: () => axisToEye(0),
        uBoxNorthEC: () => axisToEye(1),
        uBoxUpEC: () => axisToEye(2),
        uBoxHalfExtents: () => halfExtents,
        uGroundSpan: () => groundSpan
      }
    }));
    // Cesium's addEventListener returns a REMOVE FUNCTION, not the listener.
    const removeCheck = viewer.scene.postRender.addEventListener(() => {
      removeCheck();
      const gl = viewer.scene.context._originalGLContext;
      const glError = gl ? gl.getError() : 'no-gl';
      console.info('[volumetricFire] stage', stage?.name, '· ready', stage?.ready,
        '· glError', glError === 0 ? 'none' : glError);
    });
  }

  function removeStage() {
    if (stage) {
      viewer.scene.postProcessStages.remove(stage);
      stage = null;
    }
    if (arrivalTexture && !arrivalTexture.isDestroyed()) {
      arrivalTexture.destroy();
      arrivalTexture = null;
    }
  }

  function build(result) {
    const { gridSize, arrivalMinutes, bbox } = result;
    const [west, south, east, north] = bbox;
    const midLat = (south + north) / 2;
    const midLon = (west + east) / 2;

    // Ground height priority:
    //   1. result.groundHeightMeters — derived from the ignition pick, a real
    //      Cartesian3 on the actual rendered surface (scene.pickPosition).
    //   2. scene.sampleHeight at the field centre, secondary only.
    //   3. NO height available -> skip the build entirely and say so.
    // Never default to 0: that is the WGS84 ellipsoid, which sits ~100 m
    // under real terrain in most places. A 40 m box placed there is fully
    // buried, the depth clamp collapses t1 below t0, and every pixel silently
    // returns sceneColor — total invisible failure.
    let groundHeight = Number.isFinite(result.groundHeightMeters)
      ? result.groundHeightMeters
      : null;
    if (groundHeight === null && typeof viewer.scene.sampleHeight === 'function') {
      try {
        const sampled = viewer.scene.sampleHeight(Cesium.Cartographic.fromDegrees(midLon, midLat));
        if (Number.isFinite(sampled)) groundHeight = sampled;
      } catch { /* no pickable surface yet */ }
    }
    if (groundHeight === null) {
      console.error('[volumetricFire] no ground height available (pick and sampleHeight both failed) — skipping volume build rather than burying the box at the ellipsoid');
      return;
    }
    console.info('[volumetricFire] build · groundHeight', groundHeight.toFixed(1), 'm ·',
      Number.isFinite(result.groundHeightMeters) ? 'from ignition pick' : 'from sampleHeight');

    // Relief-aware box: base at the LOWEST cell, top clearing the HIGHEST
    // cell plus flame height. A fixed 40 m box centred on one height sliced
    // through hillsides.
    const heights = Array.isArray(result.terrainHeights) || ArrayBuffer.isView(result.terrainHeights)
      ? Array.from(result.terrainHeights).filter(Number.isFinite)
      : [];
    const groundBase = heights.length > 0 ? Math.min(...heights) : groundHeight;
    const groundTop = heights.length > 0 ? Math.max(...heights) : groundHeight;
    groundSpan = Math.max(groundTop - groundBase, 1);

    const halfEast = Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromDegrees(west, midLat, groundBase),
      Cesium.Cartesian3.fromDegrees(east, midLat, groundBase)
    ) / 2;
    const halfNorth = Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromDegrees(midLon, south, groundBase),
      Cesium.Cartesian3.fromDegrees(midLon, north, groundBase)
    ) / 2;
    const halfUp = (groundSpan + BOX_HEIGHT_METERS) / 2;

    halfExtents = new Cesium.Cartesian3(halfEast, halfNorth, halfUp);
    centreWC = Cesium.Cartesian3.fromDegrees(midLon, midLat, groundBase + halfUp);
    enu = Cesium.Transforms.eastNorthUpToFixedFrame(centreWC);

    if (arrivalTexture && !arrivalTexture.isDestroyed()) arrivalTexture.destroy();
    arrivalTexture = new Cesium.Texture({
      context: viewer.scene.context,
      source: buildArrivalTexture({ gridSize, arrivalMinutes, terrainHeights: result.terrainHeights, groundBase, groundSpan }),
      sampler: new Cesium.Sampler({
        minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
        magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST,
        wrapS: Cesium.TextureWrap.CLAMP_TO_EDGE,
        wrapT: Cesium.TextureWrap.CLAMP_TO_EDGE
      })
    });
    active = true;

    rebuildStage();
  }

  // Debug toggle, registered here so no other file needs touching:
  //   window.__ignis.volumeDebug(true)  -> magenta box wherever rays hit
  //   window.__ignis.volumeDebug(false) -> normal fire
  if (typeof window !== 'undefined') {
    window.__ignis = window.__ignis || {};
    window.__ignis.volumeDebug = (on = true) => { debug = Boolean(on); return debug; };
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
      if (!enabled) { active = false; removeStage(); }
      return enabled;
    },
    get enabled() { return enabled; },
    clear() {
      pending = null;
      active = false;
      removeStage();
    }
  };
}
