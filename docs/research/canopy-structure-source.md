# Canopy Structure Source

## Current implementation

The fire field now samples the published ETH Global Canopy Height 2020 map at
10 m resolution through the same bounded GeoTIFF range-reader used for fine
WorldCover. Each 500 m simulation cell receives the median of nine samples.
The height field is used only to decide whether a mapped tree or mangrove cell
has enough measured canopy height to use the sheltered-fuel wind adjustment.
Missing height values fall back to the existing WorldCover canopy label and
are reported as fallback coverage in the field-quality readout.

This source is an estimated canopy-top height product, not a direct canopy
base-height or canopy-bulk-density measurement. It therefore does **not**
trigger crown-fire spread. In CONUS, the field also requests LANDFIRE 2024 CH,
CC, CBH, and CBD through the bounded WCS adapter. CH/CC are used for the
structure-aware sheltered WAF when the 10 m weather reference is high enough;
CBH/CBD remain separate inputs that gate the guarded crown module. Missing
LANDFIRE data leaves the affected cells on the explicit fallback path.

Source: Lang et al. (2023), *A high-resolution canopy height model of the
Earth*, which describes the global 10 m 2020 product, its uncertainty, and its
downloadable tiles:
https://doi.org/10.1038/s41559-023-02206-6

## Coverage and limitations

- Product year: 2020; it is not a live vegetation-condition layer.
- Nominal resolution: 10 m; effective canopy feature resolution is coarser
  because the model is trained from sparse GEDI footprints.
- Values are canopy-top height estimates; low vegetation and high-uncertainty
  regions require caution.
- LANDFIRE CH/CC/CBH/CBD are CONUS-only in this adapter. The fire model remains
  surface-only for crown behavior outside that coverage. That is intentional:
  deriving crown parameters from a tree class or canopy-top height alone would
  create false precision.
- The public LANDFIRE GeoServer can intermittently reset or return an empty
  response. The server uses bounded fetch retries plus an argument-safe curl
  fallback; a persistent upstream failure is surfaced as unavailable data
  instead of silently inventing canopy structure.
