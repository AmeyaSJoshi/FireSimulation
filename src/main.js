import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { cartesianToLatitudeLongitude, latitudeLongitudeToCartesian } from './lib/coordinateMath.js';
import { fetchElevationField, quantizeElevationCacheKey } from './lib/elevationField.js';
import { canIgniteSurface, surfaceIgnitionMessage } from './lib/ignitionPolicy.js';
import { formatLocationLabel } from './lib/locationLabel.js';
import { buildSpreadExplanation, formatCompassDirection, formatElevationRange, formatModelTime } from './lib/scenarioInterpretation.js';
import { clearScenarioRecords, compareScenarioMetrics, loadScenarioRecords, saveScenarioRecord } from './lib/scenarioRecords.js';
import { createTerrainSampler } from './lib/terrainSampler.js';
import { createCanvasImageReader, createLandCoverSource } from './lib/landCoverSource.js';
import { crosswalkLandCoverToFuel } from './lib/landCoverToFuel.js';
import './styles.css';

// ─────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────
const canvas = document.querySelector('#scene');
const loadingEl = document.querySelector('#loading');
const locationValue = document.querySelector('#location-value');
const latitudeValue = document.querySelector('#latitude-value');
const longitudeValue = document.querySelector('#longitude-value');
const panelStatus = document.querySelector('#panel-status');
const statusText = document.querySelector('#status-text');
const scenarioSelect = document.querySelector('#scenario-select');
const fuelSelect = document.querySelector('#fuel-select');
const windSpeedInput = document.querySelector('#wind-speed');
const windSpeedValue = document.querySelector('#wind-speed-value');
const windDirectionInput = document.querySelector('#wind-direction');
const windDirectionValue = document.querySelector('#wind-direction-value');
const moistureInput = document.querySelector('#moisture');
const moistureValue = document.querySelector('#moisture-value');
const slopeInput = document.querySelector('#slope-strength');
const slopeValue = document.querySelector('#slope-value');
const pauseButton = document.querySelector('#pause-button');
const resetButton = document.querySelector('#reset-button');
const simulationReadout = document.querySelector('#simulation-readout');
const simulationNote = document.querySelector('.simulation-note');
const footprintValue = document.querySelector('#footprint-value');
const perimeterValue = document.querySelector('#perimeter-value');
const scaleValue = document.querySelector('#scale-value');
const modelTimeValue = document.querySelector('#model-time-value');
const burnedAreaValue = document.querySelector('#burned-area-value');
const maxSpreadValue = document.querySelector('#max-spread-value');
const spreadRateValue = document.querySelector('#spread-rate-value');
const modelValue = document.querySelector('#model-value');
const terrainValue = document.querySelector('#terrain-value');
const elevationValue = document.querySelector('#elevation-value');
const fuelBasisValue = document.querySelector('#fuel-basis-value');
const windBasisValue = document.querySelector('#wind-basis-value');
const moistureBasisValue = document.querySelector('#moisture-basis-value');
const slopeBasisValue = document.querySelector('#slope-basis-value');
const seedValue = document.querySelector('#seed-value');
const metadataState = document.querySelector('#metadata-state');
const interpretationText = document.querySelector('#interpretation-text');
const directionValue = document.querySelector('#direction-value');
const guideScale = document.querySelector('#guide-scale');
const clearHistoryButton = document.querySelector('#clear-history-button');
const runHistoryList = document.querySelector('#run-history-list');

const FIRE_GRID_SIZE = 128;
const FIRE_CELL_SIZE_KM = 1;
const FIRE_FIELD_DIAMETER_KM = FIRE_GRID_SIZE * FIRE_CELL_SIZE_KM;
const FIRE_DISPLAY_SCALE = 6;
const MODEL_TIMESTEP_MINUTES = 1;
const SIMULATION_SEED = 17;
// Phase 1 feature flag: which simulation engine the worker should run.
// 'legacy'   = the incumbent cellular model in fireSimulation.js.
// 'phase1'   = present for wiring; still delegates to the legacy model
//              (no behavior change until Phase 3 introduces real physics).
const SIMULATION_ENGINE = 'legacy';
const EARTH_RADIUS_KM = 6371;
const SCENARIO_PRESETS = {
  calm: { scenario: 'calm', windSpeed: 0, windDirection: 0, moisture: 32, slope: 0 },
  wind: { scenario: 'calm', windSpeed: 45, windDirection: 45, moisture: 24, slope: 10 },
  slope: { scenario: 'slope', windSpeed: 0, windDirection: 0, moisture: 30, slope: 100 },
  barrier: { scenario: 'barrier', windSpeed: 0, windDirection: 0, moisture: 28, slope: 0 }
};

// ─────────────────────────────────────────────────────────────
// Renderer & scene
// ─────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 20000);
camera.position.set(0, 0, 4);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

// Post-processing: subtle bloom lifts the ember and star cores without
// crushing the earth into a smear of light.
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.42, // strength
  0.35, // radius — narrow so the atmosphere rim stays a rim
  0.88  // threshold — only the ember + star cores clear it
);
const outputPass = new OutputPass();
composer.addPass(renderPass);
composer.addPass(bloomPass);
composer.addPass(outputPass);

// ─────────────────────────────────────────────────────────────
// Sun & lighting (used both for the shader and for MeshStandard-friendly fallbacks)
// ─────────────────────────────────────────────────────────────
const SUN_DIRECTION = new THREE.Vector3(0.55, 0.35, 0.75).normalize();

// A trace of ambient so nothing goes to absolute zero — the shader owns the
// real day/night look; this only affects any incidental non-shader material.
scene.add(new THREE.AmbientLight(0xffffff, 0.05));
const sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
sunLight.position.copy(SUN_DIRECTION.clone().multiplyScalar(10));
scene.add(sunLight);

// ─────────────────────────────────────────────────────────────
// Groups
// ─────────────────────────────────────────────────────────────
const globeMeshes = [];
const earthSpinGroup = new THREE.Group();
scene.add(earthSpinGroup);
let earthModel = null;
let atmosphereMesh = null;
let earthMaterial = null;
let earthRadius = null;

const fireWorker = new Worker(new URL('./workers/fireWorker.js', import.meta.url), { type: 'module' });
let fireOverlay = null;
let fireTexture = null;
let fireMaterial = null;
let fireRunId = 0;
let terrainRequestId = 0;
let fireRunning = false;
let firePaused = false;
const terrainCache = new Map();
const TERRAIN_CACHE_LIMIT = 12;
let terrainMetadataStatus = 'Awaiting land';
let terrainMetadataHeights = null;
let lastLandCover = null;
let lastFuelDecision = null;
let scenarioRecords = loadScenarioRecords();
let activeScenarioContext = null;

