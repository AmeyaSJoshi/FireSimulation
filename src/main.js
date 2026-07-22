import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { cartesianToLatitudeLongitude } from './lib/coordinateMath.js';
import { formatLocationLabel } from './lib/locationLabel.js';
import './styles.css';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const locationValue = document.querySelector('#location-value');
const latitudeValue = document.querySelector('#latitude-value');
const longitudeValue = document.querySelector('#longitude-value');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 0, 4);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const globeMeshes = [];
const earthSpinGroup = new THREE.Group();
scene.add(earthSpinGroup);
let earthModel = null;
let selectedMarker = null;

let pointerDown = null;
let isDraggingEarth = false;
let suppressNextClick = false;
let pointerOverCanvas = false;
let resumeRotationWhileHovered = false;
const earthClock = new THREE.Clock();
const AUTO_ROTATION_SPEED = 0.22;
const manualAngularVelocity = new THREE.Vector2();

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.zoomToCursor = false;
let referenceCameraDistance = camera.position.distanceTo(controls.target);

scene.add(new THREE.AmbientLight(0xffffff, 1.6));

const light = new THREE.DirectionalLight(0xffffff, 2.4);
light.position.set(3, 4, 5);
scene.add(light);

const texture = new THREE.TextureLoader().load('/earth/textures/1_earth_8k.jpg');
texture.colorSpace = THREE.SRGBColorSpace;
texture.flipY = true;
texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

const loader = new FBXLoader();
loader.load(
  '/earth/source/Earth.fbx',
  (model) => {
    earthModel = model;
    model.traverse((child) => {
      if (!child.isMesh) return;

      child.material = new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.75
      });
      globeMeshes.push(child);
    });

    earthSpinGroup.add(model);
    frameModel(model);
    loading.remove();
  },
  (event) => {
    if (event.total > 0) {
      loading.textContent = `${Math.round((event.loaded / event.total) * 100)}%`;
    }
  },
  () => {
    loading.textContent = 'Could not load model';
  }
);

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

  updateConditionPanel(coordinates);
  moveSelectedMarker(localHitPoint);
}

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

  // Dolly along the exact mouse ray. Translating the orbit target by the same
  // amount preserves the camera orientation and keeps the hit point under the
  // cursor instead of letting the current view center take over.
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

function updateConditionPanel(coordinates) {
  locationValue.textContent = formatLocationLabel(coordinates.latitude, coordinates.longitude);
  latitudeValue.textContent = coordinates.latitude.toFixed(4);
  longitudeValue.textContent = coordinates.longitude.toFixed(4);
}

function moveSelectedMarker(point) {
  if (!selectedMarker) {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 24),
      new THREE.MeshBasicMaterial({
        color: 0xff3b30,
        depthTest: false,
        depthWrite: false
      })
    );
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(1.75, 2.25, 40),
      new THREE.MeshBasicMaterial({
        color: 0xfff7ed,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95
      })
    );
    const target = new THREE.Group();
    target.add(dot, halo);
    target.renderOrder = 10;
    target.userData.surfacePoint = new THREE.Vector3();
    selectedMarker = target;
    earthSpinGroup.add(selectedMarker);
  }

  selectedMarker.userData.surfacePoint.copy(point);
  selectedMarker.position.copy(point.clone().normalize().multiplyScalar(point.length() * 1.01));
  updateSelectedMarker();
}

function updateSelectedMarker() {
  if (!selectedMarker) return;

  earthSpinGroup.updateMatrixWorld(true);

  const cameraDistance = camera.position.length();
  const zoomRatio = cameraDistance / referenceCameraDistance;
  const zoomScale = THREE.MathUtils.clamp(Math.pow(zoomRatio, 1.35), 0.32, 5);
  const markerScale = selectedMarker.userData.surfacePoint.length() * 0.018;
  selectedMarker.scale.setScalar(markerScale * zoomScale);
  const parentWorldQuaternion = earthSpinGroup.getWorldQuaternion(new THREE.Quaternion()).invert();
  selectedMarker.quaternion.copy(parentWorldQuaternion.multiply(camera.quaternion));

  const markerWorldPosition = selectedMarker.getWorldPosition(new THREE.Vector3());
  const outward = selectedMarker.userData.surfacePoint.clone()
    .normalize()
    .transformDirection(earthSpinGroup.matrixWorld);
  const towardCamera = camera.position.clone().sub(markerWorldPosition).normalize();
  selectedMarker.visible = outward.dot(towardCamera) > -0.08;
}

function frameModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();

  model.position.sub(center);

  const distance = size / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  camera.position.set(0, 0, distance * 1.35);
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  referenceCameraDistance = distance * 1.35;

  controls.target.set(0, 0, 0);
  controls.update();
}

function animate() {
  const deltaSeconds = Math.min(earthClock.getDelta(), 0.05);
  if (earthModel && !isDraggingEarth && !pointerDown &&
      (!pointerOverCanvas || resumeRotationWhileHovered)) {
    earthSpinGroup.rotation.y += (AUTO_ROTATION_SPEED + manualAngularVelocity.y) * deltaSeconds;
    earthSpinGroup.rotation.x = THREE.MathUtils.clamp(
      earthSpinGroup.rotation.x + manualAngularVelocity.x * deltaSeconds,
      -Math.PI * 0.45,
      Math.PI * 0.45
    );
    const damping = Math.pow(0.035, deltaSeconds);
    manualAngularVelocity.multiplyScalar(damping);
  }
  controls.update();
  updateSelectedMarker();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

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
  const rotationDeltaY = deltaX * 0.008;
  const rotationDeltaX = deltaY * 0.008;
  const elapsedSeconds = Math.max((event.timeStamp - pointerDown.timeStamp) / 1000, 1 / 120);
  earthSpinGroup.rotation.y += rotationDeltaY;
  earthSpinGroup.rotation.x = THREE.MathUtils.clamp(
    earthSpinGroup.rotation.x + rotationDeltaX,
    -Math.PI * 0.45,
    Math.PI * 0.45
  );
  manualAngularVelocity.y = THREE.MathUtils.clamp(rotationDeltaY / elapsedSeconds, -8, 8);
  manualAngularVelocity.x = THREE.MathUtils.clamp(rotationDeltaX / elapsedSeconds, -8, 8);
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
}

window.addEventListener('resize', resize);
canvas.addEventListener('wheel', handleZoomWheel, { capture: true });
controls.enableRotate = false;
controls.enablePan = false;
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
