// Versioned table of surface fire-behavior fuel-model parameters,
// prepared for the Rothermel (1972) surface-spread kernel that lands
// in Phase 3.
//
// Values are drawn from the Scott & Burgan (2005) "40 Standard Fire
// Behavior Fuel Models" set (US Forest Service RMRS-GTR-153) and the
// Anderson (1982) "13 Fire Behavior Fuel Models" set (USDA INT-122).
// All values are converted to SI units at the boundary of this table
// so the kernel can compute in one coherent system.
//
// Unit conversions used (documented in Rothermel 1972 appendices and
// Scott & Burgan 2005 Table 2):
//   Fuel load:                1 ton/acre     ≈ 0.2242 kg/m²
//   Surface-area-to-volume:   1 1/ft         = 3.2808 1/m
//   Fuel bed depth:           1 ft           = 0.3048 m
//   Heat content:             1 BTU/lb       ≈ 2.326 kJ/kg
//   Moisture of extinction:   dimensionless fraction (SB gives it as %)
//
// The initial Phase-2 subset covers the WorldCover 2021 classes we
// crosswalk against. The prompt § 6 requires an explicitly low-
// confidence path for classes we don't yet have a defensible parameter
// set for; the crosswalk either uses an explicit non-burnable barrier or a
// clearly labeled experimental model and its consumers must preserve that
// confidence.
//
// Sources cited per model in the `citation` field. Every value below
// was cross-checked against the published tables, not typed from
// memory. If you edit these, update the citation and bump
// FUEL_MODEL_TABLE_VERSION.

export const FUEL_MODEL_TABLE_VERSION = '1.1.0';
export const NON_BURNABLE_FUEL_CODE = 'NB';

const SB_2005 = 'Scott, J.H. & Burgan, R.E., 2005. Standard Fire Behavior Fuel Models. USDA Forest Service RMRS-GTR-153.';
const ANDERSON_1982 = 'Anderson, H.E., 1982. Aids to Determining Fuel Models for Estimating Fire Behavior. USDA Forest Service INT-122.';
const SCOTT_2007_WAF = 'Scott, J.H., 2007. Nomographs for estimating surface fire behavior characteristics. USDA Forest Service RMRS-GTR-192, Table 1.';

// Scott & Burgan fuel-model rows commonly use these standard Rothermel
// particle properties when a model does not publish a custom value. They
// are explicit here so the spread kernel never has to invent them silently.
export const STANDARD_FUEL_PARTICLE_PROPERTIES = {
  particleDensityKgPerM3: 513.0, // 32 lb/ft³
  totalMineralContentFraction: 0.0555,
  effectiveMineralContentFraction: 0.0100
};

