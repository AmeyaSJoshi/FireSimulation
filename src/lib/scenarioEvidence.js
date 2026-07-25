// Evidence profile for the user-facing run metadata. This is deliberately
// separate from fire behavior: it describes input readiness, never accuracy.

export const CONUS_SHOWCASE_BOUNDS = Object.freeze({
  west: -124.848974,
  south: 24.396308,
  east: -66.885444,
  north: 49.384358
});

export const SCENARIO_EVIDENCE_VERSION = '1.0.0';

export function isWithinConusShowcaseBounds(coordinates) {
  if (!coordinates || !Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude)) {
    return false;
  }
  return coordinates.longitude >= CONUS_SHOWCASE_BOUNDS.west
    && coordinates.longitude <= CONUS_SHOWCASE_BOUNDS.east
    && coordinates.latitude >= CONUS_SHOWCASE_BOUNDS.south
    && coordinates.latitude <= CONUS_SHOWCASE_BOUNDS.north;
}

export function classifyScenarioEvidence({
  coordinates,
  terrainAvailable = false,
  fineLandCoverCoverage = 0,
  fractionalCoverAvailable = false,
  landfireCanopyAvailable = false,
  landfireFuelAvailable = false,
  weatherAvailable = false,
  fuelSummary = null
} = {}) {
  const conus = isWithinConusShowcaseBounds(coordinates);
  const totalFuelCells = Number(fuelSummary?.totalCellCount) || 0;
  const unknownFuelCells = Number(fuelSummary?.unknownOrUnclassifiedCellCount) || 0;
  const fuelCoverage = totalFuelCells > 0
    ? Math.max(0, Math.min(1, (totalFuelCells - unknownFuelCells) / totalFuelCells))
    : 0;
  const fineCoverage = Number.isFinite(fineLandCoverCoverage)
    ? Math.max(0, Math.min(1, fineLandCoverCoverage))
    : 0;
  const inputs = [
    { id: 'fuel', label: 'mapped fuel field', ready: fuelCoverage >= 0.8 },
    { id: 'fine-cover', label: 'fine land cover', ready: fineCoverage >= 0.75 },
    { id: 'weather', label: 'location weather', ready: weatherAvailable === true },
    { id: 'terrain', label: 'elevation field', ready: terrainAvailable === true },
    { id: 'canopy', label: 'regional canopy structure', ready: landfireCanopyAvailable === true },
    { id: 'regional-fuel', label: 'LANDFIRE FBFM40 fuel', ready: landfireFuelAvailable === true },
    { id: 'fractions', label: 'fractional vegetation/water', ready: fractionalCoverAvailable === true }
  ];
  const readyCount = inputs.filter((input) => input.ready).length;
  const total = inputs.length;
  const tier = !conus
    ? 'exploratory'
    : (readyCount >= 6 && landfireFuelAvailable === true && fuelCoverage >= 0.95 ? 'showcase' : 'regional');
  const label = tier === 'showcase'
    ? 'CONUS showcase inputs'
    : tier === 'regional'
      ? 'CONUS regional inputs'
      : 'Global exploratory inputs';
  return {
    version: SCENARIO_EVIDENCE_VERSION,
    profileId: conus ? 'conus-showcase' : 'global-exploratory',
    tier,
    label,
    readyCount,
    total,
    fuelCoverage,
    fineCoverage,
    inputs,
    caveat: conus
      ? 'Regional input readiness; benchmark evidence is diagnostic, not an operational forecast.'
      : 'Outside the CONUS showcase region, mapped inputs are exploratory and may have weaker regional calibration.'
  };
}

export function formatScenarioEvidence(profile) {
  if (!profile) return 'Awaiting location';
  return `${profile.label} · ${profile.readyCount}/${profile.total} inputs`;
}
