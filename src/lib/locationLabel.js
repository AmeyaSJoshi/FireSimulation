const CITY_CATALOG = [
  // U.S. cities cover the initial simulation area and common landmark tests.
  ['San Francisco', 'California', 'United States', 37.7749, -122.4194],
  ['Los Angeles', 'California', 'United States', 34.0522, -118.2437],
  ['San Diego', 'California', 'United States', 32.7157, -117.1611],
  ['Sacramento', 'California', 'United States', 38.5816, -121.4944],
  ['Seattle', 'Washington', 'United States', 47.6062, -122.3321],
  ['Portland', 'Oregon', 'United States', 45.5152, -122.6784],
  ['Las Vegas', 'Nevada', 'United States', 36.1699, -115.1398],
  ['Phoenix', 'Arizona', 'United States', 33.4484, -112.074],
  ['Denver', 'Colorado', 'United States', 39.7392, -104.9903],
  ['Salt Lake City', 'Utah', 'United States', 40.7608, -111.891],
  ['Boise', 'Idaho', 'United States', 43.615, -116.2023],
  ['Albuquerque', 'New Mexico', 'United States', 35.0844, -106.6504],
  ['Dallas', 'Texas', 'United States', 32.7767, -96.797],
  ['Houston', 'Texas', 'United States', 29.7604, -95.3698],
  ['Austin', 'Texas', 'United States', 30.2672, -97.7431],
  ['Oklahoma City', 'Oklahoma', 'United States', 35.4676, -97.5164],
  ['Kansas City', 'Missouri', 'United States', 39.0997, -94.5786],
  ['Minneapolis', 'Minnesota', 'United States', 44.9778, -93.265],
  ['Chicago', 'Illinois', 'United States', 41.8781, -87.6298],
  ['Detroit', 'Michigan', 'United States', 42.3314, -83.0458],
  ['St. Louis', 'Missouri', 'United States', 38.627, -90.1994],
  ['New Orleans', 'Louisiana', 'United States', 29.9511, -90.0715],
  ['Atlanta', 'Georgia', 'United States', 33.749, -84.388],
  ['Miami', 'Florida', 'United States', 25.7617, -80.1918],
  ['Orlando', 'Florida', 'United States', 28.5383, -81.3792],
  ['Nashville', 'Tennessee', 'United States', 36.1627, -86.7816],
  ['Charlotte', 'North Carolina', 'United States', 35.2271, -80.8431],
  ['Washington', 'District of Columbia', 'United States', 38.9072, -77.0369],
  ['Philadelphia', 'Pennsylvania', 'United States', 39.9526, -75.1652],
  ['New York City', 'New York', 'United States', 40.7128, -74.006],
  ['Boston', 'Massachusetts', 'United States', 42.3601, -71.0589],
  ['Honolulu', 'Hawaii', 'United States', 21.3069, -157.8583],
  ['Anchorage', 'Alaska', 'United States', 61.2181, -149.9003],

  // Global reference cities keep the location readout useful before global
  // fire-data coverage is connected.
  ['London', 'England', 'United Kingdom', 51.5074, -0.1278],
  ['Paris', 'Ile-de-France', 'France', 48.8566, 2.3522],
  ['Rome', 'Lazio', 'Italy', 41.9028, 12.4964],
  ['Berlin', 'Berlin', 'Germany', 52.52, 13.405],
  ['Madrid', 'Community of Madrid', 'Spain', 40.4168, -3.7038],
  ['Cairo', 'Cairo Governorate', 'Egypt', 30.0444, 31.2357],
  ['Cape Town', 'Western Cape', 'South Africa', -33.9249, 18.4241],
  ['Rio de Janeiro', 'Rio de Janeiro', 'Brazil', -22.9068, -43.1729],
  ['Mexico City', 'Mexico City', 'Mexico', 19.4326, -99.1332],
  ['Toronto', 'Ontario', 'Canada', 43.6532, -79.3832],
  ['Vancouver', 'British Columbia', 'Canada', 49.2827, -123.1207],
  ['Tokyo', 'Tokyo', 'Japan', 35.6762, 139.6503],
  ['Beijing', 'Beijing', 'China', 39.9042, 116.4074],
  ['Singapore', 'Singapore', 'Singapore', 1.3521, 103.8198],
  ['Sydney', 'New South Wales', 'Australia', -33.8688, 151.2093],
  ['Mumbai', 'Maharashtra', 'India', 19.076, 72.8777],
  ['Dubai', 'Dubai', 'United Arab Emirates', 25.2048, 55.2708],
  ['Istanbul', 'Istanbul', 'Türkiye', 41.0082, 28.9784]
].map(([city, region, country, latitude, longitude]) => ({
  city,
  region,
  country,
  latitude,
  longitude
}));

