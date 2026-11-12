// Research export and self-assessment storage (validity studies, docs/VALIDITY_STUDY.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server/server.js';
import { Patient } from '../src/engine/patient.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { validateSelf } from '../src/server/research.js';

const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('self-assessment validation', () => {
  assert.deepEqual(validateSelf({ pct: 72.4, ants: { task: 3, sa: 2 } }), { ok: true, self: { pct: 72, ants: { task: 3, sa: 2 } } });
  assert.equal(validateSelf({ pct: 140 }).ok, false);
  assert.equal(validateSelf({ pct: 50, ants: { team: 7 } }).ok, false);
});

test('submitted sessions export as de-identified CSV rows with scores, key times and self-assessment', async () => {
  const s = createServer({ port: 0, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tbl-res-')), quiet: true, apiToken: 'secret-token' });
  const base = `http://127.0.0.1:${(await s.listen()).port}`, auth = { Authorization: 'Bearer secret-token' };
  try {
    for (const learner of ['Alice Martin', 'Alice Martin', 'Bob']) {
      const sess = await (await post(base + '/api/sessions', { scenario: 'witnessed_vf', learner })).json();
      const p = new Patient(sess.spec, { seed: sess.seed, scenario: SCENARIOS.witnessed_vf });
      p.run(10); p.dispatch({ type: 'monitor.attach', items: { ecgLeads: true } }); p.run(30); p.dispatch({ type: 'cpr.start' }); p.run(20);
      assert.equal((await post(`${base}/api/sessions/${sess.id}/self`, { pct: 50 })).status, 409, 'not before submitting');
      const sub = await (await post(`${base}/api/sessions/${sess.id}/submit`, { log: p.log, until: +p.t.toFixed(3), hash: p.stateHash() })).json();
      assert.equal(sub.result.verified, true);
      assert.equal((await post(`${base}/api/sessions/${sess.id}/self`, { pct: 80, ants: { task: 3, team: 2, sa: 3, dm: 4 } })).status, 200);
      assert.equal((await post(`${base}/api/sessions/${sess.id}/self`, { pct: 10 })).status, 409, 'only once');
    }
    assert.equal((await fetch(base + '/api/research/export')).status, 401);
    const rows = await (await fetch(base + '/api/research/export?format=json', { headers: auth })).json();
    assert.equal(rows.length, 3);
    assert.ok(rows.every(r => r.verified === 1 && r.scenario === 'witnessed_vf' && r.self_pct === 80 && r.self_ants_dm === 4));
    assert.ok(rows.every(r => r.t_monitoring === 10 && r.t_cprStart === 40), JSON.stringify(rows[0]));
    assert.equal(rows[0].learner_pid, rows[1].learner_pid, 'same learner, same pseudonym');
    assert.notEqual(rows[0].learner_pid, rows[2].learner_pid);
    const csv = await (await fetch(base + '/api/research/export', { headers: auth })).text();
    assert.ok(!csv.includes('Alice') && !csv.includes('Bob'), 'no names in the export');
    const head = csv.split('\n')[0].split(',');
    assert.ok(head.includes('score_pct') && head.includes('t_firstShock') && head.some(h => h.startsWith('crit_')));
  } finally { await s.close(); }
});
