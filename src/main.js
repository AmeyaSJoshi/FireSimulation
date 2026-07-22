import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { cartesianToLatitudeLongitude } from './lib/coordinateMath.js';
import { formatLocationLabel } from './lib/locationLabel.js';
import { createTerrainSampler } from './lib/terrainSampler.js';
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
    const earthRadius = Math.max(size.x, size.y, size.z) * 0.5;
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
  placeMarker(localHitPoint);
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

// ─────────────────────────────────────────────────────────────
// Wire it up
// ─────────────────────────────────────────────────────────────
window.addEventListener('resize', resize);
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
