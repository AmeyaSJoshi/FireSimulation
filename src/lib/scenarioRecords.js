export const SCENARIO_HISTORY_KEY = 'ignis-scenario-history-v1';
export const DEFAULT_HISTORY_LIMIT = 4;

function usableStorage(storage) {
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function';
}

export function loadScenarioRecords(storage = globalThis.localStorage) {
  if (!usableStorage(storage)) return [];
  try {
    const parsed = JSON.parse(storage.getItem(SCENARIO_HISTORY_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((record) => record && typeof record === 'object' && typeof record.id === 'string')
      : [];
  } catch {
    return [];
  }
}

export function saveScenarioRecord(storage = globalThis.localStorage, record, limit = DEFAULT_HISTORY_LIMIT) {
  if (!usableStorage(storage) || !record || typeof record.id !== 'string') return [];
  const history = loadScenarioRecords(storage)
    .filter((existing) => existing.id !== record.id)
    .slice(0, Math.max(1, Math.floor(limit) || DEFAULT_HISTORY_LIMIT));
  const next = [record, ...history].slice(0, Math.max(1, Math.floor(limit) || DEFAULT_HISTORY_LIMIT));
  try {
    storage.setItem(SCENARIO_HISTORY_KEY, JSON.stringify(next));
  } catch {
    return history;
  }
  return next;
}

export function clearScenarioRecords(storage = globalThis.localStorage) {
  if (storage && typeof storage.removeItem === 'function') {
    try {
      storage.removeItem(SCENARIO_HISTORY_KEY);
    } catch {
      // Storage can be unavailable in private browsing; memory state still works.
    }
  }
}

export function compareScenarioMetrics(base = {}, candidate = {}) {
  const fields = [
    'burnedAreaKm2',
    'footprintAreaKm2',
    'perimeterKm',
    'maxSpreadDistanceKm',
    'averageSpreadRateKmh'
  ];
  return Object.fromEntries(fields.map((field) => [
    field,
    Number(candidate[field] ?? 0) - Number(base[field] ?? 0)
  ]));
}
