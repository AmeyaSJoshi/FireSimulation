import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareScenarioMetrics,
  loadScenarioRecords,
  saveScenarioRecord
} from './scenarioRecords.js';

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
}

test('stores newest scenario records first and caps history size', () => {
  const storage = makeStorage();
  for (let index = 0; index < 5; index += 1) {
    saveScenarioRecord(storage, { id: `run-${index}`, metrics: { burnedAreaKm2: index } }, 3);
  }

  assert.deepEqual(loadScenarioRecords(storage).map((record) => record.id), ['run-4', 'run-3', 'run-2']);
});

test('ignores malformed persisted scenario history', () => {
  const storage = makeStorage({ 'ignis-scenario-history-v1': '{not-json' });
  assert.deepEqual(loadScenarioRecords(storage), []);
});

test('calculates interpretable metric deltas between scenario runs', () => {
  assert.deepEqual(
    compareScenarioMetrics(
      { burnedAreaKm2: 100, footprintAreaKm2: 140, perimeterKm: 40, maxSpreadDistanceKm: 12, averageSpreadRateKmh: 6 },
      { burnedAreaKm2: 160, footprintAreaKm2: 180, perimeterKm: 48, maxSpreadDistanceKm: 16, averageSpreadRateKmh: 8 }
    ),
    { burnedAreaKm2: 60, footprintAreaKm2: 40, perimeterKm: 8, maxSpreadDistanceKm: 4, averageSpreadRateKmh: 2 }
  );
});
