// Coagulation (dilution, lethal triad, blood products) and the cardiac effects of potassium and calcium.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { coagStatus, triadFactor, inrOf } from '../src/engine/coag.js';
import { hyperkHazard } from '../src/engine/electrolytes.js';
import { TURNAROUND_S } from '../src/engine/labs.js';

/** bleed 150 mL/min, crystalloid and red cells only (plasma-poor replacement); returns blood-volume fractions lost when
 *  fibrinogen falls to 1 g/L and platelets to 50 x10^9/L */
function plasmaPoorReplacement() {
  const p = mk(), bv = p.vol.bloodVolume; let fib1 = null, plt50 = null;
  p.dispatch({ type: 'bleed.set', mlPerMin: 150 });
  for (let m = 1; m <= 110 && plt50 === null; m++) {
    p.run(60);
    if (m % 2 === 0) p.dispatch({ type: 'fluid.bolus', volumeL: 0.25, minutes: 2 });
    if (p.vol.hb < 8) p.dispatch({ type: 'blood.transfuse', kind: 'prbc' });
    const c = coagStatus(p.vol), lost = p.vol.totalLost / bv;
    if (fib1 === null && c.fib <= 1.0) fib1 = lost;
    if (plt50 === null && c.plt <= 50) plt50 = lost;
  }
  return { fib1, plt50 };
}

test('healthy adult: normal INR, fibrinogen and platelets, full clotting function', () => {
  const c = coagStatus(mk().vol);
  assert.ok(c.inr >= 0.9 && c.inr <= 1.1 && c.fib >= 2.0 && c.fib <= 4.0 && c.plt >= 150 && c.plt <= 400, JSON.stringify(c));
  assert.equal(c.fn, 1);
});

test('plasma-poor replacement of a large haemorrhage: fibrinogen then platelets reach critical levels in the published order', () => {
  const { fib1, plt50 } = plasmaPoorReplacement();
  assert.ok(fib1 >= 1.0 && fib1 <= 1.8, `fibrinogen 1 g/L after ${fib1?.toFixed(2)} blood volumes (Hiippala 1995: ~1.4)`);
  assert.ok(plt50 >= 1.8 && plt50 <= 2.8, `platelets 50 after ${plt50?.toFixed(2)} blood volumes (Hiippala 1995: ~2.3)`);
  assert.ok(fib1 < plt50, 'fibrinogen fails first');
});

test('INR 1.5 corresponds to roughly a third of normal factor activity', () => {
  assert.ok(inrOf(0.35) > 1.4 && inrOf(0.35) < 1.7);
  assert.ok(Math.abs(inrOf(1) - 1) < 1e-9);
});

test('lethal triad: cold and acidosis impair clotting in vivo, but the laboratory INR (measured at 37 C) does not show it', () => {
  assert.ok(triadFactor(37, 7.4) === 1);
  const f = triadFactor(34, 7.2);
  assert.ok(f > 0.25 && f < 0.5, `activity ${f.toFixed(2)} at 34 C, pH 7.2`);
  const p = mk(); p.dispatch({ type: 'fluid.bolus', volumeL: 3, minutes: 30 }); p.run(1800);
  const warm = coagStatus(p.vol, 37, 7.4), cold = coagStatus(p.vol, 33, 7.15);
  assert.equal(warm.inr, cold.inr, 'same laboratory INR');
  assert.ok(cold.fn < warm.fn, `in-vivo function ${cold.fn.toFixed(2)} < ${warm.fn.toFixed(2)}`);
});

test('a coagulopathy makes the same source bleed more; FFP, cryoprecipitate and platelets correct it', () => {
  const run = (fix) => {
    const p = mk(); p.dispatch({ type: 'bleed.set', mlPerMin: 150 });
    for (let m = 0; m < 30; m++) { p.run(60); if (m % 2) p.dispatch({ type: 'fluid.bolus', volumeL: 0.3, minutes: 2 }); if (fix && m % 3 === 0) { p.dispatch({ type: 'blood.transfuse', kind: 'ffp' }); } }
    if (fix) { p.dispatch({ type: 'blood.transfuse', kind: 'cryo' }); p.dispatch({ type: 'blood.transfuse', kind: 'platelets' }); }
    return { p, c: coagStatus(p.vol, p.therm.tc, p.resp.pH) };
  };
  const a = run(false), b = run(true);
  assert.ok(a.c.inr > b.c.inr && a.c.fib < b.c.fib && a.c.plt < b.c.plt, `${JSON.stringify(a.c)} vs ${JSON.stringify(b.c)}`);
  assert.ok(a.p.vol.totalLost > b.p.vol.totalLost, 'the coagulopathic patient lost more blood for the same source');
});

test('the coagulation panel reports INR, aPTT, fibrinogen and platelets after its turnaround', () => {
  const p = mk(); p.dispatch({ type: 'lab.order', kind: 'coag' }); p.run(TURNAROUND_S.coag + 5);
  const [r] = p.labResults();
  assert.deepEqual(Object.keys(r.values), ['inr', 'aptt', 'fib', 'plt']);
  assert.ok(Object.values(r.flags).every(f => f === ''), JSON.stringify(r));
});

test('hyperkalaemia: ECG changes in the textbook order, calcium removes them and the arrest risk without lowering K', () => {
  const e = (k) => { const p = mk({ potassium: k }); return p.lytes.ecg(); };
  assert.ok(e(4.2).tAmp === 1 && e(4.2).qrsWide === 0);
  assert.ok(e(6.3).tAmp > 1.5 && e(6.3).qrsWide === 0, 'peaked T first');
  assert.ok(e(7.6).qrsWide > 0.3 && e(7.6).pAmp < 0.7, 'then flat P and wide QRS');
  assert.ok(e(9.2).sine > 0.5, 'sine wave');
  assert.equal(hyperkHazard(6.8), 0);
  assert.ok(hyperkHazard(8.0) > 4 * hyperkHazard(7.1));
  const p = mk({ potassium: 7.8 }), k0 = p.lytes.k;
  p.dispatch({ type: 'iv.access' }); p.dispatch({ type: 'drug.bolus', drug: 'calciumChloride', amount: 1000 }); p.run(30);
  assert.ok(Math.abs(p.lytes.k - k0) < 0.2, 'calcium does not lower the potassium');
  assert.ok(p.lytes.kEff < 6.5 && p.lytes.ecg().qrsWide === 0 && p.lytes.arrestHazard() === 0, 'but protects the heart');
});

test('untreated severe hyperkalaemia stops the heart within minutes; the arrest is attributed to it', () => {
  let arrests = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const p = mk({ potassium: 8.4 }, { seed }); p.run(600);
    if (p.arrest.arrested) { arrests++; assert.equal(p.arrest.causes.hyperkalemia, true); }
  }
  assert.ok(arrests >= 6, `${arrests}/8 arrested within 10 min at K 8.4`);
  const q = mk({ potassium: 4.0 }); q.run(600); assert.equal(q.arrest.arrested, false);
});
