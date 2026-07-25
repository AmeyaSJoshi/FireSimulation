// Crosswalk from ESA WorldCover 2021 class codes to fire-behavior fuel
// models. Every mapping is labeled with an explicit confidence level so
// downstream code (UI, metadata, provenance) can qualify what the run
// is actually based on. Missing or unknown land cover falls back to a
// conservative experimental default rather than pretending we know the
// answer.
//
// Confidence levels used:
//   high         — WorldCover class is unambiguous AND a well-cited
//                  fuel model exists (currently unused; requires a
//                  regional refinement to earn).
//   medium       — WorldCover class matches a Scott & Burgan 2005 fuel
//                  model directly (grass, shrub, timber-litter).
//   low          — approximate mapping to a nearby standard model,
//                  seasonal or regional variation is real (cropland,
//                  wetland).
//   experimental — no defensible mapping exists yet OR land cover is
//                  unavailable for this location; downstream must
//                  flag this in the UI.

import { getFuelModel, NON_BURNABLE_FUEL_CODE } from './fuelModels.js';
import { globalFuelbedToFuelDecision } from './globalFuelbed.js';
import { landfireFuelModelToFuelDecision } from './landfireFuel.js';

export const LAND_COVER_CROSSWALK_VERSION = '1.4.0';
export const FRACTIONAL_WATER_BARRIER_THRESHOLD_PERCENT = 50;
export const FRACTIONAL_VEGETATION_THRESHOLD_PERCENT = 20;

