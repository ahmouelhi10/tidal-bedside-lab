// Blood gas chloride and anion gap, age-adjusted PaO2, calcium gluconate, potassium chloride, glucagon, flumazenil, neostigmine,
// train-of-four, CRB-65, atrial flutter and AV blocks 1 and 2: clinical target bands, replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { replay } from '../src/engine/patient.js';
import { sampleValues, flags } from '../src/engine/labs.js';
import { scores, trainOfFour, curb65, ecg12 } from '../src/engine/clinical.js';

const mon = (p) => { p.dispatch({ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, nibp: true, capnography: true } }); p.dispatch({ type: 'nibp.cycle' }); return p; };

test('blood gas: chloride 98-106 and anion gap 8-16 when healthy; lactic acidosis widens the gap; normal PaO2 limit falls with age', () => {
  const p = mk(); p.run(60); const v = sampleValues('abg', p), f = flags(v, 'M', 50);
  assert.ok(v.cl >= 98 && v.cl <= 106 && v.ag >= 8 && v.ag <= 16, `Cl ${v.cl}, AG ${v.ag}`); assert.equal(f.cl + f.ag, '');
  const s = mk({}, { seed: 2 }); s.dispatch({ type: 'bleed.set', mlPerMin: 200 }); s.run(1500);
  const w = sampleValues('abg', s); assert.ok(w.lactate > 2 && Math.abs(w.ag - (12 + w.lactate - 1)) <= 1 && w.ag > v.ag, `lactate ${w.lactate}, AG ${w.ag}`);
  const old = mk({ age: 82 }); old.run(60); const o = sampleValues('abg', old);
  assert.equal(flags(o, 'M', 82).pao2, '', `PaO2 ${o.pao2} at 82 years is normal for age`); assert.equal(flags({ pao2: 75 }, 'M', 30).pao2, 'L');
});

test('calcium gluconate 3 g acts like calcium chloride 1 g; potassium chloride runs over an hour; glucagon raises glucose', () => {
  const a = mk(), b = mk(); a.dispatch({ type: 'drug.bolus', drug: 'calciumChloride', amount: 1000 }); b.dispatch({ type: 'drug.bolus', drug: 'calciumGluconate', amount: 3000 }); a.run(120); b.run(120);
  assert.ok(Math.abs(a.lytes.shield - b.lytes.shield) < 0.05 && Math.abs(a.lytes.ica - b.lytes.ica) < 0.05, `shield ${a.lytes.shield.toFixed(2)} vs ${b.lytes.shield.toFixed(2)}, iCa ${a.lytes.ica.toFixed(2)} vs ${b.lytes.ica.toFixed(2)}`);
  const k = mk({ weightKg: 70 }), k0 = k.lytes.k; k.dispatch({ type: 'drug.bolus', drug: 'potassiumChloride', amount: 20 }); k.run(300);
  assert.ok(k.lytes.k - k0 < 0.05, 'no bolus effect: it runs over 60 min'); k.run(3600);
  assert.ok(k.lytes.k - k0 >= 0.15 && k.lytes.k - k0 <= 0.3, `K +${(k.lytes.k - k0).toFixed(2)} after 20 mmol`);
  const g = mk(); g.dispatch({ type: 'instructor.inject', what: 'hypoglycaemia' }); g.run(60); const g0 = g.lytes.glucose;
  g.dispatch({ type: 'drug.bolus', drug: 'glucagon', amount: 1, route: 'im' }); g.run(1500);
  assert.ok(g.lytes.glucose - g0 >= 2 && g.lytes.glucose - g0 <= 5, `glucose ${g0.toFixed(1)} -> ${g.lytes.glucose.toFixed(1)} 25 min after glucagon 1 mg`);
});

test('flumazenil reverses midazolam sedation within minutes', () => {
  const p = mon(mk({ weightKg: 70 })); p.dispatch({ type: 'drug.bolus', drug: 'midazolam', amount: 12 }); p.run(300);
  const g0 = scores(p).gcs; assert.ok(g0 <= 12, `GCS ${g0} after midazolam`);
  p.dispatch({ type: 'drug.bolus', drug: 'flumazenil', amount: 500 }); p.run(120);
  assert.ok(scores(p).gcs >= 14, `GCS ${scores(p).gcs} 2 min after flumazenil 0.5 mg`);
});

