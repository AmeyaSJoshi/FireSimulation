# Elevation Source Research

**Checked:** 2026-07-22 (America/Los_Angeles)

## Recommendation

Use the public **Open-Meteo Elevation API** as the browser-side primary source:

```text
GET https://api.open-meteo.com/v1/elevation?latitude=37.7749&longitude=-122.4194
```

It is the best fit found for a global click-to-fire simulator: no API key is required for the public endpoint, it accepts WGS-84 coordinates, returns JSON, covers the world through Copernicus GLO-90, and passed a direct CORS check. It is appropriate for broad terrain behavior at roughly 90 m scale, not for precise building-scale or tactical terrain.

## Open-Meteo Elevation API

### Request and response

- Endpoint: [`/v1/elevation`](https://open-meteo.com/en/docs/elevation-api)
- Required query parameters: `latitude` and `longitude`, as floating-point WGS-84 coordinates.
- Multiple coordinates are comma-separated in each parameter; the documented maximum is 100 coordinates per request.
- Successful response is an object containing an `elevation` array, in the same coordinate order, with values in metres. Example:

  ```json
  {"elevation":[18.0]}
  ```

- Invalid parameters return HTTP 400 with a JSON error object.

For a click workflow, issue one GET for the clicked coordinate or batch nearby cache misses, then associate the returned array position with the requested point.

### Resolution and coverage

Open-Meteo documents the source as the **Copernicus DEM 2021 release GLO-90 at 90 m resolution**, available worldwide. The Copernicus documentation independently describes GLO-90 as worldwide coverage at 90 m and says the dataset has a free licence: [`Copernicus DEM collection description`](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM), [`Copernicus DEM API documentation`](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM.html).

Important modeling caveat: Copernicus describes this product as a **digital surface model**, so elevations can include vegetation and structures rather than representing bare earth. That is acceptable for coarse global terrain but should not be treated as building-accurate ground height.

### No-key and browser feasibility

- Open-Meteo's elevation docs mark `apikey` as optional and state it is only needed for commercial customers using reserved resources. The public request above therefore needs no API key.
- Direct transport check on 2026-07-22 local time, using `Origin: https://example.com`:
  - GET returned HTTP 200, JSON, and `access-control-allow-origin: *`.
  - OPTIONS preflight returned HTTP 200 with `access-control-allow-origin: *`, `access-control-allow-methods: GET, POST, OPTIONS`, and `access-control-max-age: 600`.
- This makes ordinary browser `fetch()` feasible without a project-owned proxy. Open-Meteo's official source history also records a fix for CORS preflight support: [`open-meteo release history`](https://github.com/open-meteo/open-meteo/releases).

### Rate limits, terms, and attribution

The current Open-Meteo pricing page documents the free/open-access service as non-commercial, with limits of 600 calls/minute, 5,000 calls/hour, 10,000 calls/day, and 300,000 calls/month; its FAQ specifically calls out the 10,000-call daily limit and no uptime guarantee for the free API. Treat those as shared public-service limits rather than a promise of per-user elevation capacity: [`Open-Meteo pricing and limits`](https://open-meteo.com/en/pricing).

The API data are offered under CC BY 4.0, and the elevation docs require clear attribution to both Open-Meteo and Copernicus. Add a small persistent attribution line or an accessible credits panel in the simulator: [`Open-Meteo licence`](https://open-meteo.com/en/license), [`elevation API attribution`](https://open-meteo.com/en/docs/elevation-api).

## Considered fallback: Open Topo Data

Open Topo Data is a useful technical fallback behind a server-side proxy or in a self-hosted deployment:

```text
GET https://api.opentopodata.org/v1/srtm90m?locations=37.7749,-122.4194
```

Its official docs support single or multiple WGS-84 locations, interpolation options, and JSON responses with `results[].elevation`; its public dataset list includes SRTM at 30 m or 90 m, ASTER, ETOPO1, and other regional/global datasets: [`Open Topo Data API docs`](https://www.opentopodata.org/api/), [`Open Topo Data source repository`](https://github.com/ajnisbet/opentopodata).

It is **not suitable as a direct browser fallback** based on the current transport check: the GET response returned JSON, but neither the GET nor the OPTIONS response included `Access-Control-Allow-Origin`. A browser `fetch()` should therefore be expected to fail CORS even though a command-line client can read the response. The official docs also describe the public API as available for testing; I found no current numeric public rate limit in the official API/server documentation, so absence of a stated limit must not be interpreted as unlimited capacity.

## Graceful failure recommendation

Terrain should be non-blocking for firing:

1. Query Open-Meteo with a short client timeout and cache successful values by a quantized coordinate/cell.
2. On timeout, HTTP error, quota response, or offline use, apply the last cached elevation for that cell if available.
3. If no cached value exists, continue the fire simulation with an explicit flat/unknown-terrain fallback (for example, elevation `0 m`) and mark terrain as unavailable in the UI. Do not silently present it as measured terrain.
4. For sustained public traffic, commercial use, or a requirement for stronger availability, move the request behind a project-owned service or self-host the open-source Open-Meteo server and retain the same client contract. For higher spatial fidelity, replace or augment the 90 m source with a locally appropriate DEM rather than pretending the global fallback is building-scale accurate.

## Bottom line

**Primary:** Open-Meteo Elevation API, direct browser GET, no key, global GLO-90, about 90 m resolution, CORS verified.

**Fallback:** cached elevation, then clearly labeled flat/unknown terrain; use Open Topo Data only through a proxy or self-hosted deployment because its current public endpoint is not browser-CORS compatible.