// Deterministic table: WorldCover class code -> crosswalk row.
const CROSSWALK = new Map([
  [0, {
    fuelCode: NON_BURNABLE_FUEL_CODE,
    fuelLoadScale: 0,
    confidence: 'medium',
    rationale: 'WorldCover no-data → non-burnable barrier; the model must not invent fuel where the source has no class.'
  }],
  [10, {
    // Was TL1 (bare compact litter). Changed to TU2 -- already listed below as
    // a contemplated alternative, so this is a documented option, not a new
    // invention. Evidence: RUN-018 fetched real LANDFIRE FBFM40 for the six
    // benchmark landscapes and found TU5/SH7 where this crosswalk had assumed
    // TL1 everywhere; TL1 tops out near 145 kW/m and structurally locked out
    // crown fire. TL1 also cannot carry fire at all at this app's scale --
    // measured 2 m of spread in 48 min at calm, 42 m at 20 km/h, against a
    // 500 m cell -- because TL1 models a bare forest floor with no understory,
    // whereas tree cover that actually carries fire has a shrub/grass
    // understory. TU2 (moderate load, humid-climate timber-shrub) is the
    // conservative member of that family: still near-inert at dead calm
    // (16 m/48 min, correct -- closed-canopy forest does not run without wind)
    // but crosses a cell at ~20 km/h. TU5 was NOT chosen: it is the very-high-load
    // dry-climate model, unjustifiable as a global default for WorldCover class 10,
    // which spans rainforest and boreal as well as dry western US timber.
    fuelCode: 'TU2',
    fuelModelAlternatives: ['TU2', 'TU1', 'TU3', 'TL3', 'TL1'],
    fuelLoadScale: 1,
    confidence: 'medium',
    // Litter/understory under closed canopy can hold ignition through a brief
    // humidity/rain excursion without a full duff/heavy-fuel bed (that
    // stronger case is the separate, FCCS-evidenced globalFuelbedPersistenceMinutes
    // bridge). 6 hours is a conservative fraction of that bridge's 48-hour ceiling.
    fuelPersistenceMinutes: 360,
    rationale: 'Tree cover → timber with shrub/grass understory, approximated as Scott & Burgan TU2 (moderate load, humid climate timber-shrub). Chosen over TL1 because TL1 models a bare forest floor and cannot carry fire; see RUN-018 LANDFIRE evidence. Local species mix not considered; unvalidated outside CONUS, where no perimeter benchmark exists.'
  }],
  [20, {
    fuelCode: 'SH2',
    fuelLoadScale: 1,
    confidence: 'medium',
    rationale: 'Shrubland → Scott & Burgan SH2 (moderate load dry-climate shrub). Fuel age and moisture regime not considered.'
  }],
  [30, {
    fuelCode: 'GR2',
    fuelLoadScale: 1,
    confidence: 'medium',
    rationale: 'Grassland → Scott & Burgan GR2 (low load dry-climate grass). Curing state and management not considered.'
  }],
  [40, {
    fuelCode: 'AG1',
    fuelLoadScale: 0.65,
    confidence: 'low',
    rationale: 'Cropland → experimental agricultural fuel (AG1). Real crop-residue loads vary by crop, harvest stage, and month.'
  }],
  [50, {
    fuelCode: NON_BURNABLE_FUEL_CODE,
    fuelLoadScale: 0,
    confidence: 'medium',
    rationale: 'Built-up → non-burnable barrier. Urban vegetation and wildland-urban interface fuels are not modeled.'
  }],
  [60, {
    fuelCode: 'GR1',
    fuelLoadScale: 0.15,
    confidence: 'low',
    rationale: 'Bare / sparse vegetation → GR1 (sparse dry grass) as the lightest burnable model. Genuinely bare rock/sand cells behave closer to non-burnable but our mosaic cannot distinguish.'
  }],
  [70, {
    fuelCode: NON_BURNABLE_FUEL_CODE,
    fuelLoadScale: 0,
    confidence: 'medium',
    rationale: 'Snow and ice → non-burnable.'
  }],
  [80, {
    fuelCode: NON_BURNABLE_FUEL_CODE,
    fuelLoadScale: 0,
    confidence: 'medium',
    rationale: 'Permanent water bodies → non-burnable.'
  }],
  [90, {
    fuelCode: 'GS1',
    fuelLoadScale: 0.35,
    confidence: 'low',
    rationale: 'Herbaceous wetland → GS1 (low load grass-shrub) as an approximation. Real wetland moisture regimes typically reduce spread below what GS1 predicts.'
  }],
  [95, {
    fuelCode: 'TL3',
    fuelModelAlternatives: ['TL3', 'TL1'],
    fuelLoadScale: 0.35,
    confidence: 'low',
    rationale: 'Mangroves → TL3 (moderate conifer litter) as a stand-in for closed-canopy wet forest. Real mangrove moisture generally exceeds moisture-of-extinction; ignition unlikely in practice.'
  }],
  [100, {
    fuelCode: 'GR1',
    fuelLoadScale: 0.15,
    confidence: 'low',
    rationale: 'Moss and lichen → GR1 as a light-load approximation.'
  }]
]);

// A routine diurnal humidity rise (observed in real archives to run
// roughly 2-4 hours around dawn) briefly pushes fine dead fuel above its
// moisture-of-extinction every night. An already-established, actively
// burning fire edge does not go fully cold and require full re-ignition
// for that -- residual heat along the flame front bridges a short dip.
// This is a distinct, much smaller effect than the FCCS bridge's
// litter/duff-evidence-based persistence (up to 48h): it is a floor
// applied to every burnable decision, not a heavy-fuel-specific bonus.
// Without it, zero persistence + a multi-day travel time across any
// fine fast fuel guarantees the edge straddles at least one nightly dip
// and never completes, regardless of how much simulated time is given
// (see docs/regional-model-run/THREAD.md, 2026-07-24 update 6).
export const MINIMUM_RESIDUAL_HEAT_PERSISTENCE_MINUTES = 240;

export function crosswalkLandCoverToFuel(landCover) {
  const decision = crosswalkLandCoverToFuelRaw(landCover);
  if (!decision?.burnable) return decision;
  return {
    ...decision,
    fuelPersistenceMinutes: Math.max(
      Number.isFinite(decision.fuelPersistenceMinutes) ? decision.fuelPersistenceMinutes : 0,
      MINIMUM_RESIDUAL_HEAT_PERSISTENCE_MINUTES
    )
  };
}

