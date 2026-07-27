import { solveFireRequest } from './localFireEngine.js';

/**
 * The single production client for RunFire.
 *
 * This used to POST to a Jac walker at /jac/walker/RunFire and had, by
 * design, no fallback — so the app produced no fire at all unless a separate
 * Jac service happened to be running on port 8010. That service was not in
 * the repo and had no start instructions, which is exactly how it failed.
 *
 * The solve now runs in-process against the identical request contract
 * (createJacFireRequest) using the project's own validated Rothermel and
 * elliptical-spread modules. Same inputs, same output shape, no service to
 * start. Name and signature are kept so callers and tests are unchanged.
 */
export async function runJacFire(request, { signal = undefined } = {}) {
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
const DEFAULT_JAC_ENDPOINT = 'local:javascript';
export { DEFAULT_JAC_ENDPOINT };
