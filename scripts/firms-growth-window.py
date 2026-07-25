import csv, math, json
from datetime import date, timedelta

SCRATCH = "/private/tmp/claude-501/-Users-ameyajoshi-Claude-Projects-Fire-Simulation/579c8f4a-f23a-4388-ad47-0aec7aeaa36d/scratchpad"

def poly_area_km2(coords):
    # shoelace on lon/lat with local equirectangular projection at mean lat
    lats = [c[1] for c in coords]
    lons = [c[0] for c in coords]
    mean_lat = sum(lats) / len(lats)
    km_per_deg_lat = 111.32
    km_per_deg_lon = 111.32 * math.cos(math.radians(mean_lat))
    pts = [(lon * km_per_deg_lon, lat * km_per_deg_lat) for lon, lat in coords]
    area = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0

def bbox_area_km2(bbox):
    # bbox = [minlon, minlat, maxlon, maxlat]
    minlon, minlat, maxlon, maxlat = bbox
    mean_lat = (minlat + maxlat) / 2.0
    km_per_deg_lat = 111.32
    km_per_deg_lon = 111.32 * math.cos(math.radians(mean_lat))
    w = (maxlon - minlon) * km_per_deg_lon
    h = (maxlat - minlat) * km_per_deg_lat
    return w * h

FIRES = [
    {
        "id": "oregon-gulch-2014",
        "year": 2014,
        "bbox": [-122.359151786564, 41.962927909788, -122.139824007222, 42.0937514871229],
        "alarm": "2014-07-30",
        "contain": "2014-08-13",
        "reportedAcres": 35111.25,
    },
    {
        "id": "big-five-2015",
        "year": 2015,
        "bbox": [-118.500086188751, 36.4715461926141, -118.483493638988, 36.4827345875778],
        "alarm": "2015-06-17",
        "contain": "2015-11-02",
        "reportedAcres": 264.5698,
    },
    {
        "id": "dinely-2017",
        "year": 2017,
        "bbox": [-118.873281530359, 36.4715018425483, -118.859253453518, 36.484753895508],
        "alarm": "2017-06-07",
        "contain": "2017-06-11",
        "reportedAcres": 340.5638,
    },
    {
        "id": "stoll-2018",
        "year": 2018,
        "bbox": [-122.268350250476, 40.1684693969324, -122.256296549138, 40.1848015427835],
        "alarm": "2018-06-24",
        "contain": "2018-06-24",
        "reportedAcres": 258.6872,
    },
    {
        "id": "reservoir-2016",
        "year": 2016,
        # bbox derived from geometry min/max below (computed separately); placeholder
        "alarm": "2016-06-26",
        "contain": "2016-06-30",
        "reportedAcres": 152.6466,
        "geometry": [
            [-122.57781, 39.15644], [-122.57641, 39.15672], [-122.57546, 39.15677], [-122.57502, 39.15672],
            [-122.57450, 39.15679], [-122.57398, 39.15663], [-122.57375, 39.15635], [-122.57392, 39.15577],
            [-122.57430, 39.15519], [-122.57480, 39.15469], [-122.57479, 39.15449], [-122.57452, 39.15402],
            [-122.57347, 39.15361], [-122.57300, 39.15388], [-122.57231, 39.15400], [-122.57084, 39.15398],
            [-122.56966, 39.15389], [-122.56875, 39.15383], [-122.56781, 39.15367], [-122.56737, 39.15359],
            [-122.56617, 39.15316], [-122.56508, 39.15340], [-122.56409, 39.15256], [-122.56318, 39.15219],
            [-122.56244, 39.15170], [-122.56218, 39.15092], [-122.56229, 39.15039], [-122.56259, 39.14941],
            [-122.56324, 39.14917], [-122.56381, 39.14872], [-122.56477, 39.14873], [-122.56545, 39.14912],
            [-122.56578, 39.14931], [-122.56662, 39.15007], [-122.56682, 39.15055], [-122.56764, 39.15079],
            [-122.56856, 39.15103], [-122.56915, 39.15104], [-122.56978, 39.15103], [-122.57103, 39.15097],
            [-122.57183, 39.15081], [-122.57263, 39.15054], [-122.57361, 39.15029], [-122.57387, 39.15028],
            [-122.57538, 39.15014], [-122.57686, 39.15048], [-122.57743, 39.15104], [-122.57801, 39.15200],
            [-122.57808, 39.15277], [-122.57840, 39.15348], [-122.57897, 39.15401], [-122.57936, 39.15472],
            [-122.57845, 39.15596], [-122.57781, 39.15644]
        ],
    },
    {
        "id": "deer-2016",
        "year": 2016,
        "alarm": "2016-07-01",
        "contain": "2016-07-04",
        "reportedAcres": 1563.429,
        "geometry": [
            [-118.669362, 35.229477], [-118.667731, 35.227148], [-118.668153, 35.224136], [-118.664616, 35.223166],
            [-118.663584, 35.220623], [-118.667046, 35.220269], [-118.666423, 35.218664], [-118.667804, 35.218806],
            [-118.668235, 35.217065], [-118.675932, 35.223667], [-118.680280, 35.223724], [-118.678508, 35.219896],
            [-118.672409, 35.217042], [-118.669670, 35.213929], [-118.675323, 35.214823], [-118.679817, 35.211275],
            [-118.687914, 35.211685], [-118.700544, 35.217222], [-118.712883, 35.220449], [-118.704631, 35.226193],
            [-118.699755, 35.227047], [-118.696207, 35.232847], [-118.693248, 35.230331], [-118.690088, 35.230127],
            [-118.682484, 35.233707], [-118.674389, 35.234331], [-118.673231, 35.233664], [-118.676063, 35.231312],
            [-118.671265, 35.231647], [-118.668855, 35.230759], [-118.669362, 35.229477]
        ],
    },
]

