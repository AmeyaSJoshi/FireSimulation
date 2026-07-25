// Global FCCS fuelbed provenance, tile geometry, and the conservative bridge
// from the published parameter table to this project's Rothermel surface
// solver. The FCCS table contains more strata than the surface kernel can
// currently consume. Only explicit grass and woody 1/10/100-hour loads are
// converted here; litter/duff-only fuelbeds are rejected rather than assigned
// an invented bulk density. When FCCS publishes G_live, the total grass load
// is split into dead 1-hour and live herbaceous fuel instead of assuming that
// all grass is live.

import {
  STANDARD_FUEL_PARTICLE_PROPERTIES
} from './fuelModels.js';

export const GLOBAL_FUELBED_SOURCE = Object.freeze({
  id: 'pettinari-global-fuelbed-dataset',
  title: 'Pettinari and Chuvieco Global Fuelbed Dataset',
  parameterVersion: 'v1.2',
  resolutionMeters: 300,
  mapProjection: 'WGS84 geographic lat/lon',
  doiUrl: 'https://doi.org/10.1594/PANGAEA.849808',
  paperUrl: 'https://doi.org/10.5194/bg-13-2061-2016',
  license: 'CC-BY-NC-SA-3.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/3.0/',
  parameterUrl: 'https://store.pangaea.de/Publications/Pettinari_2015/Global_fuelbeds_parameters_v1.2.xlsx'
});

export const GLOBAL_FUELBED_PIXEL_SIZE_DEGREES = 0.0027777778;
export const GLOBAL_FUELBED_NODATA = 2147483647;
export const GLOBAL_FUELBED_MAX_PERSISTENCE_MINUTES = 48 * 60;

// Bounds are taken from the dataset readme. The map tiles intentionally have
// a small amount of overlap/gap at some coastlines; the resolver keeps the
// first matching tile and the raster's own no-data value remains authoritative.
export const GLOBAL_FUELBED_TILES = Object.freeze([
  { id: 1, name: 'North America 1', west: -180, east: -105, south: 17, north: 85 },
  { id: 2, name: 'North America 2', west: -105, east: -34, south: 17, north: 85 },
  { id: 3, name: 'South America', west: -105, east: -34, south: -57, north: 17 },
  { id: 4, name: 'Europe', west: -34, east: 60, south: 25, north: 85 },
  { id: 5, name: 'Africa', west: -26, east: 60, south: -38, north: 25 },
  { id: 6, name: 'Asia 1', west: 60, east: 105, south: 0, north: 85 },
  { id: 7, name: 'Asia 2', west: 105, east: 180, south: 0, north: 85 },
  { id: 8, name: 'Oceania', west: 95, east: 180, south: -53, north: 0 }
]);

export function globalFuelbedTileForLocation(latitude, longitude) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return GLOBAL_FUELBED_TILES.find((tile) => (
    latitude >= tile.south
      && latitude < tile.north
      && longitude >= tile.west
      && longitude < tile.east
  )) ?? null;
}

export function globalFuelbedTileUrl(tileId) {
  const tile = GLOBAL_FUELBED_TILES.find(({ id }) => id === tileId);
  if (!tile) throw new RangeError(`globalFuelbed: unknown tile ${tileId}`);
  return `https://store.pangaea.de/Publications/Pettinari_2015/Global_fuelbeds_map_Tile${tile.id}.zip`;
}

export function globalFuelbedPixelCoordinates(latitude, longitude, tile) {
  if (!tile || typeof tile !== 'object') throw new TypeError('globalFuelbed: tile is required');
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new RangeError('globalFuelbed: coordinates must be finite');
  }
  return {
    x: Math.floor((longitude - tile.west) / GLOBAL_FUELBED_PIXEL_SIZE_DEGREES),
    y: Math.floor((tile.north - latitude) / GLOBAL_FUELBED_PIXEL_SIZE_DEGREES)
  };
}

