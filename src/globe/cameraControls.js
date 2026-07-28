import * as Cesium from 'cesium';

// Camera feel. Everything here is ScreenSpaceCameraController CONFIGURATION,
// not custom input code — Cesium's controller already does smooth,
// cursor-anchored wheel zoom and collision; the defaults just bundle tilt
// onto drags people use for panning, which is where the "unwanted tilt while
// panning" and "twitchy" feel came from.
//
// Contract:
//   3D: left-drag pans/rotates, tilt ONLY on right-drag or ctrl+left-drag,
//       pitch clamped to [-90, -15] deg so you can't drag under the horizon
//       or end up staring at sky.
//   2D: tilt disabled outright; pitch hard-locked to straight down.
//   Zoom: wheel/pinch only (right-drag zoom removed — that slot is tilt),
//       cursor-anchored (Cesium default), 40 m..20,000 km, collision on so
//       you can never end up inside buildings or under terrain.
//   Inertia: mild — glides, doesn't sail away.
//   Double-click: one smooth zoom step toward the cursor; default
//       entity-track behavior suppressed.

const MIN_PITCH_RADIANS = Cesium.Math.toRadians(-90);
const MAX_PITCH_RADIANS = Cesium.Math.toRadians(-15);
const DOUBLE_CLICK_ZOOM_FACTOR = 0.5; // halve the distance per double-click

const AUTO_TILT_ALTITUDE_M = 3000;
const AUTO_TILT_TARGET = Cesium.Math.toRadians(-55);
const AUTO_TILT_NEAR_NADIR = Cesium.Math.toRadians(5); // only when pitch ~= -90
const AUTO_TILT_SECONDS = 1.0;

