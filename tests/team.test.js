// Team mode: closed-loop orders, read-back errors on their own random stream, scoring and replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk, scen } from './helpers/bots.js';
import { replay } from '../src/engine/patient.js';
import { SCENARIOS, scoreSession } from '../src/engine/scenarios.js';
import { readbackOf, READBACK_ERROR_P, TEAM_ACTS, TEAM_ROLES } from '../src/engine/team.js';
import { Rng } from '../src/engine/rng.js';

test('every action the team can carry out belongs to a known team member', () => {
  for (const [type, who] of Object.entries(TEAM_ACTS)) assert.ok(TEAM_ROLES.includes(who), `${type}: unknown team member ${who}`);
});

/** a leader who listens: corrects every wrong read-back, then confirms and carries out the read-back */
function lead(p, id, act, { listen = true } = {}) {
  let r = p.dispatch({ type: 'team.order', id, act });
  assert.ok(r.ok, JSON.stringify(r));
  const wrong = JSON.stringify(r.readback) !== JSON.stringify(act);
  if (wrong && listen) r = p.dispatch({ type: 'team.correct', id });
  const c = p.dispatch({ type: 'team.confirm', id });
  p.dispatch(c.act);
  return { wrong, given: c.act };
}

test('read-back errors are plausible, about one order in eight, and use their own random stream', () => {
  const rng = new Rng(5); let errors = 0;
  for (let i = 0; i < 2000; i++) { const r = readbackOf({ type: 'drug.bolus', drug: 'epinephrine', amount: 1000 }, rng); if (r.error) { errors++; assert.ok([10000, 100].includes(r.act.amount)); } }
  assert.ok(Math.abs(errors / 2000 - READBACK_ERROR_P) < 0.03, `${errors} / 2000`);
  const a = mk({}, { seed: 9 }), b = mk({}, { seed: 9 });
  for (let i = 1; i <= 20; i++) a.dispatch({ type: 'team.order', id: i, act: { type: 'lab.order', kind: 'abg' } });
  a.run(30); b.run(30);
  assert.equal(a.rng.state, b.rng.state, 'the physiology random stream is untouched');
});

test('a listening leader closes every order; a leader who confirms a wrong read-back gives the wrong dose', () => {
  let sawError = false;
  for (let seed = 1; seed <= 12 && !sawError; seed++) {
    const p = mk({}, { seed }); p.dispatch({ type: 'iv.access' });
    for (let i = 1; i <= 10; i++) { const r = lead(p, i, { type: 'drug.bolus', drug: 'phenylephrine', amount: 100 }); if (r.wrong) sawError = true; assert.equal(r.given.amount, 100); }
    assert.ok(p.team.orders.every(o => o.status === 'confirmed'));
  }
  assert.ok(sawError, 'some read-back errors happened and were caught');
  for (let seed = 1; seed <= 30; seed++) {
    const p = mk({}, { seed }); p.dispatch({ type: 'iv.access' });
    const r = lead(p, 1, { type: 'drug.bolus', drug: 'phenylephrine', amount: 100 }, { listen: false });
    if (r.wrong) { assert.notEqual(r.given.amount, 100); assert.equal(p.team.orders[0].status, 'accepted_error'); return; }
  }
  assert.fail('no read-back error in 30 seeds');
});

test('the communication criterion appears only in team mode and rewards closed loops', () => {
  const plain = scen('witnessed_vf', 2); plain.run(30);
  assert.ok(!scoreSession(plain).items.some(i => i.id === 'closed_loop'), 'not applicable without team orders');
  const p = scen('witnessed_vf', 2); p.run(30); p.dispatch({ type: 'iv.access' });
  for (let i = 1; i <= 4; i++) lead(p, i, { type: 'drug.bolus', drug: 'epinephrine', amount: 1000 });
  p.dispatch({ type: 'team.order', id: 9, act: { type: 'lab.order', kind: 'abg' } });   // never closed
  const it = scoreSession(p).items.find(i => i.id === 'closed_loop');
  assert.ok(it && Math.abs(it.frac - 0.8) < 1e-9, JSON.stringify(it));
});

test('invalid orders are rejected, and a team session replays to the same hash', () => {
  const p = mk({}, { seed: 4 });
  assert.equal(p.dispatch({ type: 'team.order', id: 1, act: { type: 'airway.intubate' } }).ok, false, 'not a team action');
  assert.equal(p.dispatch({ type: 'team.order', id: 2, act: { type: 'drug.bolus', drug: 'epinephrine', amount: 'lots' } }).ok, false);
  assert.equal(p.dispatch({ type: 'team.confirm', id: 77 }).ok, false);
  p.dispatch({ type: 'iv.access' });
  for (let i = 3; i <= 8; i++) { lead(p, i, { type: 'fluid.bolus', volumeL: 0.25, minutes: 5 }); p.run(20); }
  const q = replay({ spec: p.spec, seed: 4, scenario: null, log: p.log.map(e => ({ ...e })), until: p.t }, SCENARIOS);
  assert.equal(q.stateHash(), p.stateHash());
  assert.deepEqual(q.team.orders.map(o => o.status), p.team.orders.map(o => o.status));
});
