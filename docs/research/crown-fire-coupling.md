# Crown-fire coupling status

## Implemented path

The project now has a guarded crown-fire module in `src/lib/crownFire.js`:

- Van Wagner initiation threshold, `I' = [0.01 × CBH × (460 + 25.9 × FMC)]^1.5` kW/m.
- Active-crown threshold, `R'active = 30 / CBD` m/min, from the 0.05 kg/m²/s critical mass-flow rate.
- Rothermel (1991) active spread, `Ractive = 3.34 × R10,40%`, using Anderson FM10 and 40% of the open 6.1 m wind.
- Final directional travel rate blends the existing surface ellipse and the published FM10 crown ellipse using a crown-fraction transition: zero at the solved torching index, one at the solved crowning index, and linear in between.

The LANDFIRE 2024 CONUS WCS adapter supplies CH, CC, CBH, and CBD. CH raw
values are divided by 10 to meters; CC raw values are divided by 100 to a
fraction; CBH raw values are divided by 10 to meters; CBD raw values are
divided by 100 to kg/m³; raw 32767 is nodata. CH and CC drive the measured
canopy shelter WAF, while CBH and CBD are both required for crown behavior.
A missing or out-of-coverage value leaves the affected cell on its conservative
fallback path.

For sheltered wind, `weatherInputs.calculateCanopyShelteredWindAdjustment`
implements the sheltered RMRS-GTR-266 equation with `F = CC / 3` and crown
ratio 1, and requires the source wind reference to be at least 20 ft above the
measured canopy top. The interactive weather reference is 10 m above ground,
so tall forests intentionally keep the existing `x0.2` fallback rather than
extrapolating a free-wind measurement that the app does not have. The equation
also rejects a result above one near the source's five-percent canopy-fill
cutoff; that cell remains on the conservative fallback.

The server keeps the WCS request bounded to the fire grid and retries transient upstream failures. Its request uses the literal comma-separated WCS 1.0 geographic extent required by the LANDFIRE GeoServer parser; if Node's TLS client is rejected, an argument-safe `curl` fallback retries the same URL before the route reports unavailable data.

## Deliberate limits

This is a validated model coupling, not a claim of global crown-fire accuracy. The Rothermel crown correlation was developed for wind-driven crown fires in the Northern Rocky Mountains and similar conditions. It does not predict plume-dominated spread or spotting. The current UI uses foliar moisture fraction 1.0 as an explicit default because the public canopy structure source does not provide local foliar moisture. The surface-only global fallback remains the honest behavior outside LANDFIRE coverage.

## Primary references

- Scott, J.H. and Reinhardt, E.D. (2001), [RMRS-RP-29](https://www.fs.usda.gov/rm/pubs/rmrs_rp029.pdf), equations 7, 11, 12, 14, and 21.
- Rothermel, R.C. (1991), [INT-RP-438](https://research.fs.usda.gov/treesearch/26696).
- LANDFIRE, [Forest Canopy Base Height](https://landfire.gov/fuel/cbh) and [Forest Canopy Bulk Density](https://landfire.gov/fuel/cbd), LF 2024 product definitions.
- LANDFIRE public [WCS/WMS services](https://landfire.gov/data/lf_wcs_wms), which the Vite server queries for bounded field rasters.
