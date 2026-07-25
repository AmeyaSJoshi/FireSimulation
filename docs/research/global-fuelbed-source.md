# Global FCCS Fuelbed Source

## Dataset

The field adapter uses the Pettinari and Chuvieco Global Fuelbed Dataset:

- Dataset DOI: https://doi.org/10.1594/PANGAEA.849808
- Methods paper: https://doi.org/10.5194/bg-13-2061-2016
- Dataset readme: https://store.pangaea.de/Publications/Pettinari_2015/Global_Fuelbed_Dataset_Readme.pdf
- License: CC-BY-NC-SA-3.0

The map is read as eight WGS84 geographic tiles at approximately 300 m. The
server downloads only the tile intersecting the requested field, caches it in
the operating-system temporary directory, and reads a bounded pixel window.
Raster values are numeric `JOIN_VALUE` identifiers. The committed compact
parameter table resolves those identifiers to the published fuelbed rows.

## Rothermel Bridge

The runtime bridge is versioned separately as `global-fccs-bridge-0.3.0` so
downstream scenario records can distinguish source-table updates from changes
to the conversion rules.

The current surface kernel accepts dead 1-hour, 10-hour, and 100-hour loads,
plus herbaceous live load. The adapter converts the published Mg/ha values to
kg/m2 and carries the source row into the custom fuel-model definition. When
FCCS publishes `G_live (%)`, the total grass load is split into dead 1-hour
and live herbaceous components using that source fraction. When the field is
missing, the bridge preserves its older explicit fallback of treating the
grass load as live. Published grass height or woody fuel depth sets the
Rothermel bed depth; litter depth is a fallback only. It uses standard
particle properties for the missing physical parameters and sets confidence
to `low`.

When the FCCS row provides overstory cover plus overstory or midstory height,
that structure is exposed as a global shelter fallback for the wind-adjustment
factor. Overstory cover is preferred to total tree cover because it is the
source stratum most directly comparable to overhead wind shelter; total or
midstory cover is used only when overstory cover is unavailable. It is used
only when the higher-resolution canopy services do not provide a value. FCCS
height-to-live-crown (`TO_HLC` / `TM_HLC`) is retained as a documented
canopy-base-height proxy. It does not enable crown fire by itself: the crown
module still requires independently supplied canopy bulk density, and any
external measured structure takes precedence.

1000-hour load, litter chemistry, duff, live woody structure, and crown fuel
are retained in provenance where available but are not silently folded into
the surface model. Rows with supported slow-fuel evidence also carry a finite
`fuelPersistenceMinutes` ignition-memory window, capped at 48 hours. It lets a
source cell wait across fully extinguished weather intervals without adding
unsupported mass or a flame-rate multiplier to Rothermel. Fuelbeds containing
only unsupported mass are rejected. This is intentional: the result is a
traceable approximation, not a claim that the global table is a complete
Rothermel parameterization.

## Runtime Fallback

If the tile download, raster read, or parameter lookup fails, the field keeps
the existing WorldCover crosswalk and fine-water barriers. A run should expose
`Global FCCS unavailable · WorldCover fallback` in its metadata rather than
pretending the global source was used.
