import { compassToMathRadians, windToMidflame } from './weatherInputs.js';

// Resolve the mutable controls that can change after a phase1 run starts.
// Weather values remain the baseline when the user leaves the wind control at
// calm; a non-zero slider is an explicit scenario override.
export function resolvePhase1RuntimeInputs(config = {}) {
  const params = config.params ?? {};
  const manualWind = Number.isFinite(params.windSpeed) && params.windSpeed > 0;
  const slopeStrength = Number.isFinite(params.slopeStrength)
    ? Math.max(0, params.slopeStrength)
    : null;
  const usesSlopePreset = params.scenario === 'slope' || config.scenario === 'slope';

  const legacyMoisture = Number.isFinite(params.moisture)
    ? params.moisture
    : (config.moistureFraction ?? 0.08);
  const deadMoistureFraction = Number.isFinite(params.deadMoisture)
    ? params.deadMoisture
    : (config.deadMoistureFraction ?? legacyMoisture);
  const liveMoistureFraction = Number.isFinite(params.liveMoisture)
    ? params.liveMoisture
    : (config.liveMoistureFraction ?? legacyMoisture);

  return {
    manualWind,
    moistureFraction: deadMoistureFraction,
    deadMoistureFraction,
    liveMoistureFraction,
    tenMeterWindKmh: manualWind ? params.windSpeed : null,
    midflameWindKmh: manualWind
      ? windToMidflame({
        tenMeterWindKmh: params.windSpeed,
        canopySheltered: config.canopySheltered ?? false,
        fuelBedDepthMeters: config.fuelBedDepthMeters ?? null
      }).speedKmh
      : (config.midflameWindKmh ?? 0),
    windDirectionRadians: manualWind
      ? compassToMathRadians(params.windDirection ?? 0)
      : (config.windDirectionRadians ?? compassToMathRadians(params.windDirection ?? 0)),
    defaultSlopeRadians: slopeStrength === null
      ? (config.defaultSlopeRadians ?? 0)
      : Math.atan(slopeStrength),
    defaultSlopeAspectEast: config.defaultSlopeAspectEast ?? 0,
    defaultSlopeAspectNorth: usesSlopePreset ? 1 : (config.defaultSlopeAspectNorth ?? 0)
  };
}