// ─────────────────────────────────────────────────────────────
// Starfield — procedural, spherical distribution, gentle twinkle
// ─────────────────────────────────────────────────────────────
function createStarfield(count = 4200, radius = 900) {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const brightness = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    // Uniform spherical distribution
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = radius * (0.85 + Math.random() * 0.15);
    positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    // Weighted so the vast majority are small; a few are noticeably bright
    const rank = Math.pow(Math.random(), 4);
    sizes[i] = 1.4 + rank * 5.6;
    brightness[i] = 0.35 + Math.pow(Math.random(), 2.2) * 0.65;
    phases[i] = Math.random() * Math.PI * 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aBrightness', new THREE.BufferAttribute(brightness, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() }
    },
    vertexShader: /* glsl */`
      attribute float aSize;
      attribute float aPhase;
      attribute float aBrightness;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vTwinkle;
      varying float vBrightness;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        // Slow, per-star sinusoidal twinkle
        vTwinkle = 0.65 + 0.35 * sin(uTime * 1.1 + aPhase);
        vBrightness = aBrightness;
        gl_PointSize = aSize * uPixelRatio * (240.0 / -mvPosition.z) * (0.75 + 0.25 * vTwinkle);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */`
      varying float vTwinkle;
      varying float vBrightness;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = length(c);
        if (d > 0.5) discard;
        // Soft disc with a hot core
        float a = smoothstep(0.5, 0.0, d);
        float core = smoothstep(0.18, 0.0, d) * 0.6;
        float alpha = (a * (0.45 + 0.55 * vTwinkle) + core) * vBrightness;
        // Slight warm cream so stars don't read as pure white
        vec3 color = vec3(1.0, 0.965, 0.9);
        gl_FragColor = vec4(color, alpha);
      }
    `
  });

  return new THREE.Points(geometry, material);
}

const starfield = createStarfield();
starfield.frustumCulled = false;
scene.add(starfield);

// ─────────────────────────────────────────────────────────────
// Atmospheric halo — fresnel rim, breathes almost imperceptibly
// ─────────────────────────────────────────────────────────────
function createAtmosphere(radius) {
  const geometry = new THREE.SphereGeometry(radius * 1.025, 96, 96);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uSunDirection: { value: SUN_DIRECTION.clone() },
      uColor: { value: new THREE.Color(0x6fa8ff) },
      uWarmColor: { value: new THREE.Color(0xff9a4f) },
      uIntensity: { value: 0.65 }
    },
    vertexShader: /* glsl */`
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      uniform vec3 uSunDirection;
      uniform vec3 uColor;
      uniform vec3 uWarmColor;
      uniform float uIntensity;
      uniform float uTime;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        vec3 n = -vWorldNormal;
        // Tight fresnel — rim only, no fill
        float rim = pow(1.0 - max(dot(viewDir, n), 0.0), 4.5);
        // Sun-facing rim is brighter; back side keeps a slight wisp
        float sunFacing = clamp(dot(n, uSunDirection) * 0.5 + 0.5, 0.0, 1.0);
        float dayGlow = mix(0.28, 1.0, pow(sunFacing, 1.4));
        // Narrow twilight warmth right at the terminator
        float terminator = exp(-pow((sunFacing - 0.5) * 6.5, 2.0));
        vec3 col = mix(uColor, uWarmColor, terminator * 0.65);
        float breathe = 0.95 + 0.05 * sin(uTime * 0.35);
        float alpha = rim * dayGlow * uIntensity * breathe;
        gl_FragColor = vec4(col, 1.0) * alpha;
      }
    `
  });

  return new THREE.Mesh(geometry, material);
}

// ─────────────────────────────────────────────────────────────
// Earth material — custom shader with day/night terminator
// ─────────────────────────────────────────────────────────────
function createEarthMaterial(dayMap) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uDayMap: { value: dayMap },
      uSunDirection: { value: SUN_DIRECTION.clone() },
      uNightTint: { value: new THREE.Color(0x0b1c3a) },       // cold blue night
      uTwilightTint: { value: new THREE.Color(0xff8438) },    // warm terminator glow
      uNightBrightness: { value: 0.04 }
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      void main() {
        vUv = uv;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uDayMap;
      uniform vec3 uSunDirection;
      uniform vec3 uNightTint;
      uniform vec3 uTwilightTint;
      uniform float uNightBrightness;
      varying vec2 vUv;
      varying vec3 vWorldNormal;

      // Manual sRGB → linear so the texture matches the rest of the pipeline
      vec3 srgbToLinear(vec3 c) {
        return pow(c, vec3(2.2));
      }

      void main() {
        vec3 dayLinear = srgbToLinear(texture2D(uDayMap, vUv).rgb);
        float sun = dot(normalize(vWorldNormal), uSunDirection);

        // Soft day/night blend
        float dayAmount = smoothstep(-0.06, 0.18, sun);

        // Lit day: gentle Lambertian falloff so the terminator side is dimmer
        float lightAmount = 0.55 + 0.9 * clamp(sun, 0.0, 1.0);
        vec3 dayLit = dayLinear * lightAmount * 2.1;

        // Night side: mostly the cold night tint plus a hint of the map
        vec3 night = uNightTint * 0.9 + dayLinear * uNightBrightness;

        // Narrow terminator warmth — a soft crescent, not a band
        float terminator = exp(-pow(sun * 14.0, 2.0));
        vec3 warmth = uTwilightTint * terminator * 0.14;

        vec3 color = mix(night, dayLit, dayAmount) + warmth;
        gl_FragColor = vec4(color, 1.0);
      }
    `
  });
}

