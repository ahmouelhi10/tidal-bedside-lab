import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, validateLog, validateBodySpec, LIMITS } from '../src/server/server.js';
import { Patient } from '../src/engine/patient.js';
import { SCENARIOS, scoreSession, playOut } from '../src/engine/scenarios.js';
import { aclsTeam } from './helpers/bots.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tbl-'));

async function withServer(opts, fn) {
  const dataDir = opts.dataDir || tmp();
  const s = createServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true, ...opts });
  const addr = await s.listen(); const base = `http://127.0.0.1:${addr.port}`;
  try { return await fn(base, s, dataDir); } finally { await s.close(); }
}
const j = async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) });
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('health, scenario list and security headers', async () => {
  await withServer({}, async (base) => {
    const h = await j(await fetch(base + '/api/health'));
    assert.equal(h.status, 200); assert.equal(h.body.status, 'ok'); assert.equal(h.body.scenarios, Object.keys(SCENARIOS).length);
    assert.match(h.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
    const sc = await j(await fetch(base + '/api/scenarios'));
    assert.equal(sc.body.length, Object.keys(SCENARIOS).length); assert.ok(sc.body.every(x => x.id && x.title && !('score' in x)));
  });
});

test('static: the client and engine modules are served with correct MIME types; traversal and unknown types are refused', async () => {
  await withServer({}, async (base) => {
    const idx = await fetch(base + '/');
    assert.equal(idx.status, 200); assert.match(idx.headers.get('content-type'), /text\/html/);
    const html = await idx.text(); assert.match(html, /id="app"/); assert.match(html, /<script type="module" src="\/main\.js">/); assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, 'no inline scripts (CSP script-src self)');
    const eng = await fetch(base + '/engine/patient.js');
    assert.equal(eng.status, 200); assert.match(eng.headers.get('content-type'), /javascript/);
    for (const bad of ['/../package.json', '/%2e%2e/package.json', '/engine/../../package.json', '/..%2fpackage.json', '/engine/%00.js', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/engine/']) {
      const r = await fetch(base + bad); assert.ok([400, 404].includes(r.status), bad + ' -> ' + r.status); await r.arrayBuffer();
    }
    const nf = await fetch(base + '/package.json'); assert.equal(nf.status, 404); await nf.arrayBuffer();
    const tag = (await fetch(base + '/engine/util.js')).headers.get('etag');
    const cached = await fetch(base + '/engine/util.js', { headers: { 'if-none-match': tag } }); assert.equal(cached.status, 304); await cached.arrayBuffer();
    const put = await fetch(base + '/', { method: 'DELETE' }); assert.equal(put.status, 405); await put.arrayBuffer();
  });
});

test('input validation: body spec ranges, JSON errors and payload limits', async () => {
  await withServer({}, async (base) => {
    assert.equal((await j(await post(base + '/api/sessions', { scenario: 'nope' }))).status, 404);
    assert.equal((await j(await post(base + '/api/sessions', { scenario: 'stemi_vf', spec: { weightKg: 5 } }))).status, 400);
    assert.equal((await j(await post(base + '/api/sessions', { scenario: 'stemi_vf', spec: { sex: 'X' } }))).status, 400);
    assert.equal((await j(await post(base + '/api/sessions', '{not json'))).status, 400);
    assert.equal((await j(await post(base + '/api/sessions', { spec: { heightCm: 210, weightKg: 40 } }))).status, 400, 'BMI 9 is outside the validated envelope');
    assert.equal((await j(await post(base + '/api/sessions', { spec: { heightCm: 150, weightKg: 150 } }))).status, 400, 'BMI 67 is outside the validated envelope');
    let bigStatus = 0; try { bigStatus = (await post(base + '/api/sessions', JSON.stringify({ pad: 'x'.repeat(LIMITS.maxBodyBytes + 10) }))).status; } catch { /* connection closed by the server is an acceptable refusal */ }
    assert.ok(bigStatus === 413 || bigStatus === 0, 'oversized body refused, got ' + bigStatus);
    const ok = await j(await post(base + '/api/sessions', { scenario: 'stemi_vf', spec: { weightKg: 140, sex: 'F' }, learner: 'resident-' + 'x'.repeat(200) }));
    assert.equal(ok.status, 201); assert.equal(ok.body.spec.weightKg, 140); assert.equal(ok.body.spec.sex, 'F'); assert.equal(ok.body.spec.lvFunction, 0.82);
    assert.ok(ok.body.learner.length <= LIMITS.maxStrLen); assert.match(ok.body.id, /^[a-f0-9]{32}$/); assert.ok(Number.isInteger(ok.body.seed));
    assert.equal((await j(await fetch(base + '/api/sessions/not-an-id'))).status, 400);
    assert.equal((await j(await fetch(base + '/api/sessions/' + 'a'.repeat(32)))).status, 404);
  });
  assert.equal(validateBodySpec({ age: 17 }).ok, false); assert.equal(validateBodySpec({ age: 18 }).ok, true);
  assert.equal(validateLog([{ type: 'drug.bolus', t: 5 }, { type: 'iv.access', t: 1 }], 10).ok, false);       // t decreasing
  assert.equal(validateLog([{ type: 'launch.missiles', t: 1 }], 10).ok, false);
  assert.equal(validateLog([{ type: 'iv.access', t: 11 }], 10).ok, false);
  assert.equal(validateLog([], LIMITS.maxSimSeconds + 1).ok, false);
});

test('end-to-end: server-issued seed -> client plays locally -> server replays, verifies the hash and scores authoritatively', async () => {
  await withServer({}, async (base, _s, dataDir) => {
    const created = (await j(await post(base + '/api/sessions', { scenario: 'witnessed_vf', learner: 'test-learner' }))).body;
    const p = new Patient(created.spec, { seed: created.seed, scenario: SCENARIOS.witnessed_vf });   // what the browser does
    aclsTeam(p, { endT: 300, reaction: 5 });
    const hash = p.stateHash(), until = p.t;
    playOut(p); const local = scoreSession(p);                         // the browser plays an early end out to the case length, as the server does
    const sub = await j(await post(`${base}/api/sessions/${created.id}/submit`, { log: p.log, until, hash }));
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.status, 'submitted');
    assert.equal(sub.body.result.verified, true);
    assert.equal(sub.body.result.serverHash, hash);
    assert.deepEqual(sub.body.result.score, local);
    assert.equal(sub.body.result.roscCount, p.arrest.roscCount ?? 0);   // the server reports the same outcome as the client's run (ROSC itself is probabilistic: the seed is the server's, so its presence is not asserted)
    assert.equal((await j(await post(`${base}/api/sessions/${created.id}/submit`, { log: p.log, until, hash }))).status, 409);   // single submission
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', created.id + '.json'), 'utf8'));
    assert.equal(stored.result.verified, true);
    assert.equal((await j(await fetch(`${base}/api/sessions/${created.id}`))).body.result.score.pct, local.pct);
    assert.equal(sub.body.log, undefined, 'the public view never exposes the log');
  });
});

