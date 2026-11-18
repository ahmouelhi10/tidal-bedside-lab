// Sodium balance and hypertonic saline, 12-lead patterns, pulmonary oedema, titratable antihypertensives, variceal bleeding:
// clinical target bands (REF adrogue2000, spasovski2014, surawicz2009, thygesen2018, esc_hf2021, esc_htn2018, baveno7, villanueva2013), replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk, scen } from './helpers/bots.js';
import { replay } from '../src/engine/patient.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { ecg12, scores, cardiacValues } from '../src/engine/clinical.js';

test('sodium follows the fluids as Adrogue-Madias predicts; 150 mL of 3 % saline raises it ~2 mmol/L in a small woman', () => {
  const a = mk({ sex: 'M', age: 40, weightKg: 70 }); a.dispatch({ type: 'fluid.bolus', volumeL: 1, minutes: 30, fluid: 'glucose5' }); a.run(1900);
  const expA = (0 - 140) / (0.6 * 70 + 1);                             // change per litre of infusate
  assert.ok(Math.abs((a.lytes.na - 140) - expA) < 0.4, `glucose 5 %: ${(a.lytes.na - 140).toFixed(2)} vs ${expA.toFixed(2)}`);
  const b = mk({ sex: 'M', age: 40, weightKg: 70 }); b.dispatch({ type: 'fluid.bolus', volumeL: 1, minutes: 30, fluid: 'saline' }); b.run(1900);
  assert.ok(b.lytes.na > 140 && b.lytes.na < 141, `0.9 % saline barely moves a normal sodium: ${b.lytes.na.toFixed(1)}`);
  const p = mk({ sex: 'F', age: 72, heightCm: 160, weightKg: 62, sodium: 113 }); p.dispatch({ type: 'fluid.bolus', volumeL: 0.15, minutes: 20, fluid: 'saline3' }); p.run(1300);
  assert.ok(p.lytes.na - 113 >= 1.5 && p.lytes.na - 113 <= 3, `+${(p.lytes.na - 113).toFixed(1)} after one bolus`);
  assert.equal(mk().dispatch({ type: 'fluid.bolus', volumeL: 1, minutes: 10, fluid: 'saline3' }).ok, false, 'no litre of 3 % saline');
});

test('severe hyponatraemia: drowsy, seizures within the hour in most; hypernatraemia also lowers consciousness; normal sodium does neither', () => {
  const mon = (p) => { p.dispatch({ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, capnography: true } }); p.run(30); return p; };
  assert.ok(scores(mon(mk({ sodium: 113 }))).gcs <= 8 && scores(mon(mk({ sodium: 122 }))).gcs <= 13 && scores(mon(mk({ sodium: 170 }))).gcs <= 8 && scores(mon(mk())).gcs === 15);
  let fits = 0; for (let s = 1; s <= 12; s++) { const p = mk({ sodium: 112 }, { seed: s }); p.run(3600); if (p.crises.se.ever) fits++; }
  assert.ok(fits >= 8, `${fits}/12 seized within an hour at Na 112`);
  const n = mk({}, { seed: 3 }); n.run(3600); assert.equal(n.crises.se.ever, false);
});

test('12-lead patterns: each has its findings; NSTEMI depresses ST and raises troponin; WPW shortens the PR and widens the QRS', () => {
  const base = ecg12(mk()); assert.deepEqual(base.findings, []);
  const one = (k) => ecg12(mk({ ecg: [k] }));
  for (const k of ['wpw', 'lvh', 'lahb', 'nstemi', 'pericarditis', 'wellens', 'bigeminy']) assert.ok(one(k).findings.includes(k), k);
  const ns = one('nstemi'); assert.ok(ns.st.V5 <= -1 && ns.st.V2 === 0 && ns.tinv.includes('V5'), 'lateral ST depression and T inversion');
  const pc = one('pericarditis'); assert.ok(pc.st.II >= 1 && pc.st.V5 >= 1 && pc.st.aVR < 0, 'diffuse elevation, aVR depressed');
  const w = one('wpw'); assert.ok(w.qrs >= 120 && w.morph.prS < 0, `WPW QRS ${w.qrs}`);
  const m = mk({ ecg: ['nstemi'] }); m.run(4 * 3600); assert.ok(cardiacValues(m).tnt > 50 && cardiacValues(mk()).tnt <= 14, `troponin ${cardiacValues(m).tnt}`);
  const v = mk({ ecg: ['lvh'] }); v.dispatch({ type: 'instructor.inject', what: 'vf' }); assert.ok(!ecg12(v).findings.includes('lvh'), 'no pattern reading in VF');
  const i = mk(); i.dispatch({ type: 'instructor.inject', what: 'ecg_pericarditis' }); assert.ok(ecg12(i).findings.includes('pericarditis')); i.dispatch({ type: 'instructor.inject', what: 'ecg_clear' }); assert.deepEqual(ecg12(i).findings, []);
});

