import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  DEFAULT_ELEVATION_FIELD_SAMPLE_SIZE,
  fetchElevationField,
  quantizeElevationCacheKey
} from './lib/elevationField.js';
import { createSpatialGrid } from './lib/spatialGrid.js';
import { canIgniteFuelDecision, canIgniteSurface, surfaceIgnitionMessage } from './lib/ignitionPolicy.js';
import { formatLocationLabel } from './lib/locationLabel.js';
import { buildSpreadExplanation, formatCompassDirection, formatElevationRange, formatModelTime } from './lib/scenarioInterpretation.js';
import { clearScenarioRecords, compareScenarioMetrics, loadScenarioRecords, saveScenarioRecord } from './lib/scenarioRecords.js';
import { createTerrainSampler } from './lib/terrainSampler.js';
import { createCanvasImageReader, createLandCoverSource } from './lib/landCoverSource.js';
import { getFuelModel } from './lib/fuelModels.js';
import {
  LANDFIRE_FUEL_MIN_VALID_FRACTION,
  LANDFIRE_FUEL_SOURCE
} from './lib/landfireFuel.js';
import {
  crosswalkLandCoverToFuel,
  FRACTIONAL_WATER_BARRIER_THRESHOLD_PERCENT
} from './lib/landCoverToFuel.js';
import { buildFuelModelCodeField } from './lib/fireFieldInputs.js';
import { isSimulationSettled } from './lib/simulationLifecycle.js';
import { compassToMathRadians, fetchWeatherInputs, windToMidflame } from './lib/weatherInputs.js';
import {
  aggregateWorldCoverFineSamples,
  createWorldCoverFineSampleBatches,
  nearestWorldCoverFineSample,
  normalizeWorldCoverFineSamples,
  summarizeWorldCoverFineCoverage,
  WORLD_COVER_FINE_BATCH_RETRIES,
  WORLD_COVER_FINE_REQUEST_CONCURRENCY
} from './lib/worldCoverFine.js';
import {
  aggregateCanopyHeightSamples,
  CANOPY_HEIGHT_SAMPLE_OFFSETS,
  CANOPY_HEIGHT_SAMPLES_PER_CELL,
  classifyCanopyHeight
} from './lib/canopyHeight.js';
import { resolveWaterEvidence, WATER_AUTHORITY_VERSION } from './lib/waterAuthority.js';
import { classifyScenarioEvidence, formatScenarioEvidence } from './lib/scenarioEvidence.js';
import { BUILT_UP_CLASS_CODE, fetchUrbanFootprintsForBbox } from './lib/urbanFootprints.js';
import { buildFuelColorField, createBlockScene } from './renderers/blockScene.js';
import { initCesiumGlobe } from './globe/cesiumGlobe.js';
import { MAX_PROPAGATION_MINUTES, runFromClick } from './sim/runFromClick.js';
import { createFireLOD } from './globe/fireLOD.js';
import { initGlobeLOD } from './globe/globeLOD.js';
import './styles.css';

// ─────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────
const canvas = document.querySelector('#scene');
const loadingEl = document.querySelector('#loading');
const locationValue = document.querySelector('#location-value');
const latitudeValue = document.querySelector('#latitude-value');
const longitudeValue = document.querySelector('#longitude-value');
const panelStatus = document.querySelector('#panel-status');
const statusText = document.querySelector('#status-text');
const scenarioSelect = document.querySelector('#scenario-select');
const fuelSelect = document.querySelector('#fuel-select');
const windSpeedInput = document.querySelector('#wind-speed');
const windSpeedValue = document.querySelector('#wind-speed-value');
const windDirectionInput = document.querySelector('#wind-direction');
const windDirectionValue = document.querySelector('#wind-direction-value');
const moistureInput = document.querySelector('#moisture');
const moistureValue = document.querySelector('#moisture-value');
const weatherMoistureToggle = document.querySelector('#weather-moisture-toggle');
const liveMoistureInput = document.querySelector('#live-moisture');
const liveMoistureValue = document.querySelector('#live-moisture-value');
const slopeInput = document.querySelector('#slope-strength');
const slopeValue = document.querySelector('#slope-value');
const uncertaintyToggle = document.querySelector('#uncertainty-toggle');
const pauseButton = document.querySelector('#pause-button');
const resetButton = document.querySelector('#reset-button');
const timelineScrub = document.querySelector('#timeline-scrub');
const timelineScrubValue = document.querySelector('#timeline-scrub-value');
const simulationReadout = document.querySelector('#simulation-readout');
const simulationNote = document.querySelector('.simulation-note');
const footprintValue = document.querySelector('#footprint-value');
const perimeterValue = document.querySelector('#perimeter-value');
const scaleValue = document.querySelector('#scale-value');
const urbanBasisValue = document.querySelector('#urban-basis-value');
const spottingBasisValue = document.querySelector('#spotting-basis-value');
const modelTimeValue = document.querySelector('#model-time-value');
const burnedAreaValue = document.querySelector('#burned-area-value');
const maxSpreadValue = document.querySelector('#max-spread-value');
const spreadRateValue = document.querySelector('#spread-rate-value');
const modelValue = document.querySelector('#model-value');
const terrainValue = document.querySelector('#terrain-value');
const waterBasisValue = document.querySelector('#water-basis-value');
const elevationValue = document.querySelector('#elevation-value');
const fuelBasisValue = document.querySelector('#fuel-basis-value');
const windBasisValue = document.querySelector('#wind-basis-value');
const moistureBasisValue = document.querySelector('#moisture-basis-value');
const liveMoistureBasisValue = document.querySelector('#live-moisture-basis-value');
const slopeBasisValue = document.querySelector('#slope-basis-value');
const seedValue = document.querySelector('#seed-value');
const uncertaintyBasisValue = document.querySelector('#uncertainty-basis-value');
const fuelFieldQualityValue = document.querySelector('#fuel-field-quality-value');
const evidenceProfileValue = document.querySelector('#evidence-profile-value');
const metadataState = document.querySelector('#metadata-state');
const interpretationText = document.querySelector('#interpretation-text');
const directionValue = document.querySelector('#direction-value');
const guideScale = document.querySelector('#guide-scale');
const clearHistoryButton = document.querySelector('#clear-history-button');
const runHistoryList = document.querySelector('#run-history-list');
const metadataToggle = document.querySelector('#metadata-toggle');
const rangeInputs = [windSpeedInput, windDirectionInput, moistureInput, liveMoistureInput, slopeInput];
const conditionPanel = document.querySelector('#condition-panel');
const simulationPanel = document.querySelector('#simulation-panel');
const hoverPausePanels = [conditionPanel, simulationPanel];

// Block-scale retarget (scope change, not a mode toggle — see README §
// "Block scale" and CLAUDE.md). Field is now 640 m at 10 m/cell, matching
// ESA WorldCover's native resolution (worldCoverFine.js). Grid stays 64.
// There is no accuracy claim at this scale: the 6-fire benchmark this model
// is scored against runs 76k-151k acres; a 0.4 km² block is for legibility
// of individual buildings/streets, not validated physics.
const FIRE_GRID_SIZE = 64;
const FIRE_CELL_SIZE_KM = 0.01;
const FIRE_FIELD_DIAMETER_KM = FIRE_GRID_SIZE * FIRE_CELL_SIZE_KM;
const FIRE_FIELD_DIAMETER_METERS = Math.round(FIRE_FIELD_DIAMETER_KM * 1000);
// The model field is 640 m; this is a presentation enlargement only. The
// shader masks the enlarged footprint against the real Earth texture so it
// cannot paint over visible water.
const FIRE_DISPLAY_SCALE = 24;
// Block-scale default window: 120 minutes, not the regional model's 72 h.
// A 640 m field cannot hold a multi-day run inside its own boundary anyway.
const FIRE_GRID_CENTER = (FIRE_GRID_SIZE - 1) / 2;
const MODEL_TIMESTEP_MINUTES = 1;
const SIMULATION_SEED = 17;
const ENSEMBLE_MEMBER_COUNT = 8;
// These are deliberately labeled sensitivity bounds, not calibrated error
// bars. They perturb only inputs already identified as estimated or mapped.
const SENSITIVITY_PERTURBATIONS = Object.freeze({
  windFraction: 0.10,
  directionRadians: Math.PI / 36,
  moistureFraction: 0.02,
  liveMoistureFraction: 0.10,
  fuelAvailabilityFraction: 0.10,
  // Forest labels do not identify a unique surface fuel model. The
  // deterministic run keeps the primary crosswalk; the optional ensemble
  // samples only the explicit alternatives carried by the field.
  fuelModelAlternatives: true
});
// The rate-based, location-aware engine is now the product path. Keep the
// legacy engine available for controlled comparisons, but do not silently use
// it for a normal click.
const SIMULATION_ENGINE = 'phase1';
const EARTH_RADIUS_KM = 6371;
const SCENARIO_PRESETS = {
  calm: { scenario: 'calm', windSpeed: 0, windDirection: 0, deadMoisture: 8, liveMoisture: 60, slope: 0 },
  wind: { scenario: 'calm', windSpeed: 45, windDirection: 45, deadMoisture: 6, liveMoisture: 50, slope: 10 },
  slope: { scenario: 'slope', windSpeed: 0, windDirection: 0, deadMoisture: 8, liveMoisture: 60, slope: 100 },
  barrier: { scenario: 'barrier', windSpeed: 0, windDirection: 0, deadMoisture: 8, liveMoisture: 60, slope: 0 }
};

// ─────────────────────────────────────────────────────────────
// Renderer & scene
// ─────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 20000);
camera.position.set(0, 0, 4);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

// Post-processing: subtle bloom lifts the ember and star cores without
// crushing the earth into a smear of light.
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.42, // strength
  0.35, // radius — narrow so the atmosphere rim stays a rim
  0.88  // threshold — only the ember + star cores clear it
);
const outputPass = new OutputPass();
composer.addPass(renderPass);
composer.addPass(bloomPass);
composer.addPass(outputPass);

// ─────────────────────────────────────────────────────────────
// Sun & lighting (used both for the shader and for MeshStandard-friendly fallbacks)
// ─────────────────────────────────────────────────────────────
const SUN_DIRECTION = new THREE.Vector3(0.55, 0.35, 0.75).normalize();

// A trace of ambient so nothing goes to absolute zero — the shader owns the
// real day/night look; this only affects any incidental non-shader material.
scene.add(new THREE.AmbientLight(0xffffff, 0.05));
const sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
sunLight.position.copy(SUN_DIRECTION.clone().multiplyScalar(10));
scene.add(sunLight);

// ─────────────────────────────────────────────────────────────
// Groups
// ─────────────────────────────────────────────────────────────
let globeReady = false;
let pickedCoordinates = null;
let cesiumGlobe = null;
let globeLOD = null;
let fireDrape = null;
// P3: fire is draped on the Cesium globe in place; no camera cut.
const DRAPE_ON_GLOBE = true;

const fireWorker = new Worker(new URL('./workers/fireWorker.js', import.meta.url), { type: 'module' });

// Block scene: the globe stays the location picker; the camera drops into
// this local scene on a successful ignite. Fire replay reads the
// already-solved arrival-time field via setTime — never re-solves.
let blockSceneInstance = null;
let blockSceneActive = false;
let liveModelMinutes = 0;
const BLOCK_SCENE_CAMERA_DISTANCE = 500;
// The globe/starfield/atmosphere live at world-unit scale in the hundreds
// (starfield radius alone is 900). Offset the block scene far outside that
// so dropping the camera in never shows the globe bleeding through.
const BLOCK_SCENE_OFFSET = new THREE.Vector3(0, 8000, 0);

function rebuildBlockScene(fuelField, urbanFootprints) {
  blockSceneInstance?.dispose();
  scene.remove(...(blockSceneInstance ? [blockSceneInstance.group] : []));
  const burnableByCell = fuelField.fuelModelCodes.map((code) => code !== 'NB');
  const fuelColors = buildFuelColorField({
    gridSize: FIRE_GRID_SIZE,
    fuelModelCodes: fuelField.fuelModelCodes,
    burnableByCell,
    urbanCells: urbanFootprints?.raster?.cells ?? null
  });
  blockSceneInstance = createBlockScene({
    THREE,
    gridSize: FIRE_GRID_SIZE,
    cellSizeMeters: FIRE_CELL_SIZE_KM * 1000,
    fuelCellColors: fuelColors,
    buildings: urbanFootprints?.buildings ?? [],
    roads: urbanFootprints?.roads ?? []
  });
  blockSceneInstance.group.position.copy(BLOCK_SCENE_OFFSET);
  scene.add(blockSceneInstance.group);
  blockSceneActive = true;
  timelineScrub.disabled = false;
  timelineScrub.max = String(MAX_PROPAGATION_MINUTES);
}

