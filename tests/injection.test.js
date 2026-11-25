// How an injection is given and timed on screen (src/web/injection.js), and the slow doses on a syringe driver (syringe.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { injectionPlan, injectionPhases, PUMP_S } from '../src/web/injection.js';
import { syringePumps } from '../src/web/syringe.js';
import { mk } from './helpers/bots.js';

const B = (drug, extra = {}) => ({ type: 'drug.bolus', drug, amount: 1, ...extra });

test('each drug is given the way it is at the bedside: rapid with a big flush, slow push, syringe driver, IM, nebuliser', () => {
  const ad = injectionPlan(B('adenosine')); assert.ok(ad.pushS <= 2 && ad.flushMl === 20, 'adenosine: rapid push and a 20 mL flush');
  assert.ok(injectionPlan(B('rocuronium')).pushS <= 5, 'RSI relaxant: a rapid bolus');
  const pr = injectionPlan(B('propofol')); assert.ok(pr.pushS >= 20 && pr.pushS <= 60 && !pr.pump, 'induction over ~30 s by hand');
  assert.ok(injectionPlan(B('lorazepam')).pushS >= 120, 'lorazepam at most 2 mg/min');
  const mg = injectionPlan(B('magnesium')); assert.ok(mg.pump && mg.pushS >= 600, 'magnesium out of arrest: 10-15 min on a driver');
  const mgA = injectionPlan(B('magnesium'), true); assert.ok(!mgA.pump && mgA.pushS <= 120 && mgA.flushMl === 20, 'in arrest: pushed, then a 20 mL flush');
  assert.ok(injectionPlan(B('epinephrine'), true).pushS <= 5, 'adrenaline in arrest: fast');
  assert.equal(injectionPlan(B('potassiumChloride')).pump, true, 'potassium is never pushed');
  assert.equal(injectionPlan(B('epinephrine', { route: 'im' })).route, 'im');
  assert.equal(injectionPlan(B('salbutamol')).route, 'neb');
  for (const d of ['propofol', 'adenosine', 'rocuronium', 'labetalol']) assert.ok(injectionPlan(B(d)).pushS <= PUMP_S);
});

test('the phases follow each other (clean, connect, push, flush, leave) and speed shortens what is shown', () => {
  const plan = injectionPlan(B('fentanyl')), p1 = injectionPhases(plan, 1), p10 = injectionPhases(plan, 10);
  for (const ph of [p1, p10]) { const order = ['swab', 'connect', 'push', 'flush', 'leave']; order.forEach((k, i) => { assert.ok(ph[k][0] <= ph[k][1]); if (i) assert.equal(ph[k][0], ph[order[i - 1]][1]); }); }
  assert.ok(p1.push[1] - p1.push[0] >= plan.pushS - 1e-9, 'real time at 1x');
  assert.ok(p10.dur < p1.dur / 3, 'at 10x the push is shown ten times faster');
});

test('a slow dose runs on its own syringe driver, emptying evenly, then shows stopped', () => {
  const p = mk(); p.dispatch({ type: 'iv.access' }); p.dispatch({ type: 'drug.bolus', drug: 'magnesium', amount: 2 });
  p.run(450); let q = syringePumps(p).find(x => x.drug === 'magnesium');
  assert.ok(q && q.running && q.ml > 20 && q.ml < 30, `half way: ${q?.ml}`);
  p.run(500); q = syringePumps(p).find(x => x.drug === 'magnesium'); assert.ok(q && !q.running && q.ml === 0);
  const r = mk(); r.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 50 }); assert.equal(syringePumps(r).length, 0, 'a push by hand is not a pump');
});