const US_STATE_CATALOG = [
  ['Alabama', 32.8067, -86.7911], ['Alaska', 64.2008, -149.4937],
  ['Arizona', 34.0489, -111.0937], ['Arkansas', 34.9697, -92.3731],
  ['California', 36.7783, -119.4179], ['Colorado', 39.0598, -105.3111],
  ['Connecticut', 41.6032, -73.0877], ['Delaware', 39.0, -75.5],
  ['Florida', 27.6648, -81.5158], ['Georgia', 32.1656, -82.9001],
  ['Hawaii', 19.8968, -155.5828], ['Idaho', 44.0682, -114.742],
  ['Illinois', 40.6331, -89.3985], ['Indiana', 40.5512, -85.6024],
  ['Iowa', 42.0115, -93.2105], ['Kansas', 38.5266, -96.7265],
  ['Kentucky', 37.8393, -84.270], ['Louisiana', 30.9843, -91.9623],
  ['Maine', 45.2538, -69.4455], ['Maryland', 39.0458, -76.6413],
  ['Massachusetts', 42.4072, -71.3824], ['Michigan', 44.3148, -85.6024],
  ['Minnesota', 46.7296, -94.6859], ['Mississippi', 32.3547, -89.3985],
  ['Missouri', 37.9643, -91.8318], ['Montana', 46.8797, -110.3626],
  ['Nebraska', 41.4925, -99.9018], ['Nevada', 38.8026, -116.4194],
  ['New Hampshire', 43.1939, -71.5724], ['New Jersey', 40.0583, -74.4057],
  ['New Mexico', 34.5199, -105.8701], ['New York', 42.9538, -75.5268],
  ['North Carolina', 35.7596, -79.0193], ['North Dakota', 47.5515, -101.002],
  ['Ohio', 40.4173, -82.9071], ['Oklahoma', 35.4676, -97.5164],
  ['Oregon', 43.8041, -120.5542], ['Pennsylvania', 41.2033, -77.1945],
  ['Rhode Island', 41.5801, -71.4774], ['South Carolina', 33.8361, -80.9066],
  ['South Dakota', 43.9695, -99.9018], ['Tennessee', 35.5175, -86.5804],
  ['Texas', 31.9686, -99.9018], ['Utah', 39.321, -111.0937],
  ['Vermont', 44.5588, -72.5778], ['Virginia', 37.4316, -78.6569],
  ['Washington', 47.4009, -121.4905], ['West Virginia', 38.5976, -80.4549],
  ['Wisconsin', 44.2685, -89.6165], ['Wyoming', 43.0759, -107.2903]
].map(([region, latitude, longitude]) => ({ region, latitude, longitude }));

const EARTH_RADIUS_KM = 6371;

export function findNearestCity(latitude, longitude, maxDistanceKm = 45) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  let nearest = null;
  for (const city of CITY_CATALOG) {
    const distanceKm = haversineDistanceKm(latitude, longitude, city.latitude, city.longitude);
    if ((!nearest || distanceKm < nearest.distanceKm) && distanceKm <= maxDistanceKm) {
      nearest = { ...city, distanceKm };
    }
  }
  return nearest;
}

