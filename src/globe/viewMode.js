import * as Cesium from 'cesium';

// Single owner of the explicit 2D/3D mode. Nothing else may flip projection —
// not altitude (globeLOD reads this instead of the camera height once a mode
// is set explicitly), not a click (ignite framing reads .mode but never calls
// setMode). The only writers are the toggle button and the 'v' shortcut.
const STORAGE_KEY = 'ignis:viewMode';

const AERIAL_PITCH = Cesium.Math.toRadians(-55);
const TOPDOWN_PITCH = Cesium.Math.toRadians(-90);
const TOPDOWN_HEADING = 0;
const TRANSITION_DURATION_S = 1.2;
const MIN_HEIGHT_ABOVE_GROUND_M = 120;
// Above this camera height, "preserve the current range" produces a
// destination kilometers past the horizon (or behind the camera) once
// combined with a steep pitch — clamp to a sane close-in framing instead.
const RANGE_PRESERVE_MAX_HEIGHT_M = 100_000;
const DEFAULT_RANGE_M = 2000;

function readStoredMode() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '2d' ? '2d' : '3d';
  } catch {
    return '3d';
  }
}

function persistMode(mode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // storage unavailable (private mode, quota) — mode still works this session
  }
}

// Anchor for the tween, always resolved (never null): pickEllipsoid first —
// it hits any point the camera is generally facing, unlike pickPosition/
// globe.pick which need real depth geometry and can miss or land near the
// horizon at high altitude. If the camera is tilted off the globe entirely
// (looking at sky/space), fall back to the point straight below the camera
// itself so there is always something to tween toward.
function resolveAnchor(viewer) {
  const canvas = viewer.scene.canvas;
  const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  const cartesian = viewer.camera.pickEllipsoid(center, viewer.scene.globe.ellipsoid) ?? null;
  if (cartesian) {
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    return { latitude: carto.latitude, longitude: carto.longitude, groundHeightMeters: carto.height };
  }
  const cameraCarto = viewer.camera.positionCartographic;
  return { latitude: cameraCarto.latitude, longitude: cameraCarto.longitude, groundHeightMeters: 0 };
}

// Reuses googleTiles.js's flyNow geometry (terrain-relative height, camera
// pulled back along the view ray) so the tween never dips underground.
function animateToMode(viewer, mode) {
  const anchor = resolveAnchor(viewer);
  const pitch = mode === '2d' ? TOPDOWN_PITCH : AERIAL_PITCH;
  const heading = mode === '2d' ? TOPDOWN_HEADING : viewer.camera.heading;

  // Preserving the camera's current slant range only makes sense close in —
  // from high above, that range combined with a steep pitch points the
  // destination past the horizon. Above the threshold, use a fixed close-in
  // framing over the anchor instead.
  const cameraHeight = viewer.camera.positionCartographic.height;
  let rangeMeters = DEFAULT_RANGE_M;
  if (cameraHeight <= RANGE_PRESERVE_MAX_HEIGHT_M) {
    const anchorCartesian = Cesium.Cartesian3.fromRadians(anchor.longitude, anchor.latitude, anchor.groundHeightMeters);
    rangeMeters = Cesium.Cartesian3.distance(viewer.camera.position, anchorCartesian);
  }

  const height = anchor.groundHeightMeters + Math.max(MIN_HEIGHT_ABOVE_GROUND_M, rangeMeters * Math.sin(-pitch));
  const ground = rangeMeters * Math.cos(-pitch); // 0 at top-down: camera sits directly above the target
  const metresPerDegreeLat = 111320;
  const metresPerDegreeLon = metresPerDegreeLat * Math.max(Math.cos(anchor.latitude), 1e-6);
  const latitude = Cesium.Math.toDegrees(anchor.latitude);
  const longitude = Cesium.Math.toDegrees(anchor.longitude);

  const destination = Cesium.Cartesian3.fromDegrees(
    longitude - (ground * Math.sin(heading)) / metresPerDegreeLon,
    latitude - (ground * Math.cos(heading)) / metresPerDegreeLat,
    height
  );

  viewer.camera.flyTo({
    destination,
    orientation: { heading, pitch, roll: 0 },
    duration: TRANSITION_DURATION_S
  });
}

export function initViewMode({ viewer }) {
  let mode = readStoredMode();
  const listeners = new Set();

  function setMode(nextMode) {
    if (nextMode !== '2d' && nextMode !== '3d') return;
    if (nextMode === mode) return;
    mode = nextMode;
    persistMode(mode);
    animateToMode(viewer, mode);
    listeners.forEach((cb) => cb(mode));
  }

  return {
    get mode() { return mode; },
    setMode,
    toggle() { setMode(mode === '3d' ? '2d' : '3d'); },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }
  };
}
