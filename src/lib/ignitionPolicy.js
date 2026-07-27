// isOcean is null until the legacy 8K-image terrain sampler finishes
// decoding (createTerrainSampler in main.js, ~1s on a fresh load). Blocking
// on isOcean === false exactly meant every click before that resolved — i.e.
// every first click on a fresh page — read as "unavailable" and stayed that
// way, since retrying re-reads the same not-yet-loaded sampler. Water is now
// also caught downstream by the scenario adapter's real WorldCover classification
// (classCode 80), so this only needs to block a *confirmed* ocean click, not
// hold ignition hostage to a secondary sampler that hasn't loaded yet.
export function canIgniteSurface(isOcean) {
  return isOcean !== true;
}

export function canIgniteFuelDecision(decision) {
  return Boolean(decision?.burnable && decision.fuelCode && decision.fuelCode !== 'NB');
}

export function surfaceIgnitionMessage(isOcean) {
  if (isOcean === true) return 'Water surface · no ignition';
  if (isOcean === false) return 'Location armed · ignition ready';
  return 'Surface classification loading · try again';
}