function dropCameraIntoBlockScene() {
  camera.position.copy(BLOCK_SCENE_OFFSET)
    .add(new THREE.Vector3(0, BLOCK_SCENE_CAMERA_DISTANCE, BLOCK_SCENE_CAMERA_DISTANCE));
  camera.near = 1;
  camera.far = BLOCK_SCENE_OFFSET.length() + BLOCK_SCENE_CAMERA_DISTANCE * 10;
  camera.updateProjectionMatrix();
  controls.target.copy(BLOCK_SCENE_OFFSET);
  controls.update();
  cesiumGlobe?.setVisible(false);
  canvas.style.display = '';
}

function restoreGlobeCamera() {
  blockSceneActive = false;
  if (blockSceneInstance) {
    scene.remove(blockSceneInstance.group);
    blockSceneInstance.dispose();
    blockSceneInstance = null;
  }
  timelineScrub.disabled = true;
  timelineScrub.value = '0';
  timelineScrubValue.textContent = '0 min';
  canvas.style.display = 'none';
  cesiumGlobe?.setVisible(true);
  fireDrape?.clear();
}
let fireTexture = null;
let fireRunId = 0;
let terrainRequestId = 0;
let fireRunning = false;
let firePaused = false;
const terrainCache = new Map();
const TERRAIN_CACHE_LIMIT = 12;
let terrainMetadataStatus = 'Awaiting land';
let terrainMetadataHeights = null;
let terrainSamplingMetadata = null;
let weatherMetadataStatus = 'Scenario fallback';
let fineLandCoverStatus = 'Coarse WorldCover mosaic';
let fractionalCoverStatus = 'Optional Copernicus layer';
let canopyHeightStatus = 'Optional global canopy height';
let globalFuelbedStatus = 'Global FCCS fuelbed fallback';
let landfireFuelStatus = 'LANDFIRE FBFM40 unavailable · fallback';
let urbanFootprintStatus = 'Not fetched';
let ensembleMetadata = null;
let scenarioEvidence = null;
let lastWeather = null;
let lastLandCover = null;
let lastFuelDecision = null;
let scenarioRecords = loadScenarioRecords();
let activeScenarioContext = null;

// The Earth texture is a visual guard for clicks and overlay masking. Model
// water decisions go through resolveWaterEvidence so classified sources can
// take precedence when they are available.
function isMappedWaterAtLatLon(latitude, longitude) {
  return terrainSampler?.isWaterAtLatLon?.(latitude, longitude) === true
    || landCoverSource?.isWaterAtLatLon?.(latitude, longitude) === true;
}


// ─────────────────────────────────────────────────────────────
// Camera controls & interaction state
// ─────────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enableRotate = false;
controls.enablePan = false;
controls.zoomToCursor = false;
const earthClock = new THREE.Clock();

// ─────────────────────────────────────────────────────────────
// Terrain sampler — land/ocean classification independent of any
// rendering path. Cesium owns the visible imagery now; this loads the same
// source image directly for pixel-level water classification.
// ─────────────────────────────────────────────────────────────
let terrainSampler = null;
createTerrainSampler('/earth/textures/1_earth_8k.jpg', { sampleWidth: 4096, sampleHeight: 2048 })
  .then((sampler) => {
    terrainSampler = sampler;
  })
  .catch((error) => console.error('[terrain] sampler failed to load:', error));

// Phase 2 land-cover source. The preprocessed WorldCover mosaic PNG lives
// in public/ alongside its metadata sidecar. Phase1 waits for this source;
// unknown cells become non-burnable barriers instead of guessed fuel.
let landCoverSource = null;
let landCoverSourceStatus = 'loading';
async function loadLandCoverSource() {
  try {
    const [meta, image] = await Promise.all([
      fetch('/landcover-coarse.json').then((r) => r.ok ? r.json() : null),
      loadImageElement('/landcover-coarse.png')
    ]);
    if (!meta || !image) {
      landCoverSourceStatus = 'unavailable';
      return;
    }
    landCoverSource = await createLandCoverSource({
      pngUrl: '/landcover-coarse.png',
      meta,
      imageReader: async () => createCanvasImageReader(image)
    });
    landCoverSourceStatus = 'ready';
    console.info('[landcover] loaded', meta.source, meta.mosaic);
  } catch (error) {
    landCoverSourceStatus = 'unavailable';
    console.warn('[landcover] source unavailable, falling back to experimental crosswalk:', error);
  }

}

async function fetchFineLandCoverAtLatLon(latitude, longitude) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 2_500) : null;
  try {
    const query = new URLSearchParams({ lat: String(latitude), lon: String(longitude) });
    const response = await fetch(`/api/landcover/fine?${query}`, controller ? { signal: controller.signal } : undefined);
    if (!response.ok) return null;
    const payload = await response.json();
    if (!Number.isInteger(payload?.classCode)) return null;
    return payload;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchCanopyHeightAtLatLon(latitude, longitude) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 2_500) : null;
  try {
    const query = new URLSearchParams({ lat: String(latitude), lon: String(longitude) });
    const response = await fetch(`/api/canopy/height?${query}`, controller ? { signal: controller.signal } : undefined);
    if (!response.ok) return null;
    const payload = await response.json();
    return classifyCanopyHeight(payload?.heights?.[0]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchCopernicusLandCoverAtLatLon(latitude, longitude) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 2_500) : null;
  try {
    const query = new URLSearchParams({ lat: String(latitude), lon: String(longitude) });
    const response = await fetch('/api/landcover/fractions?' + query, controller ? { signal: controller.signal } : undefined);
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload.available !== true || !payload.coverFractions) return null;
    fractionalCoverStatus = 'Copernicus 100 m fractions';
    return payload;
  } catch (error) {
    console.info('[landcover] Copernicus point fractions unavailable:', error?.message ?? error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// At the block-scale 10 m cell size the model cell *is* one WorldCover
// pixel: WORLD_COVER_FINE_SAMPLE_OFFSETS' 4x4 subsample grid was sized to
// spread across a 500 m cell and would now land 16 samples inside one
// 10 m pixel. Sample the cell centre once and skip the majority vote —
// there is nothing to vote between.
const BLOCK_SCALE_SAMPLE_OFFSETS = Object.freeze([0]);

async function fetchUrbanFootprintsField(grid) {
  const bbox = gridBbox(grid);
  if (!bbox) {
    urbanFootprintStatus = 'Not fetched';
    return { available: false, buildings: [], roads: [], green: [], raster: null };
  }
  try {
    const result = await fetchUrbanFootprintsForBbox(
      [bbox[1], bbox[0], bbox[3], bbox[2]],
      {
        originLatitude: grid.origin.latitude,
        originLongitude: grid.origin.longitude,
        gridSize: grid.gridSize,
        cellSizeMeters: grid.cellSizeMeters
      }
    );
    urbanFootprintStatus = result.available
      ? `OSM Overpass · ${result.raster?.summary.buildingCells ?? 0} building / ${result.raster?.summary.roadCells ?? 0} road cells`
      : 'OSM Overpass unavailable · WorldCover only';
    return result;
  } catch (error) {
    console.info('[urban] footprints unavailable:', error?.message ?? error);
    urbanFootprintStatus = 'OSM Overpass unavailable · WorldCover only';
    return { available: false, buildings: [], roads: [], green: [], raster: null };
  }
}

async function fetchFineLandCoverField(grid) {
  const samples = [];
  for (let row = 0; row < grid.gridSize; row += 1) {
    for (let col = 0; col < grid.gridSize; col += 1) {
      for (const rowOffset of BLOCK_SCALE_SAMPLE_OFFSETS) {
        for (const colOffset of BLOCK_SCALE_SAMPLE_OFFSETS) {
          const { latitude, longitude } = grid.cellCenterLatLon(row + rowOffset, col + colOffset);
          samples.push({ latitude, longitude });
        }
      }
    }
  }
  const batches = createWorldCoverFineSampleBatches(samples);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 30_000) : null;
  try {
    const classifications = new Array(samples.length);
    let successfulBatchCount = 0;
    await mapWithConcurrency(batches, WORLD_COVER_FINE_REQUEST_CONCURRENCY, async (batch) => {
      try {
        const batchClassifications = await fetchFineLandCoverBatch(batch, {
          signal: controller?.signal,
          maxAttempts: WORLD_COVER_FINE_BATCH_RETRIES
        });
        for (let index = 0; index < batchClassifications.length; index += 1) {
          classifications[batch.startIndex + index] = batchClassifications[index];
        }
        successfulBatchCount += 1;
      } catch (error) {
        // A failed tile must not discard successful native samples from the
        // rest of the field. Missing cells fall back to the coarse source.
        console.info('[landcover] fine field batch unavailable:', error?.message ?? error);
      }
    });
    const validSampleCount = classifications.reduce(
      (count, classification) => count + (classification ? 1 : 0),
      0
    );
    const coverage = summarizeWorldCoverFineCoverage({
      totalSampleCount: samples.length,
      validSampleCount,
      totalBatchCount: batches.length,
      successfulBatchCount
    });
    if (successfulBatchCount === 0) {
      throw new Error('fine field returned no successful batches');
    }
    // samplesPerCell = 1: this degenerates aggregateWorldCoverFineSamples's
    // majority vote into a direct pass-through of the single centre sample.
    const aggregatedClassifications = aggregateWorldCoverFineSamples(classifications, {
      gridSize: grid.gridSize,
      samplesPerCell: BLOCK_SCALE_SAMPLE_OFFSETS.length ** 2
    });
    const coverageLabel = coverage.complete
      ? 'complete'
      : `${Math.round(coverage.sampleCoverageFraction * 100)}% samples · ${coverage.successfulBatchCount}/${coverage.totalBatchCount} batches`;
    fineLandCoverStatus = `WorldCover 10 m COG (native) · 1 centre sample/cell · ${coverageLabel}`;
    return {
      classifications: aggregatedClassifications,
      sampleClassifications: classifications,
      source: classifications.find(Boolean)?.source ?? 'ESA WorldCover 2021 v200 · 10 m COG',
      resolutionMeters: 10,
      requestCount: batches.length,
      ...coverage
    };
  } catch (error) {
    console.info('[landcover] fine field unavailable; using coarse global mosaic:', error?.message ?? error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchGlobalFuelbedField(grid) {
  const samples = [];
  for (let row = 0; row < grid.gridSize; row += 1) {
    for (let col = 0; col < grid.gridSize; col += 1) {
      samples.push(grid.cellCenterLatLon(row, col));
    }
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 75_000) : null;
  try {
    const response = await fetch('/api/fuelbed/global-field', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ samples }),
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) throw new Error(`global fuelbed field failed with HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.available !== true
      || !Array.isArray(payload.fuelbeds)
      || payload.fuelbeds.length !== samples.length) {
      throw new Error('global fuelbed field returned an unexpected sample count');
    }
    const availableCount = payload.fuelbeds.reduce((count, value) => count + (value ? 1 : 0), 0);
    globalFuelbedStatus = availableCount > 0
      ? `Global FCCS v1.2 · ${availableCount}/${samples.length} cells`
      : 'Global FCCS no coverage · WorldCover fallback';
    return payload.fuelbeds;
  } catch (error) {
    console.info('[fuelbed] global FCCS field unavailable; using WorldCover fallback:', error?.message ?? error);
    globalFuelbedStatus = 'Global FCCS unavailable · WorldCover fallback';
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchCanopyHeightField(grid) {
  const samples = [];
  for (let row = 0; row < grid.gridSize; row += 1) {
    for (let col = 0; col < grid.gridSize; col += 1) {
      for (const rowOffset of CANOPY_HEIGHT_SAMPLE_OFFSETS) {
        for (const colOffset of CANOPY_HEIGHT_SAMPLE_OFFSETS) {
          const { latitude, longitude } = grid.cellCenterLatLon(row + rowOffset, col + colOffset);
          samples.push({ latitude, longitude });
        }
      }
    }
  }
  const batches = createWorldCoverFineSampleBatches(samples);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 30_000) : null;
  try {
    const heightSamples = new Array(samples.length);
    await mapWithConcurrency(batches, WORLD_COVER_FINE_REQUEST_CONCURRENCY, async (batch) => {
      const response = await fetch('/api/canopy/height-field', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ samples: batch.samples }),
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!response.ok) throw new Error(`canopy height batch failed with HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload?.heights) || payload.heights.length !== batch.samples.length) {
        throw new Error('canopy height batch returned an unexpected sample count');
      }
      for (let index = 0; index < payload.heights.length; index += 1) {
        heightSamples[batch.startIndex + index] = classifyCanopyHeight(payload.heights[index]);
      }
    });
    const aggregate = aggregateCanopyHeightSamples(heightSamples, {
      gridSize: grid.gridSize,
      samplesPerCell: CANOPY_HEIGHT_SAMPLES_PER_CELL
    });
    const values = new Float32Array(aggregate.length);
    values.fill(-1);
    let validCellCount = 0;
    aggregate.forEach((sample, index) => {
      if (!sample) return;
      values[index] = sample.heightMeters;
      validCellCount += 1;
    });
    canopyHeightStatus = `Canopy height 10 m · ${validCellCount}/${aggregate.length} cells`;
    return { values, validCellCount, requestCount: batches.length };
  } catch (error) {
    console.info('[canopy] field unavailable; retaining land-cover shelter fallback:', error?.message ?? error);
    canopyHeightStatus = 'Canopy height unavailable · land-cover shelter fallback';
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchLandfireCanopyField(grid) {
  const bbox = gridBbox(grid);
  if (!bbox) return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 20_000) : null;
  try {
    const response = await fetch('/api/canopy/landfire-field', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bbox, width: grid.gridSize, height: grid.gridSize }),
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload.available !== true
      || !Array.isArray(payload.canopyHeightMeters)
      || !Array.isArray(payload.canopyCoverFraction)
      || !Array.isArray(payload.canopyBaseHeightMeters)
      || !Array.isArray(payload.canopyBulkDensityKgPerM3)
      || payload.canopyHeightMeters.length !== grid.gridSize * grid.gridSize
      || payload.canopyCoverFraction.length !== grid.gridSize * grid.gridSize
      || payload.canopyBaseHeightMeters.length !== grid.gridSize * grid.gridSize
      || payload.canopyBulkDensityKgPerM3.length !== grid.gridSize * grid.gridSize) {
      return null;
    }
    const canopyHeightByCell = new Float32Array(payload.canopyHeightMeters.length);
    const canopyCoverFractionByCell = new Float32Array(payload.canopyCoverFraction.length);
    const canopyBaseHeightByCell = new Float32Array(payload.canopyBaseHeightMeters.length);
    const canopyBulkDensityByCell = new Float32Array(payload.canopyBulkDensityKgPerM3.length);
    canopyHeightByCell.fill(-1);
    canopyCoverFractionByCell.fill(-1);
    canopyBaseHeightByCell.fill(-1);
    canopyBulkDensityByCell.fill(-1);
    payload.canopyHeightMeters.forEach((value, index) => {
      if (Number.isFinite(value) && value > 0) canopyHeightByCell[index] = value;
    });
    payload.canopyCoverFraction.forEach((value, index) => {
      if (Number.isFinite(value) && value >= 0 && value <= 1) canopyCoverFractionByCell[index] = value;
    });
    payload.canopyBaseHeightMeters.forEach((value, index) => {
      if (Number.isFinite(value) && value >= 0) canopyBaseHeightByCell[index] = value;
    });
    payload.canopyBulkDensityKgPerM3.forEach((value, index) => {
      if (Number.isFinite(value) && value > 0) canopyBulkDensityByCell[index] = value;
    });
    return {
      source: payload.source,
      canopyHeightByCell,
      canopyCoverFractionByCell,
      canopyBaseHeightByCell,
      canopyBulkDensityByCell,
      canopyWindStructureCellCount: Number(payload.canopyWindStructureCellCount) || 0,
      crownStructureCellCount: Number(payload.crownStructureCellCount) || 0
    };
  } catch (error) {
    console.info('[canopy] LANDFIRE structure unavailable; crown behavior stays disabled:', error?.message ?? error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchLandfireFuelField(grid) {
  const bbox = gridBbox(grid);
  if (!bbox) return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 25_000) : null;
  try {
    const response = await fetch('/api/fuel/landfire-field', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bbox, width: grid.gridSize, height: grid.gridSize }),
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) {
      landfireFuelStatus = 'LANDFIRE FBFM40 unavailable · fallback';
      return null;
    }
    const payload = await response.json();
    const expectedLength = grid.gridSize * grid.gridSize;
    if (payload.available !== true
      || !Array.isArray(payload.fuelModelCodes)
      || payload.fuelModelCodes.length !== expectedLength) {
      landfireFuelStatus = payload.reason === 'outside_conus_coverage'
        ? 'LANDFIRE FBFM40 outside CONUS · fallback'
        : payload.reason === 'insufficient_valid_coverage'
          ? 'LANDFIRE FBFM40 partial coverage · fallback'
        : 'LANDFIRE FBFM40 unavailable · fallback';
      return null;
    }
    const validCellCount = payload.fuelModelCodes.filter(Boolean).length;
    const validCellFraction = Number(payload.validCellFraction);
    if (validCellCount === 0 || !Number.isFinite(validCellFraction)
      || validCellFraction < LANDFIRE_FUEL_MIN_VALID_FRACTION) {
      landfireFuelStatus = 'LANDFIRE FBFM40 returned no valid cells · fallback';
      return null;
    }
    landfireFuelStatus = `${LANDFIRE_FUEL_SOURCE} · ${validCellCount}/${expectedLength} cells (${Math.round(validCellFraction * 100)}%)`;
    return {
      source: payload.source ?? LANDFIRE_FUEL_SOURCE,
      resolutionMeters: Number(payload.resolutionMeters) || 30,
      fuelModelCodes: payload.fuelModelCodes,
      validCellCount,
      validCellFraction,
      modelCounts: payload.modelCounts ?? null,
      geometry: payload.geometry ?? null
    };
  } catch (error) {
    console.info('[fuel] LANDFIRE FBFM40 unavailable; retaining global fallback:', error?.message ?? error);
    landfireFuelStatus = 'LANDFIRE FBFM40 unavailable · fallback';
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchFineLandCoverBatch(batch, { signal = null, maxAttempts = 1 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch('/api/landcover/fine-field', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ samples: batch.samples }),
        ...(signal ? { signal } : {})
      });
      if (!response.ok) throw new Error(`fine field batch failed with HTTP ${response.status}`);
      const payload = await response.json();
      const classifications = normalizeWorldCoverFineSamples(payload);
      if (!classifications || classifications.length !== batch.samples.length) {
        throw new Error('fine field batch returned an unexpected sample count');
      }
      return classifications;
    } catch (error) {
      lastError = error;
      if (signal?.aborted || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250 * (2 ** (attempt - 1)), 1000)));
    }
  }
  throw lastError ?? new Error('fine field batch failed without an error');
}

