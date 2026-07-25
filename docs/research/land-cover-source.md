# Land Cover Source Research — ESA WorldCover 2021

**Checked:** 2026-07-23 (America/Los_Angeles)
**Target dataset:** ESA WorldCover 2021 v200, global 10 m land-cover classification
**Purpose:** Phase 2 crosswalk from land cover → fire-behavior fuel model, per
`docs/realistic-fire-model-claude-code-prompt.txt` § 6

## Delivered path

The project selected the zero-infrastructure path: a one-time Node
preprocessing job produces a deterministic coarse global PNG and JSON sidecar.
The browser reads that asset locally, so normal simulation clicks do not depend
on a tile service, a proxy, or a paid account. The source remains ESA
WorldCover 2021 v200; only the runtime representation is coarse.

## Dataset facts

Source: [ESA WorldCover project](https://esa-worldcover.org/) · Data: v200,
2021 · Native resolution: 10 m · Global coverage · 11 discrete classes:

| Code | Class | Fuel implication |
|------|-------|------------------|
| 10 | Tree cover                    | Timber fuel model |
| 20 | Shrubland                     | Brush fuel model |
| 30 | Grassland                     | Grass fuel model |
| 40 | Cropland                      | Grass or agricultural (seasonal) |
| 50 | Built-up                      | Non-burnable |
| 60 | Bare / sparse vegetation      | Low-load / non-burnable |
| 70 | Snow and ice                  | Non-burnable |
| 80 | Permanent water bodies        | Non-burnable |
| 90 | Herbaceous wetland            | Low-flammability grass/scrub |
| 95 | Mangroves                     | Low-flammability wet timber |
| 100 | Moss and lichen              | Low-load |

License: **CC BY 4.0**, ESA + Zanaga et al. citation required in any
distribution.

## Transport check (2026-07-23)

Every endpoint was hit with `Origin: https://example.com` to simulate a
browser fetch. Results:

### 1. ESA S3 bucket (direct COG download)

```text
GET https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/
    ESA_WorldCover_10m_2021_v200_N39W087_Map.tif
→ HTTP/1.1 200 OK
  Content-Length: 98580896   # 98 MB per 3° tile
  Accept-Ranges: bytes
  (no Access-Control-Allow-Origin header)

OPTIONS (CORS preflight):
→ HTTP/1.1 403 Forbidden
```

Verdict: **not usable directly from the browser** — bucket has no CORS
policy attached, and each tile is 98 MB anyway. Range requests would let
us fetch a single pixel from a COG, but the CORS preflight fails, so the
browser will refuse the request before the Range even matters.

### 2. Terrascope WMS

```text
GET https://services.terrascope.be/wms/v2?SERVICE=WMS&REQUEST=GetCapabilities
→ (connection failure across multiple retries — DNS or TLS timeout)
```

Verdict: **unreachable** from this environment. Even if it were reachable,
WMS GetFeatureInfo is a standard fallback pattern (returns a class code
for a point), but we cannot verify CORS on an endpoint we cannot hit.

### 3. Microsoft Planetary Computer STAC

```text
GET https://planetarycomputer.microsoft.com/api/stac/v1/collections/esa-worldcover
→ access-control-allow-origin: *   ✅

POST /api/stac/v1/search   { collections:["esa-worldcover"],
                             intersects:{Point,[lon,lat]} }
→ 200, JSON feature with asset URLs on Azure Blob Storage

GET /api/sas/v1/token/ai4edataeuwest/esa-worldcover
→ 200, JSON { token: "<SAS>", msft:expiry: "..." }
```

Verdict: **STAC layer is CORS-friendly**, but the actual COG lives on
Azure Blob Storage (`ai4edataeuwest.blob.core.windows.net`) and is fetched
with the SAS token. The Azure blob does not advertise CORS in the STAC
response; downloading the whole 98 MB TIFF client-side is still not
viable, and Range-reading a COG requires a GeoTIFF parser (`geotiff.js`,
~90 KB min) — a new runtime dependency the prompt § 8 says to check with
you first.

## Available paths considered

Ranked by architectural simplicity, most-honest to most-clever:

### A. Serverless proxy (recommended if we want live per-pixel reads)

A tiny Cloudflare Worker or Vercel edge function exposes:

```text
GET /api/landcover?lat=<n>&lon=<n>
→ { classCode: 40, className: "Cropland",
    source: "ESA WorldCover 2021 v200", fetchedAt: <ms> }
```

Implementation server-side:
1. STAC search to find the 3° tile that covers the point.
2. Ask Planetary Computer for a SAS token (or use the token TTL cache).
3. Range-request the COG's IFD + one 512 × 512 tile at zoom level 0.
4. Decode with `geotiff` in the worker runtime, return the pixel class.

**Pros:** live, exact 10 m resolution, browser gets a clean JSON contract
without ever seeing GeoTIFF or CORS. Frontend adds zero dependencies.
**Cons:** you now own a hosted service. Free tiers (CF Workers 100k
req/day, Vercel 100 GB-h/mo) are ample for a research tool. Requires you
to deploy and register the endpoint.

### B. Preprocessed coarse global asset (recommended if we want zero infra)

I write a **one-time preprocessing script** in Node (`scripts/build-
landcover-map.mjs`) that:

1. Downloads a fixed set of WorldCover COGs (globally, at the 3° tile
   grid ESA publishes).
2. Downsamples each to a small class-value mosaic — modal class per 4 km
   or 8 km pixel — using nearest-neighbour or majority downsampling.
3. Packs the whole mosaic into a paletted PNG (~few MB total, 11 class
   values including "no data").
4. Ships the PNG in `public/landcover-coarse.png`.

Runtime uses the same pattern as `src/lib/terrainSampler.js` — read a
pixel from the visible image, look up the class from the palette. Zero
new runtime dependencies. The preprocessing script *does* need a
GeoTIFF reader in Node (`geotiff` npm package, dev-dependency only), and
takes a few minutes to run once.

**Pros:** offline, no infrastructure, matches the existing terrain-
sampler architecture, deterministic. Cache is the entire globe, always
available. **Cons:** loses per-pixel precision to whatever mosaic
resolution we pick (4 km ≈ still detects urban-vs-forest reliably, will
smear coastlines and small features). Adds one dev-dependency.

### C. Ship without WorldCover for now

Fall back to the coarse continent/biome inference we already have from
`locationLabel`, tag every fuel choice as `experimental` per prompt § 10,
document the gap in the UI. Doesn't move the needle on prompt § 6 goals
but doesn't block the rest of Phase 2 either (fuel-model table and
weather ingest can proceed independently).

