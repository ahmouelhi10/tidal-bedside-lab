// Electrolytes and glucose: clinical target bands for each intervention, and determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { replay } from '../src/engine/patient.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { TURNAROUND_S } from '../src/engine/labs.js';

const peak = (p, key, seconds, sign = 1) => { let best = p.lytes[key]; for (let i = 0; i < seconds; i++) { p.run(1); best = sign > 0 ? Math.max(best, p.lytes[key]) : Math.min(best, p.lytes[key]); } return best; };

test('healthy adult: K, Na, ionised Ca and glucose within the adult reference intervals', () => {
  const s = mk().run(60).snapshot();
  assert.ok(s.k >= 3.5 && s.k <= 5.0, `K ${s.k}`);
  assert.ok(s.na >= 135 && s.na <= 145, `Na ${s.na}`);
  assert.ok(s.ica >= 1.15 && s.ica <= 1.33, `iCa ${s.ica}`);
  assert.ok(s.glucose >= 3.9 && s.glucose <= 7.8, `glucose ${s.glucose}`);
});

test('succinylcholine 1 mg/kg raises K by about 0.5 mmol/L within minutes, then it returns toward baseline', () => {
  const p = mk(), k0 = p.lytes.k;
  p.dispatch({ type: 'iv.access' });
  p.dispatch({ type: 'drug.bolus', drug: 'succinylcholine', amount: 80 });
  const rise = peak(p, 'k', 600) - k0;
  assert.ok(rise >= 0.3 && rise <= 0.8, `rise ${rise.toFixed(2)} mmol/L (label: ~0.5)`);
  p.run(2400);
  assert.ok(p.lytes.k - k0 < 0.1, 'back near baseline after 50 min');
});

test('insulin-glucose in hyperkalaemia: K falls 0.5-1.2 mmol/L at 60 min, glucose rises first then falls', () => {
  const p = mk({ causes: ['hyperkalemia'] }), k0 = p.lytes.k, g0 = p.lytes.glucose;
  assert.ok(k0 >= 6.5, `hyperkalaemic case starts at K ${k0} (>= 6.5)`);
  p.dispatch({ type: 'procedure.treat_hyperkalemia' });
  p.run(600);
  assert.ok(p.lytes.glucose > g0 + 2, `glucose ${p.lytes.glucose.toFixed(1)} after 25 g dextrose`);
  p.run(3000);
  const drop = k0 - p.lytes.k;
  assert.ok(drop >= 0.5 && drop <= 1.2, `K drop ${drop.toFixed(2)} at 60 min (Harel 2016: ~0.6-1.0)`);
  p.run(3600);
  assert.ok(p.lytes.glucose < g0, `glucose ${p.lytes.glucose.toFixed(1)} below baseline at 2 h: hypoglycaemia risk`);
});

test('calcium chloride 1 g raises ionised calcium transiently', () => {
  const p = mk(), c0 = p.lytes.ica;
  p.dispatch({ type: 'iv.access' });
  p.dispatch({ type: 'drug.bolus', drug: 'calciumChloride', amount: 1000 });
  const rise = peak(p, 'ica', 120) - c0;
  assert.ok(rise >= 0.1 && rise <= 0.5, `iCa +${rise.toFixed(2)} mmol/L`);
  p.run(1800);
  assert.ok(p.lytes.ica - c0 < 0.05, 'back to baseline after 30 min');
});

test('rapid transfusion lowers ionised calcium, and hypothermia slows its recovery', () => {
  const run = (cold) => {
    const p = mk(); if (cold) p.therm.tc = 33;
    for (let i = 0; i < 6; i++) p.dispatch({ type: 'blood.transfuse', kind: 'prbc' });
    const low = peak(p, 'ica', 60, -1); p.run(540);
    return { low, at10: p.lytes.ica };
  };
  const warm = run(false), cold = run(true);
  assert.ok(warm.low < 1.15, `iCa ${warm.low.toFixed(2)} below 1.15 after 6 units`);
  assert.ok(cold.at10 < warm.at10, `cold ${cold.at10.toFixed(2)} vs warm ${warm.at10.toFixed(2)} at 10 min`);
});

test('bicarbonate (metabolic alkalosis) shifts K into the cells', () => {
  const p = mk(), k0 = p.lytes.k;
  p.dispatch({ type: 'bicarb.bolus', mEq: 100 });
  p.run(300);
  assert.ok(p.lytes.k < k0 - 0.05, `K ${k0.toFixed(2)} -> ${p.lytes.k.toFixed(2)}`);
});

test('the chemistry panel and the blood gas report the electrolytes, flagged against reference intervals', () => {
  const p = mk({ causes: ['hyperkalemia'] });
  p.dispatch({ type: 'lab.order', kind: 'chem' }); p.dispatch({ type: 'lab.order', kind: 'abg' });
  p.run(TURNAROUND_S.chem + 5);
  const [chem, abg] = p.labs;
  assert.equal(chem.flags.k, 'H'); assert.equal(abg.flags.k, 'H');
  assert.ok('na' in chem.values && 'glucose' in chem.values && 'ica' in abg.values);
});

test('electrolyte state is part of the replay hash and replays identically', () => {
  const a = mk({}, { seed: 4 }), b = mk({}, { seed: 4 });
  a.dispatch({ type: 'blood.transfuse', kind: 'prbc' }); a.run(30);
  b.run(30);
  assert.notEqual(a.stateHash(), b.stateHash());
  const q = replay({ spec: a.spec, seed: 4, scenario: null, log: a.log.map(e => ({ ...e })), until: a.t }, SCENARIOS);
  assert.equal(q.stateHash(), a.stateHash());
  assert.equal(q.lytes.ica, a.lytes.ica);
});