test('tampering: a doctored log or a forged hash is reported as unverified and the SERVER score is what is stored', async () => {
  await withServer({}, async (base) => {
    const mkSession = async () => (await j(await post(base + '/api/sessions', { scenario: 'witnessed_vf' }))).body;
    const a = await mkSession(), pa = new Patient(a.spec, { seed: a.seed, scenario: SCENARIOS.witnessed_vf });
    aclsTeam(pa, { endT: 200, reaction: 5 });
    const forged = await j(await post(`${base}/api/sessions/${a.id}/submit`, { log: pa.log, until: pa.t, hash: 'deadbeef' }));
    assert.equal(forged.body.result.verified, false);
    playOut(pa); assert.deepEqual(forged.body.result.score, scoreSession(pa), 'score comes from the server replay, not from the client');
    const b = await mkSession(), pb = new Patient(b.spec, { seed: b.seed, scenario: SCENARIOS.witnessed_vf });
    aclsTeam(pb, { endT: 200, reaction: 5 });
    const lied = pb.log.filter(e => e.type !== 'defib.shock');                                       // claims it never needed to shock...
    const r = await j(await post(`${base}/api/sessions/${b.id}/submit`, { log: lied, until: pb.t, hash: pb.stateHash() }));
    assert.equal(r.body.result.verified, false);
    playOut(pb); assert.ok(r.body.result.score.pct < scoreSession(pb).pct, 'removing the shock cannot raise the score');
    const c = await mkSession();                                                                       // wrong seed on the client side
    const pc = new Patient(c.spec, { seed: c.seed + 1, scenario: SCENARIOS.witnessed_vf }); aclsTeam(pc, { endT: 200, reaction: 5 });
    assert.equal((await j(await post(`${base}/api/sessions/${c.id}/submit`, { log: pc.log, until: pc.t, hash: pc.stateHash() }))).body.result.verified, false);
  });
});