// The complete Scott & Burgan FBFM40 family. The original rows above remain
// hand-audited because they are used by existing validation fixtures. These
// missing rows are generated from the published table using one conversion
// path so LANDFIRE FBFM40 codes never collapse into a generic family model.
const STANDARD_40_ROWS = [
  ['GR3', 'Low load very coarse humid climate grass', [0.10, 0.40, 0.00], [1.50, 0.00], 1500, 1300, 9999, 2.0, 0.30, 8000],
  ['GR4', 'Moderate load dry climate grass', [0.25, 0.00, 0.00], [1.90, 0.00], 2000, 1800, 9999, 2.0, 0.15, 8000],
  ['GR5', 'Low load humid climate grass', [0.40, 0.00, 0.00], [2.50, 0.00], 1800, 1600, 9999, 1.5, 0.40, 8000],
  ['GR6', 'Moderate load continuous humid climate grass', [0.10, 0.00, 0.00], [3.40, 0.00], 2200, 2000, 9999, 1.5, 0.40, 9000],
  ['GR7', 'High load continuous dry climate grass', [1.00, 0.00, 0.00], [5.40, 0.00], 2000, 1800, 9999, 3.0, 0.15, 8000],
  ['GR8', 'High load very coarse humid climate grass', [0.50, 1.00, 0.00], [7.30, 0.00], 1500, 1300, 9999, 4.0, 0.30, 8000],
  ['GR9', 'Very high load dense tall humid climate grass', [1.00, 1.00, 0.00], [9.00, 0.00], 1800, 1600, 9999, 5.0, 0.40, 8000],
  ['GS2', 'Moderate load dry climate grass-shrub', [0.50, 0.50, 0.00], [0.60, 1.00], 2000, 1800, 1800, 1.5, 0.15, 8000],
  ['GS3', 'Moderate load humid climate grass-shrub', [0.30, 0.25, 0.00], [1.45, 1.25], 1800, 1600, 1600, 1.8, 0.40, 8000],
  ['GS4', 'High load humid climate grass-shrub', [1.90, 0.30, 0.10], [3.40, 7.10], 1800, 1600, 1600, 2.1, 0.40, 8000],
  ['SH1', 'Low load dry climate shrub', [0.25, 0.25, 0.00], [0.15, 1.30], 2000, 1800, 1600, 1.0, 0.15, 8000],
  ['SH3', 'Moderate load humid climate shrub', [0.45, 3.00, 0.00], [0.00, 6.20], 1600, 9999, 1400, 2.4, 0.40, 8000],
  ['SH4', 'Low load humid climate shrub', [0.85, 1.15, 0.20], [0.00, 2.55], 2000, 1800, 1600, 3.0, 0.30, 8000],
  ['SH5', 'High load dry climate shrub', [3.60, 2.10, 0.00], [0.00, 2.90], 750, 9999, 1600, 6.0, 0.15, 8000],
  ['SH6', 'Low load humid climate shrub', [2.90, 1.45, 0.00], [0.00, 1.40], 750, 9999, 1600, 2.0, 0.30, 8000],
  ['SH7', 'Very high load dry climate shrub', [3.50, 5.30, 2.20], [0.00, 3.40], 750, 9999, 1600, 6.0, 0.15, 8000],
  ['SH8', 'High load humid climate shrub', [2.05, 3.40, 0.85], [0.00, 4.35], 750, 9999, 1600, 3.0, 0.40, 8000],
  ['SH9', 'Very high load humid climate shrub', [4.50, 2.45, 0.00], [1.55, 7.00], 750, 1800, 1500, 4.4, 0.40, 8000],
  ['TU1', 'Low load dry climate timber-grass-shrub', [0.20, 0.90, 1.50], [0.20, 0.90], 2000, 1800, 1600, 0.6, 0.20, 8000],
  ['TU3', 'Moderate load humid climate timber-grass-shrub', [1.10, 0.15, 0.25], [0.65, 1.10], 1800, 1600, 1400, 1.3, 0.30, 8000],
  ['TU4', 'Dwarf conifer with understory', [4.50, 0.00, 0.00], [0.00, 2.00], 2300, 9999, 2000, 0.5, 0.12, 8000],
  ['TU5', 'Very high load dry climate timber-shrub', [4.00, 4.00, 3.00], [0.00, 3.00], 1500, 9999, 750, 1.0, 0.25, 8000],
  ['TL2', 'Low load broadleaf litter', [1.40, 2.30, 2.20], [0.00, 0.00], 2000, 9999, 9999, 0.2, 0.25, 8000],
  ['TL4', 'Small downed logs', [0.50, 1.50, 4.20], [0.00, 0.00], 2000, 9999, 9999, 0.4, 0.25, 8000],
  ['TL5', 'High load conifer litter', [1.15, 2.50, 4.40], [0.00, 0.00], 2000, 9999, 1600, 0.6, 0.25, 8000],
  ['TL6', 'Moderate load broadleaf litter', [2.40, 1.20, 1.20], [0.00, 0.00], 2000, 9999, 9999, 0.3, 0.25, 8000],
  ['TL7', 'Large downed logs', [0.30, 1.40, 8.10], [0.00, 0.00], 2000, 9999, 9999, 0.4, 0.25, 8000],
  ['TL8', 'Long-needle litter', [5.80, 1.40, 1.10], [0.00, 0.00], 1800, 9999, 9999, 0.3, 0.35, 8000],
  ['TL9', 'Very high load broadleaf litter', [6.65, 3.30, 4.15], [0.00, 0.00], 1800, 9999, 1600, 0.6, 0.35, 8000],
  ['SB1', 'Low load slash', [1.50, 3.00, 11.00], [0.00, 0.00], 2000, 9999, 9999, 1.0, 0.25, 8000],
  ['SB2', 'Moderate load slash', [4.50, 4.25, 4.00], [0.00, 0.00], 2000, 9999, 9999, 1.0, 0.25, 8000],
  ['SB3', 'High load slash', [5.50, 2.75, 3.00], [0.00, 0.00], 2000, 9999, 9999, 1.2, 0.25, 8000],
  ['SB4', 'Very high load slash', [5.25, 3.50, 5.25], [0.00, 0.00], 2000, 9999, 9999, 2.7, 0.25, 8000]
];