// ─────────────────────────────────────────────────────────────
// Ember marker + radar ping — the "ignition point"
// ─────────────────────────────────────────────────────────────
function createEmberTexture(colorInner, colorOuter) {
  const size = 128;
  const canvasEl = document.createElement('canvas');
  canvasEl.width = size;
  canvasEl.height = size;
  const ctx = canvasEl.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0.0, colorInner);
  gradient.addColorStop(0.35, colorOuter);
  gradient.addColorStop(1.0, 'rgba(255, 140, 40, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvasEl);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const emberCoreTexture = createEmberTexture('rgba(255, 240, 205, 1)', 'rgba(255, 165, 60, 0.9)');
const emberGlowTexture = createEmberTexture('rgba(255, 180, 90, 0.8)', 'rgba(255, 100, 20, 0.35)');

let markerGroup = null;
let markerSurfacePoint = new THREE.Vector3();
const activePings = [];

function ensureMarker() {
  if (markerGroup) return markerGroup;

  markerGroup = new THREE.Group();
  markerGroup.renderOrder = 10;

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: emberGlowTexture,
    color: 0xffffff,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 1
  }));
  glow.userData.role = 'glow';
  glow.userData.baseScale = 1.0;
  markerGroup.add(glow);

  const core = new THREE.Sprite(new THREE.SpriteMaterial({
    map: emberCoreTexture,
    color: 0xffffff,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 1
  }));
  core.userData.role = 'core';
  core.userData.baseScale = 0.32;
  markerGroup.add(core);

  earthSpinGroup.add(markerGroup);
  return markerGroup;
}

function launchPingRing() {
  if (!markerGroup) return;
  const geometry = new THREE.RingGeometry(0.62, 0.72, 96);
  const material = new THREE.MeshBasicMaterial({
    color: 0xffa14b,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    opacity: 1
  });
  const ring = new THREE.Mesh(geometry, material);
  ring.renderOrder = 11;
  ring.userData.role = 'ping';
  ring.userData.startTime = performance.now();
  ring.userData.lifetime = 1400;
  ring.userData.baseScale = 1;
  markerGroup.add(ring);
  activePings.push(ring);
}

function updatePings(now) {
  for (let i = activePings.length - 1; i >= 0; i -= 1) {
    const ring = activePings[i];
    const t = (now - ring.userData.startTime) / ring.userData.lifetime;
    if (t >= 1) {
      markerGroup?.remove(ring);
      ring.geometry.dispose();
      ring.material.dispose();
      activePings.splice(i, 1);
      continue;
    }
    // Exponential ease-out expansion, opacity fades faster
    const eased = 1 - Math.pow(1 - t, 3);
    const scale = 1 + eased * 4.5;
    ring.userData.baseScale = scale;
    ring.material.opacity = (1 - t) * (1 - t) * 0.9;
  }
}

// ─────────────────────────────────────────────────────────────
// Camera controls & interaction state
// ─────────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enableRotate = false;
controls.enablePan = false;
controls.zoomToCursor = false;
let referenceCameraDistance = camera.position.distanceTo(controls.target);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDown = null;
let isDraggingEarth = false;
let suppressNextClick = false;
let pointerOverCanvas = false;
let resumeRotationWhileHovered = false;
const earthClock = new THREE.Clock();
const AUTO_ROTATION_SPEED = 0.075;
const manualAngularVelocity = new THREE.Vector2();

// ─────────────────────────────────────────────────────────────
// Texture & model load
// ─────────────────────────────────────────────────────────────
const dayTexture = new THREE.TextureLoader().load('/earth/textures/1_earth_8k.jpg', () => {
  loadingEl?.classList.add('is-map-ready');
});
dayTexture.colorSpace = THREE.SRGBColorSpace;
dayTexture.flipY = true;
dayTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
dayTexture.wrapS = THREE.RepeatWrapping;
dayTexture.wrapT = THREE.ClampToEdgeWrapping;

// Ground truth for land/ocean classification: reads the same texture pixels
// being rendered, so a click can never be told it's ocean when the visible
// pixel is land (or vice versa). Loads in parallel with the FBX model.
let terrainSampler = null;
createTerrainSampler('/earth/textures/1_earth_8k.jpg')
  .then((sampler) => { terrainSampler = sampler; })
  .catch((error) => console.error('[terrain] sampler failed to load:', error));

// Phase 2 land-cover source. The preprocessed WorldCover mosaic PNG lives
// in public/ alongside its metadata sidecar. If either is missing (e.g.
// preprocessing script has not been run in this workspace), the source
// stays null and every classify call returns null — the crosswalk then
// gracefully falls back to an experimental-confidence default.
let landCoverSource = null;
async function loadLandCoverSource() {
  try {
    const [meta, image] = await Promise.all([
      fetch('/landcover-coarse.json').then((r) => r.ok ? r.json() : null),
      loadImageElement('/landcover-coarse.png')
    ]);
    if (!meta || !image) return;
    landCoverSource = await createLandCoverSource({
      pngUrl: '/landcover-coarse.png',
      meta,
      imageReader: async () => createCanvasImageReader(image)
    });
    console.info('[landcover] loaded', meta.source, meta.mosaic);
  } catch (error) {
    console.warn('[landcover] source unavailable, falling back to experimental crosswalk:', error);
  }
}
function loadImageElement(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}
loadLandCoverSource();

const fbxLoader = new FBXLoader();
fbxLoader.load(
  '/earth/source/Earth.fbx',
  (model) => {
    earthModel = model;
    earthMaterial = createEarthMaterial(dayTexture);
    model.traverse((child) => {
      if (!child.isMesh) return;
      child.material = earthMaterial;
      child.frustumCulled = false;
      globeMeshes.push(child);
    });

    earthSpinGroup.add(model);
    frameModel(model);

    // Atmosphere: sized from the actual sphere radius (world-space, after framing)
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    // For a sphere mesh, x/y/z should be equal (or close). Use the max half-extent.
    earthRadius = Math.max(size.x, size.y, size.z) * 0.5;
    atmosphereMesh = createAtmosphere(earthRadius);
    earthSpinGroup.add(atmosphereMesh);

    if (loadingEl) {
      loadingEl.style.opacity = '0';
      setTimeout(() => loadingEl.remove(), 320);
    }
  },
  (event) => {
    if (event.total > 0 && loadingEl) {
      const pct = Math.round((event.loaded / event.total) * 100);
      loadingEl.textContent = `Loading terrain · ${pct}%`;
    }
  },
  () => {
    if (loadingEl) loadingEl.textContent = 'Terrain load failed';
  }
);

