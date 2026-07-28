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

export function initCameraControls(viewer) {
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
  controller.zoomEventTypes = [
    Cesium.CameraEventType.WHEEL,
    Cesium.CameraEventType.PINCH
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

  // Pitch clamp. postUpdate (after the controller has applied input, before
  // render) so a drag can momentarily request an out-of-range pitch but never
  // shows a frame of it. In 2D the lock is hard at straight down.
  const scratchPosition = new Cesium.Cartesian3();
  const postUpdateListener = viewer.scene.postUpdate.addEventListener(() => {
    const pitch = camera.pitch;
    const target = mode === '2d'
      ? MIN_PITCH_RADIANS
      : Math.min(Math.max(pitch, MIN_PITCH_RADIANS), MAX_PITCH_RADIANS);
    if (Math.abs(pitch - target) < 1e-4) return;
    Cesium.Cartesian3.clone(camera.position, scratchPosition);
    camera.setView({
      destination: scratchPosition,
      orientation: { heading: camera.heading, pitch: target, roll: 0 }
    });
  });

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
    }
  };
}