async function mapWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  }));
}

async function fetchCopernicusLandCoverField(grid) {
  const bbox = gridBbox(grid);
  if (!bbox) return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 15_000) : null;
  try {
    const response = await fetch('/api/landcover/fractions-field', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bbox, width: grid.gridSize, height: grid.gridSize }),
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload.available !== true
      || !Array.isArray(payload.samples)
      || payload.samples.length !== grid.gridSize * grid.gridSize) {
      return null;
    }
    fractionalCoverStatus = 'Copernicus 100 m fractions';
    return payload;
  } catch (error) {
    console.info('[landcover] Copernicus field fractions unavailable:', error?.message ?? error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function gridBbox(grid) {
  const corners = [
    grid.cellCenterLatLon(0, 0),
    grid.cellCenterLatLon(0, grid.gridSize - 1),
    grid.cellCenterLatLon(grid.gridSize - 1, 0),
    grid.cellCenterLatLon(grid.gridSize - 1, grid.gridSize - 1)
  ];
  const longitudes = corners.map((point) => point.longitude);
  const latitudes = corners.map((point) => point.latitude);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  if (east - west > 180) return null;
  const latitudePad = grid.cellSizeMeters / 111320;
  const longitudePad = latitudePad / Math.max(Math.cos(grid.origin.latitude * Math.PI / 180), 0.1);
  return [
    Math.max(-180, west - longitudePad),
    Math.max(-90, Math.min(...latitudes) - latitudePad),
    Math.min(180, east + longitudePad),
    Math.min(90, Math.max(...latitudes) + latitudePad)
  ];
}

function attachFractionalCover(landCover, fractionalSample) {
  if (!landCover || !fractionalSample?.coverFractions) return landCover;
  return {
    ...landCover,
    coverFractions: fractionalSample.coverFractions,
    fractionalCoverSource: fractionalSample.source,
    fractionalCoverResolutionMeters: fractionalSample.resolutionMeters,
    fractionalCoverConfidence: fractionalSample.sourceConfidence
  };
}

function isFractionalWater(fractionalSample) {
  const fractions = fractionalSample?.coverFractions;
  if (!fractions) return false;
  const permanent = Number.isFinite(fractions.permanentWaterCoverFraction)
    ? fractions.permanentWaterCoverFraction
    : 0;
  const seasonal = Number.isFinite(fractions.seasonalWaterCoverFraction)
    ? fractions.seasonalWaterCoverFraction
    : 0;
  return permanent + seasonal >= FRACTIONAL_WATER_BARRIER_THRESHOLD_PERCENT;
}

function fieldSampleAtLatLon(grid, field, latitude, longitude) {
  if (!field?.samples) return null;
  const cell = grid.latLonToCell(latitude, longitude);
  const row = Math.round(cell.row);
  const col = Math.round(cell.col);
  if (row < 0 || row >= grid.gridSize || col < 0 || col >= grid.gridSize) return null;
  return field.samples[row * grid.gridSize + col] ?? null;
}

function loadImageElement(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}
loadLandCoverSource();

canvas.style.display = 'none';
try {
  cesiumGlobe = initCesiumGlobe();
  // P5: altitude-gated photoreal-tiles <-> shaded terrain globe swap.
  globeLOD = initGlobeLOD(cesiumGlobe.viewer, cesiumGlobe.tilesetPromise);
  // P6: same flat overlay as before, plus volumetric flames up close.
  fireDrape = createFireLOD(cesiumGlobe.viewer);
  globeReady = true;
  if (import.meta.env.DEV) window.__ignis = { viewer: cesiumGlobe.viewer, fireDrape, globe: cesiumGlobe, globeLOD };
  cesiumGlobe.onGlobeClick(({ lat, lon, groundHeightMeters }) => handleGlobeClick(lat, lon, groundHeightMeters));
  cesiumGlobe.onPickRefused((message) => {
    resetFireSimulation();
    panelStatus.dataset.mode = 'blocked';
    statusText.textContent = message;
    simulationReadout.textContent = 'No ignition — click did not resolve to a confident surface point';
    simulationNote.textContent = message;
  });
} catch (error) {
  console.error('[main] Cesium globe failed to initialize — clicks will not work:', error);
}
if (loadingEl) {
  loadingEl.style.opacity = '0';
  setTimeout(() => loadingEl.remove(), 320);
}

// ─────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────
function handleGlobeClick(lat, lon, groundHeightMeters = 0) {
  if (!globeReady) return;
  const coordinates = { latitude: lat, longitude: lon };
  const isOcean = terrainSampler ? terrainSampler.isWaterAtLatLon(lat, lon) : null;

  updateConditionPanel(coordinates, isOcean);

  // terrainSampler classifies against landcover-coarse.png, a ~1km mosaic
  // where an entire coastal strip (piers, waterfront parks) reads as ocean.
  // On DRAPE_ON_GLOBE, runFromClick's 10m WorldCover field is the real water
  // test, so this coarse check is advisory only here — it still blocks on
  // the legacy (!DRAPE_ON_GLOBE) globe, which has no finer check to defer to.
  if (!DRAPE_ON_GLOBE && !canIgniteSurface(isOcean)) {
    resetFireSimulation();
    panelStatus.dataset.mode = 'blocked';
    statusText.textContent = surfaceIgnitionMessage(isOcean);
    simulationReadout.textContent = isOcean === true
      ? 'Select a land surface to ignite'
      : 'Surface classification unavailable · try again';
    simulationNote.textContent = isOcean === true
      ? 'Ocean surface · fire ignition disabled'
      : 'Surface classification required before ignition';
    setTerrainMetadata(isOcean === true ? 'Ocean · no ignition' : 'Surface unknown');
    return;
  }
  if (DRAPE_ON_GLOBE && isOcean === true) {
    console.info('[handleGlobeClick] coarse check says ocean — proceeding anyway, runFromClick has the real water test');
  }

  if (SIMULATION_ENGINE === 'phase1' && !landCoverSource) {
    resetFireSimulation();
    panelStatus.dataset.mode = 'blocked';
    statusText.textContent = landCoverSourceStatus === 'loading'
      ? 'Loading global land-cover field'
      : 'Global land-cover field unavailable';
    simulationReadout.textContent = 'Waiting for location-specific fuel data';
    simulationNote.textContent = 'Fire model paused until land-cover data is available';
    return;
  }

  // Classify the clicked location for scenario metadata. The phase1 worker
  // also builds the complete local field from this same source.
  const landCover = landCoverSource
    ? landCoverSource.classifyAtLatLon(coordinates.latitude, coordinates.longitude)
    : null;
  const fuelDecision = crosswalkLandCoverToFuel(landCover);
  lastLandCover = landCover;
  lastFuelDecision = fuelDecision;
  console.info('[landcover]',
    landCover ? `${landCover.className} (WC ${landCover.classCode})` : 'no coverage',
    `→ ${fuelDecision.fuelCode} (${fuelDecision.confidence})`);

  // Same coarse-mosaic problem as the ocean check above: landCoverSource is
  // the ~1km landcover-coarse.png, which misclassifies plenty of real fuel
  // (this exact lawn included). On DRAPE_ON_GLOBE, startFireSimulation/
  // runFromClick reclassify from 10m WorldCover independently — so let a
  // coarse "non-burnable" through here and let those checks have the final
  // word, same as the ocean gate right above.
  if (DRAPE_ON_GLOBE && !canIgniteFuelDecision(fuelDecision)) {
    console.info('[handleGlobeClick] coarse check says non-burnable — proceeding anyway, fine-resolution checks decide');
  } else if (!canIgniteFuelDecision(fuelDecision)) {
    resetFireSimulation();
    panelStatus.dataset.mode = 'blocked';
    statusText.textContent = 'Non-burnable surface · no ignition';
    simulationReadout.textContent = 'Select a burnable land surface';
    simulationNote.textContent = fuelDecision.rationale;
    setTerrainMetadata('Non-burnable surface');
    return;
  }

  pickedCoordinates = coordinates;
  // Tilted aerial framing, fired immediately on click. This must NOT wait on
  // runFromClick — that blocks on an Overpass round trip, so the camera would
  // sit top-down for seconds and never move at all if the fetch rejects.
  if (DRAPE_ON_GLOBE) cesiumGlobe?.flyToAerial({ latitude: lat, longitude: lon, groundHeightMeters });
  startFireSimulation(coordinates);

  // P3: real WorldCover + OSM ignition, draped onto the globe in place. The
  // block-scene run above still drives the timeline clock and metrics panels.
  // The scenario sliders override live weather on this path too, matching the
  // block scene: a non-zero wind slider wins, otherwise Open-Meteo drives it.
  const sliderParams = getSimulationParams();
  runFromClick({
    lat,
    lon,
    overrides: {
      windSpeed: sliderParams.windSpeed,
      windDirection: sliderParams.windDirection,
      deadMoisture: sliderParams.deadMoisture,
      liveMoisture: sliderParams.liveMoisture,
      slopeStrength: sliderParams.slopeStrength,
      useWeatherMoisture: sliderParams.useWeatherMoisture
    }
  }).then((result) => {
    const m = result.metrics;
    // The four diagnostics that actually explain an ignition outcome.
    console.info('[runFromClick]', {
      burnedCellCount: m.burnedCellCount,
      burnableCellCount: m.burnableCellCount,
      nonBurnableCellCount: m.nonBurnableCellCount,
      maxFiniteArrivalMinutes: Number(m.maxFiniteArrivalMinutes.toFixed(2))
    }, `· ${result.buildings.length} buildings · ${result.roads.length} road segments`, result.provenance);
    if (DRAPE_ON_GLOBE) {
      fireDrape?.show(result);
      startDrapePlayback(result);
    }
  }).catch((error) => console.warn('[runFromClick] failed:', error));
}

// Drape playback. The solver returns every cell's arrival time up front, so
// "playing" is just advancing a clock across that field — nothing re-solves.
//
// This exists because terminationReason === 'horizon_reached' was being
// treated as terminal. It is not: firePropagation records a horizon-limited
// cell for ANY cell whose travel time lands past the cap, which happens on
// nearly every run, so playback stopped before the fire had visibly moved.
// Playback now always runs to maxFiniteArrivalMinutes — the last time
// anything actually ignites — and only then reports an outcome.
function formatDrapeOutcome({ burnedCellCount, maxFiniteArrivalMinutes, cellAreaSquareMeters }) {
  if (burnedCellCount === 0) return 'No burnable fuel at this location';
  if (burnedCellCount < 10) return `Fire contained by roads and structures (${burnedCellCount} cells)`;
  const hectares = (burnedCellCount * cellAreaSquareMeters) / 10_000;
  const minutes = Math.round(maxFiniteArrivalMinutes);
  return `Burned ${hectares.toFixed(hectares < 1 ? 2 : 1)} ha in ${minutes} min`;
}

// Playback is owned by the overlay's own clock (one uTime uniform advanced on
// viewer.clock.onTick). main.js used to run a second, competing rAF loop that
// pushed setTime every frame; that fought the overlay clock and pinned it to
// paused. This now only mirrors the overlay's time onto the scrub UI.
function startDrapePlayback(result) {
  const metrics = result.metrics;
  const endMinutes = metrics.maxFiniteArrivalMinutes;

  timelineScrub.disabled = false;
  timelineScrub.max = String(Math.max(1, Math.ceil(endMinutes)));

  if (metrics.burnedCellCount === 0 || endMinutes <= 0) {
    fireDrape?.setTime(0);
    panelStatus.dataset.mode = 'armed';
    statusText.textContent = formatDrapeOutcome(metrics);
    simulationNote.textContent = `${metrics.burnableCellCount} burnable · ${metrics.nonBurnableCellCount} non-burnable cells`;
    return;
  }

  panelStatus.dataset.mode = 'running';
  statusText.textContent = 'Simulation running · local scenario';

  fireDrape?.onTime((minutes) => {
    liveModelMinutes = minutes;
    if (Number(timelineScrub.dataset.scrubbing) !== 1) {
      timelineScrub.value = String(minutes);
      timelineScrubValue.textContent = formatModelTime(minutes);
    }
    if (minutes >= endMinutes && panelStatus.dataset.mode === 'running') {
      panelStatus.dataset.mode = 'armed';
      statusText.textContent = formatDrapeOutcome(metrics);
      simulationNote.textContent = `${metrics.burnedCellCount}/${metrics.burnableCellCount} burnable cells reached · ${metrics.nonBurnableCellCount} non-burnable`;
    }
  });
  fireDrape?.play();
}

function updateConditionPanel(coordinates, isOcean) {
  locationValue.textContent = formatLocationLabel(coordinates.latitude, coordinates.longitude, isOcean);
  latitudeValue.textContent = formatCoord(coordinates.latitude, 'lat');
  longitudeValue.textContent = formatCoord(coordinates.longitude, 'lon');
  latitudeValue.classList.remove('placeholder');
  longitudeValue.classList.remove('placeholder');
  panelStatus.dataset.mode = 'armed';
  statusText.textContent = 'Location armed · ignition ready';
}

function formatCoord(value, axis) {
  const hemisphere = axis === 'lat'
    ? (value >= 0 ? 'N' : 'S')
    : (value >= 0 ? 'E' : 'W');
  const magnitude = Math.abs(value);
  const degrees = Math.floor(magnitude);
  const minutes = (magnitude - degrees) * 60;
  return `${degrees.toString().padStart(axis === 'lat' ? 2 : 3, '0')}° ${minutes.toFixed(3).padStart(6, '0')}′ ${hemisphere}`;
}

function createFireDataTexture() {
  fireTexture?.dispose();
  fireTexture = new THREE.DataTexture(
    new Uint8Array(FIRE_GRID_SIZE * FIRE_GRID_SIZE * 4),
    FIRE_GRID_SIZE,
    FIRE_GRID_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  fireTexture.minFilter = THREE.LinearFilter;
  fireTexture.magFilter = THREE.LinearFilter;
  fireTexture.wrapS = THREE.ClampToEdgeWrapping;
  fireTexture.wrapT = THREE.ClampToEdgeWrapping;
  fireTexture.needsUpdate = true;
  return fireTexture;
}


function getSimulationParams() {
  return {
    fuelPreset: fuelSelect.value,
    windSpeed: Number(windSpeedInput.value),
    windDirection: Number(windDirectionInput.value),
    moisture: Number(moistureInput.value) / 100,
    deadMoisture: Number(moistureInput.value) / 100,
    liveMoisture: Number(liveMoistureInput.value) / 100,
    useWeatherMoisture: weatherMoistureToggle?.checked ?? true,
    useUncertaintyEnsemble: uncertaintyToggle?.checked ?? false,
    slopeStrength: Number(slopeInput.value) / 100
  };
}

function getScenarioConfig() {
  return SCENARIO_PRESETS[scenarioSelect.value] ?? SCENARIO_PRESETS.calm;
}

function applyScenarioPreset() {
  const preset = getScenarioConfig();
  windSpeedInput.value = String(preset.windSpeed);
  windDirectionInput.value = String(preset.windDirection);
  moistureInput.value = String(preset.deadMoisture ?? preset.moisture ?? 8);
  liveMoistureInput.value = String(preset.liveMoisture ?? preset.deadMoisture ?? preset.moisture ?? 60);
  slopeInput.value = String(preset.slope);
  updateSimulationLabels();
  if (fireRunning) {
    fireWorker.postMessage({
      type: 'update',
      scenario: preset.scenario,
      params: getSimulationParams()
    });
    simulationReadout.textContent = 'Scenario updated · recalculating field';
  }
}

function updateSimulationLabels() {
  windSpeedValue.textContent = `${windSpeedInput.value} km/h`;
  windDirectionValue.textContent = `${windDirectionInput.value.padStart(3, '0')}°`;
  moistureValue.textContent = `${moistureInput.value}%`;
  liveMoistureValue.textContent = `${liveMoistureInput.value}%`;
  slopeValue.textContent = `${slopeInput.value}%`;
  syncRangeFills();
  updateScenarioMetadata();
}

// Presentation only: sets a --fill custom property (0-100%) on each range
// input so the CSS track can render a filled/unfilled split. Never reads
// simulation state, never writes anything the worker consumes.
function syncRangeFills() {
  for (const input of rangeInputs) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const percent = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', `${Math.max(0, Math.min(100, percent))}%`);
  }
}

// Presentation only: a brief one-shot highlight so a meaningful moment
// (ignition, settle) reads as a distinct event rather than blending into
// the constant per-frame metric text updates.
function flashPanels(...panels) {
  for (const panel of panels) {
    if (!panel) continue;
    panel.classList.remove('ignite-flash');
    // Force reflow so re-adding the class restarts the animation.
    void panel.offsetWidth;
    panel.classList.add('ignite-flash');
  }
}

function flashMetricChips() {
  document.querySelectorAll('.simulation-metrics > div').forEach((chip) => {
    chip.classList.remove('metric-flash');
    void chip.offsetWidth;
    chip.classList.add('metric-flash');
  });
}

function setTerrainMetadata(status, heights = null) {
  terrainMetadataStatus = status;
  terrainMetadataHeights = heights;
  updateScenarioMetadata();
}

function updateScenarioMetadata() {
  const fuelLabel = fuelSelect.selectedOptions[0]?.textContent ?? fuelSelect.value;
  const windDirection = windDirectionInput.value.padStart(3, '0');
  const params = getSimulationParams();
  modelValue.textContent = `Rothermel · ${SIMULATION_ENGINE} · ${MODEL_TIMESTEP_MINUTES} min/tick`;
  terrainValue.textContent = terrainMetadataStatus;
  waterBasisValue.textContent = fineLandCoverStatus + ' + ' + fractionalCoverStatus + ' + Earth 4k';
  elevationValue.textContent = formatElevationRange(terrainMetadataHeights);
  fuelBasisValue.textContent = formatFuelBasisLabel(fuelLabel);
  windBasisValue.textContent = weatherMetadataStatus === 'Scenario fallback'
    ? `${windDirection}° · ${windSpeedInput.value} km/h`
    : `${weatherMetadataStatus} · ${lastWeather?.wind?.midflameSpeedKmh?.toFixed(1) ?? '—'} km/h`;
  const estimatedMoisture = lastWeather?.fuelMoisture?.byClass;
  const estimatedLiveMoisture = lastWeather?.liveFuelMoisture?.byClass;
  moistureBasisValue.textContent = weatherMoistureToggle?.checked && estimatedMoisture
    ? `1h ${Math.round(estimatedMoisture['1h'] * 100)}% · 10h ${Math.round(estimatedMoisture['10h'] * 100)}% · 100h ${Math.round(estimatedMoisture['100h'] * 100)}%`
    : `${moistureInput.value}% manual`;
  liveMoistureBasisValue.textContent = weatherMoistureToggle?.checked && estimatedLiveMoisture
    ? `Herb ${Math.round(estimatedLiveMoisture.herbaceous * 100)}% · woody ${Math.round(estimatedLiveMoisture.woody * 100)}%`
    : `${liveMoistureInput.value}% manual`;
  slopeBasisValue.textContent = `${slopeInput.value}%`;
  const cellSizeMetersLabel = Math.round(FIRE_CELL_SIZE_KM * 1000);
  const fieldSizeMetersLabel = Math.round(FIRE_FIELD_DIAMETER_KM * 1000);
  scaleValue.textContent = `Block scale · ${cellSizeMetersLabel} m cells · ${fieldSizeMetersLabel} m field`;
  urbanBasisValue.textContent = urbanFootprintStatus;
  spottingBasisValue.textContent = 'Off · field narrower than max ember flight distance';
  seedValue.textContent = String(SIMULATION_SEED);
  uncertaintyBasisValue.textContent = params.useUncertaintyEnsemble
    ? (ensembleMetadata
      ? `${ensembleMetadata.memberCount}-member range`
      : 'Loading range')
    : 'Deterministic';
  evidenceProfileValue.textContent = formatScenarioEvidence(scenarioEvidence);
  metadataState.textContent = terrainMetadataStatus;
  guideScale.textContent = `${Math.round(FIRE_FIELD_DIAMETER_KM * 1000)} m field`;
}

// Keep the selected scenario label alongside the location-derived WorldCover
// crosswalk so the scenario basis remains inspectable.
function formatFuelBasisLabel(legacyDropdownLabel) {
  if (!lastFuelDecision) return legacyDropdownLabel;
  const confidence = lastFuelDecision.confidence;
  const wcName = lastLandCover?.className ?? 'unavailable';
  const scale = Number.isFinite(lastFuelDecision.fuelLoadScale)
    ? ` · fuel x${lastFuelDecision.fuelLoadScale.toFixed(2)}`
    : '';
  const fractional = lastFuelDecision.fractionalCoverUsed ? ' · 100 m fractions' : '';
  const alternatives = lastFuelDecision.fuelModelAlternatives?.length > 1
    ? ` · ${lastFuelDecision.fuelModelAlternatives.length} forest variants`
    : '';
  const global = lastFuelDecision.globalFuelbedId
    ? ` · FCCS ${lastFuelDecision.globalFuelbedId}`
    : (globalFuelbedStatus.includes('fallback') || globalFuelbedStatus.includes('unavailable')
      ? ` · ${globalFuelbedStatus}`
      : '');
  const regional = lastFuelDecision.landfireFuelModelCode
    ? ` · LANDFIRE ${lastFuelDecision.landfireFuelModelCode} (${lastFuelDecision.landfireFuelResolutionMeters ?? 30} m)`
    : (landfireFuelStatus.includes('fallback') || landfireFuelStatus.includes('unavailable')
      ? ` · ${landfireFuelStatus}`
      : '');
  return `${legacyDropdownLabel} · WC ${wcName} → ${lastFuelDecision.fuelCode} (${confidence})${scale}${fractional}${alternatives}${global}${regional}`;
}

function formatSignedAreaMetric(value) {
  const delta = Number(value) || 0;
  if (Math.round(delta * 1_000_000) === 0) return '— vs prior';
  const sign = delta > 0 ? '+' : '-';
  return `${sign}${formatAreaMetric(Math.abs(delta))} burned vs prior`;
}

function createHistoryMetric(label, value) {
  const wrapper = document.createElement('span');
  wrapper.className = 'history-metric';
  const labelEl = document.createElement('small');
  labelEl.textContent = label;
  const valueEl = document.createElement('strong');
  valueEl.textContent = value;
  wrapper.append(labelEl, valueEl);
  return wrapper;
}

function renderScenarioHistory() {
  if (!runHistoryList) return;
  runHistoryList.replaceChildren();
  if (scenarioRecords.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'Complete a run to save it here.';
    runHistoryList.append(empty);
    return;
  }

  scenarioRecords.forEach((record, index) => {
    const card = document.createElement('article');
    card.className = 'history-card';
    const header = document.createElement('div');
    header.className = 'history-card-header';
    const title = document.createElement('strong');
    title.textContent = record.location || 'Saved ignition';
    const replay = document.createElement('button');
    replay.type = 'button';
    replay.className = 'history-replay';
    replay.dataset.runId = record.id;
    replay.setAttribute('aria-label', `Replay ${record.location || 'saved ignition'}`);
    replay.textContent = 'Replay';
    header.append(title, replay);
    const basis = document.createElement('span');
    basis.className = 'history-basis';
    basis.textContent = `${record.scenarioLabel || 'Custom'} · ${record.terrain || 'Terrain unavailable'} · seed ${record.seed ?? SIMULATION_SEED}`;
    const metrics = document.createElement('div');
    metrics.className = 'history-metrics';
    const data = record.metrics || {};
    metrics.append(
      createHistoryMetric('Burned', formatAreaMetric(data.burnedAreaKm2 ?? 0)),
      createHistoryMetric('Time', formatModelTime(data.elapsedMinutes ?? 0)),
      createHistoryMetric('Spread', formatDistanceMetric(data.maxSpreadDistanceKm ?? 0))
    );
    card.append(header, basis, metrics);
    if (scenarioRecords[index + 1]) {
      const delta = compareScenarioMetrics(scenarioRecords[index + 1].metrics, data);
      const deltaLine = document.createElement('span');
      deltaLine.className = 'history-delta';
      deltaLine.textContent = formatSignedAreaMetric(delta.burnedAreaKm2);
      card.append(deltaLine);
    }
    runHistoryList.append(card);
  });
}

function recordSettledScenario(metrics) {
  if (!activeScenarioContext || activeScenarioContext.recorded) return;
  activeScenarioContext.recorded = true;
  flashMetricChips();
  const record = {
    id: `run-${Date.now()}-${fireRunId}`,
    createdAt: Date.now(),
    location: activeScenarioContext.location,
    coordinates: activeScenarioContext.coordinates,
    scenario: scenarioSelect.value,
    scenarioLabel: scenarioSelect.selectedOptions[0]?.textContent ?? scenarioSelect.value,
    params: getSimulationParams(),
    terrain: terrainMetadataStatus,
    elevationRange: formatElevationRange(terrainMetadataHeights),
    seed: SIMULATION_SEED,
    waterAuthorityVersion: activeScenarioContext.waterAuthorityVersion,
    uncertainty: ensembleMetadata
      ? {
        memberCount: ensembleMetadata.memberCount,
        seed: ensembleMetadata.seed,
        footprintAtMinutes: ensembleMetadata.footprintAtMinutes,
        interpretation: ensembleMetadata.interpretation
      }
      : null,
    metrics: {
      burnedAreaKm2: metrics.burnedAreaKm2 ?? 0,
      footprintAreaKm2: metrics.footprintAreaKm2 ?? 0,
      perimeterKm: metrics.perimeterKm ?? 0,
      maxSpreadDistanceKm: metrics.maxSpreadDistanceKm ?? 0,
      averageSpreadRateKmh: metrics.averageSpreadRateKmh ?? 0,
      elapsedMinutes: metrics.elapsedMinutes ?? 0,
      dominantSpreadDirectionDeg: metrics.dominantSpreadDirectionDeg ?? 0,
      terminationReason: metrics.terminationReason ?? null,
      horizonLimitedCellCount: metrics.horizonLimitedCellCount ?? 0,
      fieldBoundaryReached: metrics.fieldBoundaryReached === true
    }
  };
  scenarioRecords = saveScenarioRecord(undefined, record);
  renderScenarioHistory();
}

function replayScenario(record) {
  if (!globeReady || !record?.coordinates) return;
  const params = record.params ?? {};
  scenarioSelect.value = record.scenario ?? 'calm';
  fuelSelect.value = params.fuelPreset ?? 'brush';
  windSpeedInput.value = String(params.windSpeed ?? 0);
  windDirectionInput.value = String(params.windDirection ?? 0);
  moistureInput.value = String(Math.round((params.deadMoisture ?? params.moisture ?? 0) * 100));
  liveMoistureInput.value = String(Math.round((params.liveMoisture ?? params.moisture ?? 0.6) * 100));
  slopeInput.value = String(Math.round((params.slopeStrength ?? 0) * 100));
  if (uncertaintyToggle) uncertaintyToggle.checked = params.useUncertaintyEnsemble === true;
  updateSimulationLabels();
  updateConditionPanel(record.coordinates, false);
  pickedCoordinates = record.coordinates;
  startFireSimulation(record.coordinates);
}

async function startFireSimulation(coordinates) {
  if (!globeReady || !pickedCoordinates) return;
  const requestId = ++terrainRequestId;
  fineLandCoverStatus = 'Coarse WorldCover mosaic';
  globalFuelbedStatus = 'Global FCCS fuelbed fallback';
  landfireFuelStatus = 'Loading LANDFIRE FBFM40';
  canopyHeightStatus = 'Loading global canopy height';
  scenarioEvidence = classifyScenarioEvidence({ coordinates });
  updateScenarioMetadata();
  const coarseClickedLandCover = landCoverSource
    ? landCoverSource.classifyAtLatLon(coordinates.latitude, coordinates.longitude)
    : null;
  const [fineClickedLandCover, copernicusClickedLandCover, clickedCanopyHeight] = await Promise.all([
    fetchFineLandCoverAtLatLon(coordinates.latitude, coordinates.longitude),
    fetchCopernicusLandCoverAtLatLon(coordinates.latitude, coordinates.longitude),
    fetchCanopyHeightAtLatLon(coordinates.latitude, coordinates.longitude)
  ]);
  if (requestId !== terrainRequestId) return;
  const clickedLandCover = attachFractionalCover(
    fineClickedLandCover ?? coarseClickedLandCover,
    copernicusClickedLandCover
  );
  const clickedWater = resolveWaterEvidence({
    fractionalWater: copernicusClickedLandCover?.coverFractions
      ? isFractionalWater(copernicusClickedLandCover)
      : null,
    fineClassCode: fineClickedLandCover?.classCode ?? null,
    coarseClassCode: coarseClickedLandCover?.classCode ?? null,
    visualWater: !fineClickedLandCover
      && isMappedWaterAtLatLon(coordinates.latitude, coordinates.longitude)
  }).isWater;
  if (clickedWater) {
    resetFireSimulation();
    panelStatus.dataset.mode = 'blocked';
    statusText.textContent = 'Water surface · no ignition';
    simulationReadout.textContent = 'Select a land surface to ignite';
    simulationNote.textContent = 'Classified water source · fire ignition disabled';
    setTerrainMetadata('Water · no ignition');
    return;
  }
  const clickedFuelDecision = crosswalkLandCoverToFuel(clickedLandCover);
  if (!canIgniteFuelDecision(clickedFuelDecision)) {
    resetFireSimulation();
    panelStatus.dataset.mode = 'blocked';
    statusText.textContent = 'Non-burnable surface · no ignition';
    simulationReadout.textContent = 'Select a burnable land surface';
    simulationNote.textContent = clickedFuelDecision.rationale;
    setTerrainMetadata('Non-burnable surface');
    return;
  }
  fireRunId += 1;
  createFireDataTexture();
  fireRunning = true;
  firePaused = false;
  activeScenarioContext = {
    coordinates: { latitude: coordinates.latitude, longitude: coordinates.longitude },
    location: locationValue.textContent,
    waterAuthorityVersion: WATER_AUTHORITY_VERSION,
    recorded: false
  };
  pauseButton.disabled = false;
  resetButton.disabled = false;
  pauseButton.textContent = 'Pause';
  pauseButton.setAttribute('aria-label', 'Pause simulation');
  panelStatus.dataset.mode = 'running';
  flashPanels(conditionPanel, simulationPanel);
  statusText.textContent = 'Loading terrain · local elevation';
  simulationReadout.textContent = 'Loading terrain field · preparing fire grid';
  modelTimeValue.textContent = '0 min';
  burnedAreaValue.textContent = '0 km²';
  footprintValue.textContent = '0 km²';
  perimeterValue.textContent = '0 km';
  maxSpreadValue.textContent = '0 km';
  spreadRateValue.textContent = '0 km/h';
  interpretationText.textContent = 'Preparing terrain and ignition field';
  directionValue.textContent = 'Spread direction · —';
  setTerrainMetadata('Loading GLO-90');
  const scenarioConfig = getScenarioConfig();
  const params = getSimulationParams();
  lastLandCover = clickedLandCover;
  lastFuelDecision = clickedFuelDecision;
  ensembleMetadata = null;
  weatherMetadataStatus = 'Loading weather';
  updateScenarioMetadata();

  const grid = createSpatialGrid({
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    cellSizeMeters: FIRE_CELL_SIZE_KM * 1000,
    gridSize: FIRE_GRID_SIZE
  });
  const fineFieldPromise = fetchFineLandCoverField(grid);
  const urbanFootprintPromise = fetchUrbanFootprintsField(grid);
  const globalFuelbedFieldPromise = fetchGlobalFuelbedField(grid);
  const fractionalFieldPromise = fetchCopernicusLandCoverField(grid);
  const canopyHeightFieldPromise = fetchCanopyHeightField(grid);
  const landfireCanopyFieldPromise = fetchLandfireCanopyField(grid);
  const landfireFuelFieldPromise = fetchLandfireFuelField(grid);

  const weatherPromise = SIMULATION_ENGINE === 'phase1'
    ? fetchWeatherInputs({
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      canopySheltered: [10, 95].includes(clickedLandCover?.classCode)
        && (clickedCanopyHeight?.heightMeters ?? 5) >= 2,
      fuelModel: getFuelModel(clickedFuelDecision.fuelCode),
      fuelBedDepthMeters: getFuelModel(clickedFuelDecision.fuelCode).fuelBedDepthMeters,
      initialDeadMoistureByClass: {
        '1h': params.deadMoisture,
        '10h': params.deadMoisture,
        '100h': params.deadMoisture
      },
      timeoutMs: 5000
    }).catch((error) => {
      console.warn('[weather] unavailable, using scenario controls:', error);
      return null;
    })
    : Promise.resolve(null);
  const cacheKey = quantizeElevationCacheKey(
    coordinates.latitude,
    coordinates.longitude,
    FIRE_FIELD_DIAMETER_KM
  );
  const cacheEntry = terrainCache.get(cacheKey);
  let terrainHeights = cacheEntry?.heights?.slice() ?? null;
  if (terrainHeights) {
    const sampleLabel = cacheEntry?.sampleSize
      ? `${cacheEntry.sampleSize} × ${cacheEntry.sampleSize} terrain samples`
      : 'cached terrain samples';
    terrainSamplingMetadata = sampleLabel;
    simulationNote.textContent = `Cached GLO-90 terrain (90 m, upsampled) · ${FIRE_FIELD_DIAMETER_METERS} m field · ${sampleLabel} · overlay ×${FIRE_DISPLAY_SCALE}`;
    setTerrainMetadata('Cached GLO-90', terrainHeights);
  } else {
    try {
      const terrain = await fetchElevationField({
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        sampleSize: DEFAULT_ELEVATION_FIELD_SAMPLE_SIZE,
        targetSize: FIRE_GRID_SIZE,
        spanKm: FIRE_FIELD_DIAMETER_KM,
        timeoutMs: 15_000
      });
      if (requestId !== terrainRequestId) return;
      terrainHeights = terrain.heights;
      // Cache stores provenance alongside the height buffer so Phase 2
      // freshness policy can consult { fetchedAt, source } without a re-fetch.
      terrainCache.set(cacheKey, {
        heights: terrainHeights.slice(),
        fetchedAt: terrain.fetchedAt,
        source: terrain.source,
        sampleSize: terrain.sampleSize,
        requestCount: terrain.requestCount
      });
      terrainSamplingMetadata = `${terrain.sampleSize} × ${terrain.sampleSize} terrain samples / ${terrain.requestCount} requests`;
      while (terrainCache.size > TERRAIN_CACHE_LIMIT) terrainCache.delete(terrainCache.keys().next().value);
      simulationNote.textContent = `GLO-90 terrain loaded (90 m, upsampled) · ${FIRE_FIELD_DIAMETER_METERS} m field · ${terrain.sampleSize} × ${terrain.sampleSize} samples / ${terrain.requestCount} requests · overlay ×${FIRE_DISPLAY_SCALE}`;
      setTerrainMetadata('GLO-90 loaded', terrainHeights);
    } catch (error) {
      if (requestId !== terrainRequestId) return;
      console.warn('[terrain] elevation unavailable, using synthetic fallback:', error);
      simulationNote.textContent = 'Terrain unavailable · synthetic fallback active';
      setTerrainMetadata('Synthetic fallback');
    }
  }

  if (requestId !== terrainRequestId) return;
  const weather = await weatherPromise;
  if (requestId !== terrainRequestId) return;
  lastWeather = weather;
  weatherMetadataStatus = weather
    ? (weather.windTimeline?.length > 1
      ? 'Open-Meteo hourly + forecast'
      : (weather.fuelMoisture || weather.liveFuelMoisture ? 'Open-Meteo hourly' : 'Open-Meteo current'))
    : 'Scenario fallback';
  scenarioEvidence = classifyScenarioEvidence({
    coordinates,
    terrainAvailable: Boolean(terrainHeights),
    weatherAvailable: Boolean(weather)
  });
  updateScenarioMetadata();

  const fineField = await fineFieldPromise;
  if (requestId !== terrainRequestId) return;
  if (fineField) updateScenarioMetadata();
  const urbanFootprints = await urbanFootprintPromise;
  if (requestId !== terrainRequestId) return;
  updateScenarioMetadata();
  const globalFuelbedField = await globalFuelbedFieldPromise;
  if (requestId !== terrainRequestId) return;
  updateScenarioMetadata();
  const fractionalField = await fractionalFieldPromise;
  if (requestId !== terrainRequestId) return;
  if (fractionalField) updateScenarioMetadata();
  const canopyHeightField = await canopyHeightFieldPromise;
  if (requestId !== terrainRequestId) return;
  if (canopyHeightField) updateScenarioMetadata();
  const landfireCanopyField = await landfireCanopyFieldPromise;
  if (requestId !== terrainRequestId) return;
  if (landfireCanopyField) updateScenarioMetadata();
  const landfireFuelField = await landfireFuelFieldPromise;
  if (requestId !== terrainRequestId) return;
  updateScenarioMetadata();
  let activeLandCover = clickedLandCover;
  let activeFuelDecision = clickedFuelDecision;
  const ignitionCellIndex = Math.floor(FIRE_GRID_CENTER) * FIRE_GRID_SIZE + Math.floor(FIRE_GRID_CENTER);
  const clickedLandfireFuelModelCode = landfireFuelField?.fuelModelCodes[ignitionCellIndex] ?? null;
  if (clickedLandfireFuelModelCode) {
    activeLandCover = {
      ...activeLandCover,
      landfireFuelModelCode: clickedLandfireFuelModelCode
    };
    const regionalDecision = crosswalkLandCoverToFuel(activeLandCover);
    if (regionalDecision) {
      activeFuelDecision = regionalDecision;
      lastLandCover = activeLandCover;
      lastFuelDecision = activeFuelDecision;
      updateScenarioMetadata();
    }
  }
  const clickedGlobalFuelbed = globalFuelbedField?.[ignitionCellIndex] ?? null;
  if (clickedGlobalFuelbed && !clickedLandfireFuelModelCode) {
    activeLandCover = { ...clickedLandCover, globalFuelbed: clickedGlobalFuelbed };
    const globalDecision = crosswalkLandCoverToFuel(activeLandCover);
    if (canIgniteFuelDecision(globalDecision)) {
      activeFuelDecision = globalDecision;
      lastLandCover = activeLandCover;
      lastFuelDecision = activeFuelDecision;
      updateScenarioMetadata();
    }
  }
  if (!canIgniteFuelDecision(activeFuelDecision)) {
    resetFireSimulation();
    panelStatus.dataset.mode = 'blocked';
    statusText.textContent = 'Regional fuel class · no ignition';
    simulationReadout.textContent = 'Select a burnable land surface';
    simulationNote.textContent = activeFuelDecision.rationale;
    setTerrainMetadata('Regional non-burnable surface');
    return;
  }
  const nearestFineSampleAtLatLon = (latitude, longitude) => {
    if (!fineField?.sampleClassifications) return null;
    const cell = grid.latLonToCell(latitude, longitude);
    return nearestWorldCoverFineSample(fineField.sampleClassifications, {
      gridSize: grid.gridSize,
      cellRow: cell.row,
      cellCol: cell.col,
      // fineField was sampled with one centre sample/cell at block scale
      // (see fetchFineLandCoverField); match that layout here or this
      // throws on the length check inside nearestWorldCoverFineSample.
      sampleOffsets: BLOCK_SCALE_SAMPLE_OFFSETS
    });
  };
  const globalFuelbedAtLatLon = (latitude, longitude) => {
    if (!globalFuelbedField) return null;
    const cell = grid.latLonToCell(latitude, longitude);
    const row = Math.round(cell.row);
    const col = Math.round(cell.col);
    if (row < 0 || row >= FIRE_GRID_SIZE || col < 0 || col >= FIRE_GRID_SIZE) return null;
    return globalFuelbedField[row * FIRE_GRID_SIZE + col] ?? null;
  };
  const landfireFuelAtLatLon = (latitude, longitude) => {
    if (!landfireFuelField) return null;
    const cell = grid.latLonToCell(latitude, longitude);
    const row = Math.round(cell.row);
    const col = Math.round(cell.col);
    if (row < 0 || row >= FIRE_GRID_SIZE || col < 0 || col >= FIRE_GRID_SIZE) return null;
    return landfireFuelField.fuelModelCodes[row * FIRE_GRID_SIZE + col] ?? null;
  };
  const isFineWaterAtLatLon = (latitude, longitude, context = null) => {
    const cell = grid.latLonToCell(latitude, longitude);
    const row = Math.round(cell.row);
    const col = Math.round(cell.col);
    const inField = row >= 0 && row < grid.gridSize && col >= 0 && col < grid.gridSize;
    const index = row * grid.gridSize + col;
    const fractionalSample = fieldSampleAtLatLon(grid, fractionalField, latitude, longitude);
    const fineClassification = context?.kind === 'cell-edge'
      ? nearestFineSampleAtLatLon(latitude, longitude)
      : (inField ? fineField?.classifications[index] ?? null : null);
    const fineClassCode = fineClassification?.classCode ?? null;
    const coarseClassCode = landCoverSource?.classifyAtLatLon(latitude, longitude)?.classCode ?? null;
    const edgeWater = context?.kind === 'cell-edge' && isMappedWaterAtLatLon(latitude, longitude);
    return resolveWaterEvidence({
      fractionalWater: fractionalSample?.coverFractions
        ? isFractionalWater(fractionalSample)
        : null,
      fineClassCode,
      coarseClassCode,
      visualWater: edgeWater || (fineClassification === null
        && fractionalSample === null
        && isMappedWaterAtLatLon(latitude, longitude)),
      edgeVisualVeto: context?.kind === 'cell-edge'
    }).isWater;
  };
  let fuelField;
  try {
    fuelField = buildFuelModelCodeField({
      grid,
      classifyAtLatLon: (latitude, longitude) => attachFractionalCover(
        {
          ...landCoverSource.classifyAtLatLon(latitude, longitude),
          globalFuelbed: globalFuelbedAtLatLon(latitude, longitude),
          landfireFuelModelCode: landfireFuelAtLatLon(latitude, longitude)
        },
        fieldSampleAtLatLon(grid, fractionalField, latitude, longitude)
      ),
    classifyAtCell: (fineField || urbanFootprints?.raster)
        ? (row, col) => {
          const index = row * FIRE_GRID_SIZE + col;
          const fineClassification = fineField?.classifications[index];
          const { latitude, longitude } = grid.cellCenterLatLon(row, col);
          const fallbackClassification = landCoverSource.classifyAtLatLon(latitude, longitude);
          const classified = attachFractionalCover(
            {
              ...(fineClassification ?? fallbackClassification),
              globalFuelbed: globalFuelbedField?.[index] ?? null,
              landfireFuelModelCode: landfireFuelField?.fuelModelCodes[index] ?? null
            },
            fractionalField?.samples[index]
          );
          // Buildings/roads/green go through urbanFootprints.js's raster.
          // Reuse the SAME classCode-driven crosswalk path WorldCover's
          // "Built-up" (50) already takes for non-burnable, and the same
          // vegetation classes for OSM green space — no new fuel-decision
          // code path (see landCoverToFuel.js).
          const urbanCell = urbanFootprints?.raster?.cells?.[index];
          if (urbanCell?.kind === 'building' || urbanCell?.kind === 'road') {
            return {
              ...classified,
              classCode: BUILT_UP_CLASS_CODE,
              source: 'OSM Overpass',
              landfireFuelModelCode: null,
              globalFuelbed: null
            };
          }
          if (urbanCell?.kind === 'green') {
            return {
              ...classified,
              classCode: urbanCell.classCode,
              source: 'OSM Overpass landuse',
              landfireFuelModelCode: null
            };
          }
          return classified;
        }
        : null,
      crosswalk: crosswalkLandCoverToFuel,
      isWaterAtLatLon: isFineWaterAtLatLon,
      canopyHeightByCell: landfireCanopyField?.canopyHeightByCell ?? canopyHeightField?.values ?? null,
      canopyCoverFractionByCell: landfireCanopyField?.canopyCoverFractionByCell ?? null,
      canopyBaseHeightByCell: landfireCanopyField?.canopyBaseHeightByCell ?? null,
      canopyBulkDensityByCell: landfireCanopyField?.canopyBulkDensityByCell ?? null,
      ignition: { x: FIRE_GRID_CENTER, y: FIRE_GRID_CENTER },
      ignitionFuelCode: activeFuelDecision.fuelCode,
      ignitionFuelLoadScale: activeFuelDecision.fuelLoadScale,
      allowExperimental: false
    });
  } catch (error) {
    console.error('[fuel-field] failed to build location-specific field:', error);
    panelStatus.dataset.mode = 'blocked';
    statusText.textContent = 'Location fuel field unavailable';
    simulationReadout.textContent = 'Could not classify the local fuel raster';
    simulationNote.textContent = 'No fire started · location data required';
    fireRunning = false;
    return;
  }

  fuelFieldQualityValue.textContent = formatFuelFieldQuality(fuelField.summary);
  scenarioEvidence = classifyScenarioEvidence({
    coordinates,
    terrainAvailable: Boolean(terrainHeights),
    fineLandCoverCoverage: fineField?.sampleCoverageFraction ?? 0,
    fractionalCoverAvailable: Boolean(fractionalField),
    landfireCanopyAvailable: Boolean(landfireCanopyField),
    landfireFuelAvailable: Boolean(landfireFuelField),
    weatherAvailable: Boolean(weather),
    fuelSummary: fuelField.summary
  });
  updateScenarioMetadata();

  if (fuelField.summary.burnableCellCount === 0) {
    panelStatus.dataset.mode = 'blocked';
    statusText.textContent = 'No burnable fuel in local field';
    simulationReadout.textContent = 'Select a land surface with mapped fuel';
    simulationNote.textContent = 'WorldCover classified the field as non-burnable';
    fireRunning = false;
    return;
  }

  rebuildBlockScene(fuelField, urbanFootprints);
  // P3 (drape-on-globe) is parked: the Cesium rectangle never rendered inside
  // the timebox, so the camera cut back to the block scene. Flip
  // DRAPE_ON_GLOBE to re-enable and pick the work back up.
  if (!DRAPE_ON_GLOBE) dropCameraIntoBlockScene();

  const transferredHeights = terrainHeights?.slice() ?? null;
  const slopeGrade = Math.max(0, params.slopeStrength);
  const usesPresetSlope = scenarioConfig.scenario === 'slope';
  const weatherWind = weather?.wind;
  const manualWind = params.windSpeed > 0;
  const activeFuelModel = activeFuelDecision.fuelModelDefinition ?? getFuelModel(activeFuelDecision.fuelCode);
  const fuelBedDepthMeters = activeFuelModel.fuelBedDepthMeters;
  const canopySheltered = [10, 95].includes(activeLandCover?.classCode)
    && (clickedCanopyHeight?.heightMeters ?? 5) >= 2;
  const midflameWindKmh = manualWind
    ? windToMidflame({
      tenMeterWindKmh: params.windSpeed,
      canopySheltered,
      fuelBedDepthMeters,
      fuelModel: activeFuelModel
    }).speedKmh
    : (weatherWind?.midflameSpeedKmh ?? 0);
  const windDirectionRadians = manualWind
    ? compassToMathRadians(params.windDirection)
    : (weatherWind?.mathFrameRadians ?? compassToMathRadians(params.windDirection));
  const message = {
    type: 'start',
    config: {
      runId: fireRunId,
      engine: SIMULATION_ENGINE,
      size: FIRE_GRID_SIZE,
      cellSizeKm: FIRE_CELL_SIZE_KM,
      seed: SIMULATION_SEED,
      waterAuthorityVersion: WATER_AUTHORITY_VERSION,
      scenario: scenarioConfig.scenario,
      params,
      // Playback multiplier only: physics still advances in 1-minute ticks.
      speed: 24,
      timestepMinutes: MODEL_TIMESTEP_MINUTES,
      ignition: { x: FIRE_GRID_CENTER, y: FIRE_GRID_CENTER },
      // Phase1 consumes the location-specific field; legacy ignores it.
      fuelModelCode: activeFuelDecision.fuelCode,
      fuelBedDepthMeters,
      canopySheltered,
      canopyShelteredByCell: fuelField.canopyShelteredByCell,
      canopyCrownAvailableByCell: fuelField.canopyCrownAvailableByCell,
      canopyHeightByCell: fuelField.canopyHeightByCell,
      canopyCoverFractionByCell: fuelField.canopyCoverFractionByCell,
      canopyBaseHeightByCell: fuelField.canopyBaseHeightByCell,
      canopyBulkDensityByCell: fuelField.canopyBulkDensityByCell,
      fuelModelCodes: fuelField.fuelModelCodes,
      fuelModelDefinitionsByCode: fuelField.fuelModelDefinitionsByCode,
      fuelModelAlternativesByCell: fuelField.fuelModelAlternativesByCell,
      fuelLoadScaleByCell: fuelField.fuelLoadScaleByCell,
      fuelPersistenceMinutesByCell: fuelField.fuelPersistenceMinutesByCell,
      moistureFraction: params.moisture,
      deadMoistureFraction: params.deadMoisture,
      liveMoistureFraction: params.liveMoisture,
      deadMoistureByClass: params.useWeatherMoisture
        ? (weather?.fuelMoisture?.byClass ?? null)
        : null,
      liveMoistureByClass: params.useWeatherMoisture
        ? (weather?.liveFuelMoisture?.byClass ?? null)
        : null,
      waterBarrierEdges: fuelField.waterBarrierEdges,
      weatherTimeline: !manualWind
        ? (params.useWeatherMoisture
          ? (weather?.weatherTimeline ?? weather?.windTimeline ?? null)
          : (weather?.windTimeline ?? null))
        : null,
      midflameWindKmh,
      windDirectionRadians,
      defaultSlopeRadians: Math.atan(slopeGrade),
      defaultSlopeAspectEast: 0,
      defaultSlopeAspectNorth: usesPresetSlope ? 1 : 0,
      terrainHeights: transferredHeights,
      maxPropagationMinutes: MAX_PROPAGATION_MINUTES,
      // Block scale (640 m field) is well inside SPOTTING_MAX_DISTANCE_METERS
      // (5000 m) — embers would land off-map. Explicit, not just relying on
      // the solver's default; see the matching assertion in fireWorker.js.
      enableSpotting: false,
      ensemble: params.useUncertaintyEnsemble
        ? {
          enabled: true,
          memberCount: ENSEMBLE_MEMBER_COUNT,
          seed: SIMULATION_SEED,
          perturbations: SENSITIVITY_PERTURBATIONS
        }
        : null
    }
  };
  const transferables = [
    ...(terrainHeights ? [terrainHeights.buffer] : []),
    ...(fuelField.waterBarrierEdges ? [fuelField.waterBarrierEdges.buffer] : []),
    ...(fuelField.fuelLoadScaleByCell ? [fuelField.fuelLoadScaleByCell.buffer] : []),
    ...(fuelField.fuelPersistenceMinutesByCell
      ? [fuelField.fuelPersistenceMinutesByCell.buffer]
      : []),
    ...(fuelField.canopyShelteredByCell ? [fuelField.canopyShelteredByCell.buffer] : []),
    ...(fuelField.canopyCrownAvailableByCell ? [fuelField.canopyCrownAvailableByCell.buffer] : []),
    ...(fuelField.canopyHeightByCell ? [fuelField.canopyHeightByCell.buffer] : []),
    ...(fuelField.canopyCoverFractionByCell ? [fuelField.canopyCoverFractionByCell.buffer] : []),
    ...(fuelField.canopyBaseHeightByCell ? [fuelField.canopyBaseHeightByCell.buffer] : []),
    ...(fuelField.canopyBulkDensityByCell ? [fuelField.canopyBulkDensityByCell.buffer] : [])
  ];
  if (transferables.length > 0) fireWorker.postMessage(message, transferables);
  else fireWorker.postMessage(message);
}

function resetFireSimulation() {
  terrainRequestId += 1;
  fireRunId += 1;
  fireWorker.postMessage({ type: 'stop' });
  fireRunning = false;
  firePaused = false;
  restoreGlobeCamera();
  lastWeather = null;
  terrainSamplingMetadata = null;
  fineLandCoverStatus = 'Coarse WorldCover mosaic';
  fractionalCoverStatus = 'Optional Copernicus layer';
  canopyHeightStatus = 'Optional global canopy height';
  globalFuelbedStatus = 'Global FCCS fuelbed fallback';
  landfireFuelStatus = 'LANDFIRE FBFM40 unavailable · fallback';
  urbanFootprintStatus = 'Not fetched';
  ensembleMetadata = null;
  scenarioEvidence = null;
  weatherMetadataStatus = 'Scenario fallback';
  activeScenarioContext = null;
  pauseButton.disabled = true;
  pauseButton.textContent = 'Pause';
  pauseButton.setAttribute('aria-label', 'Pause simulation');
  resetButton.disabled = true;
  panelStatus.dataset.mode = 'armed';
  statusText.textContent = 'Location armed · ignition ready';
  simulationReadout.textContent = 'Click the globe to ignite a local scenario';
  modelTimeValue.textContent = '—';
  burnedAreaValue.textContent = '—';
  footprintValue.textContent = '—';
  perimeterValue.textContent = '—';
  maxSpreadValue.textContent = '—';
  spreadRateValue.textContent = '—';
  interpretationText.textContent = 'Click land to begin a scenario';
  directionValue.textContent = 'Spread direction · —';
  fuelFieldQualityValue.textContent = 'Awaiting local field';
  evidenceProfileValue.textContent = 'Awaiting location';
  simulationNote.textContent = 'Rothermel surface model · 1 min/tick · terrain loads on ignition';
  updateScenarioMetadata();
}

function formatFuelFieldQuality(summary) {
  const total = Math.max(0, Number(summary?.totalCellCount) || 0);
  const experimental = Number(summary?.experimentalCellCount) || 0;
  const low = Number(summary?.lowConfidenceCellCount) || 0;
  const unknown = Number(summary?.unknownOrUnclassifiedCellCount) || 0;
  const canopyMeasured = Number(summary?.canopyHeightDataCellCount) || 0;
  const canopyShelteredMeasured = Number(summary?.canopyHeightShelteredCellCount) || 0;
  const crownMeasured = Number(summary?.crownStructureDataCellCount) || 0;
  if (!total) return 'Unavailable';
  const covered = Math.max(0, total - unknown);
  const quality = experimental || unknown ? 'mapped with limits' : 'mapped';
  const canopy = canopyMeasured > 0
    ? ` · canopy ${canopyShelteredMeasured}/${canopyMeasured}`
    : ' · canopy fallback';
  const canopyWind = Number(summary?.canopyWindStructureDataCellCount) || 0;
  const globalCanopy = Number(summary?.globalCanopyStructureDataCellCount) || 0;
  const globalCanopyLabel = globalCanopy > 0 ? ` · FCCS structure ${globalCanopy}` : '';
  const globalCanopyBaseHeight = Number(summary?.globalCanopyBaseHeightDataCellCount) || 0;
  const globalCanopyBaseHeightLabel = globalCanopyBaseHeight > 0
    ? ` · FCCS HLC proxy ${globalCanopyBaseHeight}`
    : '';
  const crown = crownMeasured > 0 ? ` · crown ${crownMeasured}` : '';
  const wind = canopyWind > 0 ? ` · WAF ${canopyWind}` : '';
  const variants = Number(summary?.fuelModelAlternativeCellCount) || 0;
  const variantLabel = variants > 0 ? ` · ${variants} forest variants` : '';
  const global = Number(summary?.globalFuelbedCellCount) || 0;
  const globalLabel = global > 0 ? ` · FCCS ${global}` : '';
  const regional = Number(summary?.regionalFuelCellCount) || 0;
  const regionalLabel = regional > 0 ? ` · LANDFIRE FBFM40 ${regional}` : '';
  return quality + ' · ' + Math.round((covered / total) * 100) + '% covered · ' + low + ' low' + canopy + wind + globalCanopyLabel + globalCanopyBaseHeightLabel + crown + variantLabel + globalLabel + regionalLabel;
}

// At block scale (10 m cells, 0.4 km² field) most meaningful values are
// well under 1 km² / 1 km: Math.round(...) + "km²" rounds every readable
// result to "0". Switch to m² / m below 0.1 of the unit so an actively
// spreading fire doesn't display as if nothing happened.
function formatAreaMetric(areaKm2) {
  const area = Number.isFinite(areaKm2) ? areaKm2 : 0;
  if (area < 0.1) return `${Math.round(area * 1_000_000).toLocaleString()} m²`;
  return `${area.toFixed(2)} km²`;
}
function formatDistanceMetric(distanceKm) {
  const distance = Number.isFinite(distanceKm) ? distanceKm : 0;
  if (distance < 0.1) return `${Math.round(distance * 1000).toLocaleString()} m`;
  return `${distance.toFixed(2)} km`;
}
function formatRateMetric(rateKmh) {
  const rate = Number.isFinite(rateKmh) ? rateKmh : 0;
  if (rate < 0.1) return `${Math.round(rate * 1000).toLocaleString()} m/h`;
  return `${rate.toFixed(1)} km/h`;
}

fireWorker.onmessage = ({ data }) => {
  if (data.type !== 'frame' || data.runId && data.runId !== fireRunId) return;
  if (!fireTexture) return;
  fireTexture.image.data = data.frame;
  fireTexture.needsUpdate = true;
  if (data.arrivalField && blockSceneInstance) {
    blockSceneInstance.setArrivalField(data.arrivalField.values);
  }
  if (data.ensemble) {
    ensembleMetadata = data.ensemble;
    updateScenarioMetadata();
    const range = data.ensemble.footprintAtMinutes;
    const horizonHours = Number.isFinite(data.ensemble.horizonMinutes)
      ? Math.round(data.ensemble.horizonMinutes / 60)
      : null;
    const lowArea = formatAreaMetric((range.low ?? 0) * FIRE_CELL_SIZE_KM ** 2);
    const highArea = formatAreaMetric((range.high ?? 0) * FIRE_CELL_SIZE_KM ** 2);
    simulationNote.textContent = horizonHours
      ? `Experimental sensitivity range · ${lowArea}-${highArea} at ${horizonHours} h · uncalibrated`
      : 'Experimental sensitivity range · uncalibrated';
  }
  firePaused = data.paused;
  pauseButton.textContent = firePaused ? 'Resume' : 'Pause';
  pauseButton.setAttribute('aria-label', firePaused ? 'Resume simulation' : 'Pause simulation');
  if (data.terrainAvailable) {
    const sampleLabel = terrainSamplingMetadata ? ` · ${terrainSamplingMetadata}` : '';
    simulationNote.textContent = `GLO-90 terrain loaded (90 m, upsampled) · ${FIRE_FIELD_DIAMETER_METERS} m field${sampleLabel} · overlay ×${FIRE_DISPLAY_SCALE}`;
  }
  const metrics = data.metrics ?? {};
  liveModelMinutes = metrics.elapsedMinutes ?? 0;
  if (blockSceneInstance && Number(timelineScrub.dataset.scrubbing) !== 1) {
    blockSceneInstance.setTime(liveModelMinutes);
    // The drape owns its own clock (see startDrapePlayback) and plays on a
    // completely different timescale than this legacy worker. Pinning it to
    // the worker's elapsedMinutes here silently stopped drape playback dead
    // at ~0 the instant the first worker tick arrived.
    if (!DRAPE_ON_GLOBE) fireDrape?.setTime(liveModelMinutes);
    timelineScrub.value = String(Math.min(Number(timelineScrub.max), liveModelMinutes));
    timelineScrubValue.textContent = formatModelTime(liveModelMinutes);
  }
  const direction = formatCompassDirection(metrics.dominantSpreadDirectionDeg ?? 0);
  const params = getSimulationParams();
  // A run that burns nothing is usually a correct physical result, not a
  // failure: the ignition cell may be non-burnable (bare rock, water, no-data),
  // or the fuel's spread rate at the current wind/slope may be too low to cross
  // even one cell in the model window. Both used to surface as a bare "0 km²",
  // which reads as a broken app. Say which it is.
  const burned = metrics.burnedAreaKm2 ?? 0;
  let zeroReason = '';
  if (burned <= 0 && data.stepCount > 0) {
    const code = lastFuelDecision?.fuelCode ?? 'unknown';
    if (lastFuelDecision && lastFuelDecision.burnable === false) {
      zeroReason = ` · no spread — ignition cell is non-burnable (${code})`;
    } else {
      const cellM = Math.round(FIRE_CELL_SIZE_KM * 1000);
      zeroReason = ` · no spread — ${code} below cell-crossing rate at ${params.windSpeed ?? 0} km/h (needs to cross ${cellM} m; try more wind or slope)`;
    }
  }
  simulationReadout.textContent = `${data.stepCount.toString().padStart(3, '0')} ticks · ${formatModelTime(metrics.elapsedMinutes ?? 0)} · ${formatAreaMetric(burned)} burned${zeroReason}`;
  modelTimeValue.textContent = formatModelTime(metrics.elapsedMinutes ?? 0);
  burnedAreaValue.textContent = formatAreaMetric(metrics.burnedAreaKm2 ?? 0);
  footprintValue.textContent = formatAreaMetric(metrics.footprintAreaKm2 ?? 0);
  perimeterValue.textContent = formatDistanceMetric(metrics.perimeterKm ?? 0);
  maxSpreadValue.textContent = formatDistanceMetric(metrics.maxSpreadDistanceKm ?? 0);
  spreadRateValue.textContent = formatRateMetric(metrics.averageSpreadRateKmh ?? 0);
  directionValue.textContent = `Spread direction · ${direction} · ${Math.round(metrics.dominantSpreadDirectionDeg ?? 0)}°`;
  interpretationText.textContent = buildSpreadExplanation({
    direction,
    windSpeed: params.windSpeed,
    slopeStrength: params.slopeStrength,
    moisture: params.moisture
  });
  if (firePaused) {
    panelStatus.dataset.mode = 'armed';
    statusText.textContent = 'Simulation paused · resume when ready';
  } else if (fireRunning && isSimulationSettled(data)) {
    fireRunning = false;
    firePaused = false;
    pauseButton.disabled = true;
    panelStatus.dataset.mode = 'armed';
    const terminationReason = metrics.terminationReason;
    // 'horizon_reached' is deliberately NOT handled as a terminal outcome: it
    // fires whenever any single cell's travel time lands past the cap, which
    // is nearly every run. Outcome status comes from startDrapePlayback, which
    // reports what actually burned once the arrival-time animation finishes.
    if (terminationReason === 'horizon_reached') {
      // Leave status to the drape playback; do not stop it here.
    } else if (terminationReason === 'field_boundary_reached') {
      statusText.textContent = 'Model field boundary reached · click to ignite again';
      simulationNote.textContent = 'Local field boundary reached · spread beyond the field is not shown';
    } else {
      statusText.textContent = 'Fire exhausted available fuel · click to ignite again';
      simulationNote.textContent = 'No reachable burnable cells remain in the local field';
    }
    recordSettledScenario(metrics);
  } else if (fireRunning) {
    panelStatus.dataset.mode = 'running';
    statusText.textContent = 'Simulation running · local scenario';
  }
};

// ─────────────────────────────────────────────────────────────
// Camera framing
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// Animation loop — renders the local block scene once ignited.
// The globe/location-picking phase is owned entirely by Cesium.
// ─────────────────────────────────────────────────────────────
function animate() {
  earthClock.getDelta();
  controls.update();
  composer.render();
  requestAnimationFrame(animate);
}

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloomPass.setSize(window.innerWidth, window.innerHeight);
}

function handleSimulationControlChange() {
  updateSimulationLabels();
  if (fireRunning) {
    fireWorker.postMessage({ type: 'configure', params: getSimulationParams() });
    simulationReadout.textContent = 'Parameters updated · recalculating field';
  }
}

function handleHistoryClick(event) {
  const replayButton = event.target.closest('.history-replay');
  if (!replayButton) return;
  const record = scenarioRecords.find((item) => item.id === replayButton.dataset.runId);
  if (record) replayScenario(record);
}

// ─────────────────────────────────────────────────────────────
// Wire it up
// ─────────────────────────────────────────────────────────────
window.addEventListener('resize', resize);
applyScenarioPreset();
renderScenarioHistory();
scenarioSelect.addEventListener('change', applyScenarioPreset);
fuelSelect.addEventListener('change', handleSimulationControlChange);
windSpeedInput.addEventListener('input', handleSimulationControlChange);
windDirectionInput.addEventListener('input', handleSimulationControlChange);
moistureInput.addEventListener('input', handleSimulationControlChange);
weatherMoistureToggle?.addEventListener('change', handleSimulationControlChange);
uncertaintyToggle?.addEventListener('change', handleSimulationControlChange);
liveMoistureInput.addEventListener('input', handleSimulationControlChange);
slopeInput.addEventListener('input', handleSimulationControlChange);
timelineScrub.addEventListener('input', () => {
  timelineScrub.dataset.scrubbing = '1';
  const minutes = Number(timelineScrub.value);
  blockSceneInstance?.setTime(minutes);
  fireDrape?.setTime(minutes);
  timelineScrubValue.textContent = formatModelTime(minutes);
});
timelineScrub.addEventListener('change', () => {
  delete timelineScrub.dataset.scrubbing;
});
pauseButton.addEventListener('click', () => fireWorker.postMessage({ type: 'pause' }));
resetButton.addEventListener('click', resetFireSimulation);
runHistoryList?.addEventListener('click', handleHistoryClick);
metadataToggle?.addEventListener('click', () => {
  const expanded = metadataToggle.getAttribute('aria-expanded') === 'true';
  metadataToggle.setAttribute('aria-expanded', String(!expanded));
});
clearHistoryButton?.addEventListener('click', () => {
  clearScenarioRecords();
  scenarioRecords = [];
  renderScenarioHistory();
});
animate();