test('pulmonary oedema: high wedge pressure, hypoxaemia, fast shallow breathing; CPAP improves the oxygenation, nitrate and furosemide clear it', () => {
  const po = () => { const p = mk({ sex: 'M', age: 74, heightCm: 172, weightKg: 82, lvFunction: 0.5, map0: 132, congestion: true }); p.vol.vp += 0.6; p.run(900); return p; };
  const a = po(); assert.ok(a.pcwp > 22 && a.oedema > 0.4 && a.resp.spo2 < 90 && a.resp.rr > 20, `PCWP ${a.pcwp.toFixed(0)}, oedema ${a.oedema.toFixed(2)}, SpO2 ${a.resp.spo2.toFixed(0)}, RR ${a.resp.rr.toFixed(0)}`);
  const s0 = a.resp.spo2; a.dispatch({ type: 'niv.set', mode: 'cpap', epap: 8, fio2: 0.4 }); a.run(300);
  const o = po(); o.dispatch({ type: 'o2.mask', fio2: 0.4, seal: 1 }); o.run(300);
  assert.ok(a.resp.spo2 > s0 + 5 && a.resp.spo2 > o.resp.spo2, `CPAP ${a.resp.spo2.toFixed(0)} % vs the same oxygen by mask ${o.resp.spo2.toFixed(0)} %`);
  const e1 = a.oedema, w1 = a.pcwp;
  a.dispatch({ type: 'iv.access' }); a.dispatch({ type: 'drug.infusion', drug: 'nitroglycerin', rate: 50 }); a.dispatch({ type: 'drug.bolus', drug: 'furosemide', amount: 40 }); a.run(1800);
  assert.ok(a.oedema < 0.6 * e1 && a.pcwp < w1 - 4, `after nitrate and furosemide: oedema ${e1.toFixed(2)} -> ${a.oedema.toFixed(2)}, PCWP ${w1.toFixed(0)} -> ${a.pcwp.toFixed(0)}`);
  const f = po(), e0 = f.oedema; f.dispatch({ type: 'fluid.bolus', volumeL: 1, minutes: 15 }); f.run(1200); assert.ok(f.oedema > e0, 'a fluid bolus makes it worse');
  const h = mk({ lvFunction: 0.5 }); h.run(600); assert.equal(h.oedema, 0, 'only in cases that model congestion');
});

test('hypertensive emergency: labetalol titrates the MAP down by 15-30 % with 100-200 mg, without a reflex tachycardia', () => {
  const p = mk({ sex: 'M', age: 58, heightCm: 176, weightKg: 88, map0: 160 }); p.dispatch({ type: 'iv.access' }); p.run(300);
  const m0 = p.circ.mapArt, h0 = p.circ.hr; assert.ok(m0 > 150, `MAP ${m0.toFixed(0)}`);
  p.dispatch({ type: 'drug.bolus', drug: 'labetalol', amount: 20 }); p.run(600); const d20 = 1 - p.circ.mapArt / m0;
  for (const d of [40, 40, 80]) { p.dispatch({ type: 'drug.bolus', drug: 'labetalol', amount: d }); p.run(600); }
  const d180 = 1 - p.circ.mapArt / m0;
  assert.ok(d20 < 0.1 && d180 >= 0.15 && d180 <= 0.3 && d180 > d20 + 0.08, `-${(d20 * 100).toFixed(0)} % after 20 mg, -${(d180 * 100).toFixed(0)} % after 180 mg`);
  assert.ok(p.circ.hr < h0 + 8, `HR ${h0.toFixed(0)} -> ${p.circ.hr.toFixed(0)}`);
});

