import * as Cesium from 'cesium';

// This is deliberately a camera-mode switch, not scene.morphTo2D: Google
// Photorealistic 3D Tiles do not render in Cesium's real 2D scene mode.
const STORAGE_KEY = 'ignis:viewMode';
const AERIAL_PITCH = Cesium.Math.toRadians(-45);
const TOPDOWN_PITCH = Cesium.Math.toRadians(-90);
const TRANSITION_DURATION_S = 1.2;
const MIN_RANGE_M = 120;
const SATELLITE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

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
    // Storage unavailable — the mode still works for this session.
  }
}

function isUsablePosition(position) {
  return position
    && Number.isFinite(position.x)
    && Number.isFinite(position.y)
    && Number.isFinite(position.z);
}

// Pick the geometry actually visible at screen centre. An ellipsoid fallback
// is intentionally forbidden: it ignores buildings and terrain and is the
// reason the old toggle jumped to a different area at oblique angles.
function resolveAnchor(viewer) {
  const { scene, camera } = viewer;
  const canvas = scene.canvas;
  const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);

  if (scene.pickPositionSupported) {
    try {
      const depthPosition = scene.pickPosition(center);
      if (isUsablePosition(depthPosition)) return depthPosition;
    } catch {
      // Depth is not ready at this pixel; try the rendered tileset below.
    }
  }

  try {
    const ray = camera.getPickRay(center);
    const hit = ray ? scene.pickFromRay(ray) : null;
    if (isUsablePosition(hit?.position)) return hit.position;
  } catch {
    // Ray picking can fail while tiles are still streaming. Abort the toggle.
  }

  return null;
}

function findTilesets(viewer) {
  const matches = [];
  const primitives = viewer.scene.primitives;
  for (let i = 0; i < primitives.length; i += 1) {
    const primitive = primitives.get(i);
    if (primitive instanceof Cesium.Cesium3DTileset) matches.push(primitive);
  }
  return matches;
}

function createSatelliteLayer(viewer) {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: SATELLITE_URL,
    maximumLevel: 19,
    credit: new Cesium.Credit(
      '<a href="https://www.esri.com/" target="_blank">Tiles © Esri</a> — Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
    )
  });
  const layer = viewer.imageryLayers.addImageryProvider(provider);
  layer.show = false;
  return layer;
}

function applySurfaceMode(viewer, satelliteLayer, mode) {
  const tilesets = findTilesets(viewer);
  const topDown = mode === '2d';
  satelliteLayer.show = topDown;

  if (topDown) {
    for (const tileset of tilesets) tileset.show = false;
    viewer.scene.globe.show = true;
    viewer.imageryLayers.raiseToTop(satelliteLayer);
  } else if (tilesets.length > 0) {
    for (const tileset of tilesets) tileset.show = true;
    viewer.scene.globe.show = false;
  } else {
    // No photoreal tiles available: retain the ordinary imagery globe.
    viewer.scene.globe.show = true;
  }
  viewer.scene.requestRender();
}

function createVolumeModeGuard(viewer, getMode) {
  const hiddenStates = new Map();

  function sync() {
    const primitives = viewer.scene.primitives;
    if (getMode() === '2d') {
      for (let i = 0; i < primitives.length; i += 1) {
        const primitive = primitives.get(i);
        if (!(primitive instanceof Cesium.ParticleSystem)) continue;
        if (!hiddenStates.has(primitive)) hiddenStates.set(primitive, primitive.show);
        primitive.show = false;
      }
      return;
    }

    if (hiddenStates.size > 0) {
      for (const [primitive, wasShown] of hiddenStates) {
        if (!primitive.isDestroyed?.()) primitive.show = wasShown;
      }
      hiddenStates.clear();
    }
  }

  // fireLOD registers its preRender listener after initViewMode. Register this
  // guard on the next task so it runs after fireLOD and wins in top-down mode.
  let removeListener = null;
  setTimeout(() => {
    const listener = viewer.scene.preRender.addEventListener(sync);
    removeListener = () => viewer.scene.preRender.removeEventListener(listener);
    sync();
  }, 0);

  return {
    sync,
    destroy() {
      removeListener?.();
      removeListener = null;
      for (const [primitive, wasShown] of hiddenStates) {
        if (!primitive.isDestroyed?.()) primitive.show = wasShown;
      }
      hiddenStates.clear();
    }
  };
}