test('abuse: oversized replay window, unknown events and huge logs are rejected before any simulation runs', async () => {
  await withServer({}, async (base) => {
    const s = (await j(await post(base + '/api/sessions', { scenario: 'witnessed_vf' }))).body;
    const url = `${base}/api/sessions/${s.id}/submit`;
    assert.equal((await j(await post(url, { log: [], until: 99999 }))).status, 400);
    assert.equal((await j(await post(url, { log: [], until: SCENARIOS.witnessed_vf.durationS * 2 + 1 }))).status, 400);
    assert.equal((await j(await post(url, { log: [{ type: 'rm.rf', t: 1 }], until: 10 }))).status, 400);
    assert.equal((await j(await post(url, { log: 'x', until: 10 }))).status, 400);
    assert.equal((await j(await post(url, { log: Array.from({ length: LIMITS.maxEvents + 1 }, () => ({ type: 'note', t: 1 })), until: 10 }))).status, 400);
    const ok = await j(await post(url, { log: [{ type: 'iv.access', t: 1 }], until: 5, hash: 'x' }));      // still open after rejections
    assert.equal(ok.status, 200);
  });
});

test('instructor listing is disabled without API_TOKEN and requires the bearer token when configured; logs only for authorised callers', async () => {
  await withServer({ apiToken: '' }, async (base) => {
    assert.equal((await j(await fetch(base + '/api/sessions'))).status, 403);
  });
  await withServer({ apiToken: 's3cret-token' }, async (base) => {
    const s = (await j(await post(base + '/api/sessions', { scenario: 'hemorrhage', learner: 'r1' }))).body;
    await post(`${base}/api/sessions/${s.id}/submit`, { log: [{ type: 'iv.access', t: 3 }], until: 10, hash: 'x' });
    assert.equal((await j(await fetch(base + '/api/sessions'))).status, 401);
    assert.equal((await j(await fetch(base + '/api/sessions', { headers: { authorization: 'Bearer nope' } }))).status, 401);
    const list = await j(await fetch(base + '/api/sessions', { headers: { authorization: 'Bearer s3cret-token' } }));
    assert.equal(list.status, 200); assert.equal(list.body.length, 1); assert.equal(list.body[0].learner, 'r1');
    assert.equal((await j(await fetch(`${base}/api/sessions/${s.id}?log=1`))).body.log, undefined);
    const withLog = await j(await fetch(`${base}/api/sessions/${s.id}?log=1`, { headers: { authorization: 'Bearer s3cret-token' } }));
    assert.equal(withLog.body.log.length, 1);
  });
});

test('persistence: sessions survive a server restart', async () => {
  const dataDir = tmp(); let id;
  await withServer({ dataDir }, async (base) => { id = (await j(await post(base + '/api/sessions', { scenario: 'obese_rsi' }))).body.id; });
  await withServer({ dataDir }, async (base) => {
    const r = await j(await fetch(`${base}/api/sessions/${id}`)); assert.equal(r.status, 200); assert.equal(r.body.scenario, 'obese_rsi'); assert.equal(r.body.status, 'open');
  });
});

test('free-play session (no scenario) replays without a score', async () => {
  await withServer({}, async (base) => {
    const s = (await j(await post(base + '/api/sessions', { spec: { sex: 'F', weightKg: 55, heightCm: 160, age: 30 } }))).body;
    assert.equal(s.scenario, null);
    const p = new Patient(s.spec, { seed: s.seed }); p.run(5); p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 100 }); p.run(60);
    const r = await j(await post(`${base}/api/sessions/${s.id}/submit`, { log: p.log, until: p.t, hash: p.stateHash() }));
    assert.equal(r.body.result.verified, true); assert.equal(r.body.result.score, null);
  });
});