// `isOcean`, when provided, is ground truth read from the actual Earth
// texture pixel at the click (see terrainSampler.js) — not a guess. When
// it's known, land and ocean are never confused with each other, because
// the classification comes from the same image the user is looking at.
// When it's unknown (sampler not ready yet), we fall back to the coarse
// region name only, which can be imprecise at coastlines but is still
// clearly labeled as approximate territory, never a specific city.
export function formatLocationLabel(latitude, longitude, isOcean = null) {
  if (isOcean === false) {
    const nearest = findNearestCity(latitude, longitude);
    if (nearest) return `Near ${nearest.city}, ${nearest.region}`;

    const state = findNearestUsState(latitude, longitude);
    if (state) return `${state.region}, United States`;

    return continentName(latitude, longitude) ?? `Land (${latitude.toFixed(2)}, ${longitude.toFixed(2)})`;
  }

  if (isOcean === true) {
    return oceanName(latitude, longitude);
  }

  // No ground truth yet: still avoid a wrong city name, but be explicit
  // that this is an approximate region, not a confirmed place.
  const nearest = findNearestCity(latitude, longitude);
  if (nearest && nearest.distanceKm <= 12) return `Near ${nearest.city}, ${nearest.region}`;
  return `Approx. region — ${oceanName(latitude, longitude) ?? continentName(latitude, longitude) ?? 'unresolved'}`;
}

function findNearestUsState(latitude, longitude) {
  const insideUsEnvelope = latitude >= 17 && latitude <= 72 && longitude >= -171 && longitude <= -64;
  if (!insideUsEnvelope) return null;

  let nearest = null;
  for (const state of US_STATE_CATALOG) {
    const distanceKm = haversineDistanceKm(latitude, longitude, state.latitude, state.longitude);
    if (!nearest || distanceKm < nearest.distanceKm) nearest = { ...state, distanceKm };
  }
  return nearest?.distanceKm <= 800 ? nearest : null;
}

// Coarse ocean/continent naming used only to pick a label string once land
// vs. water is already known from the real pixel. Overlap between these
// boxes is harmless here — it only affects which of two adjacent ocean/
// continent *names* is shown, never whether land gets called ocean.
function oceanName(latitude, longitude) {
  const oceans = [
    { name: 'North Pacific',  test: (la, lo) => la >= 0 && la <= 65 && (lo <= -100 || lo >= 100) },
    { name: 'South Pacific',  test: (la, lo) => la < 0 && la >= -60 && (lo <= -70 || lo >= 140) },
    { name: 'North Atlantic', test: (la, lo) => la >= 5 && la <= 65 && lo >= -80 && lo <= 0 },
    { name: 'South Atlantic', test: (la, lo) => la < 5 && la >= -60 && lo >= -55 && lo <= 20 },
    { name: 'Indian Ocean',   test: (la, lo) => la >= -60 && la <= 30 && lo >= 20 && lo <= 120 },
    { name: 'Southern Ocean', test: (la) => la < -60 },
    { name: 'Arctic Ocean',   test: (la) => la > 66 }
  ];
  return oceans.find((o) => o.test(latitude, longitude))?.name ?? 'Open ocean';
}

function continentName(latitude, longitude) {
  const continents = [
    { name: 'Continental Europe', test: (la, lo) => la >= 36 && la <= 71 && lo >= -10 && lo <= 40 },
    { name: 'North America',      test: (la, lo) => la >= 15 && la <= 72 && lo >= -170 && lo <= -50 },
    { name: 'South America',      test: (la, lo) => la >= -55 && la <= 12 && lo >= -82 && lo <= -34 },
    { name: 'Africa',             test: (la, lo) => la >= -35 && la <= 37 && lo >= -18 && lo <= 51 },
    { name: 'Asia',               test: (la, lo) => la >= 0 && la <= 75 && lo >= 40 && lo <= 180 },
    { name: 'Australia',          test: (la, lo) => la >= -45 && la <= -10 && lo >= 110 && lo <= 155 },
    { name: 'Antarctica',         test: (la) => la <= -60 },
    { name: 'Arctic land',        test: (la) => la >= 70 }
  ];
  return continents.find((c) => c.test(latitude, longitude))?.name ?? null;
}

export function haversineDistanceKm(latitudeA, longitudeA, latitudeB, longitudeB) {
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(latitudeA)) * Math.cos(toRadians(latitudeB)) * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}