function crosswalkLandCoverToFuelRaw(landCover) {
  if (!landCover || typeof landCover.classCode !== 'number') {
    return experimentalDefault(
      'No land cover available for this location; using a conservative brush-like default so ignition still runs, but confidence is experimental.'
    );
  }

  const fractionalWater = fractionalWaterPercent(landCover.coverFractions);
  if (fractionalWater >= FRACTIONAL_WATER_BARRIER_THRESHOLD_PERCENT) {
    return {
      fuelCode: NON_BURNABLE_FUEL_CODE,
      fuelLoadScale: 0,
      fuelDisplayName: getFuelModel(NON_BURNABLE_FUEL_CODE).displayName,
      burnable: false,
      confidence: 'medium',
      rationale: 'Copernicus fractional water cover is ' + fractionalWater
        + '% (threshold ' + FRACTIONAL_WATER_BARRIER_THRESHOLD_PERCENT
        + '%) → hard non-burnable barrier.',
      landCoverSource: landCover.fractionalCoverSource ?? landCover.source ?? null,
      fractionalCoverSource: landCover.fractionalCoverSource ?? null,
      fractionalCoverResolutionMeters: landCover.fractionalCoverResolutionMeters ?? null,
      fractionalCoverConfidence: landCover.fractionalCoverConfidence ?? null,
      fractionalCoverUsed: true,
      crosswalkVersion: LAND_COVER_CROSSWALK_VERSION
    };
  }

  // Keep explicit WorldCover barriers authoritative, then prefer the direct
  // LANDFIRE FBFM40 observation over every coarse/global approximation.
  if ([0, 50, 70, 80].includes(landCover.classCode)) {
    const row = CROSSWALK.get(landCover.classCode);
    if (row) {
      const model = getFuelModel(row.fuelCode);
      return {
        fuelCode: row.fuelCode,
        fuelModelAlternatives: null,
        fuelLoadScale: 0,
        fuelDisplayName: model.displayName,
        burnable: false,
        confidence: row.confidence,
        rationale: row.rationale,
        landCoverSource: landCover.source ?? null,
        fractionalCoverSource: landCover.fractionalCoverSource ?? null,
        fractionalCoverResolutionMeters: landCover.fractionalCoverResolutionMeters ?? null,
        fractionalCoverConfidence: landCover.fractionalCoverConfidence ?? null,
        fractionalCoverUsed: false,
        crosswalkVersion: LAND_COVER_CROSSWALK_VERSION
      };
    }
  }

  if (landCover.landfireFuelModelCode) {
    const regionalDecision = landfireFuelModelToFuelDecision(landCover.landfireFuelModelCode);
    if (regionalDecision) {
      return {
        ...regionalDecision,
        landCoverSource: landCover.source ?? null,
        fractionalCoverSource: landCover.fractionalCoverSource ?? null,
        fractionalCoverResolutionMeters: landCover.fractionalCoverResolutionMeters ?? null,
        fractionalCoverConfidence: landCover.fractionalCoverConfidence ?? null,
        fractionalCoverUsed: false,
        fineSampleCount: Number.isInteger(landCover.fineSampleCount) ? landCover.fineSampleCount : null,
        fineBurnableFraction: normalizedFineBurnableFraction(landCover.fineBurnableFraction),
        crosswalkVersion: `${LAND_COVER_CROSSWALK_VERSION}+${regionalDecision.crosswalkVersion}`
      };
    }
  }

  // The global FCCS raster is a fuelbed observation, not a land-cover class.
  // Use it for burnable land when present, while keeping WorldCover's explicit
  // water, snow, built-up, and no-data classes as hard barriers.
  if (!([0, 50, 70, 80].includes(landCover.classCode)) && landCover.globalFuelbed) {
    const globalDecision = globalFuelbedToFuelDecision(landCover.globalFuelbed);
    if (globalDecision) {
      const fineBurnableFraction = normalizedFineBurnableFraction(landCover.fineBurnableFraction);
      const fuelLoadScale = roundFraction(globalDecision.fuelLoadScale * fineBurnableFraction);
      return {
        ...globalDecision,
        fuelLoadScale,
        rationale: fineBurnableFraction < 1
          ? `${globalDecision.rationale} Fine WorldCover samples reduce available fuel to ${Math.round(fineBurnableFraction * 100)}% of the cell.`
          : globalDecision.rationale,
        fineSampleCount: Number.isInteger(landCover.fineSampleCount) ? landCover.fineSampleCount : null,
        fineBurnableFraction,
        fractionalCoverSource: landCover.fractionalCoverSource ?? null,
        fractionalCoverResolutionMeters: landCover.fractionalCoverResolutionMeters ?? null,
        fractionalCoverConfidence: landCover.fractionalCoverConfidence ?? null,
        crosswalkVersion: `${LAND_COVER_CROSSWALK_VERSION}+${globalDecision.crosswalkVersion}`
      };
    }
  }

  const row = CROSSWALK.get(landCover.classCode);
  if (!row) {
    return experimentalDefault(
      `WorldCover class ${landCover.classCode} is not in the crosswalk table; treating as experimental.`
    );
  }

  const fractionalDecision = fractionalVegetationDecision(landCover);
  if (fractionalDecision) return fractionalDecision;

  const fuelModel = getFuelModel(row.fuelCode);
  const fineBurnableFraction = normalizedFineBurnableFraction(landCover.fineBurnableFraction);
  const fuelLoadScale = roundFraction(row.fuelLoadScale * fineBurnableFraction);
  return {
    fuelCode: row.fuelCode,
    fuelModelAlternatives: normalizeFuelModelAlternatives(row.fuelModelAlternatives, row.fuelCode),
    fuelLoadScale,
    fuelDisplayName: fuelModel.displayName,
    burnable: fuelModel.burnable,
    confidence: row.confidence,
    rationale: fineBurnableFraction < 1
      ? `${row.rationale} Fine WorldCover samples indicate ${Math.round(fineBurnableFraction * 100)}% burnable ground in this model cell; fuel availability is scaled by that observed sample fraction.`
      : row.rationale,
    landCoverSource: landCover.source ?? null,
    fractionalCoverSource: landCover.fractionalCoverSource ?? null,
    fractionalCoverResolutionMeters: landCover.fractionalCoverResolutionMeters ?? null,
    fractionalCoverConfidence: landCover.fractionalCoverConfidence ?? null,
    fractionalCoverUsed: false,
    fineSampleCount: Number.isInteger(landCover.fineSampleCount) ? landCover.fineSampleCount : null,
    fineBurnableFraction,
    fuelPersistenceMinutes: Number.isFinite(row.fuelPersistenceMinutes) ? row.fuelPersistenceMinutes : 0,
    crosswalkVersion: LAND_COVER_CROSSWALK_VERSION
  };
}

