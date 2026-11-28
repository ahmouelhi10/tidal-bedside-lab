// Server hardening (security audit leads, November 2026): a failed static read, CSV formulas, live-channel limits and
// the rate-limit key behind a proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from '../src/server/server.js';
import { csvCell } from '../src/server/research.js';
import { LIVE_LIMITS } from '../src/server/live.js';
import { Patient } from '../src/engine/patient.js';

const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function withServer(opts, fn) {
  const s = createServer({ port: 0, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tbl-hard-')), quiet: true, ...opts });
  const base = `http://127.0.0.1:${(await s.listen()).port}`;
  try { return await fn(base); } finally { await s.close(); }
}

test('a static file read that fails after the stat ends that response only; the server keeps serving', async () => {
  await withServer({}, async (base) => {
    const orig = fs.createReadStream;
    fs.createReadStream = () => new Readable({ read() { this.destroy(Object.assign(new Error('too many open files'), { code: 'EMFILE' })); } });
    try { await fetch(base + '/index.html').then(r => r.text()).catch(() => null); } finally { fs.createReadStream = orig; }
    const h = await fetch(base + '/api/health');
    assert.equal(h.status, 200, 'still up');
    assert.equal((await fetch(base + '/index.html')).status, 200);
  });
});

test('research CSV: text that a spreadsheet would run as a formula opens as plain text', () => {
  for (const s of ['=1+1', '+cmd', '-2+3', '@SUM(A1)', '\tx', '\rx']) assert.ok(csvCell(s).replace(/^"/, '').startsWith("'"), JSON.stringify(s));
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('a\rb'), '"a\rb"', 'a carriage return is quoted');
  assert.equal(csvCell(-3), '-3', 'numbers are left alone');
  assert.equal(csvCell('beginner'), 'beginner');
});

test('live channel: learner tabs are capped, wrong join codes are limited, and the channel closes on submit', async () => {
  await withServer({}, async (base) => {
    const sess = await (await post(base + '/api/sessions', { scenario: null })).json();
    const { code } = await (await post(`${base}/api/live/${sess.id}/open`, {})).json();
    const ctl = new AbortController(), streams = [];
    for (let i = 0; i < LIVE_LIMITS.maxLearners; i++) streams.push(await fetch(`${base}/api/live/${sess.id}/stream`, { signal: ctl.signal }));
    assert.ok(streams.every(r => r.status === 200));
    assert.equal((await fetch(`${base}/api/live/${sess.id}/stream`)).status, 429, 'one tab too many');
    // wrong codes from one address: after the limit even the right code waits for the next minute
    for (let i = 0; i < LIVE_LIMITS.joinMissesPerMin; i++) assert.equal((await fetch(`${base}/api/live/join/ZZZZZZ`)).status, 404);
    assert.equal((await fetch(`${base}/api/live/join/${code}`)).status, 429);
    // submit closes the channel
    const p = new Patient(sess.spec, { seed: sess.seed }); p.run(10);
    assert.equal((await post(`${base}/api/sessions/${sess.id}/submit`, { log: p.log, until: +p.t.toFixed(3), hash: p.stateHash() })).status, 200);
    assert.equal((await fetch(`${base}/api/live/${sess.id}/stream`)).status, 404, 'channel gone');
    assert.equal((await post(`${base}/api/live/${sess.id}/open`, {})).status, 409);
    ctl.abort();
  });
});

test('rate-limit key behind a proxy: invented header values are ignored; with TRUST_PROXY_HOPS the proxy-added entry is used', async () => {
  const burst = async (base, hdr) => { let last; for (let i = 0; i <= 120; i++) last = (await fetch(base + '/api/scenarios', { headers: { 'x-forwarded-for': hdr(i) } })).status; return last; };
  await withServer({ trustProxy: true }, async (base) => {
    assert.equal(await burst(base, i => `not-an-ip-${i}`), 429, 'non-IP values fall back to the socket address');
  });
  await withServer({ trustProxy: true, trustProxyHops: 1 }, async (base) => {
    assert.equal(await burst(base, i => `198.51.100.${i % 250}, 203.0.113.5`), 429, 'a rotated first entry does not escape the limit');
  });
  await withServer({ trustProxy: true }, async (base) => {
    assert.equal(await burst(base, i => `198.51.100.${i % 250}`), 200, 'default: the first entry is the client (a replacing proxy), as before');
  });
});
