// Laboratory orders: results frozen at sampling time, released after the turnaround, never changing the physiology.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { replay } from '../src/engine/patient.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { TURNAROUND_S, baseExcess } from '../src/engine/labs.js';

test('a blood gas is not available before the turnaround and then reports the values at sampling time', () => {
  const p = mk();
  p.run(60);
  const truth = p.snapshot();
  const r = p.dispatch({ type: 'lab.order', kind: 'abg' });
  assert.ok(r.ok && r.willTakeS === TURNAROUND_S.abg);
  p.run(TURNAROUND_S.abg - 10);
  assert.equal(p.labResults().length, 0, 'not back yet');
  p.run(20);
  const [res] = p.labResults();
  assert.ok(res, 'result released');
  assert.ok(Math.abs(res.values.ph - truth.ph) < 0.011 && Math.abs(res.values.paco2 - truth.paco2) <= 1, 'values of the sample, not of the moment the result arrives');
  assert.ok(res.values.ph >= 7.35 && res.values.ph <= 7.45, `healthy adult pH ${res.values.ph} in 7.35-7.45`);
  assert.ok(res.values.paco2 >= 35 && res.values.paco2 <= 45, `PaCO2 ${res.values.paco2} in 35-45 mmHg`);
  assert.equal(res.flags.ph, '');
});

test('apnoea: a second blood gas shows the respiratory acidosis developing, flagged as abnormal', () => {
  const p = mk();
  p.dispatch({ type: 'iv.access' });
  p.dispatch({ type: 'lab.order', kind: 'abg' });
  p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 85 });   // paralysis without ventilation (teaching scenario)
  p.run(150);
  p.dispatch({ type: 'lab.order', kind: 'abg' });
  p.run(TURNAROUND_S.abg + 5);
  const [a, b] = p.labResults();
  assert.ok(b.values.paco2 > a.values.paco2 + 5, `PaCO2 ${a.values.paco2} -> ${b.values.paco2} rises during apnoea`);
  assert.ok(b.values.ph < a.values.ph, 'pH falls');
  assert.equal(b.flags.paco2, 'H');
});

test('haemorrhage lowers the haemoglobin of a later blood count', () => {
  const p = mk();
  p.dispatch({ type: 'lab.order', kind: 'cbc' });
  p.dispatch({ type: 'bleed.set', mlPerMin: 200 });
  p.dispatch({ type: 'fluid.bolus', volumeL: 2, minutes: 20 });   // dilution after crystalloid replacement
  p.run(1200);
  p.dispatch({ type: 'lab.order', kind: 'cbc' });
  p.run(TURNAROUND_S.cbc + 5);
  const [a, b] = p.labResults();
  assert.ok(b.values.hb < a.values.hb - 0.5, `Hb ${a.values.hb} -> ${b.values.hb}`);
});

test('base excess: standard Van Slyke form gives ~0 at pH 7.40 and HCO3 24.4, negative in metabolic acidosis', () => {
  assert.ok(Math.abs(baseExcess(24.4, 7.40)) < 1e-9);
  assert.ok(baseExcess(15, 7.20) < -10);
});

test('ordering tests never changes the trajectory, and malformed orders are rejected', () => {
  const a = mk(), b = mk();
  a.dispatch({ type: 'lab.order', kind: 'abg' }); a.dispatch({ type: 'lab.order', kind: 'cbc' });
  a.run(300); b.run(300);
  assert.equal(a.stateHash(), b.stateHash());
  assert.equal(mk().dispatch({ type: 'lab.order', kind: 'potassium' }).ok, false);
});

test('replay reproduces the same laboratory results', () => {
  const p = mk({}, { seed: 7 });
  p.dispatch({ type: 'lab.order', kind: 'abg' }); p.run(400);
  const log = p.log.map(e => ({ ...e }));
  const q = replay({ spec: p.spec, seed: 7, scenario: null, log, until: p.t }, SCENARIOS);
  assert.deepEqual(q.labResults().map(l => l.values), p.labResults().map(l => l.values));
});