test('train-of-four and neostigmine: reversal from a count of 2 in 10-20 min, not from a deep block; bradycardia without atropine', () => {
  const anaest = () => { const p = mk({ weightKg: 70 }); p.dispatch({ type: 'iv.access' }); p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 140 }); p.dispatch({ type: 'drug.infusion', drug: 'propofol', rate: 6 }); p.dispatch({ type: 'airway.set', device: 'bvm' }); p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: 500, fio2: 1, peep: 5, seal: 0.95 } }); return p; };
  const p = anaest(); assert.equal(trainOfFour(p).count, 4); p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 42 }); p.run(180);
  assert.ok(trainOfFour(p).count <= 1, 'intubating block after 0.6 mg/kg');
  while (trainOfFour(p).count < 2) p.run(10);
  const hr0 = p.circ.hr; p.dispatch({ type: 'drug.bolus', drug: 'neostigmine', amount: 3500 }); let tr = null, hrMin = hr0;
  for (let s = 10; s <= 1800 && tr == null; s += 10) { p.run(10); hrMin = Math.min(hrMin, p.circ.hr); if (trainOfFour(p).extubationReady) tr = s; }
  assert.ok(tr >= 600 && tr <= 1200, `TOF ratio >= 0.9 ${tr} s after neostigmine`); assert.ok(hrMin < hr0 - 10, `HR ${hr0.toFixed(0)} -> ${hrMin.toFixed(0)}`);
  const d = anaest(); d.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 84 }); d.run(300); d.dispatch({ type: 'drug.bolus', drug: 'neostigmine', amount: 3500 }); d.run(600);
  assert.equal(trainOfFour(d).extubationReady, false, 'neostigmine cannot reverse a deep block');
  const s = anaest(); s.dispatch({ type: 'drug.bolus', drug: 'succinylcholine', amount: 100 }); s.run(150); const t = trainOfFour(s);
  assert.equal(t.depolarising, true); s.run(400); assert.ok(trainOfFour(s).ratio == null || trainOfFour(s).ratio >= 0.9 || trainOfFour(s).count < 4, 'no fade with succinylcholine');
});

test('CRB-65: age >= 65 scores 1 in a healthy patient; CURB-65 needs a urea result', () => {
  const p = mon(mk({ age: 70 })); p.run(60); const c = curb65(p);
  assert.equal(c.crb65, 1); assert.equal(c.curb65, null);
  p.dispatch({ type: 'lab.order', kind: 'renal' }); p.run(2800); assert.equal(curb65(p).curb65, 1);
});

