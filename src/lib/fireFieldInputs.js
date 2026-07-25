// Build the spatial fuel field consumed by the rate-based propagation engine.
// Unknown land-cover cells are barriers: an experimental burnable default is
// appropriate for a single clicked cell, but unsafe for an entire raster.

import { NON_BURNABLE_FUEL_CODE } from './fuelModels.js';
import { GLOBAL_FUELBED_MAX_PERSISTENCE_MINUTES } from './globalFuelbed.js';
import {
  hasUsableCanopyWindStructure,
  hasUsableCrownStructure
} from './landfireCanopy.js';

const NEIGHBORS = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1]
];
const REVERSE_NEIGHBOR_INDEX = [1, 0, 3, 2, 7, 6, 5, 4];
const EDGE_SAMPLE_FRACTIONS = [0.25, 0.5, 0.75];
const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'experimental'];

export function buildFuelModelCodeField({
  grid,
  classifyAtLatLon,
  classifyAtCell = null,
  crosswalk,
  isWaterAtLatLon = null,
  ignition = null,
  ignitionFuelCode = null,
  ignitionFuelLoadScale = 1,
  canopyHeightByCell = null,
  canopyCoverFractionByCell = null,
  canopyBaseHeightByCell = null,
  canopyBulkDensityByCell = null,
  canopyShelterMinimumHeightMeters = 2,
  nonBurnableFuelCode = NON_BURNABLE_FUEL_CODE,
  allowExperimental = false
} = {}) {
  if (!grid || !Number.isInteger(grid.gridSize) || typeof grid.cellCenterLatLon !== 'function') {
    throw new TypeError('fireFieldInputs: grid with gridSize and cellCenterLatLon is required');
  }
  if (typeof classifyAtLatLon !== 'function' && typeof classifyAtCell !== 'function') {
    throw new TypeError('fireFieldInputs: classifyAtLatLon is required');
  }
  if (typeof crosswalk !== 'function') {
    throw new TypeError('fireFieldInputs: crosswalk is required');
  }
  if (isWaterAtLatLon !== null && typeof isWaterAtLatLon !== 'function') {
    throw new TypeError('fireFieldInputs: isWaterAtLatLon must be a function when provided');
  }

  const size = grid.gridSize;
  const fuelModelCodes = new Array(size * size).fill(nonBurnableFuelCode);
  const fuelModelAlternativesByCell = Array.from({ length: size * size }, () => null);
  const fuelModelDefinitionsByCode = Object.create(null);
  const fuelLoadScaleByCell = new Float32Array(size * size);
  const fuelPersistenceMinutesByCell = new Float32Array(size * size);
  let classifiedCellCount = 0;
  let unknownCellCount = 0;
  let burnableCellCount = 0;
  let nonBurnableCellCount = 0;
  let waterCellCount = 0;
  let waterBarrierEdgeCount = 0;
  let crosswalkCellCount = 0;
  let fineSampledCellCount = 0;
  let fineBurnableFractionSum = 0;
  let fineBurnableFractionMinimum = 1;
  let fineBurnableFractionMaximum = 0;
  let canopyShelteredCellCount = 0;
  let canopyHeightDataCellCount = 0;
  let canopyHeightShelteredCellCount = 0;
  let canopyWindStructureDataCellCount = 0;
  let globalCanopyStructureDataCellCount = 0;
  let globalCanopyBaseHeightDataCellCount = 0;
  let crownStructureDataCellCount = 0;
  let globalFuelbedCellCount = 0;
  let regionalFuelCellCount = 0;
  const regionalFuelModelCounts = Object.create(null);
  const crosswalkConfidenceCounts = createConfidenceCounts();
  const waterCellMask = new Uint8Array(size * size);
  const canopyShelteredByCell = new Uint8Array(size * size);
  const canopyCrownAvailableByCell = new Uint8Array(size * size);
  const normalizedCanopyBaseHeightByCell = new Float32Array(size * size);
  const normalizedCanopyBulkDensityByCell = new Float32Array(size * size);
  const normalizedCanopyHeightByCell = new Float32Array(size * size);
  const normalizedCanopyCoverFractionByCell = new Float32Array(size * size);
  normalizedCanopyBaseHeightByCell.fill(-1);
  normalizedCanopyBulkDensityByCell.fill(-1);
  normalizedCanopyHeightByCell.fill(-1);
  normalizedCanopyCoverFractionByCell.fill(-1);
  const waterBarrierEdges = new Uint8Array(size * size * NEIGHBORS.length);
  const decisionCache = new Map();

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const index = row * size + col;
      const { latitude, longitude } = grid.cellCenterLatLon(row, col);
      if (isWaterAtLatLon?.(latitude, longitude, {
        kind: 'cell-center',
        row,
        col,
        index
      }) === true) {
        waterCellCount += 1;
        waterCellMask[index] = 1;
        nonBurnableCellCount += 1;
        continue;
      }
      const landCover = classifyAtCell
        ? classifyAtCell(row, col, index, { latitude, longitude })
        : classifyAtLatLon(latitude, longitude);
      if (!landCover) {
        unknownCellCount += 1;
        nonBurnableCellCount += 1;
        continue;
      }

      classifiedCellCount += 1;
      const cacheKey = Number.isFinite(landCover.classCode) && !landCover.landfireFuelModelCode
        ? landCover.classCode
        : null;
      const hasFractionalCover = Boolean(landCover.coverFractions);
      const hasGlobalFuelbed = Boolean(landCover.globalFuelbed);
      const decision = cacheKey === null || hasFractionalCover || hasGlobalFuelbed
        ? crosswalk(landCover)
        : (decisionCache.has(cacheKey)
          ? decisionCache.get(cacheKey)
          : decisionCacheSet(decisionCache, cacheKey, crosswalk(landCover)));
      crosswalkCellCount += 1;
      incrementConfidence(crosswalkConfidenceCounts, decision?.confidence);
      if (decision?.landfireFuelModelCode) {
        regionalFuelCellCount += 1;
        regionalFuelModelCounts[decision.landfireFuelModelCode] =
          (regionalFuelModelCounts[decision.landfireFuelModelCode] ?? 0) + 1;
      }
      if (Number.isFinite(decision?.fineBurnableFraction)
        && decision.fineBurnableFraction >= 0
        && decision.fineBurnableFraction <= 1) {
        fineSampledCellCount += 1;
        fineBurnableFractionSum += decision.fineBurnableFraction;
        fineBurnableFractionMinimum = Math.min(fineBurnableFractionMinimum, decision.fineBurnableFraction);
        fineBurnableFractionMaximum = Math.max(fineBurnableFractionMaximum, decision.fineBurnableFraction);
      }
      if (landCover.burnable === false) {
        nonBurnableCellCount += 1;
        continue;
      }
      const accepted = decision && (allowExperimental || decision.confidence !== 'experimental');
      const code = accepted ? decision.fuelCode : nonBurnableFuelCode;
      fuelModelCodes[index] = code;
      if (accepted && decision?.fuelModelDefinition) {
        fuelModelDefinitionsByCode[code] = decision.fuelModelDefinition;
        if (decision.globalFuelbedId) globalFuelbedCellCount += 1;
      }
      if (accepted && Array.isArray(decision?.fuelModelAlternatives)
        && decision.fuelModelAlternatives.length > 1) {
        fuelModelAlternativesByCell[index] = [...decision.fuelModelAlternatives];
      }
      fuelLoadScaleByCell[index] = accepted && decision.burnable && code !== nonBurnableFuelCode
        ? Math.min(1, Math.max(0, decision.fuelLoadScale ?? 1))
        : 0;
      fuelPersistenceMinutesByCell[index] = accepted && decision.burnable
        && code !== nonBurnableFuelCode
        && Number.isFinite(decision.fuelPersistenceMinutes)
        ? Math.min(
          GLOBAL_FUELBED_MAX_PERSISTENCE_MINUTES,
          Math.max(0, decision.fuelPersistenceMinutes)
        )
        : 0;
      const mappedCanopyClass = landCover.classCode === 10 || landCover.classCode === 95;
      const globalCanopyHeight = decision?.canopyHeightMeters;
      const globalCanopyCoverFraction = decision?.canopyCoverFraction;
      const globalCanopyBaseHeight = decision?.canopyBaseHeightMeters;
      const externalCanopyHeight = canopyHeightByCell?.[index];
      const hasExternalCanopyHeight = Number.isFinite(externalCanopyHeight) && externalCanopyHeight >= 0;
      const canopyHeight = hasExternalCanopyHeight ? externalCanopyHeight : globalCanopyHeight;
      const hasCanopyHeight = Number.isFinite(canopyHeight) && canopyHeight >= 0;
      const hasGlobalCanopyStructure = accepted
        && decision.burnable
        && !hasExternalCanopyHeight
        && Number.isFinite(globalCanopyHeight)
        && Number.isFinite(globalCanopyCoverFraction);
      if (hasGlobalCanopyStructure) globalCanopyStructureDataCellCount += 1;
      if (hasCanopyHeight) canopyHeightDataCellCount += 1;
      if (hasCanopyHeight) normalizedCanopyHeightByCell[index] = canopyHeight;
      const externalCanopyCoverFraction = canopyCoverFractionByCell?.[index];
      const hasExternalCanopyCover = Number.isFinite(externalCanopyCoverFraction)
        && externalCanopyCoverFraction >= 0
        && externalCanopyCoverFraction <= 1;
      const canopyCoverFraction = hasExternalCanopyCover
        ? externalCanopyCoverFraction
        : globalCanopyCoverFraction;
      if (Number.isFinite(canopyCoverFraction)
        && canopyCoverFraction >= 0
        && canopyCoverFraction <= 1) {
        normalizedCanopyCoverFractionByCell[index] = canopyCoverFraction;
      }
      const externalCanopyBaseHeight = canopyBaseHeightByCell?.[index];
      const hasExternalCanopyBaseHeight = Number.isFinite(externalCanopyBaseHeight)
        && externalCanopyBaseHeight >= 0;
      const canopyBaseHeight = hasExternalCanopyBaseHeight
        ? externalCanopyBaseHeight
        : globalCanopyBaseHeight;
      const hasCanopyBaseHeight = Number.isFinite(canopyBaseHeight) && canopyBaseHeight >= 0;
      if (!hasExternalCanopyBaseHeight && Number.isFinite(globalCanopyBaseHeight)
        && globalCanopyBaseHeight >= 0) globalCanopyBaseHeightDataCellCount += 1;
      if (hasCanopyBaseHeight) normalizedCanopyBaseHeightByCell[index] = canopyBaseHeight;
      const canopyWindClass = mappedCanopyClass || hasGlobalCanopyStructure;
      if (canopyWindClass && hasUsableCanopyWindStructure({
        canopyHeightMeters: canopyHeight,
        canopyCoverFraction
      })) canopyWindStructureDataCellCount += 1;
      const hasMeasuredShelter = hasCanopyHeight
        ? canopyHeight >= canopyShelterMinimumHeightMeters
        : mappedCanopyClass;
      if (accepted && decision.burnable && code !== nonBurnableFuelCode && canopyWindClass
        && hasMeasuredShelter) {
        canopyShelteredByCell[index] = 1;
        canopyShelteredCellCount += 1;
        if (hasCanopyHeight) canopyHeightShelteredCellCount += 1;
      }
      const canopyBaseHeightMeters = canopyBaseHeightByCell?.[index];
      const canopyBulkDensityKgPerM3 = canopyBulkDensityByCell?.[index];
      if (mappedCanopyClass && hasUsableCrownStructure({
        canopyBaseHeightMeters: canopyBaseHeight,
        canopyBulkDensityKgPerM3
      })) {
        normalizedCanopyBaseHeightByCell[index] = canopyBaseHeightMeters;
        normalizedCanopyBulkDensityByCell[index] = canopyBulkDensityKgPerM3;
        if (accepted && decision.burnable && code !== nonBurnableFuelCode) {
          canopyCrownAvailableByCell[index] = 1;
          crownStructureDataCellCount += 1;
        }
      }
      if (accepted && decision.burnable && code !== nonBurnableFuelCode) burnableCellCount += 1;
      else nonBurnableCellCount += 1;
    }
  }

  // Center samples catch ordinary water cells, but a narrow river or coast
  // can fall between two land-centered cells. Sample each unique cell edge
  // and mark the transition itself as blocked when the authoritative water
  // source intersects it. The reverse edge receives the same flag so the
  // propagation solver cannot cross it from either side.
  if (isWaterAtLatLon) {
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const index = row * size + col;
        const origin = grid.cellCenterLatLon(row, col);
        for (let directionIndex = 0; directionIndex < NEIGHBORS.length; directionIndex += 1) {
          const [dx, dy] = NEIGHBORS[directionIndex];
          const nextCol = col + dx;
          const nextRow = row + dy;
          if (nextCol < 0 || nextCol >= size || nextRow < 0 || nextRow >= size) continue;
          const nextIndex = nextRow * size + nextCol;
          if (nextIndex <= index) continue;
          const destination = grid.cellCenterLatLon(nextRow, nextCol);
          const blocked = EDGE_SAMPLE_FRACTIONS.some((fraction) => {
            const longitude = interpolateLongitude(origin.longitude, destination.longitude, fraction);
            const latitude = origin.latitude + (destination.latitude - origin.latitude) * fraction;
            return isWaterAtLatLon(latitude, longitude, {
              kind: 'cell-edge',
              originRow: row,
              originCol: col,
              originIndex: index,
              directionIndex,
              fraction
            }) === true;
          });
          if (!blocked) continue;
          waterBarrierEdges[index * NEIGHBORS.length + directionIndex] = 1;
          waterBarrierEdges[nextIndex * NEIGHBORS.length + REVERSE_NEIGHBOR_INDEX[directionIndex]] = 1;
          waterBarrierEdgeCount += 1;
        }
      }
    }
  }

  if (ignitionFuelCode && ignition) {
    const ignitionXValue = Number.isFinite(ignition.x) ? ignition.x : ignition.col;
    const ignitionYValue = Number.isFinite(ignition.y) ? ignition.y : ignition.row;
    const ignitionX = clampIndex(
      Math.floor(Number.isFinite(ignitionXValue) ? ignitionXValue : (size - 1) / 2),
      size
    );
    const ignitionY = clampIndex(
      Math.floor(Number.isFinite(ignitionYValue) ? ignitionYValue : (size - 1) / 2),
      size
    );
    const ignitionIndex = ignitionY * size + ignitionX;
    const wasBurnable = fuelModelCodes[ignitionIndex] !== nonBurnableFuelCode;
    fuelModelCodes[ignitionIndex] = ignitionFuelCode;
    if (ignitionFuelCode !== nonBurnableFuelCode) {
      const alternatives = [...new Set([
        ignitionFuelCode,
        ...(fuelModelAlternativesByCell[ignitionIndex] ?? [])
      ])];
      fuelModelAlternativesByCell[ignitionIndex] = alternatives.length > 1 ? alternatives : null;
    }
    fuelLoadScaleByCell[ignitionIndex] = ignitionFuelCode === nonBurnableFuelCode
      ? 0
      : Math.min(1, Math.max(0, ignitionFuelLoadScale));
    if (!wasBurnable && ignitionFuelCode !== nonBurnableFuelCode && waterCellMask[ignitionIndex] === 0) {
      nonBurnableCellCount -= 1;
      burnableCellCount += 1;
    }
    if (waterCellMask[ignitionIndex] === 1) fuelModelCodes[ignitionIndex] = nonBurnableFuelCode;
  }

  return {
    fuelModelCodes,
    fuelModelAlternativesByCell,
    fuelModelDefinitionsByCode,
    fuelLoadScaleByCell,
    fuelPersistenceMinutesByCell,
    summary: {
      gridSize: size,
      totalCellCount: size * size,
      classifiedCellCount,
      unknownCellCount,
      burnableCellCount,
      nonBurnableCellCount,
      waterCellCount,
      waterBarrierEdgeCount,
      crosswalkCellCount,
      fineSampledCellCount,
      meanFineBurnableFraction: fineSampledCellCount > 0
        ? fineBurnableFractionSum / fineSampledCellCount
        : null,
      minFineBurnableFraction: fineSampledCellCount > 0 ? fineBurnableFractionMinimum : null,
      maxFineBurnableFraction: fineSampledCellCount > 0 ? fineBurnableFractionMaximum : null,
      canopyShelteredCellCount,
      canopyHeightDataCellCount,
      canopyHeightShelteredCellCount,
      canopyWindStructureDataCellCount,
      globalCanopyStructureDataCellCount,
      globalCanopyBaseHeightDataCellCount,
      crownStructureDataCellCount,
      crosswalkConfidenceCounts,
      experimentalCellCount: crosswalkConfidenceCounts.experimental,
      lowConfidenceCellCount: crosswalkConfidenceCounts.low,
      unknownOrUnclassifiedCellCount: unknownCellCount,
      fuelModelAlternativeCellCount: fuelModelAlternativesByCell.filter(Boolean).length,
      globalFuelbedCellCount,
      regionalFuelCellCount,
      regionalFuelModelCounts,
      fuelPersistenceCellCount: [...fuelPersistenceMinutesByCell]
        .filter((value) => value > 0).length,
      maxFuelPersistenceMinutes: Math.max(...fuelPersistenceMinutesByCell)
    },
    waterBarrierEdges,
    canopyShelteredByCell,
    canopyCrownAvailableByCell,
    canopyHeightByCell: normalizedCanopyHeightByCell,
    canopyCoverFractionByCell: normalizedCanopyCoverFractionByCell,
    canopyBaseHeightByCell: normalizedCanopyBaseHeightByCell,
    canopyBulkDensityByCell: normalizedCanopyBulkDensityByCell
  };
}

function createConfidenceCounts() {
  return Object.fromEntries(CONFIDENCE_LEVELS.map((level) => [level, 0]));
}

function incrementConfidence(counts, confidence) {
  const level = CONFIDENCE_LEVELS.includes(confidence) ? confidence : 'experimental';
  counts[level] += 1;
}

function decisionCacheSet(cache, key, value) {
  cache.set(key, value);
  return value;
}

function clampIndex(index, size) {
  return Math.min(size - 1, Math.max(0, index));
}

function interpolateLongitude(from, to, fraction) {
  let delta = to - from;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  let longitude = from + delta * fraction;
  if (longitude > 180) longitude -= 360;
  if (longitude < -180) longitude += 360;
  return longitude;
}