// ─────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────
function handleGlobeClick(event) {
  if (globeMeshes.length === 0) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const [hit] = raycaster.intersectObjects(globeMeshes, true);
  if (!hit) return;

  const localHitPoint = earthSpinGroup.worldToLocal(hit.point.clone());
  const coordinates = cartesianToLatitudeLongitude(localHitPoint);
  // hit.uv is the exact texture coordinate the fragment shader used to
  // paint this pixel — reading it here ties the land/ocean call directly
  // to what's on screen, with zero risk of drifting from a separate
  // lat/lng-based recomputation.
  const isOcean = terrainSampler && hit.uv
    ? terrainSampler.isOceanAtUv(hit.uv.x, hit.uv.y)
    : null;

  updateConditionPanel(coordinates, isOcean);

  if (!canIgniteSurface(isOcean)) {
    resetFireSimulation();
    if (markerGroup) markerGroup.visible = false;
    panelStatus.dataset.mode = 'blocked';
    statusText.textContent = surfaceIgnitionMessage(isOcean);
    simulationReadout.textContent = isOcean === true
      ? 'Select a land surface to ignite'
      : 'Surface classification unavailable · try again';
    simulationNote.textContent = isOcean === true
      ? 'Ocean surface · fire ignition disabled'
      : 'Surface classification required before ignition';
    setTerrainMetadata(isOcean === true ? 'Ocean · no ignition' : 'Surface unknown');
    return;
  }

  // Phase 2: classify land cover for the crosswalk. Always runs (cheap,
  // in-memory), even under the legacy engine — the info surfaces in the
  // scenario-basis metadata so users can see what the phase1 engine
  // will consume when it's turned on. Legacy sim math is unchanged.
  const landCover = landCoverSource
    ? landCoverSource.classifyAtLatLon(coordinates.latitude, coordinates.longitude)
    : null;
  const fuelDecision = crosswalkLandCoverToFuel(landCover);
  lastLandCover = landCover;
  lastFuelDecision = fuelDecision;
  console.info('[landcover]',
    landCover ? `${landCover.className} (WC ${landCover.classCode})` : 'no coverage',
    `→ ${fuelDecision.fuelCode} (${fuelDecision.confidence})`);

  placeMarker(localHitPoint);
  startFireSimulation(coordinates);
}

function updateConditionPanel(coordinates, isOcean) {
  locationValue.textContent = formatLocationLabel(coordinates.latitude, coordinates.longitude, isOcean);
  latitudeValue.textContent = formatCoord(coordinates.latitude, 'lat');
  longitudeValue.textContent = formatCoord(coordinates.longitude, 'lon');
  latitudeValue.classList.remove('placeholder');
  longitudeValue.classList.remove('placeholder');
  panelStatus.dataset.mode = 'armed';
  statusText.textContent = 'Location armed · ignition ready';
}

function formatCoord(value, axis) {
  const hemisphere = axis === 'lat'
    ? (value >= 0 ? 'N' : 'S')
    : (value >= 0 ? 'E' : 'W');
  const magnitude = Math.abs(value);
  const degrees = Math.floor(magnitude);
  const minutes = (magnitude - degrees) * 60;
  return `${degrees.toString().padStart(axis === 'lat' ? 2 : 3, '0')}° ${minutes.toFixed(3).padStart(6, '0')}′ ${hemisphere}`;
}

function placeMarker(point) {
  ensureMarker();
  markerSurfacePoint.copy(point);
  markerGroup.position.copy(point.clone().normalize().multiplyScalar(point.length() * 1.002));
  markerGroup.userData.placedAt = performance.now();
  updateMarker();
  launchPingRing();
}

function updateMarker() {
  if (!markerGroup) return;
  earthSpinGroup.updateMatrixWorld(true);

  const cameraDistance = camera.position.length();
  const zoomRatio = cameraDistance / referenceCameraDistance;
  const zoomScale = THREE.MathUtils.clamp(Math.pow(zoomRatio, 1.2), 0.4, 4.2);
  const surfaceRadius = markerSurfacePoint.length();
  const worldScale = surfaceRadius * 0.028 * zoomScale;

  // Ember breathing
  const time = performance.now() * 0.001;
  const breathe = 0.85 + 0.15 * Math.sin(time * 2.1);

  markerGroup.children.forEach((child) => {
    if (child.userData.role === 'glow') {
      const s = worldScale * 2.6 * breathe;
      child.scale.set(s, s, 1);
      child.material.opacity = 0.85 * (0.75 + 0.25 * breathe);
    } else if (child.userData.role === 'core') {
      const s = worldScale * 0.55 * (0.9 + 0.1 * breathe);
      child.scale.set(s, s, 1);
    } else if (child.userData.role === 'ping') {
      const s = worldScale * 1.4 * (child.userData.baseScale ?? 1);
      child.scale.set(s, s, 1);
      // Orient the ping flat against the sphere surface
      const outward = markerSurfacePoint.clone().normalize();
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward);
      child.quaternion.copy(quat);
    }
  });

  // Face the camera (sprites do this automatically; this handles the ring group)
  const markerWorldPosition = markerGroup.getWorldPosition(new THREE.Vector3());
  const outward = markerSurfacePoint.clone()
    .normalize()
    .transformDirection(earthSpinGroup.matrixWorld);
  const towardCamera = camera.position.clone().sub(markerWorldPosition).normalize();
  // Hide when facing away, with a small tolerance for the ping halo
  markerGroup.visible = outward.dot(towardCamera) > -0.08;
}

