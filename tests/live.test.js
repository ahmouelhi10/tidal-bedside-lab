// Live instructor channel: relay of learner state and instructor changes, and replay of a session that received changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server/server.js';
import { validateCommand, validCode, newCode } from '../src/server/live.js';
import { Patient, replay, INJECTS } from '../src/engine/patient.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { mk } from './helpers/bots.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tbl-live-'));
async function withServer(fn) {
  const s = createServer({ port: 0, host: '127.0.0.1', dataDir: tmp(), quiet: true });
  const addr = await s.listen(); const base = `http://127.0.0.1:${addr.port}`;
  try { return await fn(base); } finally { await s.close(); }
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Reads Server-Sent Events from a fetch response; next(name) resolves with the data of the next event of that name. */
function sseReader(res) {
  const reader = res.body.getReader(), dec = new TextDecoder(), queue = [], waiting = [];
  let buf = '';
  (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true })); if (done) return;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
        if (!ev) continue;
        const item = { ev, data: JSON.parse(data) }, w = waiting.findIndex(x => x.ev === ev);
        if (w >= 0) waiting.splice(w, 1)[0].resolve(item.data); else queue.push(item);
      }
    }
  })();
  return {
    next: (ev) => { const q = queue.findIndex(x => x.ev === ev); if (q >= 0) return Promise.resolve(queue.splice(q, 1)[0].data); return new Promise((resolve, reject) => { waiting.push({ ev, resolve }); setTimeout(() => reject(new Error('timeout waiting for ' + ev)), 15000); }); },
    close: () => reader.cancel().catch(() => {}),
  };
}

test('join codes and command validation', () => {
  for (let i = 0; i < 50; i++) assert.ok(validCode(newCode()));
  assert.equal(validCode('ABC1O0'), false, 'ambiguous characters are never used');
  assert.deepEqual(validateCommand({ what: 'bleed', mlPerMin: 300.4 }), { ok: true, cmd: { what: 'bleed', mlPerMin: 300 } });
  assert.equal(validateCommand({ what: 'bleed', mlPerMin: 5000 }).ok, false);
  assert.equal(validateCommand({ what: 'teleport' }).ok, false);
  assert.equal(validateCommand({ what: 'marker', text: '' }).ok, false);
  assert.deepEqual(validateCommand({ what: 'marker', text: ' missed pulse check ' }).cmd, { what: 'marker', text: 'missed pulse check' });
});

test('learner state reaches the instructor and the instructor change reaches the learner', async () => {
  await withServer(async (base) => {
    const sess = await (await post(base + '/api/sessions', { scenario: null })).json();
    const open = await (await post(`${base}/api/live/${sess.id}/open`, {})).json();
    assert.ok(validCode(open.code));
    const learner = sseReader(await fetch(`${base}/api/live/${sess.id}/stream`));
    assert.deepEqual(await learner.next('watchers'), { watchers: 0 });
    const instr = sseReader(await fetch(`${base}/api/live/join/${open.code}`));
    const hello = await instr.next('hello');
    assert.equal(hello.learnerOnline, true); assert.equal(hello.spec.weightKg, sess.spec.weightKg);
    assert.deepEqual(await learner.next('watchers'), { watchers: 1 });
    assert.equal((await post(`${base}/api/live/${sess.id}/state`, { t: 12, hr: 88 })).status, 204);
    // straight after (well inside LIVE_LIMITS.minStateMs): checked here, not after the other requests below, which on a
    // busy CI runner can take longer than the window and then rightly let a second push through
    assert.equal((await post(`${base}/api/live/${sess.id}/state`, { t: 13 })).status, 429, 'state pushes are rate limited per channel');
    assert.deepEqual(await instr.next('state'), { t: 12, hr: 88 });
    const r = await (await post(`${base}/api/live/join/${open.code}/cmd`, { what: 'bleed', mlPerMin: 250 })).json();
    assert.deepEqual(r, { ok: true, seq: 1, delivered: true });
    assert.deepEqual(await learner.next('cmd'), { seq: 1, what: 'bleed', mlPerMin: 250 });
    assert.equal((await post(`${base}/api/live/join/${open.code}/cmd`, { what: 'nope' })).status, 400);
    assert.equal((await fetch(`${base}/api/live/join/ZZZZZZ`)).status, 404);
    learner.close(); instr.close();
  });
});

test('a delivered instructor change is kept on the session: the honest log verifies, a log without it does not', async () => {
  await withServer(async (base) => {
    const run = async (keep) => {
      const sess = await (await post(base + '/api/sessions', { scenario: null })).json();
      const open = await (await post(`${base}/api/live/${sess.id}/open`, {})).json();
      const learner = sseReader(await fetch(`${base}/api/live/${sess.id}/stream`)); await learner.next('watchers');
      assert.equal((await post(`${base}/api/live/join/${open.code}/cmd`, { what: 'bleed', mlPerMin: 300 })).status, 200);
      const { seq, ...cmd } = await learner.next('cmd');
      const p = new Patient(sess.spec, { seed: sess.seed }); p.run(20);
      if (keep) p.dispatch({ type: 'instructor.inject', ...cmd }); p.run(20);
      const r = await (await post(`${base}/api/sessions/${sess.id}/submit`, { log: p.log, until: +p.t.toFixed(3), hash: p.stateHash() })).json();
      assert.equal((await post(`${base}/api/live/join/${open.code}/cmd`, { what: 'vf' })).status, 404, 'no changes once the case is submitted: its channel is closed');
      learner.close(); return r.result;
    };
    const honest = await run(true); assert.equal(honest.verified, true, JSON.stringify(honest));
    const dropped = await run(false); assert.equal(dropped.verified, false); assert.ok(dropped.instructorMismatch);
  });
});

test('a session with instructor changes replays to the same hash, and the changes act on the physiology', () => {
  const p = mk({}, { seed: 11 });
  p.run(30); p.dispatch({ type: 'instructor.inject', what: 'bleed', mlPerMin: 400 });
  p.run(300); p.dispatch({ type: 'instructor.inject', what: 'marker', text: 'did not reassess after bleeding started' });
  p.run(30); p.dispatch({ type: 'instructor.inject', what: 'vf' });
  p.run(20);
  assert.equal(p.arrest.key, 'VF'); assert.ok(p.vol.fractionLost > 0.05, 'bleeding happened');
  assert.ok(p.notes.some(n => n.text === 'instructor: did not reassess after bleeding started'));
  const q = replay({ spec: p.spec, seed: 11, scenario: null, log: p.log.map(e => ({ ...e })), until: p.t }, SCENARIOS);
  assert.equal(q.stateHash(), p.stateHash());
  assert.equal(mk().dispatch({ type: 'instructor.inject', what: 'bleed', mlPerMin: 9999 }).ok, false);
  assert.equal(mk().dispatch({ type: 'instructor.inject', what: 'unknown' }).ok, false);
  assert.ok(INJECTS.includes('tension_ptx'));
  const t = mk(); t.dispatch({ type: 'instructor.inject', what: 'tension_ptx', side: 'L' }); t.run(600);
  assert.equal(t.chest.side, 'L'); assert.ok(t.chest.tension > 0.1, 'tension develops');
  const h = mk(); h.dispatch({ type: 'instructor.inject', what: 'hyperkalaemia' }); h.run(5); assert.ok(h.lytes.k >= 6.5);
  assert.ok(new Patient({}).stateHash() !== h.stateHash());
});