function fractionalVegetationDecision(landCover) {
  if (!landCover?.coverFractions || landCover.burnable === false) return null;
  if ([0, 50, 70, 80].includes(landCover.classCode)) return null;

  const fractions = landCover.coverFractions;
  const components = [
    { key: 'treeCoverFraction', label: 'tree', fuelCode: 'TU2' },
    { key: 'shrubCoverFraction', label: 'shrub', fuelCode: 'SH2' },
    { key: 'grassCoverFraction', label: 'grass', fuelCode: landCover.classCode === 90 ? 'GS1' : 'GR2' },
    { key: 'cropsCoverFraction', label: 'crop', fuelCode: 'AG1' }
  ]
    .map((component) => ({ ...component, fraction: readFraction(fractions[component.key]) }))
    .filter((component) => component.fraction > 0);
  if (components.length === 0) return null;

  const vegetationCoverPercent = Math.min(100, components.reduce(
    (sum, component) => sum + component.fraction,
    0
  ));
  const dominant = components.reduce((current, component) => (
    component.fraction > current.fraction ? component : current
  ), components[0]);
  if (dominant.fraction < FRACTIONAL_VEGETATION_THRESHOLD_PERCENT) return null;

  const fuelModel = getFuelModel(dominant.fuelCode);
  const fineBurnableFraction = normalizedFineBurnableFraction(landCover.fineBurnableFraction);
  const fuelLoadScale = roundFraction((vegetationCoverPercent / 100) * fineBurnableFraction);
  return {
    fuelCode: dominant.fuelCode,
    fuelModelAlternatives: normalizeFuelModelAlternatives(
      dominant.fuelCode === 'TL1' ? ['TL1', 'TL3', 'TU2'] : null,
      dominant.fuelCode
    ),
    fuelLoadScale,
    fuelDisplayName: fuelModel.displayName,
    burnable: fuelModel.burnable,
    confidence: 'low',
    rationale: `Copernicus fractional cover selects dominant ${dominant.label} vegetation (${dominant.fraction}%) with ${vegetationCoverPercent}% total mapped vegetation; ${dominant.fuelCode} is a fuel-model approximation and local fuel structure is not observed.${fineBurnableFraction < 1 ? ` Fine WorldCover samples reduce available fuel to ${Math.round(fineBurnableFraction * 100)}% of the cell.` : ''}`,
    landCoverSource: landCover.source ?? null,
    fractionalCoverSource: landCover.fractionalCoverSource ?? landCover.source ?? null,
    fractionalCoverResolutionMeters: landCover.fractionalCoverResolutionMeters ?? null,
    fractionalCoverConfidence: landCover.fractionalCoverConfidence ?? null,
    fractionalCoverUsed: true,
    fractionalVegetationCoverPercent: vegetationCoverPercent,
    fractionalDominantCoverPercent: dominant.fraction,
    fineSampleCount: Number.isInteger(landCover.fineSampleCount) ? landCover.fineSampleCount : null,
    fineBurnableFraction,
    crosswalkVersion: LAND_COVER_CROSSWALK_VERSION
  };
}

