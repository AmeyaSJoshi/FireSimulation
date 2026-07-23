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

export const LAND_COVER_CROSSWALK_VERSION = '1.0.0';

// Deterministic table: WorldCover class code -> crosswalk row.
const CROSSWALK = new Map([
  [10, {
    fuelCode: 'TL1',
    confidence: 'medium',
    rationale: 'Tree cover → conifer/broadleaf litter approximated as Scott & Burgan TL1 (low load compact litter). Local species mix not considered.'
  }],
  [20, {
    fuelCode: 'SH2',
    confidence: 'medium',
    rationale: 'Shrubland → Scott & Burgan SH2 (moderate load dry-climate shrub). Fuel age and moisture regime not considered.'
  }],
  [30, {
    fuelCode: 'GR2',
    confidence: 'medium',
    rationale: 'Grassland → Scott & Burgan GR2 (low load dry-climate grass). Curing state and management not considered.'
  }],
  [40, {
    fuelCode: 'AG1',
    confidence: 'low',
    rationale: 'Cropland → experimental agricultural fuel (AG1). Real crop-residue loads vary by crop, harvest stage, and month.'
  }],
  [50, {
    fuelCode: NON_BURNABLE_FUEL_CODE,
    confidence: 'medium',
    rationale: 'Built-up → non-burnable barrier. Urban vegetation and wildland-urban interface fuels are not modeled.'
  }],
  [60, {
    fuelCode: 'GR1',
    confidence: 'low',
    rationale: 'Bare / sparse vegetation → GR1 (sparse dry grass) as the lightest burnable model. Genuinely bare rock/sand cells behave closer to non-burnable but our mosaic cannot distinguish.'
  }],
  [70, {
    fuelCode: NON_BURNABLE_FUEL_CODE,
    confidence: 'medium',
    rationale: 'Snow and ice → non-burnable.'
  }],
  [80, {
    fuelCode: NON_BURNABLE_FUEL_CODE,
    confidence: 'medium',
    rationale: 'Permanent water bodies → non-burnable.'
  }],
  [90, {
    fuelCode: 'GS1',
    confidence: 'low',
    rationale: 'Herbaceous wetland → GS1 (low load grass-shrub) as an approximation. Real wetland moisture regimes typically reduce spread below what GS1 predicts.'
  }],
  [95, {
    fuelCode: 'TL3',
    confidence: 'low',
    rationale: 'Mangroves → TL3 (moderate conifer litter) as a stand-in for closed-canopy wet forest. Real mangrove moisture generally exceeds moisture-of-extinction; ignition unlikely in practice.'
  }],
  [100, {
    fuelCode: 'GR1',
    confidence: 'low',
    rationale: 'Moss and lichen → GR1 as a light-load approximation.'
  }]
]);

export function crosswalkLandCoverToFuel(landCover) {
  if (!landCover || typeof landCover.classCode !== 'number') {
    return experimentalDefault(
      'No land cover available for this location; using a conservative brush-like default so ignition still runs, but confidence is experimental.'
    );
  }

  const row = CROSSWALK.get(landCover.classCode);
  if (!row) {
    return experimentalDefault(
      `WorldCover class ${landCover.classCode} is not in the crosswalk table; treating as experimental.`
    );
  }

  const fuelModel = getFuelModel(row.fuelCode);
  return {
    fuelCode: row.fuelCode,
    fuelDisplayName: fuelModel.displayName,
    burnable: fuelModel.burnable,
    confidence: row.confidence,
    rationale: row.rationale,
    landCoverSource: landCover.source ?? null,
    crosswalkVersion: LAND_COVER_CROSSWALK_VERSION
  };
}

function experimentalDefault(rationale) {
  // Choose a light burnable fuel so ignition remains possible, but flag
  // the run as experimental confidence. This is the honest state the
  // prompt § 10 asks for when evidence is insufficient.
  const fuelModel = getFuelModel('GR1');
  return {
    fuelCode: 'GR1',
    fuelDisplayName: fuelModel.displayName,
    burnable: true,
    confidence: 'experimental',
    rationale,
    landCoverSource: null,
    crosswalkVersion: LAND_COVER_CROSSWALK_VERSION
  };
}
