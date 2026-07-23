export function canIgniteSurface(isOcean) {
  return isOcean === false;
}

export function surfaceIgnitionMessage(isOcean) {
  if (isOcean === true) return 'Water surface · no ignition';
  if (isOcean === false) return 'Location armed · ignition ready';
  return 'Surface classification loading · try again';
}