export function initCameraControls(viewer, { getTileset = () => null } = {}) {
  const controller = viewer.scene.screenSpaceCameraController;
  const camera = viewer.camera;
  let mode = '3d';

  // Zoom bounds + never inside geometry.
  controller.minimumZoomDistance = 40;
  controller.maximumZoomDistance = 20_000_000;
  controller.enableCollisionDetection = true;

  // Mild inertia.
  controller.inertiaSpin = 0.6;
  controller.inertiaTranslate = 0.6;
  controller.inertiaZoom = 0.65;

  // Wheel + pinch zoom only. The default also binds RIGHT_DRAG to zoom,
  // which is both the twitchy zoom and the slot tilt needs.
  //
  // CTRL+WHEEL is macOS trackpad pinch: the OS delivers the pinch gesture to
  // the browser as a wheel event with ctrlKey set. Without this entry the
  // aggregator classifies it as a modified event, matches nothing, and
  // trackpad pinch-zoom silently does NOTHING.
  controller.zoomEventTypes = [
    Cesium.CameraEventType.WHEEL,
    Cesium.CameraEventType.PINCH,
    { eventType: Cesium.CameraEventType.WHEEL, modifier: Cesium.KeyboardEventModifier.CTRL }
  ];

  // Left-drag pans. Never tilts.
  controller.rotateEventTypes = [Cesium.CameraEventType.LEFT_DRAG];
  controller.translateEventTypes = [Cesium.CameraEventType.LEFT_DRAG];

  function applyMode(nextMode) {
    mode = nextMode === '2d' ? '2d' : '3d';
    if (mode === '2d') {
      controller.enableTilt = false;
    } else {
      controller.enableTilt = true;
      // Tilt ONLY on right-drag or ctrl+drag — never plain left-drag.
      controller.tiltEventTypes = [
        Cesium.CameraEventType.RIGHT_DRAG,
        { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.CTRL },
        { eventType: Cesium.CameraEventType.RIGHT_DRAG, modifier: Cesium.KeyboardEventModifier.CTRL }
      ];
    }
  }
  applyMode(mode);

  // Pitch clamp + auto-tilt, one postUpdate listener (after the controller
  // has applied input, before render, so no bad frame ever shows).
  //
  // Auto-tilt is the Google Earth swoop, and the fix for "3D looks flat until
  // the 2D->3D dance": boot pitch is -90, zoom preserves pitch, and tilt
  // lives on drags trackpad users never find — so photoreal tiles were only
  // ever seen from straight above, which IS flat (rooftops). Descending below
  // AUTO_TILT_ALTITUDE_M while still near nadir eases to -55 over ~1s. A
  // user-chosen tilt (pitch already away from -90) is never overridden, and
  // in-flight tweens are never fought.
  const scratchPosition = new Cesium.Cartesian3();
  let autoTiltStartMs = null;
  let autoTiltFromPitch = 0;
  const postUpdateListener = viewer.scene.postUpdate.addEventListener(() => {
    const pitch = camera.pitch;
    const flying = viewer.scene.tweens.length > 0;

    let target = mode === '2d'
      ? MIN_PITCH_RADIANS
      : Math.min(Math.max(pitch, MIN_PITCH_RADIANS), MAX_PITCH_RADIANS);

    if (mode === '3d' && !flying) {
      const nearNadir = Math.abs(pitch - MIN_PITCH_RADIANS) < AUTO_TILT_NEAR_NADIR;
      const low = camera.positionCartographic.height < AUTO_TILT_ALTITUDE_M;
      if (autoTiltStartMs === null && nearNadir && low) {
        autoTiltStartMs = performance.now();
        autoTiltFromPitch = pitch;
      }
      if (autoTiltStartMs !== null) {
        const t = Math.min((performance.now() - autoTiltStartMs) / (AUTO_TILT_SECONDS * 1000), 1);
        const eased = t * t * (3 - 2 * t);
        target = autoTiltFromPitch + (AUTO_TILT_TARGET - autoTiltFromPitch) * eased;
        if (t >= 1) autoTiltStartMs = null;
      }
    } else {
      autoTiltStartMs = null;
    }

    if (Math.abs(pitch - target) < 1e-4) return;
    Cesium.Cartesian3.clone(camera.position, scratchPosition);
    camera.setView({
      destination: scratchPosition,
      orientation: { heading: camera.heading, pitch: target, roll: 0 }
    });
  });

  // Discoverable tilt: a small +/- pair on screen, driving the same clamped
  // pitch. Right-drag/ctrl-drag still work; this is for trackpads.
  const tiltUI = document.createElement('div');
  tiltUI.id = 'tilt-control';
  tiltUI.style.cssText = 'position:fixed;right:14px;bottom:96px;z-index:30;display:flex;flex-direction:column;gap:4px;';
  const mkButton = (label, deltaDeg, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.cssText = 'width:34px;height:34px;border-radius:8px;border:1px solid rgba(255,180,90,0.4);background:rgba(10,10,14,0.72);color:#f4c98a;font-size:16px;cursor:pointer;';
    b.addEventListener('click', () => {
      if (mode === '2d') return;
      autoTiltStartMs = null; // a manual tilt is a user choice — stop the swoop
      const next = Math.min(Math.max(
        camera.pitch + Cesium.Math.toRadians(deltaDeg), MIN_PITCH_RADIANS), MAX_PITCH_RADIANS);
      Cesium.Cartesian3.clone(camera.position, scratchPosition);
      camera.setView({
        destination: scratchPosition,
        orientation: { heading: camera.heading, pitch: next, roll: 0 }
      });
    });
    return b;
  };
  tiltUI.appendChild(mkButton('\u2921', 10, 'Tilt up (toward horizon)'));
  tiltUI.appendChild(mkButton('\u2913', -10, 'Tilt down (top-down)'));
  document.body.appendChild(tiltUI);

  // Instrumentation: one line at wheel-zoom end. If tileset.show is ever
  // false below 60 km in 3D, that is a second, separate bug — report it.
  let wheelEndTimer = null;
  const onWheel = () => {
    if (wheelEndTimer) clearTimeout(wheelEndTimer);
    wheelEndTimer = setTimeout(() => {
      const tileset = getTileset();
      const altitude = Math.round(camera.positionCartographic.height);
      console.info('[cameraControls] zoom-end · alt', altitude, 'm · pitch',
        Cesium.Math.toDegrees(camera.pitch).toFixed(1), 'deg · lodMode',
        window.__ignis?.globeLOD?.mode ?? 'n/a', '· tileset.show', tileset ? tileset.show : 'none');
      if (tileset && !tileset.show && altitude < 60_000 && mode === '3d') {
        console.warn('[cameraControls] tileset hidden below 60 km in 3D — separate bug, report this line');
      }
    }, 250);
  };
  viewer.scene.canvas.addEventListener('wheel', onWheel, { passive: true });

  // Double-click: one zoom step toward the cursor. Kill the widget default
  // first (entity track + green selection reticle).
  viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  viewer.screenSpaceEventHandler.setInputAction((movement) => {
    const picked = viewer.scene.pickPosition(movement.position)
      ?? camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
    if (!picked) return;
    const toTarget = Cesium.Cartesian3.subtract(picked, camera.position, new Cesium.Cartesian3());
    const distance = Cesium.Cartesian3.magnitude(toTarget);
    const step = Math.max(distance * DOUBLE_CLICK_ZOOM_FACTOR, controller.minimumZoomDistance);
    if (distance - step < controller.minimumZoomDistance) return;
    Cesium.Cartesian3.normalize(toTarget, toTarget);
    const destination = Cesium.Cartesian3.add(
      camera.position,
      Cesium.Cartesian3.multiplyByScalar(toTarget, step, toTarget),
      new Cesium.Cartesian3()
    );
    camera.flyTo({
      destination,
      orientation: { heading: camera.heading, pitch: camera.pitch, roll: 0 },
      duration: 0.45
    });
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  return {
    get mode() { return mode; },
    setMode: applyMode,
    destroy() {
      viewer.scene.postUpdate.removeEventListener(postUpdateListener);
      viewer.scene.canvas.removeEventListener('wheel', onWheel);
      tiltUI.remove();
    }
  };
}
