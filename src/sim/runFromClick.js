// P2 — Ignition: click a lat/lon, run the existing block-scale (640 m, 10 m
// cells, 64x64) fire simulation against real WorldCover + OSM data, and
// return the frozen contract documented in CLAUDE.md. Reuses src/lib/ as-is;
// nothing in src/lib/ is modified.
//
// Wind and fuel moisture come from live Open-Meteo observations via
// weatherInputs.js, with the UI sliders as an explicit override (a non-zero
// wind slider wins). Not yet included: terrain/DEM slope+aspect, LANDFIRE
// canopy structure, uncertainty ensemble — slope is a flat user value.

import { createSpatialGrid } from '../lib/spatialGrid.js';
import { createLandCoverSource, createCanvasImageReader } from '../lib/landCoverSource.js';
import { crosswalkLandCoverToFuel } from '../lib/landCoverToFuel.js';
import { buildFuelModelCodeField } from '../lib/fireFieldInputs.js';
import { BUILT_UP_CLASS_CODE, bufferLineToQuads, fetchUrbanFootprintsForBbox } from '../lib/urbanFootprints.js';
import { getFuelModel, listFuelModelCodes } from '../lib/fuelModels.js';
import { compassToMathRadians, fetchWeatherInputs, windToMidflame } from '../lib/weatherInputs.js';

export const GRID_SIZE = 64;
export const CELL_SIZE_METERS = 10;
const FIELD_CENTER = (GRID_SIZE - 1) / 2;
// Single source of truth for the block-scale run window. main.js used to keep
// its own FIRE_MAX_PROPAGATION_HOURS, which had drifted to a stale regional
// value and was printed in status text that did not match the actual solve.
export const MAX_PROPAGATION_MINUTES = 120;
const DEFAULT_ROAD_WIDTH_METERS = 6;

const FUEL_CODE_INDEX = new Map(listFuelModelCodes().map((code, i) => [code, i]));

let landCoverSourcePromise = null;
function getLandCoverSource() {
  if (!landCoverSourcePromise) {
    landCoverSourcePromise = (async () => {
      const [meta, image] = await Promise.all([
        fetch('/landcover-coarse.json').then((r) => (r.ok ? r.json() : null)),
        loadImageElement('/landcover-coarse.png')
      ]);
      if (!meta || !image) throw new Error('runFromClick: WorldCover source unavailable');
      return createLandCoverSource({
        pngUrl: '/landcover-coarse.png',
        meta,
        imageReader: async () => createCanvasImageReader(image)
      });
    })();
  }
  return landCoverSourcePromise;
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

// [west, south, east, north] in degrees, padded by half a cell.
function gridBbox(grid) {
  const corners = [
    grid.cellCenterLatLon(0, 0),
    grid.cellCenterLatLon(0, grid.gridSize - 1),
    grid.cellCenterLatLon(grid.gridSize - 1, 0),
    grid.cellCenterLatLon(grid.gridSize - 1, grid.gridSize - 1)
  ];
  const longitudes = corners.map((p) => p.longitude);
  const latitudes = corners.map((p) => p.latitude);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  const latitudePad = grid.cellSizeMeters / 111320;
  const longitudePad = latitudePad / Math.max(Math.cos(grid.origin.latitude * Math.PI / 180), 0.1);
  return [west - longitudePad, south - latitudePad, east + longitudePad, north + latitudePad];
}

// The Dijkstra-based phase1 engine solves every cell's arrival time up front
// (see fireWorker.js emitFrame) and sends it once on the very first 'frame'
// message — no need to step the simulation to completion.
function runFireWorkerOnce(config) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/fireWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'frame' && data.arrivalField) {
        const values = data.arrivalField.values;
        worker.postMessage({ type: 'stop' });
        worker.terminate();
        resolve(values);
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(event.error ?? new Error('runFromClick: fireWorker failed'));
    };
    worker.postMessage({ type: 'start', config });
  });
}

