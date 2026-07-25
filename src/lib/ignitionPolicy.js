export function canIgniteSurface(isOcean) {
  return isOcean === false;
}

export function canIgniteFuelDecision(decision) {
  return Boolean(decision?.burnable && decision.fuelCode && decision.fuelCode !== 'NB');
}

export function surfaceIgnitionMessage(isOcean) {
  if (isOcean === true) return 'Water surface · no ignition';
  if (isOcean === false) return 'Location armed · ignition ready';
  return 'Surface classification loading · try again';
}
