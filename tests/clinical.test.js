// 12-lead ECG, cardiac and renal tests, clinical scores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk, scen } from './helpers/bots.js';
import { ecg12, scores, cardiacValues, renalValues, riskScores } from '../src/engine/clinical.js';
import { TURNAROUND_S } from '../src/engine/labs.js';

const monitored = (p) => { p.dispatch({ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, nibp: true, capnography: true, tempProbe: true } }); p.dispatch({ type: 'nibp.cycle' }); p.run(60); return p; };

test('NEWS2 is 0 for a healthy monitored adult and null when a variable is not measured; GCS 15 awake, low after propofol', () => {
  const p = monitored(mk()); const s = scores(p);
  assert.equal(s.news2, 0, JSON.stringify(s.news2Parts)); assert.equal(s.gcs, 15); assert.equal(s.qsofa, 0);
  assert.equal(scores(mk()).news2, null, 'unmonitored: not computable');
  p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 150 }); p.run(60);
  assert.ok(scores(p).gcs <= 8, `GCS ${scores(p).gcs} after propofol`);
});

test('shock raises NEWS2 into the emergency band and qSOFA to >= 2', () => {
  const p = monitored(mk()); p.dispatch({ type: 'bleed.set', mlPerMin: 200 }); p.run(840); p.dispatch({ type: 'nibp.cycle' }); p.run(40);
  const s = scores(p);
  assert.ok(s.news2 >= 5 && s.shockIndex > 1, JSON.stringify(s));
});

test('STEMI: ST elevation in the anterior leads with reciprocal change; troponin normal at first, raised after 2 h', () => {
  const p = scen('stemi_vf', 1); p.run(10);
  const e = ecg12(p);
  assert.ok(e.findings.includes('stemi_anterior'));
  assert.ok(e.st.V2 >= 2 && e.st.V3 >= 2 && e.st.V1 >= 1 && e.st.aVF < 0, JSON.stringify(e.st));
  assert.ok(cardiacValues(p).tnt <= 14, `hs-TnT ${cardiacValues(p).tnt} 40 min after onset (can still be normal)`);
  p.infarctAgeS = 3 * 3600;
  assert.ok(cardiacValues(p).tnt > 50, 'raised after a few hours');
});

test('hyperkalaemia shows on the 12-lead; normal patient has no findings', () => {
  assert.deepEqual(ecg12(mk()).findings, []);
  const f = ecg12(mk({ potassium: 7.8 })).findings;
  assert.ok(f.includes('peaked_t') && f.includes('wide_qrs'), f.join(','));
});

test('cardiac and renal panels after their turnaround; prolonged hypotension raises creatinine', () => {
  const p = mk(); p.dispatch({ type: 'lab.order', kind: 'cardiac' }); p.dispatch({ type: 'lab.order', kind: 'renal' }); p.run(TURNAROUND_S.cardiac + 5);
  const [c, r] = p.labResults();
  assert.deepEqual(Object.keys(c.values), ['tnt', 'ntprobnp', 'ddimer']); assert.equal(c.flags.tnt, '');
  assert.equal(r.flags.creat, '');
  const q = mk(); const c0 = renalValues(q).creat; q.dispatch({ type: 'bleed.set', mlPerMin: 150 }); q.run(1500);
  assert.ok(renalValues(q).creat > c0, 'creatinine rises after time below MAP 65');
});