# fill in bbox + area for geometry-only fires
for f in FIRES:
    if "geometry" in f:
        lons = [c[0] for c in f["geometry"]]
        lats = [c[1] for c in f["geometry"]]
        f["bbox"] = [min(lons), min(lats), max(lons), max(lats)]
        f["observedAreaKm2"] = poly_area_km2(f["geometry"])
    else:
        f["observedAreaKm2"] = f["reportedAcres"] * 0.00404686

# generous padding around bbox for FIRMS query (fires can spread outside bbox slightly / detections have some offset)
PAD_DEG = 0.02

def load_year_detections(year, bbox):
    path = f"{SCRATCH}/viirs_{year}_us.csv"
    minlon, minlat, maxlon, maxlat = bbox
    minlon -= PAD_DEG; minlat -= PAD_DEG; maxlon += PAD_DEG; maxlat += PAD_DEG
    rows = []
    with open(path, newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            try:
                lat = float(row["latitude"])
                lon = float(row["longitude"])
            except (KeyError, ValueError):
                continue
            if minlat <= lat <= maxlat and minlon <= lon <= maxlon:
                rows.append((row["acq_date"], lat, lon))
    return rows

def cumulative_extent_bbox_km2(dated_points, start, end):
    # dated_points: list of (date_str, lat, lon) filtered to calendar window
    d0 = date.fromisoformat(start)
    d1 = date.fromisoformat(end)
    by_day = {}
    for ds, lat, lon in dated_points:
        d = date.fromisoformat(ds)
        by_day.setdefault(d, []).append((lat, lon))
    days = sorted(by_day.keys())
    if not days:
        return [], 0
    cum_lats = []
    cum_lons = []
    curve = []  # (day_index_from_start, cumulative_bbox_area_km2, n_points_so_far)
    n_total = 0
    all_days_range = []
    d = d0
    while d <= d1:
        all_days_range.append(d)
        d += timedelta(days=1)
    for d in all_days_range:
        if d in by_day:
            for lat, lon in by_day[d]:
                cum_lats.append(lat)
                cum_lons.append(lon)
                n_total += 1
        if cum_lats:
            bbox_now = [min(cum_lons), min(cum_lats), max(cum_lons), max(cum_lats)]
            area = bbox_area_km2(bbox_now)
        else:
            area = 0.0
        curve.append({"date": d.isoformat(), "day_index": (d - d0).days, "cum_area_km2": area, "n_points": n_total})
    return curve, len(days)

results = {}
for f in FIRES:
    dets = load_year_detections(f["year"], f["bbox"])
    curve, _ = cumulative_extent_bbox_km2(dets, f["alarm"], f["contain"])
    d0 = date.fromisoformat(f["alarm"]); d1 = date.fromisoformat(f["contain"])
    active_dates_in_window = {date.fromisoformat(ds) for ds, lat, lon in dets if d0 <= date.fromisoformat(ds) <= d1}
    n_active_days = len(active_dates_in_window)
    final_area = curve[-1]["cum_area_km2"] if curve else 0
    final_n = curve[-1]["n_points"] if curve else 0
    calendar_days = (date.fromisoformat(f["contain"]) - date.fromisoformat(f["alarm"])).days + 1
    growth_day = None
    if final_area > 0:
        threshold = 0.95 * final_area
        for pt in curve:
            if pt["cum_area_km2"] >= threshold:
                growth_day = pt["day_index"]
                break
    results[f["id"]] = {
        "year": f["year"],
        "calendar_days": calendar_days,
        "n_detections_total": final_n,
        "n_active_days": n_active_days,
        "final_detection_extent_km2": round(final_area, 3),
        "growth_window_days_95pct": growth_day,
        "observed_area_km2": round(f["observedAreaKm2"], 4),
        "extent_over_observed_ratio": round(final_area / f["observedAreaKm2"], 2) if f["observedAreaKm2"] > 0 else None,
    }

print(json.dumps(results, indent=2))
