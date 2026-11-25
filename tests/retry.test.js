// Submitting while the server is busy: the client tries again on 503 / 429 only, with growing waits, and gives up in
// under a minute; the server queues a whole class instead of refusing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendWithRetry, RETRY_DELAYS_S } from '../src/web/retry.js';
import { LIMITS } from '../src/server/server.js';

const res = (status, retryAfter) => ({ status, ok: status < 400, headers: { get: (k) => (k === 'retry-after' && retryAfter != null ? String(retryAfter) : null) } });
const script = (...statuses) => { let i = 0; const sent = []; return { sent, send: async () => { sent.push(i); return statuses[Math.min(i++, statuses.length - 1)]; } }; };

test('a busy server (503, 429) is tried again until it answers; the waits grow and stay under a minute', async () => {
  const s = script(res(503), res(429), res(503), res(200)), waits = [];
  const r = await sendWithRetry(s.send, { sleep: async (ms) => { waits.push(ms); }, rand: () => 0.5 });
  assert.equal(r.status, 200); assert.equal(s.sent.length, 4);
  assert.deepEqual(waits, [2000, 4000, 8000]);                                        // 2, 4, 8 s (no spread at rand 0.5)
  assert.ok(RETRY_DELAYS_S.reduce((a, b) => a + b, 0) * 1.25 < 60, 'worst case under a minute');
});

test('other answers are final at once: success, a refused log, an already submitted session, a server error', async () => {
  for (const st of [200, 400, 409, 422, 500]) {
    const s = script(res(st)); const r = await sendWithRetry(s.send, { sleep: async () => { throw new Error('must not wait'); } });
    assert.equal(r.status, st); assert.equal(s.sent.length, 1, `status ${st}`);
  }
});

test('it gives up after the last wait and returns the busy answer; a longer Retry-After is honoured', async () => {
  const s = script(res(503, 30)), waits = [];
  const r = await sendWithRetry(s.send, { sleep: async (ms) => { waits.push(ms); }, rand: () => 0 });
  assert.equal(r.status, 503); assert.equal(s.sent.length, RETRY_DELAYS_S.length + 1);
  assert.ok(waits.every(w => w === 30000), 'the server asked for 30 s each time');
});

test('the server queue holds a whole class finishing at once (2 replaying + the queue)', () => {
  assert.ok(LIMITS.replayConcurrency + LIMITS.replayQueue >= 60, `${LIMITS.replayConcurrency + LIMITS.replayQueue} at once`);
});