function fractionalWaterPercent(coverFractions) {
  if (!coverFractions || typeof coverFractions !== 'object') return 0;
  const permanent = Number.isFinite(coverFractions.permanentWaterCoverFraction)
    ? coverFractions.permanentWaterCoverFraction
    : 0;
  const seasonal = Number.isFinite(coverFractions.seasonalWaterCoverFraction)
    ? coverFractions.seasonalWaterCoverFraction
    : 0;
  return Math.min(100, permanent + seasonal);
}

function readFraction(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 0;
}

function roundFraction(value) {
  return Math.round(value * 100) / 100;
}

function normalizedFineBurnableFraction(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
}

function normalizeFuelModelAlternatives(alternatives, primaryCode) {
  if (!Array.isArray(alternatives)) return null;
  const normalized = [...new Set([primaryCode, ...alternatives]
    .filter((code) => typeof code === 'string'))];
  return normalized.length > 1 ? normalized : null;
}

function experimentalDefault(rationale) {
  // Choose a light burnable fuel so ignition remains possible, but flag
  // the run as experimental confidence. This is the honest state the
  // prompt § 10 asks for when evidence is insufficient.
  const fuelModel = getFuelModel('GR1');
  return {
    fuelCode: 'GR1',
    fuelLoadScale: 1,
    fuelDisplayName: fuelModel.displayName,
    burnable: true,
    confidence: 'experimental',
    rationale,
    landCoverSource: null,
    fractionalCoverUsed: false,
    crosswalkVersion: LAND_COVER_CROSSWALK_VERSION
  };
}
