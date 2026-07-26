import * as Cesium from 'cesium';

// Altitude-gated swap between P4's Google Photorealistic 3D Tiles and the
// plain Cesium World Terrain + imagery globe.
//
// Why: the photoreal tileset is authored for close range. Above a few tens of
// km its LOD thins out to near-flat grey sheets, so the zoomed-out view loses
// both colour and relief — exactly the altitudes where you want a recognisable
// Earth. The terrain+imagery globe has the opposite profile: coarse up close,
// but properly coloured and (with lighting on) hill-shaded from orbit.
//
// Both layers are already constructed by initCesiumGlobe — the viewer is built
// with Terrain.fromWorldTerrain() + World Imagery, and P4 adds the tileset.
// This module only flips `.show`; it never creates or destroys either one, so
// crossing the threshold costs nothing and cannot flash black or re-stream.
export const FAR_ALTITUDE_M = 60_000;
const THROTTLE_MS = 120;

export function initGlobeLOD(viewer, tilesetPromise) {
  let tileset = null;
  let mode = null;
  let lastCheck = 0;

  function apply(nextMode) {
    if (nextMode === mode) return;
    mode = nextMode;
    const far = nextMode === 'far';

    // With no tileset (no ion/Google key) the globe is the only surface there
    // is, so it must stay visible at every altitude.
    if (tileset) tileset.show = !far;
    viewer.scene.globe.show = far || !tileset;

    // Lighting is what makes mountains read as mountains — terrain normals
    // only shade when there is a light. But the default light is the real sun,
    // and at a 12,000 km default camera height that renders the entire visible
    // hemisphere as unlit black whenever it happens to be facing night, which
    // is exactly half the time and looks like a broken globe.
    //
    // So: lighting on, but lit from the camera instead of the sun. Relief
    // still shades (the terrain is side-lit as you orbit), and whatever you
    // are looking at is always visible. Restore the real sun in near mode,
    // where the photoreal tileset carries its own baked lighting.
    viewer.scene.globe.enableLighting = far;
    viewer.scene.light = far ? cameraLight : defaultLight;
  }

  // Reused every frame; allocating a DirectionalLight per frame would churn.
  const defaultLight = viewer.scene.light;
  const cameraLight = new Cesium.DirectionalLight({
    direction: Cesium.Cartesian3.clone(viewer.camera.directionWC),
    intensity: 1.7
  });

  function trackCameraLight() {
    if (mode !== 'far') return;
    // Off-axis so the terrain is side-lit; a light exactly down the view ray
    // flattens every slope it touches.
    const direction = Cesium.Cartesian3.clone(viewer.camera.directionWC, cameraLight.direction);
    Cesium.Cartesian3.add(
      direction,
      Cesium.Cartesian3.multiplyByScalar(viewer.camera.rightWC, -0.35, new Cesium.Cartesian3()),
      direction
    );
    Cesium.Cartesian3.normalize(direction, cameraLight.direction);
  }

  function tick() {
    const now = performance.now();
    if (now - lastCheck < THROTTLE_MS) return;
    lastCheck = now;
    apply(viewer.camera.positionCartographic.height > FAR_ALTITUDE_M ? 'far' : 'near');
  }

  function onPreRender() {
    tick();
    trackCameraLight();
  }

  const listener = viewer.scene.preRender.addEventListener(onPreRender);

  Promise.resolve(tilesetPromise).then((resolved) => {
    tileset = resolved ?? null;
    // P4's loader sets globe.show = false as soon as the tileset resolves.
    // Re-evaluate from scratch so a camera already above the threshold gets
    // the globe back instead of staring at hidden geometry.
    mode = null;
    lastCheck = 0;
    tick();
  }).catch(() => { /* P4 already logs; plain globe stays up */ });

  tick();

  return {
    get mode() { return mode; },
    destroy() { viewer.scene.preRender.removeEventListener(listener); }
  };
}