test('atrial flutter 2:1 at ~150, slowed by adenosine and beta-blockade, converted by a synchronised shock; AV blocks 1 and 2', () => {
  const f = mon(mk({}, { seed: 3 })); f.dispatch({ type: 'iv.access' }); f.dispatch({ type: 'instructor.inject', what: 'flutter' }); f.run(60);
  assert.ok(Math.abs(f.circ.hr - 150) < 8, `flutter HR ${f.circ.hr.toFixed(0)}`); assert.ok(ecg12(f).findings.includes('rhythm_flutter'));
  f.dispatch({ type: 'drug.bolus', drug: 'adenosine', amount: 6 }); let lo = 999; for (let i = 0; i < 40; i++) { f.run(1); lo = Math.min(lo, f.circ.hr); }
  assert.ok(lo < 100 && f.arrest.key === 'FLUTTER', `adenosine slows (${lo.toFixed(0)}) but does not convert`);
  f.dispatch({ type: 'drug.bolus', drug: 'metoprolol', amount: 5 }); f.run(600); assert.ok(f.circ.hr < 125, `metoprolol: ${f.circ.hr.toFixed(0)}`);
  let conv = 0; for (let s = 1; s <= 10; s++) { const q = mk({}, { seed: s }); q.dispatch({ type: 'instructor.inject', what: 'flutter' }); q.dispatch({ type: 'defib.pads' }); q.dispatch({ type: 'defib.mode', mode: 'sync' }); q.dispatch({ type: 'defib.setEnergy', energy: 100 }); q.dispatch({ type: 'defib.charge' }); q.run(5); q.dispatch({ type: 'defib.shock' }); if (q.arrest.key === 'NSR') conv++; }
  assert.ok(conv >= 7, `synchronised 100 J converted ${conv}/10`);
  const a1 = mon(mk()); a1.dispatch({ type: 'instructor.inject', what: 'avblock1' }); a1.run(30); assert.ok(ecg12(a1).findings.includes('rhythm_av_block1') && a1.circ.hr > 55);
  const a2 = mon(mk()); a2.dispatch({ type: 'iv.access' }); a2.dispatch({ type: 'instructor.inject', what: 'avblock2' }); a2.run(60); const h2 = a2.circ.hr;
  assert.ok(h2 >= 32 && h2 <= 48, `Mobitz II 2:1: ${h2.toFixed(0)}`);
  a2.dispatch({ type: 'drug.bolus', drug: 'atropine', amount: 500 }); a2.run(480); assert.ok(a2.circ.hr - h2 < 15, `atropine +${(a2.circ.hr - h2).toFixed(0)} only`);
  a2.dispatch({ type: 'defib.pads' }); a2.dispatch({ type: 'pacing.set', on: true, rate: 70, mA: 100 }); a2.run(30); assert.ok(Math.abs(a2.circ.hr - 70) < 5, 'pacing captures');
});

test('new drugs and rhythms replay to the same hash', () => {
  const p = mk({}, { seed: 9 });
  for (const e of [{ type: 'drug.bolus', drug: 'calciumGluconate', amount: 3000 }, { type: 'drug.bolus', drug: 'potassiumChloride', amount: 10 }, { type: 'drug.bolus', drug: 'glucagon', amount: 1, route: 'im' }, { type: 'drug.bolus', drug: 'midazolam', amount: 3 }, { type: 'drug.bolus', drug: 'flumazenil', amount: 200 }, { type: 'instructor.inject', what: 'flutter' }, { type: 'drug.bolus', drug: 'adenosine', amount: 6 }]) { p.dispatch(e); p.run(20); }
  p.run(200);
  const q = replay({ spec: p.spec, seed: 9, scenario: null, log: p.log.map(e => ({ ...e })), until: p.t }, {});
  assert.equal(q.stateHash(), p.stateHash());
});

test('0.9 % saline 60 mL/kg causes a normal-gap hyperchloraemic acidosis; balanced fluid does not; magnesium sulfate raises serum Mg', () => {
  const g = (fluid) => { const p = mk({ weightKg: 70 }); p.dispatch({ type: 'fluid.bolus', volumeL: 4.2, minutes: 120, fluid }); p.run(7200); return sampleValues('abg', p); };
  const s = g('saline'), b = g('balanced');
  // awake and breathing, the patient compensates by breathing more (Scheingraber's patients were ventilated: pH 7.28), so the metabolic values are tested
  assert.ok(s.be <= -5 && s.be >= -9 && s.cl >= 108 && s.ag <= 14 && s.ph < b.ph - 0.03, `saline: pH ${s.ph}, BE ${s.be}, Cl ${s.cl}, AG ${s.ag} (Scheingraber 1999: BE -6.7)`);
  assert.ok(b.ph >= 7.36 && b.be > -2, `balanced: pH ${b.ph}, BE ${b.be}`);
  const m = mk(), m0 = m.lytes.mg; assert.equal(flags(sampleValues('chem', m), 'M', 50).mg, '');
  m.dispatch({ type: 'drug.bolus', drug: 'magnesium', amount: 2 }); m.run(300); assert.ok(m.lytes.mg - m0 >= 0.3 && m.lytes.mg - m0 <= 0.7, `Mg +${(m.lytes.mg - m0).toFixed(2)}`);
});