**Pros:** honest about the gap, zero infrastructure. **Cons:** the
whole point of Phase 2 land-cover work is defeated.

## What was shipped

**Option B (preprocessed coarse asset)** was shipped for four reasons:

1. It matches the existing project pattern (`terrainSampler.js` reads a
   preprocessed image the same way). Reviewer surprise = zero.
2. It's dependency-free at *runtime*, which is the constraint the prompt
   cares about most.
3. The dev-time preprocessing script is a one-time cost. `geotiff` is
   MIT-licensed, no transitive tail, and only runs in Node during a
   `npm run build:landcover` step, never in the browser bundle.
4. It removes an ongoing service dependency — no free-tier expiry, no
   deploy step, no rate-limit surprises when someone else uses the app.

The precision loss is real but honest: at 4 km per pixel, "cropland" and
"grassland" won't shift under a single click and the confidence label
will say so.

## Remaining accuracy limit

At runtime, classified ESA WorldCover fine/coarse samples and optional
Copernicus fractional water are treated as model evidence. The Earth texture
is retained for visual masking and as a conservative fallback when no
classified sample is available. For ignition clicks, fine classified land and
fractional land remain authoritative. For propagation edges, visible water is
also an explicit conservative veto, so a fine cell-majority land label cannot
open a transition across a visible shoreline or narrow water strip. An
explicit fractional-land sample still prevents that veto when the texture is
known to be a coarse false positive.
For the interactive 0.5 km raster, sixteen native 10 m samples are taken
inside each cell and majority-voted before the fuel crosswalk. Four samples
per axis are placed near each edge as well as near the interior. Edge checks
retain the nearest native water evidence instead of collapsing the query to
the cell majority, reducing narrow-river and coastline errors without adding
a paid service. The browser transports the full field as bounded ordered
batches rather than one oversized request, with a small retry budget for
transient COG failures. Successful batches are retained when another batch
times out or fails; missing native samples are left unknown and the affected
cells use the coarse global classification. If every batch fails, the explicit
coarse fallback is used for the entire field. Runtime metadata reports the
native sample fraction and successful/total batch count so partial coverage is
never presented as a complete 10 m field.

