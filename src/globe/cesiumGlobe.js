import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { addGooglePhotorealisticTiles, MINIMAL_VIEWER_CHROME, flyToAerial } from './googleTiles.js';

const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN;
const hasIonToken = typeof ION_TOKEN === 'string' && ION_TOKEN.trim().length > 0;
if (hasIonToken) Cesium.Ion.defaultAccessToken = ION_TOKEN;

// Location picker. Cesium owns all globe rendering/imagery/zoom; the
// existing Three.js canvas is reused only for the local block scene that
// activates after a successful ignite (see rebuildBlockScene in main.js).
//
// Without a real Ion token (VITE_CESIUM_ION_TOKEN unset), Ion-backed
// imagery/terrain (createWorldImageryAsync / Terrain.fromWorldTerrain) fail
// to authenticate and the globe never renders anything pickable — clicks
// silently do nothing. Fall back to a token-free OSM imagery layer and the
// default (always-pickable) ellipsoid terrain in that case.
export function initCesiumGlobe() {
  const container = document.createElement('div');
  container.id = 'cesium-globe';
  Object.assign(container.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '0'
  });
  document.body.prepend(container);

  const viewer = new Cesium.Viewer(container, {
    baseLayer: hasIonToken
      ? undefined // default: Cesium World Imagery via Ion
      : new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })),
    terrain: hasIonToken ? Cesium.Terrain.fromWorldTerrain() : undefined,
    ...MINIMAL_VIEWER_CHROME
    // NOTE: creditContainer is intentionally NOT overridden. Google's terms
    // require the ion/Google data attribution to stay visible, so it keeps its
    // default bottom-left overlay even though every other widget is hidden.
  });

  // Google Photorealistic 3D Tiles are served through ion, so they only load
  // with a token. Without one this rejects and P1's imagery/terrain globe
  // stays as-is (short-circuited, not deleted).
  let tilesetPromise = null;
  if (hasIonToken) {
    tilesetPromise = addGooglePhotorealisticTiles(viewer)
      .catch((error) => {
        console.warn('[cesiumGlobe] Google 3D Tiles unavailable, keeping imagery globe:', error?.message ?? error);
        return null;
      });
  }

  if (!hasIonToken) {
    console.warn('[cesiumGlobe] VITE_CESIUM_ION_TOKEN is not set — using OSM imagery + flat ellipsoid terrain as a fallback. Set the token in .env for satellite imagery and real terrain.');
  }
  viewer.scene.globe.depthTestAgainstTerrain = true;

  let clickCallback = null;
  viewer.screenSpaceEventHandler.setInputAction((movement) => {
    // globe.pick only hits *loaded* terrain geometry, so it returns undefined
    // while tiles are still streaming and the click silently does nothing.
    // Fall back to the smooth ellipsoid, which is always pickable.
    const ray = viewer.camera.getPickRay(movement.position);
    const cartesian = (ray && viewer.scene.globe.pick(ray, viewer.scene))
      ?? viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
    if (!cartesian) return;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    clickCallback?.({
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      cameraAltitudeMeters: viewer.camera.positionCartographic.height
    });
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  return {
    viewer,
    tilesetPromise,
    flyToAerial: (opts) => flyToAerial(viewer, opts),
    onGlobeClick(cb) {
      clickCallback = cb;
    },
    setVisible(visible) {
      container.style.display = visible ? '' : 'none';
    }
  };
}