test('haemorrhage: lactate follows the ATLS classes (normal < 15 %, rising in class III, high in class IV, bounded)', () => {
  const p = mk({ weightKg: 80 }); p.dispatch({ type: 'bleed.set', mlPerMin: 100 }); const at = {};
  for (let i = 0; i < 80; i++) { p.run(30); const f = p.vol.fractionLost; for (const th of [0.15, 0.4, 0.5]) if (f >= th && at[th] == null) at[th] = p.resp.lactate; }
  assert.ok(at[0.15] < 1.5 && at[0.4] >= 2.5 && at[0.4] <= 6 && at[0.5] >= 4 && at[0.5] <= 10, JSON.stringify(at));
  assert.ok(p.resp.lactate <= 25);
});

test('Wenckebach 4:3 at ~3/4 of the sinus rate, improved by atropine; bundle branch blocks widen the QRS to >= 120 ms with the right findings', () => {
  const w = mon(mk()); w.dispatch({ type: 'iv.access' }); w.dispatch({ type: 'instructor.inject', what: 'wenckebach' }); w.run(60);
  const h0 = w.circ.hr; assert.ok(h0 >= 50 && h0 <= 65, `Wenckebach ${h0.toFixed(0)}/min`); assert.ok(ecg12(w).findings.includes('rhythm_av_block2w'));
  w.dispatch({ type: 'drug.bolus', drug: 'atropine', amount: 1000 }); w.run(480); assert.ok(w.circ.hr > h0 + 15, `atropine: ${h0.toFixed(0)} -> ${w.circ.hr.toFixed(0)}`);
  const n = mon(mk()); n.run(10); const e0 = ecg12(n); assert.ok(e0.qrs < 110 && !e0.findings.includes('lbbb'));
  n.dispatch({ type: 'instructor.inject', what: 'lbbb' }); const l = ecg12(n);
  assert.ok(l.qrs >= 120 && l.findings.includes('lbbb') && l.st.V2 > 0 && l.st.V5 <= 0, `LBBB QRS ${l.qrs}, ST V2 ${l.st.V2}`);
  n.dispatch({ type: 'instructor.inject', what: 'rbbb' }); const r = ecg12(n); assert.ok(r.qrs >= 120 && r.findings.includes('rbbb') && !r.findings.includes('lbbb'));
  n.dispatch({ type: 'instructor.inject', what: 'bbb_off' }); assert.ok(ecg12(n).qrs < 110);
  n.dispatch({ type: 'instructor.inject', what: 'lbbb' }); n.dispatch({ type: 'instructor.inject', what: 'vf' }); assert.ok(!ecg12(n).findings.includes('lbbb'), 'no bundle branch block reading in VF');
  const p = mk({}, { seed: 5 }); p.dispatch({ type: 'instructor.inject', what: 'wenckebach' }); p.dispatch({ type: 'instructor.inject', what: 'rbbb' }); p.run(120);
  const q = replay({ spec: p.spec, seed: 5, scenario: null, log: p.log.map(e => ({ ...e })), until: p.t }, {}); assert.equal(q.stateHash(), p.stateHash());
});

test('vagal manoeuvres convert SVT: modified Valsalva ~43 %, standard ~17 % (REVERT); nothing in sinus rhythm', () => {
  let mod = 0, std = 0; const N = 60;
  for (let s = 1; s <= N; s++) {
    const a = mk({ rhythm: 'SVT' }, { seed: s }); if (a.dispatch({ type: 'procedure.vagal', technique: 'modified' }).converted) mod++;
    const b = mk({ rhythm: 'SVT' }, { seed: s + 100 }); if (b.dispatch({ type: 'procedure.vagal', technique: 'standard' }).converted) std++;
  }
  assert.ok(mod / N >= 0.28 && mod / N <= 0.58 && std / N <= 0.32 && mod > std, `modified ${mod}/${N}, standard ${std}/${N}`);
  const n = mk(); assert.equal(n.dispatch({ type: 'procedure.vagal' }).converted, false); assert.equal(n.arrest.key, 'NSR');
  const c = mk(); c.run(10); assert.equal(sampleValues('cbg', c).glucose, +c.lytes.glucose.toFixed(1));
});