// Live weather, with the UI sliders as an explicit override.
//
// This path used to hardcode calm (wind 0, slope 0, 8% moisture), which is why
// an all-burnable grassland field burned exactly one cell: Rothermel's no-wind
// no-slope rate never crossed a single 10 m cell inside the 120 min window.
//
// Mirrors the manualWind pattern main.js already uses for the block scene:
// a non-zero wind slider wins; otherwise Open-Meteo's observed wind drives the
// run. Failure to reach Open-Meteo falls back to the slider values rather than
// aborting the ignition.
async function resolveWeatherInputs({ lat, lon, overrides, landCover, fuelDecision }) {
  const fuelModel = fuelDecision.fuelModelDefinition ?? getFuelModel(fuelDecision.fuelCode);
  const fuelBedDepthMeters = fuelModel.fuelBedDepthMeters;
  // Tree cover / mangrove read as sheltered; canopy height isn't wired on this
  // path yet, so this is coarser than the block-scene equivalent.
  const canopySheltered = [10, 95].includes(landCover?.classCode);

  let weather = null;
  try {
    weather = await fetchWeatherInputs({
      latitude: lat,
      longitude: lon,
      canopySheltered,
      fuelBedDepthMeters,
      fuelModel,
      initialDeadMoistureByClass: { '1h': overrides.deadMoisture }
    });
  } catch (error) {
    console.info('[runFromClick] live weather unavailable, using slider values:', error?.message ?? error);
  }

  const weatherWind = weather?.wind;
  const manualWind = overrides.windSpeed > 0;
  const midflameWindKmh = manualWind
    ? windToMidflame({
      tenMeterWindKmh: overrides.windSpeed,
      canopySheltered,
      fuelBedDepthMeters,
      fuelModel
    }).speedKmh
    : (weatherWind?.midflameSpeedKmh ?? 0);
  const windDirectionRadians = manualWind
    ? compassToMathRadians(overrides.windDirection)
    : (weatherWind?.mathFrameRadians ?? compassToMathRadians(overrides.windDirection));

  return {
    weather,
    manualWind,
    canopySheltered,
    fuelBedDepthMeters,
    midflameWindKmh,
    windDirectionRadians,
    // Observed moisture only when the user hasn't taken manual control of it.
    deadMoistureByClass: overrides.useWeatherMoisture ? (weather?.fuelMoisture?.byClass ?? null) : null,
    liveMoistureByClass: overrides.useWeatherMoisture ? (weather?.liveFuelMoisture?.byClass ?? null) : null,
    // A time-varying timeline is only meaningful when weather (not a fixed
    // slider) is driving the wind.
    weatherTimeline: manualWind
      ? null
      : (overrides.useWeatherMoisture
        ? (weather?.weatherTimeline ?? weather?.windTimeline ?? null)
        : (weather?.windTimeline ?? null))
  };
}

export const DEFAULT_OVERRIDES = Object.freeze({
  windSpeed: 0,
  windDirection: 0,
  deadMoisture: 0.08,
  liveMoisture: 0.6,
  slopeStrength: 0,
  useWeatherMoisture: true
});

