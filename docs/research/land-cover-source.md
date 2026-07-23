# Land Cover Source Research — ESA WorldCover 2021

**Checked:** 2026-07-23 (America/Los_Angeles)
**Target dataset:** ESA WorldCover 2021 v200, global 10 m land-cover classification
**Purpose:** Phase 2 crosswalk from land cover → fire-behavior fuel model, per
`docs/realistic-fire-model-claude-code-prompt.txt` § 6

## Recommendation

**Stop and pick a delivery path with the user.** ESA WorldCover 2021 is the
right *dataset* — 10 m global coverage, 11 classes, CC BY 4.0 license, well
documented by ESA — but its official public endpoints are all unfriendly to
direct browser fetches. Getting it into the app requires either a small
serverless proxy or a preprocessed coarse-resolution asset. Neither is
blocked, but both are architecturally significant choices the prompt § 8
says to run past you first.

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

## Available paths

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

## What I would pick if it were mine

**Option B (preprocessed coarse asset)**, for four reasons:

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

## What I need from you

One of:

- **"Do B"** — I write the preprocessing script + Node dev-dep, run it,
  ship the PNG, and Phase 2 proceeds using the terrainSampler pattern.
- **"Do A"** — I write the Cloudflare Worker (or your preferred host),
  you deploy it, we wire the frontend to that endpoint.
- **"Do C for now"** — skip WorldCover this phase, revisit later.
- **"Do something else"** — propose it, I'll verify transport first.

I will not proceed on A or B without an explicit go-ahead, because both
add either a runtime dependency (A: hosted service) or a build-time
dependency (B: `geotiff` package) that § 8 requires I stop and ask about.
