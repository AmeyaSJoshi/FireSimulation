import { solveFireRequest } from './localFireEngine.js';

/**
 * The single production client for RunFire.
 *
 * Earlier revisions POSTed to an external service and had, by design, no
 * fallback, so the app produced no fire at all unless that service happened
 * to be running. It was not in the repo and had no start instructions, which
 * is exactly how it failed. The solve is now in-process and always available.
 *
 * The solve now runs in-process against the identical request contract
 * (createFireRequest) using the project's own validated Rothermel and
 * elliptical-spread modules. Same inputs, same output shape, no service to
 * start. Name and signature are kept so callers and tests are unchanged.
 */
export async function runFire(request, { signal = undefined } = {}) {
  if (signal?.aborted) throw new Error('Fire solve aborted');
  const expectedLength = request.grid_size ** 2;
  const { arrivalMinutes } = solveFireRequest(request);
  if (arrivalMinutes.length !== expectedLength) {
    throw new Error('Local fire engine returned an incomplete arrival field');
  }
  return {
    arrivalMinutes: Float32Array.from(
      arrivalMinutes,
      (value) => (Number.isFinite(value) && value >= 0 ? value : Infinity)
    ),
    endpoint: 'local:javascript'
  };
}

// Retained so existing imports keep resolving; there is no remote endpoint.
const FIRE_ENGINE_ID = 'local:javascript';
export { FIRE_ENGINE_ID };
