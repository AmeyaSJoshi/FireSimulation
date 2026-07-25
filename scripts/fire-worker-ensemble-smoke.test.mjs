import { test } from 'node:test';
import assert from 'node:assert/strict';

test('fire worker emits an ensemble payload only when explicitly enabled', async () => {
  const messages = [];
  globalThis.self = {
    postMessage(message) {
      messages.push(message);
    }
  };
  await import('../src/workers/fireWorker.js');

  const baseConfig = {
    runId: 1,
    engine: 'phase1',
    size: 9,
    cellSizeKm: 0.1,
    speed: 1,
    timestepMinutes: 1,
    ignition: { x: 4, y: 4 },
    fuelModelCode: 'TU2',
    params: {
      windSpeed: 0,
      windDirection: 0,
      moisture: 0.05,
      deadMoisture: 0.05,
      liveMoisture: 0.5,
      slopeStrength: 0
    },
    terrainHeights: new Float32Array(81),
    maxPropagationMinutes: 240,
    weatherTimeline: [{
      minutesFromIgnition: 0,
      midflameWindKmh: 0,
      windDirectionRadians: 0,
      deadMoistureFraction: 0.05,
      liveMoistureFraction: 0.5
    }]
  };

  await self.onmessage({ data: { type: 'start', config: baseConfig } });
  assert.equal(messages[0].ensemble, null);
  assert.equal(messages[0].metrics.cellSizeKm, baseConfig.cellSizeKm);
  await self.onmessage({ data: { type: 'stop' } });

  messages.length = 0;
  await self.onmessage({
    data: {
      type: 'start',
      config: {
        ...baseConfig,
        runId: 2,
        ensemble: {
          enabled: true,
          memberCount: 2,
          seed: 17,
          horizonMinutes: 240,
          perturbations: { windFraction: 0.1 }
        }
      }
    }
  });
  assert.equal(messages[0].type, 'frame');
  assert.equal(messages[0].ensemble.memberCount, 2);
  assert.equal(messages[0].ensemble.interpretation.calibratedProbability, false);
  assert.equal(messages[0].ensemble.arrivalTimeQuantiles.median.length, 81);
  await self.onmessage({ data: { type: 'stop' } });
  delete globalThis.self;
});