function createFireOverlay(surfacePoint, radius) {
  if (fireOverlay) {
    earthSpinGroup.remove(fireOverlay);
    fireOverlay.geometry.dispose();
    fireOverlay.material.dispose();
  }
  fireTexture?.dispose();

  const segments = 72;
  const patchRadius = radius * (FIRE_FIELD_DIAMETER_KM / (2 * EARTH_RADIUS_KM)) * FIRE_DISPLAY_SCALE;
  const normal = surfacePoint.clone().normalize();
  const reference = Math.abs(normal.y) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const east = new THREE.Vector3().crossVectors(reference, normal).normalize();
  const north = new THREE.Vector3().crossVectors(normal, east).normalize();
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let y = 0; y <= segments; y += 1) {
    for (let x = 0; x <= segments; x += 1) {
      const offsetX = (x / segments - 0.5) * patchRadius * 2;
      const offsetY = (y / segments - 0.5) * patchRadius * 2;
      const distance = Math.hypot(offsetX, offsetY);
      const tangent = new THREE.Vector3()
        .addScaledVector(east, offsetX)
        .addScaledVector(north, offsetY);
      const direction = distance > 0 ? tangent.normalize() : east;
      const angle = distance / radius;
      const point = normal.clone()
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(direction, Math.sin(angle))
        .multiplyScalar(radius * 1.006);
      positions.push(point.x, point.y, point.z);
      uvs.push(x / segments, 1 - y / segments);
    }
  }

  for (let y = 0; y < segments; y += 1) {
    for (let x = 0; x < segments; x += 1) {
      const row = segments + 1;
      const a = y * row + x;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  fireTexture = new THREE.DataTexture(
    new Uint8Array(FIRE_GRID_SIZE * FIRE_GRID_SIZE * 4),
    FIRE_GRID_SIZE,
    FIRE_GRID_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  fireTexture.minFilter = THREE.LinearFilter;
  fireTexture.magFilter = THREE.LinearFilter;
  fireTexture.wrapS = THREE.ClampToEdgeWrapping;
  fireTexture.wrapT = THREE.ClampToEdgeWrapping;
  fireTexture.needsUpdate = true;

  fireMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uFireMap: { value: fireTexture },
      uTime: { value: 0 }
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      varying vec3 vWorldPosition;
      void main() {
        vUv = uv;
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uFireMap;
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vWorldPosition;
      void main() {
        vec4 fire = texture2D(uFireMap, vUv);
        vec2 texel = vec2(1.0 / 128.0);
        float neighborAlpha = min(
          min(texture2D(uFireMap, vUv + vec2(texel.x, 0.0)).a, texture2D(uFireMap, vUv - vec2(texel.x, 0.0)).a),
          min(texture2D(uFireMap, vUv + vec2(0.0, texel.y)).a, texture2D(uFireMap, vUv - vec2(0.0, texel.y)).a)
        );
        float perimeter = smoothstep(0.04, 0.22, fire.a) * (1.0 - smoothstep(0.03, 0.2, neighborAlpha));
        float pulse = 0.92 + 0.08 * sin(uTime * 5.5 + vUv.x * 12.0 + vUv.y * 8.0);
        float edgeFade = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x)
          * smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.92, vUv.y);
        vec3 perimeterColor = vec3(1.0, 0.56, 0.08);
        vec3 color = mix(fire.rgb, perimeterColor, perimeter * 0.72);
        float alpha = max(fire.a, perimeter * 0.8);
        gl_FragColor = vec4(color * pulse * 1.25, alpha * pulse * edgeFade);
      }
    `
  });

  fireOverlay = new THREE.Mesh(geometry, fireMaterial);
  fireOverlay.renderOrder = 8;
  earthSpinGroup.add(fireOverlay);
  return fireOverlay;
}

function getSimulationParams() {
  return {
    fuelPreset: fuelSelect.value,
    windSpeed: Number(windSpeedInput.value),
    windDirection: Number(windDirectionInput.value),
    moisture: Number(moistureInput.value) / 100,
    slopeStrength: Number(slopeInput.value) / 100
  };
}

function getScenarioConfig() {
  return SCENARIO_PRESETS[scenarioSelect.value] ?? SCENARIO_PRESETS.calm;
}

function applyScenarioPreset() {
  const preset = getScenarioConfig();
  windSpeedInput.value = String(preset.windSpeed);
  windDirectionInput.value = String(preset.windDirection);
  moistureInput.value = String(preset.moisture);
  slopeInput.value = String(preset.slope);
  updateSimulationLabels();
  if (fireRunning) {
    fireWorker.postMessage({
      type: 'update',
      scenario: preset.scenario,
      params: getSimulationParams()
    });
    simulationReadout.textContent = 'Scenario updated · recalculating field';
  }
}

function updateSimulationLabels() {
  windSpeedValue.textContent = `${windSpeedInput.value} km/h`;
  windDirectionValue.textContent = `${windDirectionInput.value.padStart(3, '0')}°`;
  moistureValue.textContent = `${moistureInput.value}%`;
  slopeValue.textContent = `${slopeInput.value}%`;
  updateScenarioMetadata();
}

function setTerrainMetadata(status, heights = null) {
  terrainMetadataStatus = status;
  terrainMetadataHeights = heights;
  updateScenarioMetadata();
}

function updateScenarioMetadata() {
  const fuelLabel = fuelSelect.selectedOptions[0]?.textContent ?? fuelSelect.value;
  const windDirection = windDirectionInput.value.padStart(3, '0');
  modelValue.textContent = `Cellular · ${SIMULATION_ENGINE} · ${MODEL_TIMESTEP_MINUTES} min/tick`;
  terrainValue.textContent = terrainMetadataStatus;
  elevationValue.textContent = formatElevationRange(terrainMetadataHeights);
  fuelBasisValue.textContent = formatFuelBasisLabel(fuelLabel);
  windBasisValue.textContent = `${windDirection}° · ${windSpeedInput.value} km/h`;
  moistureBasisValue.textContent = `${moistureInput.value}%`;
  slopeBasisValue.textContent = `${slopeInput.value}%`;
  scaleValue.textContent = `${FIRE_CELL_SIZE_KM} km cells · ${FIRE_FIELD_DIAMETER_KM} km field`;
  seedValue.textContent = String(SIMULATION_SEED);
  metadataState.textContent = terrainMetadataStatus;
  guideScale.textContent = `${FIRE_FIELD_DIAMETER_KM} km field`;
}

// Composite the legacy sim's fuel selection with the Phase 2 WorldCover
// crosswalk. Both are shown so a reader can tell which one the current
// engine is using (legacy → the dropdown) and what the phase1 engine
// will consume (the crosswalked fuel) once flipped.
function formatFuelBasisLabel(legacyDropdownLabel) {
  if (!lastFuelDecision) return legacyDropdownLabel;
  const confidence = lastFuelDecision.confidence;
  const wcName = lastLandCover?.className ?? 'unavailable';
  return `${legacyDropdownLabel} · WC ${wcName} → ${lastFuelDecision.fuelCode} (${confidence})`;
}

function formatSignedMetric(value, unit) {
  const rounded = Math.round(Number(value) || 0);
  if (rounded === 0) return '— vs prior';
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toLocaleString()} ${unit} vs prior`;
}

function createHistoryMetric(label, value) {
  const wrapper = document.createElement('span');
  wrapper.className = 'history-metric';
  const labelEl = document.createElement('small');
  labelEl.textContent = label;
  const valueEl = document.createElement('strong');
  valueEl.textContent = value;
  wrapper.append(labelEl, valueEl);
  return wrapper;
}

function renderScenarioHistory() {
  if (!runHistoryList) return;
  runHistoryList.replaceChildren();
  if (scenarioRecords.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'Complete a run to save it here.';
    runHistoryList.append(empty);
    return;
  }

  scenarioRecords.forEach((record, index) => {
    const card = document.createElement('article');
    card.className = 'history-card';
    const header = document.createElement('div');
    header.className = 'history-card-header';
    const title = document.createElement('strong');
    title.textContent = record.location || 'Saved ignition';
    const replay = document.createElement('button');
    replay.type = 'button';
    replay.className = 'history-replay';
    replay.dataset.runId = record.id;
    replay.setAttribute('aria-label', `Replay ${record.location || 'saved ignition'}`);
    replay.textContent = 'Replay';
    header.append(title, replay);
    const basis = document.createElement('span');
    basis.className = 'history-basis';
    basis.textContent = `${record.scenarioLabel || 'Custom'} · ${record.terrain || 'Terrain unavailable'} · seed ${record.seed ?? SIMULATION_SEED}`;
    const metrics = document.createElement('div');
    metrics.className = 'history-metrics';
    const data = record.metrics || {};
    metrics.append(
      createHistoryMetric('Burned', `${Math.round(data.burnedAreaKm2 ?? 0).toLocaleString()} km²`),
      createHistoryMetric('Time', formatModelTime(data.elapsedMinutes ?? 0)),
      createHistoryMetric('Spread', `${Number(data.maxSpreadDistanceKm ?? 0).toFixed(1)} km`)
    );
    card.append(header, basis, metrics);
    if (scenarioRecords[index + 1]) {
      const delta = compareScenarioMetrics(scenarioRecords[index + 1].metrics, data);
      const deltaLine = document.createElement('span');
      deltaLine.className = 'history-delta';
      deltaLine.textContent = formatSignedMetric(delta.burnedAreaKm2, 'km² burned');
      card.append(deltaLine);
    }
    runHistoryList.append(card);
  });
}

function recordSettledScenario(metrics) {
  if (!activeScenarioContext || activeScenarioContext.recorded) return;
  activeScenarioContext.recorded = true;
  const record = {
    id: `run-${Date.now()}-${fireRunId}`,
    createdAt: Date.now(),
    location: activeScenarioContext.location,
    coordinates: activeScenarioContext.coordinates,
    scenario: scenarioSelect.value,
    scenarioLabel: scenarioSelect.selectedOptions[0]?.textContent ?? scenarioSelect.value,
    params: getSimulationParams(),
    terrain: terrainMetadataStatus,
    elevationRange: formatElevationRange(terrainMetadataHeights),
    seed: SIMULATION_SEED,
    metrics: {
      burnedAreaKm2: metrics.burnedAreaKm2 ?? 0,
      footprintAreaKm2: metrics.footprintAreaKm2 ?? 0,
      perimeterKm: metrics.perimeterKm ?? 0,
      maxSpreadDistanceKm: metrics.maxSpreadDistanceKm ?? 0,
      averageSpreadRateKmh: metrics.averageSpreadRateKmh ?? 0,
      elapsedMinutes: metrics.elapsedMinutes ?? 0,
      dominantSpreadDirectionDeg: metrics.dominantSpreadDirectionDeg ?? 0
    }
  };
  scenarioRecords = saveScenarioRecord(undefined, record);
  renderScenarioHistory();
}

function replayScenario(record) {
  if (!earthRadius || !record?.coordinates) return;
  const params = record.params ?? {};
  scenarioSelect.value = record.scenario ?? 'calm';
  fuelSelect.value = params.fuelPreset ?? 'brush';
  windSpeedInput.value = String(params.windSpeed ?? 0);
  windDirectionInput.value = String(params.windDirection ?? 0);
  moistureInput.value = String(Math.round((params.moisture ?? 0) * 100));
  slopeInput.value = String(Math.round((params.slopeStrength ?? 0) * 100));
  updateSimulationLabels();
  const point = latitudeLongitudeToCartesian({ ...record.coordinates, radius: earthRadius });
  const localPoint = new THREE.Vector3(point.x, point.y, point.z);
  updateConditionPanel(record.coordinates, false);
  placeMarker(localPoint);
  startFireSimulation(record.coordinates);
}

async function startFireSimulation(coordinates) {
  if (!earthRadius || !markerSurfacePoint.length()) return;
  const requestId = ++terrainRequestId;
  fireRunId += 1;
  createFireOverlay(markerSurfacePoint, earthRadius);
  fireRunning = true;
  firePaused = false;
  activeScenarioContext = {
    coordinates: { latitude: coordinates.latitude, longitude: coordinates.longitude },
    location: locationValue.textContent,
    recorded: false
  };
  pauseButton.disabled = false;
  resetButton.disabled = false;
  pauseButton.textContent = 'Pause';
  pauseButton.setAttribute('aria-label', 'Pause simulation');
  panelStatus.dataset.mode = 'running';
  statusText.textContent = 'Loading terrain · local elevation';
  simulationReadout.textContent = 'Loading terrain field · preparing fire grid';
  modelTimeValue.textContent = '0 min';
  burnedAreaValue.textContent = '0 km²';
  footprintValue.textContent = '0 km²';
  perimeterValue.textContent = '0 km';
  maxSpreadValue.textContent = '0 km';
  spreadRateValue.textContent = '0 km/h';
  interpretationText.textContent = 'Preparing terrain and ignition field';
  directionValue.textContent = 'Spread direction · —';
  setTerrainMetadata('Loading GLO-90');
  const scenarioConfig = getScenarioConfig();
  const cacheKey = quantizeElevationCacheKey(
    coordinates.latitude,
    coordinates.longitude,
    FIRE_FIELD_DIAMETER_KM
  );
  const cacheEntry = terrainCache.get(cacheKey);
  let terrainHeights = cacheEntry?.heights?.slice() ?? null;
  if (terrainHeights) {
    simulationNote.textContent = `Cached GLO-90 terrain · ${FIRE_FIELD_DIAMETER_KM} km field · overlay ×${FIRE_DISPLAY_SCALE}`;
    setTerrainMetadata('Cached GLO-90', terrainHeights);
  } else {
    try {
      const terrain = await fetchElevationField({
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        targetSize: FIRE_GRID_SIZE,
        spanKm: FIRE_FIELD_DIAMETER_KM
      });
      if (requestId !== terrainRequestId) return;
      terrainHeights = terrain.heights;
      // Cache stores provenance alongside the height buffer so Phase 2
      // freshness policy can consult { fetchedAt, source } without a re-fetch.
      terrainCache.set(cacheKey, {
        heights: terrainHeights.slice(),
        fetchedAt: terrain.fetchedAt,
        source: terrain.source
      });
      while (terrainCache.size > TERRAIN_CACHE_LIMIT) terrainCache.delete(terrainCache.keys().next().value);
      simulationNote.textContent = `GLO-90 terrain loaded · ${FIRE_FIELD_DIAMETER_KM} km field · overlay ×${FIRE_DISPLAY_SCALE}`;
      setTerrainMetadata('GLO-90 loaded', terrainHeights);
    } catch (error) {
      if (requestId !== terrainRequestId) return;
      console.warn('[terrain] elevation unavailable, using synthetic fallback:', error);
      simulationNote.textContent = 'Terrain unavailable · synthetic fallback active';
      setTerrainMetadata('Synthetic fallback');
    }
  }

  if (requestId !== terrainRequestId) return;
  const transferredHeights = terrainHeights?.slice() ?? null;
  const message = {
    type: 'start',
    config: {
      runId: fireRunId,
      engine: SIMULATION_ENGINE,
      size: FIRE_GRID_SIZE,
      cellSizeKm: FIRE_CELL_SIZE_KM,
      seed: SIMULATION_SEED,
      scenario: scenarioConfig.scenario,
      params: getSimulationParams(),
      speed: 1,
      timestepMinutes: MODEL_TIMESTEP_MINUTES,
      ignition: { x: 64, y: 64 },
      terrainHeights: transferredHeights
    }
  };
  if (terrainHeights) fireWorker.postMessage(message, [terrainHeights.buffer]);
  else fireWorker.postMessage(message);
}

function resetFireSimulation() {
  terrainRequestId += 1;
  fireRunId += 1;
  fireWorker.postMessage({ type: 'stop' });
  fireRunning = false;
  firePaused = false;
  activeScenarioContext = null;
  if (fireOverlay) fireOverlay.visible = false;
  pauseButton.disabled = true;
  pauseButton.textContent = 'Pause';
  pauseButton.setAttribute('aria-label', 'Pause simulation');
  resetButton.disabled = true;
  panelStatus.dataset.mode = 'armed';
  statusText.textContent = 'Location armed · ignition ready';
  simulationReadout.textContent = 'Click the globe to ignite a local scenario';
  modelTimeValue.textContent = '—';
  burnedAreaValue.textContent = '—';
  footprintValue.textContent = '—';
  perimeterValue.textContent = '—';
  maxSpreadValue.textContent = '—';
  spreadRateValue.textContent = '—';
  interpretationText.textContent = 'Click land to begin a scenario';
  directionValue.textContent = 'Spread direction · —';
  simulationNote.textContent = 'Synthetic educational model · 1 min/tick · terrain loads on ignition';
}

fireWorker.onmessage = ({ data }) => {
  if (data.type !== 'frame' || data.runId && data.runId !== fireRunId) return;
  if (!fireTexture || !fireMaterial) return;
  fireTexture.image.data = data.frame;
  fireTexture.needsUpdate = true;
  firePaused = data.paused;
  pauseButton.textContent = firePaused ? 'Resume' : 'Pause';
  pauseButton.setAttribute('aria-label', firePaused ? 'Resume simulation' : 'Pause simulation');
  if (data.terrainAvailable) {
    simulationNote.textContent = `GLO-90 terrain loaded · ${FIRE_FIELD_DIAMETER_KM} km field · overlay ×${FIRE_DISPLAY_SCALE}`;
  }
  const metrics = data.metrics ?? {};
  const direction = formatCompassDirection(metrics.dominantSpreadDirectionDeg ?? 0);
  const params = getSimulationParams();
  simulationReadout.textContent = `${data.stepCount.toString().padStart(3, '0')} ticks · ${formatModelTime(metrics.elapsedMinutes ?? 0)} · ${Math.round(metrics.burnedAreaKm2 ?? 0).toLocaleString()} km² burned`;
  modelTimeValue.textContent = formatModelTime(metrics.elapsedMinutes ?? 0);
  burnedAreaValue.textContent = `${Math.round(metrics.burnedAreaKm2 ?? 0).toLocaleString()} km²`;
  footprintValue.textContent = `${Math.round(metrics.footprintAreaKm2 ?? 0).toLocaleString()} km²`;
  perimeterValue.textContent = `${Math.round(metrics.perimeterKm ?? 0).toLocaleString()} km`;
  maxSpreadValue.textContent = `${(metrics.maxSpreadDistanceKm ?? 0).toFixed(1)} km`;
  spreadRateValue.textContent = `${(metrics.averageSpreadRateKmh ?? 0).toFixed(1)} km/h`;
  directionValue.textContent = `Spread direction · ${direction} · ${Math.round(metrics.dominantSpreadDirectionDeg ?? 0)}°`;
  interpretationText.textContent = buildSpreadExplanation({
    direction,
    windSpeed: params.windSpeed,
    slopeStrength: params.slopeStrength,
    moisture: params.moisture
  });
  if (firePaused) {
    panelStatus.dataset.mode = 'armed';
    statusText.textContent = 'Simulation paused · resume when ready';
  } else if (fireRunning && data.activeCount === 0 && data.stepCount > 10) {
    panelStatus.dataset.mode = 'armed';
    statusText.textContent = 'Simulation settled · click to ignite again';
    recordSettledScenario(metrics);
  } else if (fireRunning) {
    panelStatus.dataset.mode = 'running';
    statusText.textContent = 'Simulation running · local scenario';
  }
};

// ─────────────────────────────────────────────────────────────
// Camera framing
// ─────────────────────────────────────────────────────────────
function frameModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();

  model.position.sub(center);

  const distance = size / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  camera.position.set(0, 0, distance * 1.32);
  camera.near = distance / 100;
  camera.far = Math.max(distance * 100, 20000);
  camera.updateProjectionMatrix();
  referenceCameraDistance = distance * 1.32;

  controls.target.set(0, 0, 0);
  controls.update();
}