test('variceal bleeding: terlipressin roughly halves it, over-transfusion increases it, banding stops it, pressure does not', () => {
  const vb = (seed = 1) => { const p = scen('variceal_bleed', seed); p.dispatch({ type: 'iv.access' }); return p; };
  const lost = (p, s) => { const l0 = p.vol.totalLost; p.run(s); return (p.vol.totalLost - l0) * 1000 / (s / 60); };
  const a = vb(), ra = lost(a, 300);
  const b = vb(); b.dispatch({ type: 'drug.bolus', drug: 'terlipressin', amount: 2 }); b.run(120); const rb = lost(b, 300);
  assert.ok(ra > 60 && rb < 0.7 * ra, `bleeding ${ra.toFixed(0)} mL/min, ${rb.toFixed(0)} on terlipressin`);
  const c = vb(); c.dispatch({ type: 'drug.bolus', drug: 'terlipressin', amount: 2 }); for (let i = 0; i < 8; i++) c.dispatch({ type: 'blood.transfuse', kind: 'prbc' }); c.dispatch({ type: 'fluid.bolus', volumeL: 2, minutes: 10 }); c.run(900);
  const d = vb(); d.dispatch({ type: 'drug.bolus', drug: 'terlipressin', amount: 2 }); d.run(900);
  assert.ok(lost(c, 300) > 1.2 * lost(d, 300), 'over-transfusion and over-filling raise the portal pressure');
  assert.equal(a.dispatch({ type: 'bleed.control' }).note != null, true); assert.ok(a.vol.rates.bleed > 0, 'a tourniquet does not reach it');
  let ok = 0; for (let s = 1; s <= 20; s++) { const q = vb(s); if (q.dispatch({ type: 'procedure.endoscopy' }).controlled) ok++; }
  assert.ok(ok >= 15, `banding controlled ${ok}/20`);
  assert.equal(mk().dispatch({ type: 'procedure.endoscopy' }).controlled, false);
});

test('the new cases replay to the same hash', () => {
  for (const id of ['hyponatraemia', 'variceal_bleed', 'pulmonary_oedema']) {
    const p = scen(id, 4);
    for (const e of [{ type: 'iv.access' }, { type: 'fluid.bolus', volumeL: 0.15, minutes: 20, fluid: 'saline3' }, { type: 'drug.bolus', drug: 'terlipressin', amount: 2 }, { type: 'niv.set', mode: 'cpap', epap: 8, fio2: 0.5 }, { type: 'procedure.endoscopy' }, { type: 'instructor.inject', what: 'ecg_wpw' }]) { p.dispatch(e); p.run(30); }
    p.run(300);
    const q = replay({ spec: SCENARIOS[id].spec, seed: 4, scenario: id, log: p.log.map(e => ({ ...e })), until: p.t }, SCENARIOS);
    assert.equal(q.stateHash(), p.stateHash(), id);
  }
});

test('arrest without CPR: arterial blood stagnates, so PaCO2 rises and pH falls instead of reading the washed-out lung gas; pH stays within the analyser range', () => {
  const p = scen('tension_ptx', 1); let maxPh = 0, minArrestPh = 9;
  for (let i = 0; i < 30; i++) { p.run(40); maxPh = Math.max(maxPh, p.resp.pH); if (p.arrest.arrested) minArrestPh = Math.min(minArrestPh, p.resp.pH); }
  assert.ok(p.arrest.arrested, 'untreated tension pneumothorax arrests');
  assert.ok(maxPh < 7.5 && minArrestPh < 7.2 && p.resp.paco2 > 45 && p.resp.etco2 < 5, `max pH ${maxPh.toFixed(2)}, pH in arrest ${minArrestPh.toFixed(2)}, PaCO2 ${p.resp.paco2.toFixed(0)}, EtCO2 ${p.resp.etco2.toFixed(0)}`);
  const d = scen('dka', 1); d.run(14400); assert.ok(d.resp.pH >= 6.5 && d.resp.pH <= 8.0, `pH ${d.resp.pH.toFixed(2)}`);
});

test('status epilepticus scoring follows the seizure timeline: a stop then a recurrence is not counted as one long seizure', async () => {
  const { scoreSession } = await import('../src/engine/scenarios.js');
  const p = scen('status_epilepticus', 8);
  p.dispatch({ type: 'o2.mask', fio2: 0.85, seal: 0.9 }); p.dispatch({ type: 'drug.bolus', drug: 'midazolam', amount: 10, route: 'im' }); p.dispatch({ type: 'iv.access' }); p.dispatch({ type: 'lab.order', kind: 'abg' });
  p.run(2700);
  const s = scoreSession(p), item = (id) => s.items.find(i => i.id === id), log = p.seLog;
  const firstStop = log.find(e => !e.on), recurred = log.filter(e => e.on).length > 1;
  if (firstStop) assert.match(item('se_stopped').detail, new RegExp(`stopped at ${Math.round(firstStop.t / 60)} min`), 'the first stop is reported, not the last');
  if (!recurred && firstStop && firstStop.t < 600 + 30) assert.equal(item('se_second'), undefined, 'no second-line drug required when it stopped and never came back');
  if (recurred) assert.ok(item('se_second'), 'a recurrence requires the second-line drug');
});