function readNumber(raw, keys) {
  for (const key of keys) {
    const value = raw?.[key];
    if (value === null || value === undefined || value === '' || value === -1 || value === -3) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return 0;
}

function readText(raw, keys) {
  for (const key of keys) {
    const value = raw?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readOptionalNumber(raw, keys) {
  for (const key of keys) {
    const value = raw?.[key];
    if (value === null || value === undefined || value === '' || value === -1 || value === -3) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function normalizePercent(raw, keys) {
  return Math.min(100, readNumber(raw, keys));
}

function normalizeOptionalPercent(raw, keys) {
  const value = readOptionalNumber(raw, keys);
  return value === null ? null : Math.min(100, value);
}

export function normalizeGlobalFuelbedParameters(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fuelbed = readText(raw, ['fuelbed', 'FUELBED', 'fuelBedId']);
  if (!fuelbed || fuelbed.length > 32) return null;

  const normalized = {
    fuelbed,
    joinValue: readText(raw, ['joinValue', 'JOIN_VALUE']) ?? fuelbed,
    biome: readText(raw, ['biome', 'Biome']),
    landCover: readText(raw, ['landCover', 'LandCover']),
    treeCoverPercent: normalizePercent(raw, ['treeCoverPercent', 'Tree Cover (%)']),
    treeOverstoryCoverPercent: normalizeOptionalPercent(raw, [
      'treeOverstoryCoverPercent', 'TO_Cover (%)'
    ]),
    treeMidstoryCoverPercent: normalizeOptionalPercent(raw, [
      'treeMidstoryCoverPercent', 'TM_Cover (%)'
    ]),
    treeOverstoryHeightMeters: roundGeometry(readNumber(raw, [
      'treeOverstoryHeightMeters', 'TO_Height (m)'
    ])),
    treeOverstoryLiveCrownBaseMeters: roundOptionalGeometry(readOptionalNumber(raw, [
      'treeOverstoryLiveCrownBaseMeters', 'TO_HLC (m)'
    ])),
    treeMidstoryHeightMeters: roundGeometry(readNumber(raw, [
      'treeMidstoryHeightMeters', 'TM_Height (m)'
    ])),
    treeMidstoryLiveCrownBaseMeters: roundOptionalGeometry(readOptionalNumber(raw, [
      'treeMidstoryLiveCrownBaseMeters', 'TM_HLC (m)'
    ])),
    treeLadderFuelPresent: readOptionalNumber(raw, ['treeLadderFuelPresent', 'T_Ladder']),
    treeLadderFuelType: readOptionalNumber(raw, ['treeLadderFuelType', 'T_LadderType']),
    shrubCoverPercent: normalizePercent(raw, ['shrubCoverPercent', 'Shrub Cover (%)']),
    grassCoverPercent: normalizePercent(raw, ['grassCoverPercent', 'Grass Cover (%)']),
    grassLivePercent: normalizeOptionalPercent(raw, ['grassLivePercent', 'G_live (%)']),
    shrubLivePercent: normalizeOptionalPercent(raw, ['shrubLivePercent', 'S_Live (%)']),
    woodyCoverPercent: normalizePercent(raw, ['woodyCoverPercent', 'Woody Cover (%)']),
    grassHeightMeters: roundGeometry(readNumber(raw, ['grassHeightMeters', 'G_height (m)'])),
    shrubHeightMeters: roundGeometry(readNumber(raw, ['shrubHeightMeters', 'S_Height (m)'])),
    woodyDepthMeters: roundGeometry(readNumber(raw, ['woodyDepthMeters', 'woodyDepthCm', 'W_depth (cm)']) * 0.01),
    duffDepthMeters: roundGeometry(readNumber(raw, ['duffDepthMeters', 'duffDepthInches', 'DU_Depth (in)']) * 0.0254),
    grassLoadKgPerM2: roundLoad(readNumber(raw, ['grassLoadKgPerM2', 'grassLoadMgPerHa', 'G_Load (Mg/ha)']) * 0.1),
    dead1hLoadKgPerM2: roundLoad(readNumber(raw, ['dead1hLoadKgPerM2', 'dead1hLoadMgPerHa', 'W_1hLoad (Mg/ha)']) * 0.1),
    dead10hLoadKgPerM2: roundLoad(readNumber(raw, ['dead10hLoadKgPerM2', 'dead10hLoadMgPerHa', 'W_10h Load (Mg/ha)']) * 0.1),
    dead100hLoadKgPerM2: roundLoad(readNumber(raw, ['dead100hLoadKgPerM2', 'dead100hLoadMgPerHa', 'W_100h Load (Mg/ha)']) * 0.1),
    dead1000hLoadKgPerM2: roundLoad(readNumber(raw, ['dead1000hLoadKgPerM2', 'dead1000hLoadMgPerHa', 'W_1000h Load (Mg/ha)']) * 0.1),
    litterCoverPercent: normalizeOptionalPercent(raw, ['litterCoverPercent', 'Litter_Cover (%)']),
    litterDepthMeters: roundLoad(readNumber(raw, ['litterDepthMeters', 'litterDepthCm', 'L_depth (cm)']) * 0.01),
    litterArrangement: readOptionalNumber(raw, ['litterArrangement', 'Litter_Arr']),
    upperDuffCoverPercent: normalizeOptionalPercent(raw, ['upperDuffCoverPercent', 'DU_cover (%)']),
    lowerDuffCoverPercent: normalizeOptionalPercent(raw, ['lowerDuffCoverPercent', 'DL_cover (%)']),
    source: GLOBAL_FUELBED_SOURCE
  };
  return normalized;
}

function roundLoad(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundGeometry(value) {
  return Math.round(value * 10_000) / 10_000;
}

function roundOptionalGeometry(value) {
  return value === null ? null : roundGeometry(value);
}

export function globalFuelbedParameterKeys(raw) {
  const normalized = normalizeGlobalFuelbedParameters(raw);
  if (!normalized) return [];
  return [...new Set([
    normalized.fuelbed,
    normalized.joinValue,
    String(Number(normalized.joinValue))
  ].filter((value) => value && value !== 'NaN'))];
}

function finiteLoad(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function modelCode(fuelbed) {
  return `GF_${fuelbed.replace(/[^A-Za-z0-9]+/g, '_')}`;
}

// FCCS supplies slow-burning fuel indicators, but not the moisture/heat
// transfer state needed for a full smoldering solver. Keep this bridge
// deliberately bounded: it grants a source cell a finite ignition-memory
// window without adding unsupported heavy fuel mass to the flaming Rothermel
// surface rate.
export function globalFuelbedPersistenceMinutes(raw) {
  const parameters = raw?.source?.id === GLOBAL_FUELBED_SOURCE.id
    ? raw
    : normalizeGlobalFuelbedParameters(raw);
  if (!parameters) return 0;
  const heavyWood = finiteLoad(parameters.dead1000hLoadKgPerM2);
  const litterDepth = Number.isFinite(parameters.litterDepthMeters)
    ? parameters.litterDepthMeters
    : 0;
  const duffDepth = Number.isFinite(parameters.duffDepthMeters)
    ? parameters.duffDepthMeters
    : 0;
  const woodyDepth = Number.isFinite(parameters.woodyDepthMeters)
    ? parameters.woodyDepthMeters
    : 0;
  const ladderFuel = parameters.treeLadderFuelPresent === 1 ? 1 : 0;
  const evidence = (
    Math.min(1, heavyWood / 0.5) * 0.45
    + Math.min(1, litterDepth / 0.03) * 0.20
    + Math.min(1, duffDepth / 0.06) * 0.25
    + Math.min(1, woodyDepth / 0.10) * 0.05
    + ladderFuel * 0.05
  );
  if (evidence < 0.15) return 0;
  // Two days is a deliberately bounded upper limit for this bridge. It is
  // long enough for a 100 m cell to cross a later dry window in heavy fuel,
  // but far shorter than the 1000-hour fuel time-lag itself.
  return Math.round(Math.min(
    GLOBAL_FUELBED_MAX_PERSISTENCE_MINUTES,
    30 + evidence * (GLOBAL_FUELBED_MAX_PERSISTENCE_MINUTES - 30)
  ));
}

export function buildRothermelModelFromGlobalFuelbed(raw) {
  const parameters = normalizeGlobalFuelbedParameters(raw);
  if (!parameters) return null;

  const deadLoads = [
    finiteLoad(parameters.dead1hLoadKgPerM2),
    finiteLoad(parameters.dead10hLoadKgPerM2),
    finiteLoad(parameters.dead100hLoadKgPerM2)
  ];
  const totalGrassLoad = finiteLoad(parameters.grassLoadKgPerM2);
  const grassLiveFraction = parameters.grassLivePercent === null
    ? 1
    : parameters.grassLivePercent / 100;
  const grassLiveLoad = totalGrassLoad * grassLiveFraction;
  const grassDeadLoad = totalGrassLoad - grassLiveLoad;
  const herbaceousLoad = grassLiveLoad;
  const dead1hLoad = deadLoads[0] + grassDeadLoad;
  if (deadLoads.every((value) => value === 0) && totalGrassLoad === 0) return null;

  const hasGrassDominance = totalGrassLoad > deadLoads.reduce((sum, value) => sum + value, 0);
  const geometryDepth = hasGrassDominance
    ? parameters.grassHeightMeters
    : parameters.woodyDepthMeters;
  const fallbackDepth = hasGrassDominance ? 0.15 : 0.10;
  const depthBasis = geometryDepth > 0
    ? (hasGrassDominance ? 'fccs-grass-height' : 'fccs-woody-depth')
    : (parameters.litterDepthMeters > 0 ? 'fccs-litter-depth-fallback' : 'bounded-default');
  const depth = Math.min(0.60, Math.max(0.03, geometryDepth || parameters.litterDepthMeters || fallbackDepth));
  const extinction = hasGrassDominance ? 0.15 : 0.30;
  const code = modelCode(parameters.fuelbed);
  const persistenceMinutes = globalFuelbedPersistenceMinutes(parameters);
  const canopyHeightMeters = Math.max(
    parameters.treeOverstoryHeightMeters,
    parameters.treeMidstoryHeightMeters
  );
  const canopyCoverBasis = parameters.treeOverstoryCoverPercent !== null
    && parameters.treeOverstoryCoverPercent > 0
    ? 'fccs-overstory-cover'
    : (parameters.treeCoverPercent > 0 ? 'fccs-total-tree-cover' : 'fccs-midstory-cover');
  const canopyCoverPercent = parameters.treeOverstoryCoverPercent !== null
    && parameters.treeOverstoryCoverPercent > 0
    ? parameters.treeOverstoryCoverPercent
    : (parameters.treeCoverPercent > 0
      ? parameters.treeCoverPercent
      : (parameters.treeMidstoryCoverPercent ?? 0));
  const canopyCoverFraction = canopyCoverPercent > 0
    ? Math.min(1, canopyCoverPercent / 100)
    : null;
  const hasGlobalCanopyStructure = canopyHeightMeters >= 2
    && Number.isFinite(canopyCoverFraction)
    && canopyCoverFraction >= 0.05;
  const liveCrownBaseHeights = [
    parameters.treeOverstoryLiveCrownBaseMeters,
    parameters.treeMidstoryLiveCrownBaseMeters
  ].filter((value) => Number.isFinite(value) && value >= 0);
  const canopyBaseHeightMeters = liveCrownBaseHeights.length > 0
    ? Math.min(...liveCrownBaseHeights)
    : null;

  return {
    ...STANDARD_FUEL_PARTICLE_PROPERTIES,
    code,
    displayName: `Global FCCS fuelbed ${parameters.fuelbed}`,
    burnable: true,
    fuelBedDepthMeters: depth,
    fuelBedDepthBasis: depthBasis,
    windAdjustmentFactor: null,
    heatContentKjPerKg: 18608,
    moistureOfExtinctionFraction: extinction,
    deadFuel: [
      { className: '1h', loadKgPerM2: dead1hLoad, savRatioPerMeter: 6562 },
      { className: '10h', loadKgPerM2: deadLoads[1], savRatioPerMeter: 358 },
      { className: '100h', loadKgPerM2: deadLoads[2], savRatioPerMeter: 98 }
    ],
    liveFuel: [
      { className: 'herbaceous', loadKgPerM2: herbaceousLoad, savRatioPerMeter: 5906 },
      { className: 'woody', loadKgPerM2: 0, savRatioPerMeter: 5249 }
    ],
    globalFuelbed: {
      ...parameters,
      grassLiveLoadKgPerM2: roundLoad(grassLiveLoad),
      grassDeadLoadKgPerM2: roundLoad(grassDeadLoad),
      canopyHeightMeters: hasGlobalCanopyStructure ? canopyHeightMeters : null,
      canopyCoverFraction: hasGlobalCanopyStructure ? canopyCoverFraction : null,
      canopyCoverBasis: hasGlobalCanopyStructure ? canopyCoverBasis : null,
      canopyBaseHeightMeters,
      canopyBaseHeightSource: canopyBaseHeightMeters === null
        ? null
        : `${GLOBAL_FUELBED_SOURCE.title} TO/TM HLC proxy`,
      canopyStructureSource: hasGlobalCanopyStructure
        ? `${GLOBAL_FUELBED_SOURCE.title} TO/TM structure`
        : null,
      persistenceMinutes,
      persistenceBasis: persistenceMinutes > 0
        ? 'bounded FCCS 1000-hour/litter/duff ignition-memory proxy'
        : null
    },
    citation: `${GLOBAL_FUELBED_SOURCE.title} ${GLOBAL_FUELBED_SOURCE.parameterVersion}; `
      + 'Rothermel bridge uses explicit FCCS grass and woody 1/10/100-hour loads '
      + (parameters.grassLivePercent === null
        ? '(grass live fraction unavailable; grass defaults to live), '
        : `(FCCS G_live split at ${parameters.grassLivePercent}%), `)
      + `FCCS geometry depth (${depthBasis}), standard particle SAV values, `
      + (hasGlobalCanopyStructure
        ? `FCCS ${canopyCoverBasis} tree-cover/height shelter fallback, `
        : '')
      + (canopyBaseHeightMeters === null
        ? ''
        : 'FCCS TO/TM height-to-live-crown proxy retained for canopy diagnostics, ')
      + 'and excludes 1000-hour/litter-only mass; the bounded FCCS slow-fuel '
      + 'persistence proxy is used only as finite ignition memory.'
  };
}

export function globalFuelbedToFuelDecision(raw) {
  const model = buildRothermelModelFromGlobalFuelbed(raw);
  if (!model) return null;
  const parameters = model.globalFuelbed;
  return {
    fuelCode: model.code,
    fuelModelDefinition: model,
    fuelLoadScale: 1,
    fuelPersistenceMinutes: model.globalFuelbed.persistenceMinutes,
    fuelDisplayName: model.displayName,
    burnable: true,
    confidence: 'low',
    rationale: `Global FCCS fuelbed ${parameters.fuelbed} supplies explicit surface loads; `
      + (parameters.grassLivePercent === null
        ? 'its grass live fraction is unavailable, and '
        : 'its grass load is split with FCCS G_live, but ')
      + 'the conversion remains low confidence because FCCS litter/duff and 1000-hour '
      + 'components are outside the current surface kernel; a bounded persistence '
      + 'proxy is retained separately for long-duration ignition memory.',
    globalFuelbedId: parameters.fuelbed,
    globalFuelbedSource: GLOBAL_FUELBED_SOURCE,
    canopyHeightMeters: model.globalFuelbed.canopyHeightMeters,
    canopyCoverFraction: model.globalFuelbed.canopyCoverFraction,
    canopyBaseHeightMeters: model.globalFuelbed.canopyBaseHeightMeters,
    canopyStructureSource: model.globalFuelbed.canopyStructureSource,
    landCoverSource: GLOBAL_FUELBED_SOURCE.title,
    fractionalCoverUsed: false,
    crosswalkVersion: 'global-fccs-bridge-0.3.0'
  };
}