// ─────────────────────────────────────────────────────────────
// Zoom on wheel — dolly along the mouse ray
// ─────────────────────────────────────────────────────────────
function handleZoomWheel(event) {
  if (globeMeshes.length === 0) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const [hit] = raycaster.intersectObjects(globeMeshes, true);
  if (!hit) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  const zoomScale = Math.pow(0.82, Math.abs(event.deltaY * 0.01));
  const directionToHit = hit.point.clone().sub(camera.position).normalize();
  const currentDistance = camera.position.distanceTo(hit.point);
  const nextDistance = currentDistance * (event.deltaY < 0 ? zoomScale : 1 / zoomScale);
  const nextCameraPosition = hit.point.clone().addScaledVector(directionToHit, -nextDistance);
  const cameraDelta = nextCameraPosition.clone().sub(camera.position);

  camera.position.copy(nextCameraPosition);
  controls.target.add(cameraDelta);
  controls.update();
}

// ─────────────────────────────────────────────────────────────
// Animation loop
// ─────────────────────────────────────────────────────────────
function animate() {
  const deltaSeconds = Math.min(earthClock.getDelta(), 0.05);
  const now = performance.now();
  const timeSeconds = now * 0.001;

  if (earthModel && !isDraggingEarth && !pointerDown &&
      (!pointerOverCanvas || resumeRotationWhileHovered)) {
    earthSpinGroup.rotation.y += (AUTO_ROTATION_SPEED + manualAngularVelocity.y) * deltaSeconds;
    earthSpinGroup.rotation.x = THREE.MathUtils.clamp(
      earthSpinGroup.rotation.x + manualAngularVelocity.x * deltaSeconds,
      -Math.PI * 0.42,
      Math.PI * 0.42
    );
    const damping = Math.pow(0.035, deltaSeconds);
    manualAngularVelocity.multiplyScalar(damping);
  }

  // Very slow starfield parallax (gives the void a sense of depth)
  starfield.rotation.y += 0.005 * deltaSeconds;
  starfield.material.uniforms.uTime.value = timeSeconds;

  if (atmosphereMesh) {
    atmosphereMesh.material.uniforms.uTime.value = timeSeconds;
  }

  updatePings(now);
  controls.update();
  updateMarker();
  if (fireOverlay && fireMaterial) {
    fireMaterial.uniforms.uTime.value = timeSeconds;
    const fireWorldPosition = fireOverlay.getWorldPosition(new THREE.Vector3());
    const fireOutward = markerSurfacePoint.clone()
      .normalize()
      .transformDirection(earthSpinGroup.matrixWorld);
    const fireTowardCamera = camera.position.clone().sub(fireWorldPosition).normalize();
    fireOverlay.visible = fireOutward.dot(fireTowardCamera) > -0.08;
  }
  composer.render();
  requestAnimationFrame(animate);
}

