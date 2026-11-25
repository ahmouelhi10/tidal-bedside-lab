// Load test of the replay pool (not part of npm test): how many sessions the server verifies at once, how long a learner
// waits for the result, and what happens past the queue. It starts the server on a free port, opens realistic sessions
// (the scripted experts of tests/helpers play each case to its end, with the seed the server issued), then submits them
// in simultaneous bursts, each from its own learner address (TRUST_PROXY, X-Forwarded-For), so the per-address rate
// limit is not what is measured. Submits go through the browser's own retry (web/retry.js): a refused one waits and tries
// again, so the table shows what each learner finally gets, and how many had to retry.
// Usage: npm run load-test        LOAD_LEVELS=1,8,30,60,102,130 to choose the burst sizes.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createServer, LIMITS } from '../src/server/server.js';
import { Patient } from '../src/engine/patient.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { expertRun } from '../tests/helpers/experts.js';
import { sendWithRetry } from '../src/web/retry.js';

const LEVELS = (process.env.LOAD_LEVELS || '1,8,30,60,102,130').split(',').map(Number).filter(n => n > 0);
const CASES = ['witnessed_vf', 'stemi_vf', 'obese_rsi', 'hemorrhage', 'tension_ptx', 'opioid_pea', 'dka', 'anaphylaxis'].filter(id => SCENARIOS[id]);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbl-load-'));
const srv = createServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true, trustProxy: true });
const base = `http://127.0.0.1:${(await srv.listen()).port}`;
let ipN = 0;
const post = (url, body, ip) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };

/** One learner's finished session, ready to submit: the server issued the seed, the expert played it to the end. */
async function prepare(id) {
  const ip = `10.0.${(ipN >> 8) & 255}.${ipN++ & 255}`;
  const s = await (await post('/api/sessions', { scenario: id }, ip)).json();
  const p = new Patient(s.spec, { seed: s.seed, scenario: SCENARIOS[id] }); expertRun(p, id);
  return { id, ip, session: s.id, body: { log: p.log, until: +p.t.toFixed(3), hash: p.stateHash() }, simS: p.t, events: p.log.length };
}

async function burst(n) {
  const jobs = []; for (let i = 0; i < n; i++) jobs.push(await prepare(CASES[i % CASES.length]));
  const t0 = performance.now();
  const res = await Promise.all(jobs.map(async (j) => {
    let tries = 0; const a = performance.now();
    const r = await sendWithRetry(() => post(`/api/sessions/${j.session}/submit`, j.body, j.ip), { onWait: () => { tries++; } }), b = await r.json().catch(() => ({}));   // as the browser does
    return { status: r.status, ms: performance.now() - a, verified: b.result?.verified === true, simS: j.simS, events: j.events, tries };
  }));
  const wall = performance.now() - t0, ok = res.filter(r => r.status === 200), codes = {};
  for (const r of res) codes[r.status] = (codes[r.status] || 0) + 1;
  return { n, wallS: wall / 1000, codes, verified: ok.filter(r => r.verified).length, ok: ok.length, p50: pct(ok.map(r => r.ms), 0.5) / 1000, p95: pct(ok.map(r => r.ms), 0.95) / 1000,
    max: Math.max(...ok.map(r => r.ms)) / 1000, retried: res.filter(r => r.tries > 0).length, simMin: res.reduce((s, r) => s + r.simS, 0) / res.length / 60, events: Math.round(res.reduce((s, r) => s + r.events, 0) / res.length) };
}

console.log(`load test: replay concurrency ${LIMITS.replayConcurrency}, queue ${LIMITS.replayQueue}, timeout ${LIMITS.replayTimeoutMs / 1000} s; ${os.cpus().length} CPUs, Node ${process.version}`);
console.log('burst | final answers (status: count) | verified | wait p50 / p95 / max (s) | burst done (s) | sessions/min | retried | avg case (sim min, events)');
const rows = [];
try {
  for (const n of LEVELS) {
    const r = await burst(n); rows.push(r);
    console.log(`${String(r.n).padStart(5)} | ${JSON.stringify(r.codes).padEnd(24)} | ${String(r.verified).padStart(3)}/${String(r.ok).padEnd(3)} | ${r.p50.toFixed(2)} / ${r.p95.toFixed(2)} / ${r.max.toFixed(2)}`.padEnd(70)
      + ` | ${r.wallS.toFixed(2).padStart(6)} | ${(r.ok / r.wallS * 60).toFixed(0).padStart(5)} | ${String(r.retried).padStart(3)} | ${r.simMin.toFixed(1)} min, ${r.events}`);
  }
} finally { await srv.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
const bad = rows.filter(r => r.verified !== r.ok);
if (bad.length) { console.log('load test: FAIL, some accepted sessions did not verify'); process.exit(1); }
console.log('load test: every accepted session verified');
