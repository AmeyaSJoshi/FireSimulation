import { getFuelModel } from '../lib/fuelModels.js';
import { calculateSurfaceSpread } from '../lib/surfaceSpread.js';
import { compassToMathRadians } from '../lib/weatherInputs.js';

export function createRateField({
  fuelCodes,
  fuelModelDefinitionsByCode = {},
  windSpeedKmh,
  windDirectionDeg,
  moistureFraction
} = {}) {
  if (!Array.isArray(fuelCodes) || fuelCodes.length === 0) {
    throw new TypeError('rateField: fuelCodes must be a non-empty array');
  }
  const values = new Float32Array(fuelCodes.length);
  const direction = compassToMathRadians(windDirectionDeg);
  const cache = new Map();
  for (let index = 0; index < fuelCodes.length; index += 1) {
    const code = fuelCodes[index];
    if (!cache.has(code)) {
      const fuelModel = fuelModelDefinitionsByCode[code] ?? getFuelModel(code);
      const spread = fuelModel.burnable
        ? calculateSurfaceSpread({
          fuelModel,
          moistureFraction,
          deadMoistureFraction: moistureFraction,
          liveMoistureFraction: moistureFraction,
          midflameWindKmh: windSpeedKmh * 0.4,
          windDirectionRadians: direction
        })
        : { headRateMPerMin: 0 };
      cache.set(code, Math.max(0, Number(spread.headRateMPerMin) || 0));
    }
    values[index] = cache.get(code);
  }
  return values;
}