// ─────────────────────────────────────────────────────────────
// Pointer / touch interaction (drag-spin the earth)
// ─────────────────────────────────────────────────────────────
function handlePointerDown(event) {
  if (event.button !== 0 || !earthModel) return;
  pointerDown = { x: event.clientX, y: event.clientY, timeStamp: event.timeStamp };
  isDraggingEarth = false;
  manualAngularVelocity.set(0, 0);
  canvas.setPointerCapture?.(event.pointerId);
}

function handlePointerMove(event) {
  if (!pointerDown || !earthModel) return;
  const deltaX = event.clientX - pointerDown.x;
  const deltaY = event.clientY - pointerDown.y;
  if (!isDraggingEarth && Math.hypot(deltaX, deltaY) < 3) return;

  isDraggingEarth = true;
  const rotationDeltaY = deltaX * 0.006;
  const rotationDeltaX = deltaY * 0.006;
  const elapsedSeconds = Math.max((event.timeStamp - pointerDown.timeStamp) / 1000, 1 / 120);
  earthSpinGroup.rotation.y += rotationDeltaY;
  earthSpinGroup.rotation.x = THREE.MathUtils.clamp(
    earthSpinGroup.rotation.x + rotationDeltaX,
    -Math.PI * 0.42,
    Math.PI * 0.42
  );
  manualAngularVelocity.y = THREE.MathUtils.clamp(rotationDeltaY / elapsedSeconds, -6, 6);
  manualAngularVelocity.x = THREE.MathUtils.clamp(rotationDeltaX / elapsedSeconds, -6, 6);
  pointerDown.x = event.clientX;
  pointerDown.y = event.clientY;
  pointerDown.timeStamp = event.timeStamp;
}