const FUEL_MODELS = {};

const TONS_PER_ACRE_TO_KG_PER_M2 = 0.2242;
const INV_FOOT_TO_INV_METER = 3.28084;
const TEN_HOUR_SAV_PER_METER = 109 * INV_FOOT_TO_INV_METER;
const HUNDRED_HOUR_SAV_PER_METER = 30 * INV_FOOT_TO_INV_METER;

for (const [code, displayName, deadLoads, liveLoads, oneHourSav, herbaceousSav, woodySav, depthFeet, extinction, heat] of STANDARD_40_ROWS) {
  if (FUEL_MODELS[code]) continue;
  const toLoad = (tonsPerAcre) => tonsPerAcre * TONS_PER_ACRE_TO_KG_PER_M2;
  const toSav = (inverseFeet) => inverseFeet * INV_FOOT_TO_INV_METER;
  FUEL_MODELS[code] = {
    code,
    displayName,
    burnable: true,
    fuelBedDepthMeters: depthFeet * 0.3048,
    windAdjustmentFactor: null,
    heatContentKjPerKg: heat * 2.326,
    moistureOfExtinctionFraction: extinction,
    deadFuel: [
      { className: '1h', loadKgPerM2: toLoad(deadLoads[0]), savRatioPerMeter: toSav(oneHourSav) },
      { className: '10h', loadKgPerM2: toLoad(deadLoads[1]), savRatioPerMeter: TEN_HOUR_SAV_PER_METER },
      { className: '100h', loadKgPerM2: toLoad(deadLoads[2]), savRatioPerMeter: HUNDRED_HOUR_SAV_PER_METER }
    ],
    liveFuel: [
      { className: 'herbaceous', loadKgPerM2: toLoad(liveLoads[0]), savRatioPerMeter: toSav(herbaceousSav) },
      { className: 'woody', loadKgPerM2: toLoad(liveLoads[1]), savRatioPerMeter: toSav(woodySav) }
    ],
    citation: SB_2005
  };
}

// Shortcut: an inert fuel row (used for classes a model doesn't have)
const EMPTY_ROW = (className, savRatio = 1) => ({ className, loadKgPerM2: 0, savRatioPerMeter: savRatio });

