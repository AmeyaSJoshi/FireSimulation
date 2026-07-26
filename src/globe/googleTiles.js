import * as Cesium from 'cesium';

// Google Photorealistic 3D Tiles.
//
// Two ways in, and the app supports both because they need different keys:
//   1. VITE_GOOGLE_MAPS_API_KEY — talks to Google's tile service directly, no
//      Cesium ion account needed. Preferred.
//   2. VITE_CESIUM_ION_TOKEN — the same tileset proxied through ion.
// With neither set this throws and the caller keeps the plain imagery globe.
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
const GOOGLE_3D_TILES_URL = 'https://tile.googleapis.com/v1/3dtiles/root.json';

export function hasPhotorealisticTilesKey() {
  const google = typeof GOOGLE_MAPS_API_KEY === 'string' && GOOGLE_MAPS_API_KEY.trim().length > 0;
  const ion = typeof import.meta.env.VITE_CESIUM_ION_TOKEN === 'string'
    && import.meta.env.VITE_CESIUM_ION_TOKEN.trim().length > 0;
  return google || ion;
}

export async function addGooglePhotorealisticTiles(viewer) {
  let tileset;
  if (typeof GOOGLE_MAPS_API_KEY === 'string' && GOOGLE_MAPS_API_KEY.trim().length > 0) {
    tileset = await Cesium.Cesium3DTileset.fromUrl(
      `${GOOGLE_3D_TILES_URL}?key=${GOOGLE_MAPS_API_KEY.trim()}`,
      { showCreditsOnScreen: true }
    );
  } else {
    tileset = await Cesium.createGooglePhotorealistic3DTileset({ onlyUsingWithGoogleGeocoder: false });
  }
  viewer.scene.primitives.add(tileset);
  // The photoreal mesh *is* the surface; the underlying globe would z-fight it
  // and poke through the buildings.
  viewer.scene.globe.show = false;
  return tileset;
}

// Tilted aerial framing (reference look), not top-down.
export const AERIAL_PITCH_RADIANS = Cesium.Math.toRadians(-55);

// Altitude above which the camera is considered "far" and gets pulled down
// toward the click. Below it, the user already picked what they were looking
// at — recentering/reframing on top of that is a second, unrequested camera
// move on top of an already-correct pick.
const FAR_ALTITUDE_METERS = 2000;

export function flyToAerial(viewer, { latitude, longitude, rangeMeters = 900, duration = 1.5 }) {
  if (viewer.camera.positionCartographic.height <= FAR_ALTITUDE_METERS) return;
  // Cesium cancels an in-progress camera flight when it sees user input, and
  // callers start this from inside the click handler — the trailing mouse-up
  // of that same click killed the flight and left the camera top-down. Defer
  // past the input sequence so the flight survives.
  //
  // setTimeout, not requestAnimationFrame: rAF is throttled to zero in
  // background/headless contexts, which silently dropped the flight entirely.
  setTimeout(() => flyNow(viewer, { latitude, longitude, rangeMeters, duration }), 0);
}

// flyToBoundingSphere never tweened here (it silently no-ops unless duration
// is 0), so the destination is computed explicitly and handed to camera.flyTo.
function flyNow(viewer, { latitude, longitude, rangeMeters, duration }) {
  const pitch = AERIAL_PITCH_RADIANS;
  const heading = Cesium.Math.toRadians(30);
  // Pull the camera back along the view ray so the target sits centre-frame
  // at the requested tilt.
  const height = Math.max(120, rangeMeters * Math.sin(-pitch));
  const ground = rangeMeters * Math.cos(-pitch);
  const metresPerDegreeLat = 111320;
  const metresPerDegreeLon = metresPerDegreeLat * Math.max(Math.cos(Cesium.Math.toRadians(latitude)), 1e-6);
  const destination = Cesium.Cartesian3.fromDegrees(
    longitude - (ground * Math.sin(heading)) / metresPerDegreeLon,
    latitude - (ground * Math.cos(heading)) / metresPerDegreeLat,
    height
  );
  viewer.camera.flyTo({
    destination,
    orientation: { heading, pitch, roll: 0 },
    duration
  });
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
