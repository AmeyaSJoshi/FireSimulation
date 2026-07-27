const DEFAULT_JAC_ENDPOINT = import.meta.env?.VITE_JAC_ENDPOINT
  ?? '/jac/walker/RunFire';

function extractArrivalMinutes(payload, expectedLength) {
  const report = payload?.data?.result?.reports?.[0] ?? payload?.data?.reports?.[0];
  const arrivals = report?.arrivalMinutes;
  if (!Array.isArray(arrivals) || arrivals.length !== expectedLength) {
    throw new Error('Jac returned no complete arrival field');
  }
  return Float32Array.from(arrivals, (value) => Number.isFinite(value) && value >= 0 ? value : Infinity);
}

/**
 * The single production client for Jac RunFire. There is deliberately no
 * browser-side propagation fallback: an unavailable Jac service is surfaced
 * to the caller.
 */
export async function runJacFire(request, {
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_JAC_ENDPOINT,
  signal = undefined
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Jac fire service is unavailable because fetch is not supported');
  }
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal
  });
  if (!response.ok) {
    throw new Error(`Jac fire service returned HTTP ${response.status}`);
  }
  return {
    arrivalMinutes: extractArrivalMinutes(await response.json(), request.grid_size ** 2),
    endpoint
  };
}

export { DEFAULT_JAC_ENDPOINT };
