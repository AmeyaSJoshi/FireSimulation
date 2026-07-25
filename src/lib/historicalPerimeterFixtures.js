// Compact public historical-perimeter fixtures.
//
// Reservoir Fire (2016) is the OBJECTID 105 record from the public California
// fire-perimeter feature service. The source metadata reports GPS ground
// collection (C_METHOD 1) and 152.6466 GIS acres. The coordinates are WGS-84
// GeoJSON and intentionally remain data-only; the validation harness decides
// how to rasterize and score them.
// Source: https://services.arcgis.com/V6ZHFr6zdgNZuVG0/ArcGIS/rest/services/
// California_fires_since_2014/FeatureServer/2

export const RESERVOIR_FIRE_2016 = Object.freeze({
  id: 'california-fires-2016-105',
  name: 'Reservoir',
  year: 2016,
  sourceObjectId: 105,
  sourceUrl: 'https://services.arcgis.com/V6ZHFr6zdgNZuVG0/ArcGIS/rest/services/California_fires_since_2014/FeatureServer/2',
  collectionMethod: 'GPS ground',
  reportedAcres: 152.6466,
  alarmDate: '2016-06-26T00:00:00.000Z',
  containmentDate: '2016-06-30T00:00:00.000Z',
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [-122.57781, 39.15644], [-122.57641, 39.15672],
      [-122.57546, 39.15677], [-122.57502, 39.15672],
      [-122.57450, 39.15679], [-122.57398, 39.15663],
      [-122.57375, 39.15635], [-122.57392, 39.15577],
      [-122.57430, 39.15519], [-122.57480, 39.15469],
      [-122.57479, 39.15449], [-122.57452, 39.15402],
      [-122.57347, 39.15361], [-122.57300, 39.15388],
      [-122.57231, 39.15400], [-122.57084, 39.15398],
      [-122.56966, 39.15389], [-122.56875, 39.15383],
      [-122.56781, 39.15367], [-122.56737, 39.15359],
      [-122.56617, 39.15316], [-122.56508, 39.15340],
      [-122.56409, 39.15256], [-122.56318, 39.15219],
      [-122.56244, 39.15170], [-122.56218, 39.15092],
      [-122.56229, 39.15039], [-122.56259, 39.14941],
      [-122.56324, 39.14917], [-122.56381, 39.14872],
      [-122.56477, 39.14873], [-122.56545, 39.14912],
      [-122.56578, 39.14931], [-122.56662, 39.15007],
      [-122.56682, 39.15055], [-122.56764, 39.15079],
      [-122.56856, 39.15103], [-122.56915, 39.15104],
      [-122.56978, 39.15103], [-122.57103, 39.15097],
      [-122.57183, 39.15081], [-122.57263, 39.15054],
      [-122.57361, 39.15029], [-122.57387, 39.15028],
      [-122.57538, 39.15014], [-122.57686, 39.15048],
      [-122.57743, 39.15104], [-122.57801, 39.15200],
      [-122.57808, 39.15277], [-122.57840, 39.15348],
      [-122.57897, 39.15401], [-122.57936, 39.15472],
      [-122.57845, 39.15596], [-122.57781, 39.15644]
    ]]
  }
});

// Deer Fire (2016) is an independent GPS-ground perimeter from the same
// public California service. It is intentionally kept separate from the
// Reservoir fixture so the validation command can report a second geometry
// without fitting the model to this record. The service does not publish a
// verified ignition point for this row; the validator uses the documented
// local-window center as an explicit diagnostic assumption.
export const DEER_FIRE_2016 = Object.freeze({
  id: 'california-fires-2016-60',
  name: 'Deer',
  year: 2016,
  sourceObjectId: 60,
  sourceUrl: 'https://services.arcgis.com/V6ZHFr6zdgNZuVG0/ArcGIS/rest/services/California_fires_since_2014/FeatureServer/2',
  collectionMethod: 'GPS ground',
  reportedAcres: 1563.429,
  alarmDate: '2016-07-01T00:00:00.000Z',
  containmentDate: '2016-07-04T00:00:00.000Z',
  ignition: {
    latitude: 35.222803,
    longitude: -118.688234
  },
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [-118.669362, 35.229477], [-118.667731, 35.227148],
      [-118.668153, 35.224136], [-118.664616, 35.223166],
      [-118.663584, 35.220623], [-118.667046, 35.220269],
      [-118.666423, 35.218664], [-118.667804, 35.218806],
      [-118.668235, 35.217065], [-118.675932, 35.223667],
      [-118.680280, 35.223724], [-118.678508, 35.219896],
      [-118.672409, 35.217042], [-118.669670, 35.213929],
      [-118.675323, 35.214823], [-118.679817, 35.211275],
      [-118.687914, 35.211685], [-118.700544, 35.217222],
      [-118.712883, 35.220449], [-118.704631, 35.226193],
      [-118.699755, 35.227047], [-118.696207, 35.232847],
      [-118.693248, 35.230331], [-118.690088, 35.230127],
      [-118.682484, 35.233707], [-118.674389, 35.234331],
      [-118.673231, 35.233664], [-118.676063, 35.231312],
      [-118.671265, 35.231647], [-118.668855, 35.230759],
      [-118.669362, 35.229477]
    ]]
  }
});
