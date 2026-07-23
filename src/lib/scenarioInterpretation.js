const COMPASS_POINTS = [
  'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'
];

const DIRECTION_WORDS = {
  N: 'north',
  NE: 'northeast',
  E: 'east',
  SE: 'southeast',
  S: 'south',
  SW: 'southwest',
  W: 'west',
  NW: 'northwest'
};

export function formatModelTime(minutes) {
  const safeMinutes = Math.max(0, Math.round(Number(minutes) || 0));
  if (safeMinutes < 60) return `${safeMinutes} min`;
  const hours = Math.floor(safeMinutes / 60);
  const remainder = String(safeMinutes % 60).padStart(2, '0');
  return `${hours} h ${remainder} min`;
}

export function formatCompassDirection(degrees) {
  const normalized = ((Number(degrees) || 0) % 360 + 360) % 360;
  const index = Math.round(normalized / 45) % COMPASS_POINTS.length;
  return COMPASS_POINTS[index];
}

export function formatElevationRange(heights) {
  if (!heights?.length) return 'Unavailable';
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const height of heights) {
    minimum = Math.min(minimum, height);
    maximum = Math.max(maximum, height);
  }
  return `${Math.round(minimum)}–${Math.round(maximum)} m`;
}

export function buildSpreadExplanation({
  direction = 'N',
  windSpeed = 0,
  slopeStrength = 0,
  moisture = 0
} = {}) {
  const compassDirection = DIRECTION_WORDS[direction] ? direction : 'N';
  const directionWord = DIRECTION_WORDS[compassDirection];
  if (Number(windSpeed) >= 20) return `Wind is driving spread toward the ${directionWord}.`;
  if (Number(slopeStrength) >= 0.55) return `Slope is favoring uphill spread toward the ${directionWord}.`;
  if (Number(moisture) >= 0.7) return `High moisture is suppressing spread toward the ${directionWord}.`;
  return `Spread is mostly radial toward the ${directionWord}.`;
}