// The full table. Each entry mirrors the SB2005 layout: three dead
// size-classes (1-h, 10-h, 100-h) and two live categories (herbaceous,
// woody). SAV ratios are per meter after ft⁻¹ → m⁻¹ conversion.
Object.assign(FUEL_MODELS, {
  GR1: {
    code: 'GR1',
    displayName: 'Short, sparse dry grass',
    burnable: true,
    fuelBedDepthMeters: 0.122,          // 0.4 ft
    windAdjustmentFactor: 0.31,
    heatContentKjPerKg: 18608,          // 8000 BTU/lb
    moistureOfExtinctionFraction: 0.15,
    // Loads: 1-h 0.10, 10-h 0.00, 100-h 0.00, live herb 0.30 ton/ac
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.02242, savRatioPerMeter: 7218 }, // 2200 1/ft
      { className: '10h',  loadKgPerM2: 0,       savRatioPerMeter: 358  },
      { className: '100h', loadKgPerM2: 0,       savRatioPerMeter: 98   }
    ],
    liveFuel: [
      { className: 'herbaceous', loadKgPerM2: 0.06726, savRatioPerMeter: 6562 }, // 2000 1/ft
      { className: 'woody',      loadKgPerM2: 0,       savRatioPerMeter: 4921 }
    ],
    citation: SB_2005
  },

  GR2: {
    code: 'GR2',
    displayName: 'Low load dry climate grass',
    burnable: true,
    fuelBedDepthMeters: 0.305,          // 1.0 ft
    windAdjustmentFactor: 0.36,
    heatContentKjPerKg: 18608,
    moistureOfExtinctionFraction: 0.15,
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.02242, savRatioPerMeter: 6562 },
      { className: '10h',  loadKgPerM2: 0,       savRatioPerMeter: 358  },
      { className: '100h', loadKgPerM2: 0,       savRatioPerMeter: 98   }
    ],
    liveFuel: [
      { className: 'herbaceous', loadKgPerM2: 0.22420, savRatioPerMeter: 5906 }, // 1800 1/ft
      { className: 'woody',      loadKgPerM2: 0,       savRatioPerMeter: 4921 }
    ],
    citation: SB_2005
  },

  GS1: {
    code: 'GS1',
    displayName: 'Low load dry climate grass-shrub',
    burnable: true,
    fuelBedDepthMeters: 0.274,          // 0.9 ft
    windAdjustmentFactor: 0.35,
    heatContentKjPerKg: 18608,
    moistureOfExtinctionFraction: 0.15,
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.04484, savRatioPerMeter: 6562 },
      { className: '10h',  loadKgPerM2: 0.02242, savRatioPerMeter: 358  },
      { className: '100h', loadKgPerM2: 0,       savRatioPerMeter: 98   }
    ],
    liveFuel: [
      { className: 'herbaceous', loadKgPerM2: 0.11210, savRatioPerMeter: 5906 }, // 1800 1/ft
      { className: 'woody',      loadKgPerM2: 0.14573, savRatioPerMeter: 5906 } // 1800 1/ft
    ],
    citation: SB_2005
  },

  SH2: {
    code: 'SH2',
    displayName: 'Moderate load dry climate shrub',
    burnable: true,
    fuelBedDepthMeters: 0.305,          // 1.0 ft
    windAdjustmentFactor: 0.36,
    heatContentKjPerKg: 18608,
    moistureOfExtinctionFraction: 0.15,
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.30265, savRatioPerMeter: 6562 },
      { className: '10h',  loadKgPerM2: 0.53808, savRatioPerMeter: 358  },
      { className: '100h', loadKgPerM2: 0.16815, savRatioPerMeter: 98   }
    ],
    liveFuel: [
      { className: 'herbaceous', loadKgPerM2: 0,       savRatioPerMeter: 32805 }, // 9999 1/ft
      { className: 'woody',      loadKgPerM2: 0.86317, savRatioPerMeter: 5249 } // 1600 1/ft
    ],
    citation: SB_2005
  },

  // Published validation fixture: Scott & Burgan TU2, as reproduced in
  // USFS GTR-NRS-P-46 Table 1. It is intentionally available as a model
  // even though the current WorldCover crosswalk does not select it.
  TU2: {
    code: 'TU2',
    displayName: 'Moderate load humid climate timber-shrub',
    burnable: true,
    fuelBedDepthMeters: 0.3048,        // 1.0 ft
    windAdjustmentFactor: 0.36,
    heatContentKjPerKg: 18608,          // 8000 BTU/lb
    moistureOfExtinctionFraction: 0.30,
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.22420, savRatioPerMeter: 6562 }, // 1.0 ton/ac, 2000 1/ft
      { className: '10h',  loadKgPerM2: 0.40356, savRatioPerMeter: 358  }, // 1.8 ton/ac, 109 1/ft
      { className: '100h', loadKgPerM2: 0.29146, savRatioPerMeter: 98   }  // 1.3 ton/ac, 30 1/ft
    ],
    liveFuel: [
      { className: 'herbaceous', loadKgPerM2: 0,       savRatioPerMeter: 32805 }, // 9999 1/ft
      { className: 'woody',      loadKgPerM2: 0.04484, savRatioPerMeter: 5249 }  // 0.2 ton/ac, 1600 1/ft
    ],
    citation: `${SB_2005} (TU2 row reproduced in USFS GTR-NRS-P-46 Table 1)`
  },

  TL1: {
    code: 'TL1',
    displayName: 'Low load compact conifer litter',
    burnable: true,
    fuelBedDepthMeters: 0.061,          // 0.2 ft
    windAdjustmentFactor: 0.28,
    heatContentKjPerKg: 18608,
    moistureOfExtinctionFraction: 0.30,
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.22420, savRatioPerMeter: 6562 },
      { className: '10h',  loadKgPerM2: 0.49324, savRatioPerMeter: 358  },
      { className: '100h', loadKgPerM2: 0.80712, savRatioPerMeter: 98   }
    ],
    liveFuel: [
      EMPTY_ROW('herbaceous', 5250),
      EMPTY_ROW('woody',      5085)
    ],
    citation: SB_2005
  },

  TL3: {
    code: 'TL3',
    displayName: 'Moderate load conifer litter',
    burnable: true,
    fuelBedDepthMeters: 0.091,          // 0.3 ft
    windAdjustmentFactor: 0.29,
    heatContentKjPerKg: 18608,
    moistureOfExtinctionFraction: 0.20,
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.11210, savRatioPerMeter: 6562 },
      { className: '10h',  loadKgPerM2: 0.49324, savRatioPerMeter: 358  },
      { className: '100h', loadKgPerM2: 0.62776, savRatioPerMeter: 98   }
    ],
    liveFuel: [
      EMPTY_ROW('herbaceous', 5250),
      EMPTY_ROW('woody',      5085)
    ],
    citation: SB_2005
  },

  // Cropland: approximate as short-grass (post-harvest agricultural). Low
  // confidence; documented as experimental until a dedicated agricultural
  // model lands (post-harvest residues vary hugely by crop).
  AG1: {
    code: 'AG1',
    displayName: 'Agricultural / cropland (approx. short grass)',
    burnable: true,
    fuelBedDepthMeters: 0.152,          // 0.5 ft (interpolated)
    // No published WAF exists for this experimental crosswalk model.
    windAdjustmentFactor: null,
    heatContentKjPerKg: 18608,
    moistureOfExtinctionFraction: 0.20,
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.04484, savRatioPerMeter: 5906 },
      { className: '10h',  loadKgPerM2: 0.02242, savRatioPerMeter: 358  },
      { className: '100h', loadKgPerM2: 0,       savRatioPerMeter: 98   }
    ],
    liveFuel: [
      { className: 'herbaceous', loadKgPerM2: 0.06726, savRatioPerMeter: 5250 },
      EMPTY_ROW('woody',         5085)
    ],
    citation: `${ANDERSON_1982} (crosswalk approximation, experimental)`
  },

  // Anderson (1982) FM10 is required by the Rothermel (1991) active crown
  // spread correlation. It is deliberately not used as the actual surface
  // fuel model; crownFire.js invokes it only for that published correlation.
  FM10: {
    code: 'FM10',
    displayName: 'Timber litter and understory (crown correlation only)',
    burnable: true,
    fuelBedDepthMeters: 0.3048,       // 1.0 ft
    windAdjustmentFactor: 0.36,
    heatContentKjPerKg: 18608,
    moistureOfExtinctionFraction: 0.25,
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.6730, savRatioPerMeter: 6562 }, // 3.01 ton/ac, 2000 1/ft
      { className: '10h',  loadKgPerM2: 0.4484, savRatioPerMeter: 358  }, // 2.00 ton/ac, 109 1/ft
      { className: '100h', loadKgPerM2: 1.1234, savRatioPerMeter: 98   }  // 5.01 ton/ac, 30 1/ft
    ],
    liveFuel: [
      EMPTY_ROW('herbaceous', 32805),
      { className: 'woody', loadKgPerM2: 0.4484, savRatioPerMeter: 4921 } // 2.00 ton/ac, 1500 1/ft
    ],
    citation: `${ANDERSON_1982} (FM10; used by Rothermel 1991 crown-spread correlation)`
  },

  // Non-burnable: built-up, water, snow/ice, bare with insufficient fuel.
  // Every value is zero — the kernel sees a strict barrier here.
  [NON_BURNABLE_FUEL_CODE]: {
    code: NON_BURNABLE_FUEL_CODE,
    displayName: 'Non-burnable',
    burnable: false,
    fuelBedDepthMeters: 0,
    windAdjustmentFactor: null,
    heatContentKjPerKg: 0,
    moistureOfExtinctionFraction: 1.0,   // never propagates
    deadFuel: [
      EMPTY_ROW('1h',   1),
      EMPTY_ROW('10h',  1),
      EMPTY_ROW('100h', 1)
    ],
    liveFuel: [
      EMPTY_ROW('herbaceous', 1),
      EMPTY_ROW('woody',      1)
    ],
    citation: 'Not applicable (non-burnable class per SB2005/Anderson1982 conventions)'
  }
});

export function getFuelModel(code) {
  const model = FUEL_MODELS[code];
  if (!model) {
    throw new RangeError(`unknown fuel model code "${code}"`);
  }
  return {
    ...STANDARD_FUEL_PARTICLE_PROPERTIES,
    ...model,
    windAdjustmentCitation: Number.isFinite(model.windAdjustmentFactor)
      ? SCOTT_2007_WAF
      : null
  };
}

export function listFuelModelCodes() {
  return Object.keys(FUEL_MODELS);
}
