// Resolve water evidence for ignition and propagation decisions.
// Classified land-cover data is authoritative when available. The rendered
// Earth image is only a conservative fallback for locations without a
// classified sample, so visual styling cannot override model data.

export const WATER_AUTHORITY_VERSION = '1.2.0';
export const PERMANENT_WATER_CLASS_CODE = 80;

export function resolveWaterEvidence({
  fractionalWater = null,
  fineClassCode = null,
  coarseClassCode = null,
  visualWater = false,
  edgeVisualVeto = false
} = {}) {
  if (fractionalWater === true) {
    return { isWater: true, source: 'Copernicus fractional water cover' };
  }
  if (fineClassCode === PERMANENT_WATER_CLASS_CODE) {
    return { isWater: true, source: 'ESA WorldCover 10 m' };
  }
  if (coarseClassCode === PERMANENT_WATER_CLASS_CODE) {
    return { isWater: true, source: 'ESA WorldCover global mosaic' };
  }

  // A propagation edge is a physical transition, not an ignition click. If
  // the rendered surface says that the edge is water, conservatively block it
  // unless a fractional land observation explicitly contradicts the texture.
  // This closes narrow shoreline gaps when a fine sample's cell majority is
  // land, while preserving normal classified-land precedence for clicks.
  if (edgeVisualVeto && visualWater === true && fractionalWater !== false) {
    return {
      isWater: true,
      source: 'rendered Earth texture conservative edge veto'
    };
  }

  // A coarse land pixel can straddle a visible shoreline. Let the texture
  // veto that approximation only when no finer classified evidence exists.
  if (visualWater === true
    && fractionalWater === null
    && fineClassCode === null
    && coarseClassCode !== null) {
    return {
      isWater: true,
      source: 'rendered Earth texture conservative coastal veto'
    };
  }

  const hasClassifiedEvidence = fractionalWater !== null
    || fineClassCode !== null
    || coarseClassCode !== null;
  if (hasClassifiedEvidence) {
    return { isWater: false, source: 'classified land-cover sample' };
  }
  if (visualWater === true) {
    return { isWater: true, source: 'rendered Earth texture fallback' };
  }
  return { isWater: false, source: 'no water evidence' };
}
