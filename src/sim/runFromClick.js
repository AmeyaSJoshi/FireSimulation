// P2 — Ignition: click a lat/lon, run the existing block-scale (640 m, 10 m
// cells, 64x64) fire simulation against real WorldCover + OSM data, and
// return the frozen contract documented in CLAUDE.md. Reuses src/lib/ as-is;
// nothing in src/lib/ is modified.
//
// Not yet included (later milestones): live weather, terrain/DEM, LANDFIRE
// canopy, uncertainty ensemble. Runs flat defaults (calm, no wind, no slope)
// so this stays a pure WorldCover+OSM ignition test.

import { createSpatialGrid } from '../lib/spatialGrid.js';
import { createLandCoverSource, createCanvasImageReader } from '../lib/landCoverSource.js';
import { crosswalkLandCoverToFuel } from '../lib/landCoverToFuel.js';
import { buildFuelModelCodeField } from '../lib/fireFieldInputs.js';
import { BUILT_UP_CLASS_CODE, bufferLineToQuads, fetchUrbanFootprintsForBbox } from '../lib/urbanFootprints.js';
import { listFuelModelCodes } from '../lib/fuelModels.js';

export const GRID_SIZE = 64;
export const CELL_SIZE_METERS = 10;
const FIELD_CENTER = (GRID_SIZE - 1) / 2;
const MAX_PROPAGATION_MINUTES = 120;
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

export async function runFromClick({ lat, lon }) {
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

  if (!clickedFuelDecision.burnable || fuelField.summary.burnableCellCount === 0) {
    throw new Error('runFromClick: no burnable fuel at this location');
  }

  const arrivalValues = await runFireWorkerOnce({
    runId: 1,
    engine: 'phase1',
    size: GRID_SIZE,
    cellSizeKm: CELL_SIZE_METERS / 1000,
    seed: 17,
    scenario: 'calm',
    params: { windSpeed: 0, windDirection: 0, moisture: 0.08, deadMoisture: 0.08, liveMoisture: 0.6 },
    speed: 24,
    timestepMinutes: 1,
    ignition: { x: FIELD_CENTER, y: FIELD_CENTER },
    fuelModelCode: clickedFuelDecision.fuelCode,
    fuelModelCodes: fuelField.fuelModelCodes,
    fuelModelDefinitionsByCode: fuelField.fuelModelDefinitionsByCode,
    fuelLoadScaleByCell: fuelField.fuelLoadScaleByCell,
    fuelPersistenceMinutesByCell: fuelField.fuelPersistenceMinutesByCell,
    waterBarrierEdges: fuelField.waterBarrierEdges,
    moistureFraction: 0.08,
    deadMoistureFraction: 0.08,
    liveMoistureFraction: 0.6,
    midflameWindKmh: 0,
    windDirectionRadians: 0,
    defaultSlopeRadians: 0,
    defaultSlopeAspectEast: 0,
    defaultSlopeAspectNorth: 0,
    maxPropagationMinutes: MAX_PROPAGATION_MINUTES,
    enableSpotting: false
  });

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
    provenance: {
      worldCover: { source: 'ESA WorldCover (coarse mosaic)', clickedClassCode: clickedLandCover?.classCode ?? null },
      osm: urbanFootprints?.available ? 'OSM Overpass' : 'unavailable',
      fuelCrosswalk: 'landCoverToFuel.js',
      fuelCodeList: listFuelModelCodes(),
      weather: 'flat default — calm, no wind (not yet wired to live weather)',
      terrain: 'flat — no DEM (not yet wired)'
    }
  };
}
