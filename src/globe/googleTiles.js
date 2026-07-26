import * as Cesium from 'cesium';

// Google Photorealistic 3D Tiles. Requires a Cesium ion token — the tileset is
// served through ion, so with VITE_CESIUM_ION_TOKEN unset this throws and the
// caller keeps P1's imagery/terrain globe instead (short-circuited, not deleted).
export async function addGooglePhotorealisticTiles(viewer) {
  const tileset = await Cesium.createGooglePhotorealistic3DTileset();
  viewer.scene.primitives.add(tileset);
  // The photoreal mesh *is* the surface; the underlying globe would z-fight it.
  viewer.scene.globe.show = false;
  return tileset;
}

// Tilted aerial framing (reference look), not top-down.
export const AERIAL_PITCH_RADIANS = Cesium.Math.toRadians(-55);

export function flyToAerial(viewer, { latitude, longitude, rangeMeters = 900, duration = 1.5 }) {
  viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(
      Cesium.Cartesian3.fromDegrees(longitude, latitude, 0),
      rangeMeters * 0.5
    ),
    {
      duration,
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(30),
        AERIAL_PITCH_RADIANS,
        rangeMeters
      )
    }
  );
}

// Minimal chrome. The ion/Google data attribution is deliberately NOT hidden —
// Google's terms require the credit to stay visible, so it keeps its default
// bottom-left overlay while every other widget is suppressed.
export const MINIMAL_VIEWER_CHROME = Object.freeze({
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false
});
