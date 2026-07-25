// Request and response helpers for the optional Copernicus Global Dynamic
// Land Cover 100 m adapter. Credentials stay server-side; this module is
// deliberately pure so the request contract can be tested without network.

export const COPERNICUS_LAND_COVER_SOURCE =
  'Copernicus Global Dynamic Land Cover v3 · 100 m · 2015–2019';
export const COPERNICUS_LAND_COVER_COLLECTION_ID =
  '35fecfec-8a73-4723-bb08-b775f283a535';
export const COPERNICUS_TOKEN_URL =
  'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
export const COPERNICUS_PROCESS_URL =
  'https://sh.dataspace.copernicus.eu/api/v1/process';
export const COPERNICUS_RESOLUTION_METERS = 100;

export const COPERNICUS_OUTPUT_BANDS = Object.freeze([
  'Tree_Cover_Fraction',
  'Shrub_Cover_Fraction',
  'Grass_Cover_Fraction',
  'Crops_Cover_Fraction',
  'Bare_Cover_Fraction',
  'MossLichen_Cover_Fraction',
  'PermanentWater_Cover_Fraction',
  'SeasonalWater_Cover_fraction',
  'Discrete_Classification_Probability',
  'Discrete_Classification'
]);

export const COPERNICUS_EVALSCRIPT = [
  '//VERSION=3',
  'function setup() {',
  '  return {',
  '    input: [{ bands: [' + COPERNICUS_OUTPUT_BANDS.map((band) => JSON.stringify(band)).join(', ') + '] }],',
  '    output: { bands: ' + COPERNICUS_OUTPUT_BANDS.length + ', sampleType: \"UINT8\" }',
  '  };',
  '}',
  'function evaluatePixel(sample) {',
  '  return [' + COPERNICUS_OUTPUT_BANDS.map((band) => 'sample.' + band).join(', ') + '];',
  '}'
].join('\\n');

export function createCopernicusLandCoverRequest({
  bbox,
  width = 1,
  height = 1,
  processUrl = COPERNICUS_PROCESS_URL
} = {}) {
  const normalizedBbox = normalizeBbox(bbox);
  if (!Number.isInteger(width) || width < 1 || width > 256) {
    throw new RangeError('copernicusLandCover: width must be an integer in [1, 256]');
  }
  if (!Number.isInteger(height) || height < 1 || height > 256) {
    throw new RangeError('copernicusLandCover: height must be an integer in [1, 256]');
  }
  return {
    url: processUrl,
    body: {
      input: {
        bounds: {
          bbox: normalizedBbox,
          properties: {
            crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84'
          }
        },
        data: [{
          type: 'byoc-' + COPERNICUS_LAND_COVER_COLLECTION_ID,
          dataFilter: {
            timeRange: {
              from: '2019-01-01T00:00:00Z',
              to: '2019-12-31T23:59:59Z'
            }
          }
        }]
      },
      output: {
        width,
        height,
        responses: [{
          identifier: 'default',
          format: { type: 'application/json' }
        }]
      },
      evalscript: COPERNICUS_EVALSCRIPT
    }
  };
}

export function createPointBbox(latitude, longitude, radiusDegrees = 0.0005) {
  validateCoordinate(latitude, 'latitude', -90, 90);
  validateCoordinate(longitude, 'longitude', -180, 180);
  if (!Number.isFinite(radiusDegrees) || radiusDegrees <= 0 || radiusDegrees > 1) {
    throw new RangeError('copernicusLandCover: radiusDegrees must be in (0, 1]');
  }
  return [
    Math.max(-180, longitude - radiusDegrees),
    Math.max(-90, latitude - radiusDegrees),
    Math.min(180, longitude + radiusDegrees),
    Math.min(90, latitude + radiusDegrees)
  ];
}

export function parseCopernicusLandCoverResponse(payload, {
  width = 1,
  height = 1
} = {}) {
  const samples = extractSamples(payload);
  const expected = width * height;
  if (!samples || samples.length < expected) {
    throw new RangeError('copernicusLandCover: response has no complete sample raster');
  }
  return samples.slice(0, expected).map(parseSampleBands);
}

function parseSampleBands(sample) {
  const bands = Array.isArray(sample)
    ? sample
    : (Array.isArray(sample?.bands) ? sample.bands : null);
  if (!bands || bands.length < COPERNICUS_OUTPUT_BANDS.length) {
    throw new RangeError('copernicusLandCover: sample has incomplete bands');
  }
  const values = bands.map((value) => Number(value));
  const fractions = {
    treeCoverFraction: normalizeFraction(values[0]),
    shrubCoverFraction: normalizeFraction(values[1]),
    grassCoverFraction: normalizeFraction(values[2]),
    cropsCoverFraction: normalizeFraction(values[3]),
    bareCoverFraction: normalizeFraction(values[4]),
    mossLichenCoverFraction: normalizeFraction(values[5]),
    permanentWaterCoverFraction: normalizeFraction(values[6]),
    seasonalWaterCoverFraction: normalizeFraction(values[7])
  };
  const probability = normalizeFraction(values[8]);
  const discreteClassification = Number.isInteger(values[9]) && values[9] <= 200
    ? values[9]
    : null;
  return {
    coverFractions: fractions,
    discreteClassification,
    discreteClassificationProbability: probability,
    source: COPERNICUS_LAND_COVER_SOURCE,
    resolutionMeters: COPERNICUS_RESOLUTION_METERS,
    sourceConfidence: probability === null
      ? 'low'
      : (probability >= 80 ? 'high' : probability >= 50 ? 'medium' : 'low')
  };
}

function extractSamples(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.bands)) return [payload.bands];
  if (Array.isArray(payload?.data)) {
    if (payload.data.length === COPERNICUS_OUTPUT_BANDS.length
      && payload.data.every((item) => Number.isFinite(Number(item)))) {
      return [payload.data];
    }
    if (payload.data.every((item) => Array.isArray(item) || Array.isArray(item?.bands))) {
      return payload.data;
    }
    if (payload.data.length === 1 && Array.isArray(payload.data[0]?.data)) {
      return payload.data[0].data;
    }
  }
  return null;
}

function normalizeFraction(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function normalizeBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((value) => !Number.isFinite(Number(value)))) {
    throw new TypeError('copernicusLandCover: bbox must be [west, south, east, north]');
  }
  const normalized = bbox.map(Number);
  if (normalized[0] < -180 || normalized[2] > 180
    || normalized[1] < -90 || normalized[3] > 90
    || normalized[0] >= normalized[2] || normalized[1] >= normalized[3]) {
    throw new RangeError('copernicusLandCover: bbox must be an increasing WGS-84 extent');
  }
  return normalized;
}

function validateCoordinate(value, name, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError('copernicusLandCover: ' + name + ' must be in [' + min + ', ' + max + ']');
  }
}
