import { NON_BURNABLE_FUEL_CODE, getFuelModel } from '../lib/fuelModels.js';
import { crosswalkLandCoverToFuel } from '../lib/landCoverToFuel.js';
import { classifyWorldCoverFineCode } from '../lib/worldCoverFine.js';
import { isWithinLandfireFuelCoverage } from '../lib/landfireFuel.js';
import { loadEnvironmentalContext } from './environmentalAdapters.js';

export const DEFAULT_FALLBACK_FUEL_CODE = 'SH5';
const REGIONAL_PROVIDER_TIMEOUT_MS = 6_000;
const GLOBAL_PROVIDER_TIMEOUT_MS = 10_000;

function boundedSignal(signal, timeoutMs) {
  const timeoutSignal = typeof globalThis.AbortSignal?.timeout === 'function'
    ? globalThis.AbortSignal.timeout(timeoutMs)
    : null;
  if (signal && timeoutSignal && typeof globalThis.AbortSignal.any === 'function') {
    return globalThis.AbortSignal.any([signal, timeoutSignal]);
  }
  return signal ?? timeoutSignal ?? undefined;
}

function fuelDefinitions(codes) {
  const definitions = Object.create(null);
  for (const code of new Set(codes)) {
    try {
      definitions[code] = getFuelModel(code);
    } catch {
      definitions[NON_BURNABLE_FUEL_CODE] = getFuelModel(NON_BURNABLE_FUEL_CODE);
    }
  }
  return definitions;
}

function knownFuelCodes(codes) {
  return codes.map((code) => {
    try {
      return getFuelModel(code).code;
    } catch {
      return NON_BURNABLE_FUEL_CODE;
    }
  });
}

function gridBbox(grid) {
  const corners = [
    grid.cellCenterLatLon(-0.5, -0.5),
    grid.cellCenterLatLon(-0.5, grid.gridSize - 0.5),
    grid.cellCenterLatLon(grid.gridSize - 0.5, -0.5),
    grid.cellCenterLatLon(grid.gridSize - 0.5, grid.gridSize - 0.5)
  ];
  return [
    Math.min(...corners.map(({ longitude }) => longitude)),
    Math.min(...corners.map(({ latitude }) => latitude)),
    Math.max(...corners.map(({ longitude }) => longitude)),
    Math.max(...corners.map(({ latitude }) => latitude))
  ];
}

function fallbackContext(totalCells, reason, fuelCode = DEFAULT_FALLBACK_FUEL_CODE) {
  const fuelCodes = Array.from({ length: totalCells }, () => fuelCode);
  return {
    fuelCodes,
    fuelModelDefinitionsByCode: fuelDefinitions(fuelCodes),
    terrainHeights: null,
    buildings: [],
    roads: [],
    evidence: {
      sources: [],
      fallbacks: [reason]
    },
    confidence: 'fallback'
  };
}

export function createFallbackScenarioAdapters({ fuelCode = DEFAULT_FALLBACK_FUEL_CODE } = {}) {
  getFuelModel(fuelCode);
  return {
    async loadContext({ totalCells, reason = 'No live landscape adapter was available.' }) {
      return fallbackContext(totalCells, reason, fuelCode);
    }
  };
}

export function createViteScenarioAdapters({
  fetchImpl = globalThis.fetch,
  endpoint = '/api/landcover/fine-field',
  landfireEndpoint = '/api/fuel/landfire-field',
  osmEndpoint = '/api/osm/features',
  environmentalLayers = true,
  fallback = createFallbackScenarioAdapters()
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('scenarioAdapters: fetchImpl must be a function');
  return {
    async loadContext({ grid, totalCells, signal, includeWeatherMoisture = true }) {
      const bbox = gridBbox(grid);
      const enrich = async (context) => {
        if (!environmentalLayers) return context;
        const environment = await loadEnvironmentalContext({
          grid, bbox, fuelCodes: context.fuelCodes, fetchImpl, signal, osmEndpoint,
          includeWeatherMoisture
        });
        return {
          ...context,
          ...environment,
          evidence: {
            sources: [...context.evidence.sources, ...environment.evidence.sources],
            fallbacks: [...context.evidence.fallbacks, ...environment.evidence.fallbacks]
          }
        };
      };
      let landfireFallbackReason = null;
      if (isWithinLandfireFuelCoverage(bbox)) {
        try {
          const response = await fetchImpl(landfireEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bbox, width: grid.gridSize, height: grid.gridSize }),
            signal: boundedSignal(signal, REGIONAL_PROVIDER_TIMEOUT_MS)
          });
          if (!response.ok) throw new Error(`LANDFIRE adapter returned HTTP ${response.status}`);
          const payload = await response.json();
          if (payload.available !== true || !Array.isArray(payload.fuelModelCodes)
            || payload.fuelModelCodes.length !== totalCells) {
            throw new Error(`LANDFIRE unavailable: ${payload.reason ?? 'incomplete field'}`);
          }
          const fuelCodes = knownFuelCodes(payload.fuelModelCodes);
          return enrich({
            fuelCodes,
            fuelModelDefinitionsByCode: fuelDefinitions(fuelCodes),
            terrainHeights: null,
            buildings: [],
            roads: [],
            evidence: {
              sources: [{ name: payload.source ?? 'LANDFIRE FBFM40', resolutionMeters: payload.resolutionMeters ?? 30 }],
              fallbacks: []
            },
            confidence: 'regional'
          });
        } catch (error) {
          landfireFallbackReason = error.message;
        }
      }
      const samples = [];
      for (let row = 0; row < grid.gridSize; row += 1) {
        for (let col = 0; col < grid.gridSize; col += 1) {
          samples.push(grid.cellCenterLatLon(row, col));
        }
      }
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ samples }),
          signal: boundedSignal(signal, GLOBAL_PROVIDER_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error(`WorldCover adapter returned HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload.classCodes) || payload.classCodes.length !== totalCells) {
          throw new Error('WorldCover adapter returned an incomplete field');
        }
        const decisions = payload.classCodes.map((classCode) => {
          const classification = classifyWorldCoverFineCode(classCode, payload.source);
          return crosswalkLandCoverToFuel(classification);
        });
        const fuelCodes = knownFuelCodes(decisions.map((decision) => decision?.fuelCode ?? NON_BURNABLE_FUEL_CODE));
        const confidence = decisions.some((decision) => decision?.confidence === 'experimental')
          ? 'experimental'
          : 'global';
        return enrich({
          fuelCodes,
          fuelModelDefinitionsByCode: fuelDefinitions(fuelCodes),
          terrainHeights: null,
          buildings: [],
          roads: [],
          evidence: {
            sources: [{ name: payload.source ?? 'ESA WorldCover', resolutionMeters: payload.resolutionMeters ?? 10 }],
            fallbacks: landfireFallbackReason ? [landfireFallbackReason] : []
          },
          confidence
        });
      } catch (error) {
        const reasons = [landfireFallbackReason, error.message].filter(Boolean).join('; ');
        return fallback.loadContext({ totalCells, reason: reasons });
      }
    }
  };
}