function handlePointerUp(event) {
  if (!pointerDown) return;
  if (isDraggingEarth) suppressNextClick = true;
  canvas.releasePointerCapture?.(event.pointerId);
  pointerDown = null;
  isDraggingEarth = false;
}

function handleCanvasClick(event) {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  handleGlobeClick(event);
}

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloomPass.setSize(window.innerWidth, window.innerHeight);
}

function handleSimulationControlChange() {
  updateSimulationLabels();
  if (fireRunning) {
    fireWorker.postMessage({ type: 'configure', params: getSimulationParams() });
    simulationReadout.textContent = 'Parameters updated · recalculating field';
  }
}

function handleHistoryClick(event) {
  const replayButton = event.target.closest('.history-replay');
  if (!replayButton) return;
  const record = scenarioRecords.find((item) => item.id === replayButton.dataset.runId);
  if (record) replayScenario(record);
}

// ─────────────────────────────────────────────────────────────
// Wire it up
// ─────────────────────────────────────────────────────────────
window.addEventListener('resize', resize);
applyScenarioPreset();
renderScenarioHistory();
scenarioSelect.addEventListener('change', applyScenarioPreset);
fuelSelect.addEventListener('change', handleSimulationControlChange);
windSpeedInput.addEventListener('input', handleSimulationControlChange);
windDirectionInput.addEventListener('input', handleSimulationControlChange);
moistureInput.addEventListener('input', handleSimulationControlChange);
slopeInput.addEventListener('input', handleSimulationControlChange);
pauseButton.addEventListener('click', () => fireWorker.postMessage({ type: 'pause' }));
resetButton.addEventListener('click', resetFireSimulation);
runHistoryList?.addEventListener('click', handleHistoryClick);
clearHistoryButton?.addEventListener('click', () => {
  clearScenarioRecords();
  scenarioRecords = [];
  renderScenarioHistory();
});
canvas.addEventListener('wheel', handleZoomWheel, { capture: true, passive: false });
canvas.addEventListener('pointerdown', handlePointerDown);
canvas.addEventListener('pointermove', handlePointerMove);
canvas.addEventListener('pointerup', handlePointerUp);
canvas.addEventListener('pointercancel', handlePointerUp);
canvas.addEventListener('pointerenter', () => {
  pointerOverCanvas = true;
  resumeRotationWhileHovered = false;
});
canvas.addEventListener('pointerleave', () => { pointerOverCanvas = false; });
canvas.addEventListener('click', handleCanvasClick);

animate();
