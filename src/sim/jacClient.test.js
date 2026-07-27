import assert from 'node:assert/strict';
import test from 'node:test';
import { runJacFire } from './jacClient.js';

const request = { grid_size: 2 };

test('runJacFire posts the frozen contract and returns Jac arrivals', async () => {
  let call = null;
  const result = await runJacFire(request, {
    endpoint: '/jac/walker/RunFire',
    fetchImpl: async (url, options) => {
      call = { url, options };
      return {
        ok: true,
        json: async () => ({
          data: { result: { reports: [{ arrivalMinutes: [0, 1, -1, 3] }] } }
        })
      };
    }
  });

  assert.equal(call.url, '/jac/walker/RunFire');
  assert.equal(call.options.method, 'POST');
  assert.deepEqual(JSON.parse(call.options.body), request);
  assert.deepEqual([...result.arrivalMinutes], [0, 1, Infinity, 3]);
});

test('runJacFire surfaces a Jac service failure without a local fallback', async () => {
  await assert.rejects(
    runJacFire(request, {
      fetchImpl: async () => ({ ok: false, status: 503 })
    }),
    /Jac fire service returned HTTP 503/
  );
});