function offsetFromHeadingPitchRange(heading, pitch, rangeMeters) {
  const adjustedHeading = Cesium.Math.zeroToTwoPi(heading) - Cesium.Math.PI_OVER_TWO;
  const pitchRotation = Cesium.Quaternion.fromAxisAngle(
    Cesium.Cartesian3.UNIT_Y,
    -pitch,
    new Cesium.Quaternion()
  );
  const headingRotation = Cesium.Quaternion.fromAxisAngle(
    Cesium.Cartesian3.UNIT_Z,
    -adjustedHeading,
    new Cesium.Quaternion()
  );
  const rotation = Cesium.Quaternion.multiply(
    headingRotation,
    pitchRotation,
    new Cesium.Quaternion()
  );
  const matrix = Cesium.Matrix3.fromQuaternion(rotation, new Cesium.Matrix3());
  const offset = Cesium.Matrix3.multiplyByVector(
    matrix,
    Cesium.Cartesian3.UNIT_X,
    new Cesium.Cartesian3()
  );
  Cesium.Cartesian3.negate(offset, offset);
  return Cesium.Cartesian3.multiplyByScalar(offset, rangeMeters, offset);
}

function flightFrameForAnchor(anchor, heading, pitch, rangeMeters) {
  // Match Cesium's HeadingPitchRange geometry, then supply world-space
  // direction/up to flyTo. Unlike destination + HPR at globe-scale ranges,
  // this always aims at the original anchor even when the destination has a
  // very different local tangent frame.
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(anchor);
  const localOffset = offsetFromHeadingPitchRange(heading, pitch, rangeMeters);
  const destination = Cesium.Matrix4.multiplyByPoint(
    enu,
    localOffset,
    new Cesium.Cartesian3()
  );
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(anchor, destination, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );
  const up = Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    Cesium.Cartesian3.UNIT_Z,
    new Cesium.Cartesian3()
  );

  if (1 - Math.abs(Cesium.Cartesian3.dot(direction, up)) < Cesium.Math.EPSILON6) {
    const north = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      Cesium.Cartesian3.UNIT_Y,
      new Cesium.Cartesian3()
    );
    const headingRotation = Cesium.Quaternion.fromAxisAngle(
      direction,
      heading,
      new Cesium.Quaternion()
    );
    Cesium.Matrix3.multiplyByVector(
      Cesium.Matrix3.fromQuaternion(headingRotation, new Cesium.Matrix3()),
      north,
      up
    );
  } else {
    const right = Cesium.Cartesian3.cross(direction, up, new Cesium.Cartesian3());
    Cesium.Cartesian3.cross(right, direction, up);
    Cesium.Cartesian3.normalize(up, up);
  }

  return { destination, direction, up };
}

function flyToMode(viewer, anchor, heading, pitch) {
  const rangeMeters = Math.max(
    MIN_RANGE_M,
    Cesium.Cartesian3.distance(viewer.camera.positionWC, anchor)
  );
  const frame = flightFrameForAnchor(anchor, heading, pitch, rangeMeters);

  return new Promise((resolve) => {
    viewer.camera.flyTo({
      destination: frame.destination,
      orientation: { direction: frame.direction, up: frame.up },
      duration: TRANSITION_DURATION_S,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
      complete: () => resolve(true),
      cancel: () => resolve(false)
    });
  });
}

export function initViewMode({ viewer }) {
  let mode = readStoredMode();
  let transitionInProgress = false;
  const listeners = new Set();
  const toggleButton = document.querySelector('#view-mode-toggle');
  const satelliteLayer = createSatelliteLayer(viewer);

  viewer.scene.completeMorphOnUserInput = false;
  applySurfaceMode(viewer, satelliteLayer, mode);
  const volumeGuard = createVolumeModeGuard(viewer, () => mode);

  function setTransitioning(next) {
    transitionInProgress = next;
    if (!toggleButton) return;
    toggleButton.disabled = next;
    toggleButton.setAttribute('aria-busy', String(next));
  }

  async function setMode(nextMode) {
    if (nextMode !== '2d' && nextMode !== '3d') return false;
    if (nextMode === mode || transitionInProgress) return false;

    setTransitioning(true);
    const anchor = resolveAnchor(viewer);
    if (!anchor) {
      setTransitioning(false);
      return false;
    }

    const heading = viewer.camera.heading;
    const pitch = nextMode === '2d' ? TOPDOWN_PITCH : AERIAL_PITCH;
    mode = nextMode;
    persistMode(mode);
    applySurfaceMode(viewer, satelliteLayer, mode);
    volumeGuard.sync();
    listeners.forEach((callback) => callback(mode));

    try {
      return await flyToMode(viewer, anchor, heading, pitch);
    } finally {
      setTransitioning(false);
    }
  }

  return {
    get mode() { return mode; },
    get transitionInProgress() { return transitionInProgress; },
    setMode,
    toggle() { return setMode(mode === '3d' ? '2d' : '3d'); },
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    destroy() {
      volumeGuard.destroy();
      viewer.imageryLayers.remove(satelliteLayer, true);
    }
  };
}
