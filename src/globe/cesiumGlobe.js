import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { initCameraControls } from './cameraControls.js';
import { initPostProcess } from './postProcess.js';
import { addGooglePhotorealisticTiles, hasPhotorealisticTilesKey, MINIMAL_VIEWER_CHROME, flyToAerial, flyToTopDown } from './googleTiles.js';

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
  initPostProcess(viewer);
  const cameraControls = initCameraControls(viewer, { getTileset: () => tileset });

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

    let sampledHeight = null;
    // Plausibility gate. A ±50 m rule was tried and removed because building
    // sides and slopes legitimately disagree with a single sampleHeight() at
    // the same lon/lat by tens of metres — it refused real clicks.
    //
    // But the failure it existed to catch is real and much larger: when the
    // local 3D tiles have not streamed in, the depth buffer holds only distant
    // coarse geometry, so pickPosition returns a point tens of kilometres away
    // and sampleHeight returns a physically impossible height. Measured from
    // 900 m altitude at -40 deg pitch, where ground is ~1.4 km away: picks came
    // back 29-42 km out with sampleHeight at -22,726 m, and the click ignited
    // 23 km from the cursor.
    //
    // The two cases are separated by orders of magnitude, so gate on physical
    // impossibility rather than a tight tolerance: a building side never trips
    // this, unloaded tiles always do.
    const MAX_GROUND_ELEVATION_M = 9_000;   // above Everest
    const MIN_GROUND_ELEVATION_M = -500;    // below the Dead Sea shore
    const MAX_PICK_RANGE_M = 250_000;       // beyond any usable click range

    const pickRangeMeters = Cesium.Cartesian3.distance(viewer.camera.positionWC, cartesian);
    const impossibleHeight = carto.height < MIN_GROUND_ELEVATION_M
      || carto.height > MAX_GROUND_ELEVATION_M;

    if (typeof viewer.scene.sampleHeight === 'function') {
      try {
        sampledHeight = viewer.scene.sampleHeight(carto);
      } catch {
        sampledHeight = null; // nothing pickable at this pixel
      }
    }
    const impossibleSample = Number.isFinite(sampledHeight)
      && (sampledHeight < MIN_GROUND_ELEVATION_M || sampledHeight > MAX_GROUND_ELEVATION_M);

    if (impossibleHeight || impossibleSample || pickRangeMeters > MAX_PICK_RANGE_M) {
      console.warn('[cesiumGlobe] click refused — implausible pick · height',
        carto.height.toFixed(0), 'm · sampled',
        Number.isFinite(sampledHeight) ? sampledHeight.toFixed(0) : 'n/a',
        'm · range', Math.round(pickRangeMeters), 'm · strategy:', strategy,
        '·', TILES_LOADING_MESSAGE);
      pickRefusedCallback?.(TILES_LOADING_MESSAGE);
      return;
    }

    // Low-detail Google tile depth can report a point far inside the WGS84
    // ellipsoid when clicking from orbit. Passing that negative height into
    // the close-up flight put the camera and flames underground. Prefer a
    // plausible picked/sample height and use a safe continental estimate
    // until the terrain field supplies the exact local elevation.
    const plausible = (value) => Number.isFinite(value) && value >= -500 && value <= 9_000;
    const groundHeightMeters = plausible(carto.height)
      ? carto.height
      : (plausible(sampledHeight) ? sampledHeight : 1_500);

    console.info('[cesiumGlobe] click pick strategy:', strategy);
    clickCallback?.({
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      groundHeightMeters,
      cameraAltitudeMeters: viewer.camera.positionCartographic.height
    });
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  return {
    viewer,
    cameraControls,
    tilesetPromise,
    flyToAerial: (opts) => flyToAerial(viewer, opts),
    flyToTopDown: (opts) => flyToTopDown(viewer, opts),
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