The cell aggregation also preserves the fraction of valid native samples that
are burnable. The majority class still determines fuel identity, while that
sample fraction scales the available fuel load. This is a transparent
within-cell prior for mixed water, built-up, sparse, or vegetated ground; it is
not a regional calibration coefficient or a claim about measured biomass.

The shipped mosaic is approximately 3.7 km per pixel. It is useful for global
biome and permanent-water classification, but it cannot represent local fuel
patches, narrow roads, small wetlands, or a fire's true stand structure. The
crosswalk therefore emits a `fuelLoadScale` prior for sparse, wetland,
mangrove, moss, and agricultural classes. That scale is an explicit heuristic,
not a measured fuel load; the UI and metadata continue to label the crosswalk
confidence. A finer regional source or a deployed COG proxy is the next
resolution upgrade, not a silent change to the current global asset.

## Local high-resolution path

The localhost development server now adds an optional same-origin range-read
adapter for the original ESA WorldCover 2021 10 m COGs:

- `GET /api/landcover/fine?lat=<latitude>&lon=<longitude>` reads one class.
- `POST /api/landcover/fine-field` reads the 64 x 64 fire field with sixteen
  native samples per cell, grouping samples by 3-degree tile so a field
  crossing a tile boundary is still handled correctly; transiently missing
  batches fall back cell-by-cell to the coarse mosaic.
- `src/main.js` uses the fine field for the active per-cell fuel raster and
  falls back to the shipped coarse mosaic when the local adapter is absent or
  unavailable.
- `vite.config.js` keeps a four-tile LRU cache and uses `geotiff` range reads;
  the browser never receives a multi-gigabyte COG.

This path is intentionally development/localhost infrastructure. A static
deployment still uses the coarse global asset until a server-side proxy or
equivalent authenticated Copernicus delivery is deployed. The UI metadata
reports which resolution actually supplied the current field.

When Copernicus Data Space credentials are available to the dev server, the
same-origin adapter also exposes point and raster routes at
/api/landcover/fractions and /api/landcover/fractions-field. Set
COPERNICUS_CLIENT_ID and COPERNICUS_CLIENT_SECRET in the server environment;
the secret never enters the browser. Without those variables the routes return
an explicit credentials_missing response and the WorldCover path remains the
active fallback.

## Optional global evidence layer: Copernicus fractional cover

ESA WorldCover supplies the discrete class needed for the current crosswalk,
but a class label alone does not describe fuel continuity or mixed pixels.
The official Copernicus Global Dynamic Land Cover 100 m documentation
(https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/clms/land-cover-and-land-use-mapping/global-dynamic-land-cover/lc_global_100m_yearly_v3.html)
lists global fractional layers for tree, shrub, grass, crop, bare, moss/lichen,
and permanent-water cover, alongside a discrete classification. Those
fractions are a better evidence layer for adjusting local fuel availability
and identifying mixed water/land cells than an invented biome coefficient.

The product is free/open, but the documented delivery path is a Copernicus
Data Space BYOC/Sentinel Hub request and requires a free account with OAuth
client credentials. The localhost app therefore does not silently pretend
that this layer is present: without credentials it continues to use ESA
WorldCover and reports field-wide crosswalk quality. When the fractions are
available, the crosswalk uses the dominant tree/shrub/grass/crop fraction to
select a corresponding Scott & Burgan approximation and scales fuel
availability by total mapped vegetation cover. This is intentionally labeled
low confidence: cover percentage is not measured surface fuel load, the
2015–2019 product is not a live 2026 fuel observation, and no global
calibration coefficient is claimed. The explicit 50% permanent-plus-seasonal
water threshold remains a hard barrier.
