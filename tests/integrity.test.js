// Score and verification integrity: a hand-edited replay log, concurrent requests or a live-channel learner must not get
// credit or a "verified" result for things that did not happen (security audit, November 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server/server.js';
import { checkInjects } from '../src/server/live.js';
import { Patient, replay } from '../src/engine/patient.js';
import { SCENARIOS, scoreSession } from '../src/engine/scenarios.js';
import { mk, scen } from './helpers/bots.js';

const item = (p, id) => scoreSession(p).items.find(i => i.id === id);
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function withServer(opts, fn) {
  const s = createServer({ port: 0, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tbl-int-')), quiet: true, ...opts });
  const base = `http://127.0.0.1:${(await s.listen()).port}`;
  try { return await fn(base); } finally { await s.close(); }
}

test('airway.set cannot place a tracheal tube: intubation only goes through airway.intubate', () => {
  const p = scen('cico', 1);
  const r = p.dispatch({ type: 'airway.set', device: 'ett' });
  assert.equal(r.ok, false); assert.equal(p.airway.intubated, false); assert.notEqual(p.airway.device, 'ett');
  for (const device of ['toString', '__proto__', 'constructor', 42]) assert.equal(mk().dispatch({ type: 'airway.set', device }).ok, false, String(device));
  for (const device of ['none', 'chin_lift', 'jaw_thrust', 'opa', 'sga']) assert.equal(mk().dispatch({ type: 'airway.set', device }).ok, true, device);
  // the replayed hand-made log scores like a log without the event (it is refused, so the airway stays unsecured)
  const q = replay({ spec: p.spec, seed: 1, scenario: 'cico', log: [{ t: 0, type: 'airway.set', device: 'ett' }], until: 300 }, SCENARIOS);
  const z = replay({ spec: p.spec, seed: 1, scenario: 'cico', log: [], until: 300 }, SCENARIOS);
  assert.equal(q.airway.intubated, false); assert.equal(scoreSession(q).pct, scoreSession(z).pct);
});

test('an event the engine refused stays in the replay log but earns no score credit', () => {
  const p = scen('torsades', 1); p.run(5);
  assert.equal(p.dispatch({ type: 'pacing.set', on: true }).ok, false, 'pacing without pads is refused');
  p.run(30);
  assert.equal(p.log.at(-1).type, 'pacing.set', 'still logged, so a replay refuses it identically');
  assert.equal(p.log.at(-1).refused, true);
  assert.equal(JSON.stringify(p.log).includes('refused'), false, 'the marker is not part of the serialised log');
  assert.equal(item(p, 'tdp_rate').frac, 0, 'no credit for pacing that never started');
  const q = replay({ spec: p.spec, seed: 1, scenario: 'torsades', log: JSON.parse(JSON.stringify(p.log)), until: p.t }, SCENARIOS);
  assert.equal(q.stateHash(), p.stateHash()); assert.equal(item(q, 'tdp_rate').frac, 0, 'the server replay agrees');
  // a failed attempt that really happened is not "refused": intubating a patient who is not relaxed counts as an attempt
  const a = mk(); a.dispatch({ type: 'airway.intubate' });
  assert.equal(a.log.at(-1).ok, false); assert.equal(a.log.at(-1).refused, false); assert.equal(a.failedAttempts, 1);
});

test('a needle decompression with no side, site or length earns no technique credit', () => {
  const p = scen('tension_ptx', 1); p.run(200);
  assert.equal(p.dispatch({ type: 'procedure.needle_decompression' }).ok, true, 'the legacy path still relieves the case');
  p.run(30);
  assert.equal(p.chest.tension, 0);
  assert.equal(item(p, 'needle_technique').frac, 0);
});

test('checkInjects: the log must carry exactly the delivered instructor changes, in order', () => {
  const sent = [{ what: 'bleed', mlPerMin: 250 }, { what: 'vf' }];
  const log = (...w) => w.map((c, i) => ({ t: 10 * (i + 1), type: 'instructor.inject', ...c }));
  assert.equal(checkInjects(sent, log(...sent)).ok, true);
  assert.equal(checkInjects(sent, log(sent[0])).ok, false, 'a change removed');
  assert.equal(checkInjects(sent, log(sent[1], sent[0])).ok, false, 'reordered');
  assert.equal(checkInjects(sent, log({ what: 'bleed', mlPerMin: 20 }, sent[1])).ok, false, 'edited');
  assert.equal(checkInjects([], log({ what: 'bleed_stop' })).ok, false, 'invented');
  assert.equal(checkInjects([], [{ t: 1, type: 'note', text: 'x' }]).ok, true);
});

test('a log that invents an instructor change is unverified, even with a matching hash', async () => {
  await withServer({}, async (base) => {
    const s = await (await post(base + '/api/sessions', { scenario: 'witnessed_vf' })).json();
    const p = new Patient(s.spec, { seed: s.seed, scenario: SCENARIOS.witnessed_vf });
    p.run(20); p.dispatch({ type: 'instructor.inject', what: 'bleed_stop' }); p.run(20);
    const r = await (await post(`${base}/api/sessions/${s.id}/submit`, { log: p.log, until: +p.t.toFixed(3), hash: p.stateHash() })).json();
    assert.equal(r.result.serverHash, p.stateHash(), 'the hash itself matches');
    assert.equal(r.result.verified, false); assert.match(r.result.instructorMismatch, /1 instructor change/);
  });
});

test('one submit per session even when two are sent at once; concurrent self-assessments keep exactly one', async () => {
  await withServer({}, async (base) => {
    const s = await (await post(base + '/api/sessions', { scenario: 'witnessed_vf' })).json();
    const p = new Patient(s.spec, { seed: s.seed, scenario: SCENARIOS.witnessed_vf }); p.run(30); p.dispatch({ type: 'cpr.start' }); p.run(30);
    const body = { log: p.log, until: +p.t.toFixed(3), hash: p.stateHash() };
    const codes = (await Promise.all([post(`${base}/api/sessions/${s.id}/submit`, body), post(`${base}/api/sessions/${s.id}/submit`, body)])).map(r => r.status).sort();
    assert.deepEqual(codes, [200, 409]);
    const selfCodes = (await Promise.all([post(`${base}/api/sessions/${s.id}/self`, { pct: 90 }), post(`${base}/api/sessions/${s.id}/self`, { pct: 10 })])).map(r => r.status).sort();
    assert.deepEqual(selfCodes, [200, 409]);
    assert.equal((await post(`${base}/api/sessions/${s.id}/submit`, body)).status, 409);
  });
});

test('research key times count only what the server replay accepted', async () => {
  await withServer({ apiToken: 'tok' }, async (base) => {
    const s = await (await post(base + '/api/sessions', { scenario: 'witnessed_vf' })).json();
    const p = new Patient(s.spec, { seed: s.seed, scenario: SCENARIOS.witnessed_vf });
    p.run(5); p.dispatch({ type: 'defib.shock' }); p.dispatch({ type: 'drug.bolus', drug: 'notadrug', amount: 1 }); p.run(5);
    p.dispatch({ type: 'monitor.attach', items: { ecgLeads: true } }); p.run(10);
    await post(`${base}/api/sessions/${s.id}/submit`, { log: p.log, until: +p.t.toFixed(3), hash: p.stateHash() });
    const [row] = await (await fetch(base + '/api/research/export?format=json', { headers: { Authorization: 'Bearer tok' } })).json();
    assert.equal(row.t_firstShock, '', 'a shock without pads was refused'); assert.equal(row.t_firstDrug, '', 'an unknown drug was refused');
    assert.equal(row.t_monitoring, 10); assert.equal(row.key_times_source, 'replay');
  });
});

test('a case ended before the crisis is played out with no action, so stopping early cannot skip what would be scored', async () => {
  const { playOut } = await import('../src/engine/scenarios.js');
  const sc = SCENARIOS.anaphylaxis;
  const early = new Patient(sc.spec, { seed: 3, scenario: sc }); early.run(5);
  const atStop = scoreSession(early).pct;
  const walked = new Patient(sc.spec, { seed: 3, scenario: sc }); walked.run(5);
  assert.equal(playOut(walked), +(sc.durationS - 5).toFixed(1)); assert.equal(walked.t, sc.durationS);
  assert.equal(playOut(walked), 0, 'a case that already ran its length is not extended');
  const full = scoreSession(walked).pct;
  assert.ok(full < atStop || atStop === 0, `walking away scores no better than stopping early (${full} vs ${atStop})`);
  await withServer({}, async (base) => {
    const s = await (await post(base + '/api/sessions', { scenario: 'anaphylaxis' })).json();
    const p = new Patient(s.spec, { seed: s.seed, scenario: sc }); p.run(5);
    const r = (await (await post(`${base}/api/sessions/${s.id}/submit`, { log: p.log, until: +p.t.toFixed(3), hash: p.stateHash() })).json()).result;
    assert.equal(r.verified, true, 'the hash is still checked at the moment the learner ended');
    assert.equal(r.simTimeS, 5); assert.equal(r.playedOutS, sc.durationS - 5);
    playOut(p); assert.deepEqual(r.score, scoreSession(p), 'server score = the case played out to its end');
  });
});
