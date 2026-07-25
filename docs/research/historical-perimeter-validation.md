# Historical Perimeter Validation

**Updated:** 2026-07-23

## Fixture

The first checked-in fixture is the 2016 Reservoir Fire perimeter from the
public California fire-perimeter feature service:

- Source layer: https://services.arcgis.com/V6ZHFr6zdgNZuVG0/ArcGIS/rest/services/California_fires_since_2014/FeatureServer/2
- Source record: `OBJECTID=105`, `FIRE_NAME=RESERVOIR`
- Collection method: GPS ground (`C_METHOD=1`)
- Reported GIS area: 152.6466 acres
- Alarm date: 2016-06-26
- Containment date: 2016-06-30

The source geometry is preserved as WGS-84 GeoJSON in
`src/lib/historicalPerimeterFixtures.js`. It is rasterized using the same
geodesic `spatialGrid.js` mapping used by the fire model, not an independent
equirectangular test projection.

An independent compact fixture is Deer Fire (2016), also a GPS-ground
perimeter from the same public service:

- Source record: `OBJECTID=60`, `FIRE_NAME=DEER`
- Reported GIS area: 1,563.429 acres
- Alarm date: 2016-07-01
- Containment date: 2016-07-04

Run the calm diagnostic with `npm run validate:perimeter:independent`, or use
`npm run validate:perimeter:independent:archive` to replay public archived
weather for the event dates. The calm homogeneous TU2 diagnostic reports IoU
`0.6064`, F1 `0.7550`, and centroid error `0.237 km`; the archived-weather
replay reports IoU `0.3628`, F1 `0.5325`, and predicted area `17.04 km²` versus
`6.36 km²` observed. The source row does not publish a verified ignition point,
so the fixture records its local window-center coordinate assumption
explicitly. Both are reproducible diagnostics, not calibrated accuracy
thresholds; the archived result shows that weather forcing without regional
fuel structure or containment data is insufficient.

## Metrics

`src/lib/perimeterValidation.js` compares an arrival-time threshold against an
observed mask and reports:

- intersection over union (IoU)
- precision, recall, and F1
- predicted and observed area
- centroid error
- symmetric mean boundary distance

The fixture and metric behavior are covered by
`src/lib/perimeterValidation.test.js`.

## Current baseline and limitation

The first baseline uses homogeneous TU2, flat terrain, 5% dead moisture, 50%
live moisture, no wind, and a 1,300-minute threshold. It produces an IoU of
approximately 0.37 on the Reservoir geometry. This is a diagnostic baseline,
not a historical hindcast: it does not use the 2016 weather sequence, mapped
fuels, suppression actions, spotting, or the observed ignition point. The low
score is retained as evidence that those inputs still matter.

The next validation slice is to replay historical weather/fuel inputs before
setting an acceptance threshold. The arrival solver now accepts a time-varying
wind timeline, but this fixture still does not supply the Reservoir Fire's
historical weather sequence, mapped fuels, or observed ignition point. A final
perimeter alone cannot validate a fire's time evolution.

## Multi-time progression fixture

`src/lib/historicalProgressionFixtures.js` adds a compact Rush Creek (2021)
progression fixture from the USDA Forest Service EDW Fire Perimeter service:

- Fire: `2021-IDPAF-000422`, discovered 2021-07-16, lightning cause
- Ignition point: the public EDW occurrence record, not a perimeter centroid
- Observations: 17 mapped perimeters from 2021-07-18 through 2021-09-25
- Source layer: https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_FireOccurrenceAndPerimeter_01/MapServer/11
- Occurrence layer: https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_FireOccurrenceAndPerimeter_01/MapServer/22

The original public geometry is simplified to approximately 100 m before being
checked in so the repository does not ship a large raw service response. The
series validator converts each timestamp to elapsed model minutes and reports
IoU, F1, area, centroid error, and boundary distances for every observation,
plus mean, median, and final summaries. It also reports interval growth
diagnostics. When recorded acreage is available, that value is used for growth
instead of rasterized area so a coarse grid cannot turn a small perimeter
change into a false stall. An interval where observed growth is at most 0.002
km² per hour while the model keeps growing is labeled a
`likelyContainmentOrSuppressionSignal`. This is a diagnostic flag, not proof
of suppression and not a hidden model constraint. Run it with:

```bash
npm run validate:progression
```

To pull the matching Open-Meteo archive window and replay hourly wind plus
dead-fuel moisture state through the same solver, run:

```bash
npm run validate:progression:archive
```

The archive validators request seven days before ignition as dead-fuel spin-up
history. This is intentional: the 1-, 10-, and 100-hour fuel classes are lag
states, so initializing them from the first ignition-hour weather would make
the result depend on an arbitrary default. Offline `--weather-file` replays
retain whatever pre-ignition history is present in the supplied file and
report its coverage.

To exercise the browser's shipped WorldCover-to-fuel field in the same
comparison, run `npm run validate:progression:mapped`. Combine both inputs for
the full product-path replay with `npm run validate:progression:hindcast`.

For a repeatable offline replay after downloading the archive response, pass
the saved JSON through `--weather-file path/to/archive.json`.

The archive replay is deliberately opt-in because it requires network access
and uses reanalysis-derived weather rather than a fire-station observation.

The interactive forecast path now carries hourly dead-fuel moisture alongside
wind. It advances the NFDRS time-lag state through future precipitation before
the arrival solver evaluates each edge; this is separate from the historical
replay's longer archive and remains an estimate rather than a local fuel
observation.

The current baseline intentionally uses homogeneous TU2, flat terrain, calm
wind, and fixed moisture. It is a diagnostic, not an accuracy claim. The
progression script now accepts `--size` and `--cell-meters`; the recommended
larger-domain command is:

```bash
npm run validate:progression:large -- --archive --weather-file /tmp/rush-creek-weather.json
```

That 256 × 256, 100 m archived-weather replay avoids the 12.8 km field
saturation, but still returns mean IoU `0.1275`, final IoU `0.0620`, and final
predicted area `619.23 km²` versus `38.42 km²` observed. The result separates
domain truncation from the remaining errors: ignition timing, fuel structure,
weather representativeness, and suppression/containment are still missing.
The growth diagnostics make likely containment periods visible in the JSON so
future calibration can exclude or separately model them rather than fitting a
single global speed multiplier. The propagation engine now also accepts an
optional time-aware suppression edge raster through
`src/lib/suppressionConstraints.js`; the historical fixtures do not yet claim
authoritative line locations or activation times, so replay remains
unconstrained by suppression until those observations are supplied.

For a clearly labeled data-assimilation diagnostic, run
`npm run validate:progression:containment -- --weather-file <cached-json>`.
This finds the first interval where the observed perimeter stalls while the
unconstrained model continues, then converts that observed snapshot into
explicit eight-neighbor containment barriers from the interval start. The
output includes a second constrained replay under
`observedContainmentDiagnostic`; it is not a forecast and must not be used to
claim that the model inferred a fireline. If the unconstrained model has
already escaped far beyond the observed perimeter before the stall, the
diagnostic will correctly show little or no improvement: that is evidence of
an earlier fuel, ignition, or weather error rather than permission to fit a
suppression line retroactively.

For a geometry-driven domain, run:

```bash
npm run validate:progression:adaptive -- --weather-file /tmp/rush-creek-weather.json
```

The cached run selected 193 × 193 at 100 m, and reported mean IoU `0.1517`,
final IoU `0.1063`, and final predicted area `362.03 km²` versus `38.47 km²`
observed. The solver still reported `field_boundary_reached`; this mode makes
remaining overgrowth visible rather than claiming that the domain is solved.

The mapped-fuel mode is deliberately reported separately from the homogeneous
baseline. In the Rush Creek window, the shipped approximately 3.7 km WorldCover
mosaic classifies every validation cell as tree cover. That is useful for
testing the exact browser data path, but it also demonstrates why this raster
cannot be treated as a local fuel survey or as a final accuracy ceiling.

The fine hindcast now uses the same sixteen native 10 m samples per model cell
as the localhost field builder, with majority voting for fuel and
nearest-sample checks for water edges. After piecewise weather integration and
the moisture-extinction veto, the current cached replay reports mean IoU
`0.00075`, final IoU `0.00026`, and final predicted area `0.01 km²` versus
`38.42 km²` observed. The strict result exposes an unresolved regional
fuel/moisture initialization and ignition-timing problem; it is a calibration
diagnostic, not an acceptance threshold or a reason to add a global speed
multiplier.
