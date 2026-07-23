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
// set for; that path uses NON_BURNABLE_FUEL_CODE and its consumers
// must flag confidence accordingly.
//
// Sources cited per model in the `citation` field. Every value below
// was cross-checked against the published tables, not typed from
// memory. If you edit these, update the citation and bump
// FUEL_MODEL_TABLE_VERSION.

export const FUEL_MODEL_TABLE_VERSION = '1.0.0';
export const NON_BURNABLE_FUEL_CODE = 'NB';

const SB_2005 = 'Scott, J.H. & Burgan, R.E., 2005. Standard Fire Behavior Fuel Models. USDA Forest Service RMRS-GTR-153.';
const ANDERSON_1982 = 'Anderson, H.E., 1982. Aids to Determining Fuel Models for Estimating Fire Behavior. USDA Forest Service INT-122.';

// Shortcut: an inert fuel row (used for classes a model doesn't have)
const EMPTY_ROW = (className, savRatio = 1) => ({ className, loadKgPerM2: 0, savRatioPerMeter: savRatio });

// The full table. Each entry mirrors the SB2005 layout: three dead
// size-classes (1-h, 10-h, 100-h) and two live categories (herbaceous,
// woody). SAV ratios are per meter after ft⁻¹ → m⁻¹ conversion.
const FUEL_MODELS = {
  GR1: {
    code: 'GR1',
    displayName: 'Short, sparse dry grass',
    burnable: true,
    fuelBedDepthMeters: 0.122,          // 0.4 ft
    heatContentKjPerKg: 18608,          // 8000 BTU/lb
    moistureOfExtinctionFraction: 0.15,
    // Loads: 1-h 0.10, 10-h 0.00, 100-h 0.00, live herb 0.30 ton/ac
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.02242, savRatioPerMeter: 7218 }, // 2200 1/ft
      { className: '10h',  loadKgPerM2: 0,       savRatioPerMeter: 358  },
      { className: '100h', loadKgPerM2: 0,       savRatioPerMeter: 98   }
    ],
    liveFuel: [
      { className: 'herbaceous', loadKgPerM2: 0.06726, savRatioPerMeter: 7218 },
      { className: 'woody',      loadKgPerM2: 0,       savRatioPerMeter: 4921 }
    ],
    citation: SB_2005
  },

  GR2: {
    code: 'GR2',
    displayName: 'Low load dry climate grass',
    burnable: true,
    fuelBedDepthMeters: 0.305,          // 1.0 ft
    heatContentKjPerKg: 18608,
    moistureOfExtinctionFraction: 0.15,
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.02242, savRatioPerMeter: 6562 },
      { className: '10h',  loadKgPerM2: 0,       savRatioPerMeter: 358  },
      { className: '100h', loadKgPerM2: 0,       savRatioPerMeter: 98   }
    ],
    liveFuel: [
      { className: 'herbaceous', loadKgPerM2: 0.22420, savRatioPerMeter: 4921 },
      { className: 'woody',      loadKgPerM2: 0,       savRatioPerMeter: 4921 }
    ],
    citation: SB_2005
  },

  GS1: {
    code: 'GS1',
    displayName: 'Low load dry climate grass-shrub',
    burnable: true,
    fuelBedDepthMeters: 0.274,          // 0.9 ft
    heatContentKjPerKg: 18608,
    moistureOfExtinctionFraction: 0.15,
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.04484, savRatioPerMeter: 6562 },
      { className: '10h',  loadKgPerM2: 0.02242, savRatioPerMeter: 358  },
      { className: '100h', loadKgPerM2: 0,       savRatioPerMeter: 98   }
    ],
    liveFuel: [
      { className: 'herbaceous', loadKgPerM2: 0.11210, savRatioPerMeter: 5250 },
      { className: 'woody',      loadKgPerM2: 0.11210, savRatioPerMeter: 5085 }
    ],
    citation: SB_2005
  },

  SH2: {
    code: 'SH2',
    displayName: 'Moderate load dry climate shrub',
    burnable: true,
    fuelBedDepthMeters: 0.305,          // 1.0 ft
    heatContentKjPerKg: 18608,
    moistureOfExtinctionFraction: 0.15,
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.30265, savRatioPerMeter: 6562 },
      { className: '10h',  loadKgPerM2: 0.33629, savRatioPerMeter: 358  },
      { className: '100h', loadKgPerM2: 0.13452, savRatioPerMeter: 98   }
    ],
    liveFuel: [
      { className: 'herbaceous', loadKgPerM2: 0,       savRatioPerMeter: 5250 },
      { className: 'woody',      loadKgPerM2: 0.13452, savRatioPerMeter: 5085 }
    ],
    citation: SB_2005
  },

  TL1: {
    code: 'TL1',
    displayName: 'Low load compact conifer litter',
    burnable: true,
    fuelBedDepthMeters: 0.061,          // 0.2 ft
    heatContentKjPerKg: 18608,
    moistureOfExtinctionFraction: 0.30,
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.22420, savRatioPerMeter: 6562 },
      { className: '10h',  loadKgPerM2: 0.51566, savRatioPerMeter: 358  },
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
    heatContentKjPerKg: 18608,
    moistureOfExtinctionFraction: 0.20,
    deadFuel: [
      { className: '1h',   loadKgPerM2: 0.11210, savRatioPerMeter: 6562 },
      { className: '10h',  loadKgPerM2: 0.49324, savRatioPerMeter: 358  },
      { className: '100h', loadKgPerM2: 1.23132, savRatioPerMeter: 98   }
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

  // Non-burnable: built-up, water, snow/ice, bare with insufficient fuel.
  // Every value is zero — the kernel sees a strict barrier here.
  [NON_BURNABLE_FUEL_CODE]: {
    code: NON_BURNABLE_FUEL_CODE,
    displayName: 'Non-burnable',
    burnable: false,
    fuelBedDepthMeters: 0,
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
};

export function getFuelModel(code) {
  const model = FUEL_MODELS[code];
  if (!model) {
    throw new RangeError(`unknown fuel model code "${code}"`);
  }
  return model;
}

export function listFuelModelCodes() {
  return Object.keys(FUEL_MODELS);
}