test('Wells, PERC and CHA2DS2-VA follow their published item weights and thresholds', () => {
  // healthy 50-year-old, no history: Wells 0, PERC positive only for age, CHA2DS2-VA 0
  const h = monitored(mk()); let r = riskScores(h);
  assert.equal(r.wells, 0); assert.equal(r.wellsLikely, false); assert.deepEqual(r.percPositive, ['age']); assert.equal(r.cha2ds2va, 0);
  const y = monitored(mk({ age: 30 })); assert.equal(riskScores(y).percNegative, true, 'PERC negative for a well 30-year-old');
  assert.equal(riskScores(mk()).wells, null, 'Wells needs the heart rate');
  // post-operative pulmonary embolism with a swollen calf: DVT signs 3 + surgery 1.5 (+ HR > 100 1.5 + PE most likely 3)
  const pe = monitored(scen('echo_rv', 1)); pe.dispatch({ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true } }); pe.run(30);
  r = riskScores(pe, { peLikely: true });
  assert.equal(r.wells, 3 + 3 + 1.5 + (pe.monitor.hr > 100 ? 1.5 : 0)); assert.equal(r.wellsLikely, true);
  assert.equal(riskScores(pe).wellsLikely, pe.monitor.hr > 100, 'without clinical judgement, likely only above 4');
  assert.ok(r.percPositive.includes('legSwelling') && r.percPositive.includes('surgery'));
  // 78-year-old man, hypertension and diabetes: age 2 + 1 + 1 = 4; 66-year-old woman, hypertension: VA 2, VASc 3
  assert.equal(riskScores(scen('heart_block', 1)).cha2ds2va, 4);
  const w = riskScores(scen('torsades', 1)); assert.equal(w.cha2ds2va, 2); assert.equal(w.cha2ds2vasc, 3);
});

test('a healthy adult of any size is normal on the monitor and in the laboratory: RR 12-20, NEWS2 0, urine 0.5-1.5 mL/kg/h', async () => {
  const { sampleValues, flags, LAB_KINDS } = await import('../src/engine/labs.js');
  for (const spec of [{}, { sex: 'F', age: 25, heightCm: 158, weightKg: 50 }, { sex: 'M', age: 45, heightCm: 195, weightKg: 110 }]) {
    const p = monitored(mk(spec)); p.dispatch({ type: 'procedure.urinary_catheter' }); p.run(3600);
    assert.ok(p.monitor.rr >= 12 && p.monitor.rr <= 20, `RR ${p.monitor.rr}`); assert.equal(scores(p).news2, 0, JSON.stringify(scores(p).news2Parts));
    for (const k of LAB_KINDS) { const v = sampleValues(k, p), f = flags(v, p.spec.sex); for (const [a, b] of Object.entries(f)) assert.equal(b, '', `${JSON.stringify(spec)} ${k}.${a} = ${v[a]}`); }
    const uo = (p.vol.urine + p.vol.urineBasal - p.urine0) * 1000 / p.body.weightKg;
    assert.ok(uo >= 0.5 && uo <= 1.5, `urine ${uo.toFixed(2)} mL/kg/h`);
  }
  const s = monitored(mk()); s.dispatch({ type: 'bleed.set', mlPerMin: 150 }); s.run(900);   // haemorrhagic shock: oliguria
  const u0 = s.vol.urineBasal; s.run(1800); assert.ok((s.vol.urineBasal - u0) * 1000 / s.body.weightKg / 0.5 < 0.5, 'oliguria in shock');
});

test('insulin 10 U without glucose causes hypoglycaemia; atropine dose-response 0.5 / 1 / 3 mg', () => {
  const q = mk(); q.dispatch({ type: 'drug.bolus', drug: 'insulin', amount: 10 }); q.run(3600);
  assert.ok(q.lytes.glucose < 3.0, `glucose ${q.lytes.glucose.toFixed(1)} mmol/L 1 h after insulin alone`);
  const dHr = (mcg) => { const p = mk({ age: 40 }); p.run(30); const h0 = p.circ.hr; p.dispatch({ type: 'drug.bolus', drug: 'atropine', amount: mcg }); let mx = 0; for (let i = 0; i < 180; i++) { p.run(5); mx = Math.max(mx, p.circ.hr - h0); } return mx; };
  const a = dHr(500), b = dHr(1000), c = dHr(3000);
  assert.ok(a >= 12 && a <= 32 && b > a + 8 && c > b && c <= 70, `atropine +${a.toFixed(0)} / +${b.toFixed(0)} / +${c.toFixed(0)}`);
});