export async function runFromClick({ lat, lon, overrides: overrideInput = null }) {
  const overrides = { ...DEFAULT_OVERRIDES, ...(overrideInput ?? {}) };
  const landCoverSource = await getLandCoverSource();
  const grid = createSpatialGrid({
    latitude: lat,
    longitude: lon,
    cellSizeMeters: CELL_SIZE_METERS,
    gridSize: GRID_SIZE
  });
  const bbox = gridBbox(grid);

  const urbanFootprints = await fetchUrbanFootprintsForBbox(
    [bbox[1], bbox[0], bbox[3], bbox[2]],
    {
      originLatitude: lat,
      originLongitude: lon,
      gridSize: GRID_SIZE,
      cellSizeMeters: CELL_SIZE_METERS
    }
  );

  const clickedLandCover = landCoverSource.classifyAtLatLon(lat, lon);
  const clickedFuelDecision = crosswalkLandCoverToFuel(clickedLandCover);

  const fuelField = buildFuelModelCodeField({
    grid,
    classifyAtLatLon: (latitude, longitude) => landCoverSource.classifyAtLatLon(latitude, longitude),
    classifyAtCell: urbanFootprints?.raster
      ? (row, col) => {
        const index = row * GRID_SIZE + col;
        const { latitude, longitude } = grid.cellCenterLatLon(row, col);
        const classified = landCoverSource.classifyAtLatLon(latitude, longitude);
        const urbanCell = urbanFootprints.raster.cells?.[index];
        if (urbanCell?.kind === 'building' || urbanCell?.kind === 'road') {
          return { ...classified, classCode: BUILT_UP_CLASS_CODE, source: 'OSM Overpass' };
        }
        if (urbanCell?.kind === 'green') {
          return { ...classified, classCode: urbanCell.classCode, source: 'OSM Overpass landuse' };
        }
        return classified;
      }
      : null,
    crosswalk: crosswalkLandCoverToFuel,
    ignition: { x: FIELD_CENTER, y: FIELD_CENTER },
    ignitionFuelCode: clickedFuelDecision.fuelCode,
    ignitionFuelLoadScale: clickedFuelDecision.fuelLoadScale,
    allowExperimental: false
  });

  const totalCells = GRID_SIZE * GRID_SIZE;
  const burnableCellCount = fuelField.summary.burnableCellCount;
  const nonBurnableCellCount = totalCells - burnableCellCount;

  // A field with no burnable cell is a legitimate outcome (dense urban, water,
  // bare rock), not an error. Returning it with metrics lets the UI say what
  // happened; throwing here used to surface as a bare console warning.
  const wx = burnableCellCount === 0
    ? null
    : await resolveWeatherInputs({ lat, lon, overrides, landCover: clickedLandCover, fuelDecision: clickedFuelDecision });

  const arrivalValues = burnableCellCount === 0
    ? new Float32Array(totalCells).fill(Infinity)
    : await runFireWorkerOnce({
    runId: 1,
    engine: 'phase1',
    size: GRID_SIZE,
    cellSizeKm: CELL_SIZE_METERS / 1000,
    seed: 17,
    scenario: 'calm',
    params: {
      windSpeed: overrides.windSpeed,
      windDirection: overrides.windDirection,
      moisture: overrides.deadMoisture,
      deadMoisture: overrides.deadMoisture,
      liveMoisture: overrides.liveMoisture,
      useWeatherMoisture: overrides.useWeatherMoisture,
      slopeStrength: overrides.slopeStrength
    },
    speed: 24,
    timestepMinutes: 1,
    ignition: { x: FIELD_CENTER, y: FIELD_CENTER },
    fuelModelCode: clickedFuelDecision.fuelCode,
    fuelModelCodes: fuelField.fuelModelCodes,
    fuelModelDefinitionsByCode: fuelField.fuelModelDefinitionsByCode,
    fuelLoadScaleByCell: fuelField.fuelLoadScaleByCell,
    fuelPersistenceMinutesByCell: fuelField.fuelPersistenceMinutesByCell,
    waterBarrierEdges: fuelField.waterBarrierEdges,
    fuelBedDepthMeters: wx.fuelBedDepthMeters,
    canopySheltered: wx.canopySheltered,
    moistureFraction: overrides.deadMoisture,
    deadMoistureFraction: overrides.deadMoisture,
    liveMoistureFraction: overrides.liveMoisture,
    deadMoistureByClass: wx.deadMoistureByClass,
    liveMoistureByClass: wx.liveMoistureByClass,
    weatherTimeline: wx.weatherTimeline,
    midflameWindKmh: wx.midflameWindKmh,
    windDirectionRadians: wx.windDirectionRadians,
    defaultSlopeRadians: Math.atan(Math.max(0, overrides.slopeStrength)),
    defaultSlopeAspectEast: 0,
    defaultSlopeAspectNorth: 0,
    maxPropagationMinutes: MAX_PROPAGATION_MINUTES,
    enableSpotting: false
    });

  // The diagnostics that actually distinguish outcomes. terminationReason
  // ('horizon_reached') fires on nearly every run — any single cell whose
  // travel time lands past the cap is enough — so it says almost nothing about
  // whether the fire spread. These four do.
  let burnedCellCount = 0;
  let maxFiniteArrivalMinutes = 0;
  for (let i = 0; i < arrivalValues.length; i += 1) {
    const arrival = arrivalValues[i];
    if (!Number.isFinite(arrival)) continue;
    burnedCellCount += 1;
    if (arrival > maxFiniteArrivalMinutes) maxFiniteArrivalMinutes = arrival;
  }

  const fuelCodes = new Uint8Array(GRID_SIZE * GRID_SIZE);
  for (let i = 0; i < fuelCodes.length; i += 1) {
    fuelCodes[i] = FUEL_CODE_INDEX.get(fuelField.fuelModelCodes[i]) ?? 0;
  }

  const buildings = (urbanFootprints?.buildings ?? []).map((b) => ({
    ring: b.rings[0] ?? [],
    height: b.heightMeters
  }));
  const roads = [];
  for (const road of urbanFootprints?.roads ?? []) {
    for (const polygon of bufferLineToQuads(road.line, road.widthMeters ?? DEFAULT_ROAD_WIDTH_METERS)) {
      roads.push({ polygon });
    }
  }

  return {
    arrivalMinutes: Float32Array.from(arrivalValues),
    fuelCodes,
    buildings,
    roads,
    cellSizeMeters: CELL_SIZE_METERS,
    gridSize: GRID_SIZE,
    bbox,
    metrics: {
      burnedCellCount,
      burnableCellCount,
      nonBurnableCellCount,
      maxFiniteArrivalMinutes,
      maxPropagationMinutes: MAX_PROPAGATION_MINUTES,
      cellAreaSquareMeters: CELL_SIZE_METERS * CELL_SIZE_METERS
    },
    provenance: {
      worldCover: { source: 'ESA WorldCover (coarse mosaic)', clickedClassCode: clickedLandCover?.classCode ?? null },
      osm: urbanFootprints?.available ? 'OSM Overpass' : 'unavailable',
      fuelCrosswalk: 'landCoverToFuel.js',
      fuelCodeList: listFuelModelCodes(),
      weather: wx?.manualWind
        ? `manual override — ${overrides.windSpeed} km/h @ ${overrides.windDirection}deg`
        : (wx?.weather
          ? `Open-Meteo observed — midflame ${wx.midflameWindKmh.toFixed(1)} km/h${wx.weatherTimeline ? ' (time-varying)' : ''}`
          : 'Open-Meteo unavailable — slider values'),
      terrain: 'flat — no DEM (not yet wired)'
    }
  };
}
