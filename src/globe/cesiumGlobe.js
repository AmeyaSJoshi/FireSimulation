import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { addGooglePhotorealisticTiles, hasPhotorealisticTilesKey, MINIMAL_VIEWER_CHROME, flyToAerial } from './googleTiles.js';

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
  let tileset = null;
  let tilesetPromise = null;
  // pickPosition (depth-buffer read) is the ONLY strategy that can hit tile
  // geometry — the tileset hides the globe, so globe.pick/pickEllipsoid miss
  // it entirely. Without it there is no reliable way to pick a tile surface
  // at all, so the tileset is never enabled in that case: better a plain,
  // correctly-pickable globe than photoreal tiles nothing can click.
  const pickPositionSupported = viewer.scene.pickPositionSupported;
  if (!pickPositionSupported) {
    console.warn('[cesiumGlobe] scene.pickPositionSupported is false — Google 3D Tiles cannot be reliably picked on this device/browser. Staying on the terrain+imagery globe.');
  }
  if (pickPositionSupported && hasPhotorealisticTilesKey()) {
    tilesetPromise = addGooglePhotorealisticTiles(viewer)
      .then((result) => {
        tileset = result;
        return result;
      })
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
  let pickRefusedCallback = null;
  const TILES_LOADING_MESSAGE = 'Tiles still loading here — wait a moment and click again.';
  viewer.screenSpaceEventHandler.setInputAction((movement) => {
    const tilesActive = Boolean(tileset?.show);
    let cartesian = null;
    let strategy = null;

    if (tilesActive) {
      // Tiles hide the globe, so this is the ONLY valid strategy while they
      // are the active surface. No ellipsoid fallback here, ever — that was
      // the bug: pickEllipsoid always "succeeds," returning a WGS84 ellipsoid
      // point at height 0, which is kilometers off at any oblique angle and
      // silently ignites the wrong place.
      cartesian = viewer.scene.pickPosition(movement.position) ?? null;
      strategy = cartesian ? 'tile-depth' : null;
    } else {
      const ray = viewer.camera.getPickRay(movement.position);
      cartesian = (ray && viewer.scene.globe.pick(ray, viewer.scene)) ?? null;
      strategy = cartesian ? 'globe-terrain' : null;
      if (!cartesian) {
        cartesian = viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid) ?? null;
        strategy = cartesian ? 'ellipsoid' : null;
      }
    }

    if (!cartesian) {
      console.warn('[cesiumGlobe] click refused — no pick result',
        tilesActive ? '(tiles active, still streaming here)' : '(no globe/ellipsoid hit)',
        '·', TILES_LOADING_MESSAGE);
      pickRefusedCallback?.(TILES_LOADING_MESSAGE);
      return;
    }

    const carto = Cesium.Cartographic.fromCartesian(cartesian);

    // Sanity-check the pick against the actual rendered surface height at
    // that lon/lat. A stale/edge depth-buffer sample can return a cartesian
    // whose height doesn't match what's actually there; catch it rather than
    // ignite on a coordinate that's confidently wrong.
    if (typeof viewer.scene.sampleHeight === 'function') {
      let sampledHeight = null;
      try {
        sampledHeight = viewer.scene.sampleHeight(carto);
      } catch {
        sampledHeight = null; // no pickable surface at this pixel; skip the check
      }
      if (Number.isFinite(sampledHeight) && Math.abs(sampledHeight - carto.height) > 50) {
        console.warn('[cesiumGlobe] click refused — picked height', carto.height.toFixed(1),
          'm disagrees with sampled surface height', sampledHeight.toFixed(1),
          'm by more than 50 m · strategy:', strategy, '·', TILES_LOADING_MESSAGE);
        pickRefusedCallback?.(TILES_LOADING_MESSAGE);
        return;
      }
    }

    console.info('[cesiumGlobe] click pick strategy:', strategy);
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
    onPickRefused(cb) {
      pickRefusedCallback = cb;
    },
    setVisible(visible) {
      container.style.display = visible ? '' : 'none';
    }
  };
}
