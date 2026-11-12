// NIV and high-flow oxygen, COPD with CO2 retention, metabolic-acidosis breathing, diabetic ketoacidosis, status epilepticus:
// clinical target bands (REF davidson2016_niv, beasley2017_o2, albert1967, jbds2023, glauser2016, silbergleit2012, esett2019), replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { replay } from '../src/engine/patient.js';
import { sampleValues } from '../src/engine/labs.js';

const copd = () => { const p = mk({ sex: 'M', age: 71, heightCm: 172, weightKg: 68, copd: 1 }); p.crises.asthma = 0.8; p.run(2400); return p; };

test('stable COPD: chronic hypercapnia with metabolic compensation (PaCO2 50-60, HCO3 28-33, pH 7.33-7.40)', () => {
  const p = mk({ age: 71, copd: 0.8 }); p.run(600);
  assert.ok(p.resp.paco2 >= 50 && p.resp.paco2 <= 60 && p.resp.hco3 >= 28 && p.resp.hco3 <= 33 && p.resp.pH >= 7.33 && p.resp.pH <= 7.40, `PaCO2 ${p.resp.paco2.toFixed(0)}, HCO3 ${p.resp.hco3.toFixed(0)}, pH ${p.resp.pH.toFixed(2)}`);
});

test('COPD exacerbation: hypercapnic acidosis; controlled oxygen raises PaCO2 less than high-concentration oxygen; BiPAP corrects the acidosis', () => {
  const a = copd(); assert.ok(a.resp.pH < 7.32 && a.resp.paco2 > 60 && a.resp.spo2 < 88, `on air: pH ${a.resp.pH.toFixed(2)}, PaCO2 ${a.resp.paco2.toFixed(0)}, SpO2 ${a.resp.spo2.toFixed(0)}`);
  const c0 = a.resp.paco2;
  const v = copd(); v.dispatch({ type: 'o2.mask', fio2: 0.28, seal: 1 }); v.run(3600);
  const h = copd(); h.dispatch({ type: 'o2.mask', fio2: 0.85, seal: 0.9 }); h.run(3600);
  assert.ok(v.resp.paco2 - c0 <= 12 && h.resp.paco2 - c0 >= v.resp.paco2 - c0 + 3, `PaCO2 +${(v.resp.paco2 - c0).toFixed(0)} on 28 % Venturi, +${(h.resp.paco2 - c0).toFixed(0)} on a non-rebreather`);
  assert.ok(v.resp.spo2 >= 86 && v.resp.spo2 <= 94, `SpO2 ${v.resp.spo2.toFixed(0)} on 28 %`);
  const n = copd(); n.dispatch({ type: 'o2.mask', fio2: 0.28, seal: 1 }); n.run(600); const ph0 = n.resp.pH;
  n.dispatch({ type: 'niv.set', mode: 'bipap', ipap: 18, epap: 5, fio2: 0.28 }); n.run(3600);
  assert.ok(n.resp.pH - ph0 >= 0.04 && n.resp.paco2 < v.resp.paco2 - 10, `BiPAP: pH ${ph0.toFixed(2)} -> ${n.resp.pH.toFixed(2)}, PaCO2 ${n.resp.paco2.toFixed(0)}`);
  const t = mk(); t.dispatch({ type: 'airway.intubate' }); assert.equal(t.dispatch({ type: 'niv.set', mode: 'cpap', epap: 25 }).ok, false, 'EPAP limited to 20');
});

test('high-flow nasal oxygen: FiO2 follows the flow, small PEEP and dead-space washout lower the PaCO2 a little', () => {
  const p = mk({ age: 60 }); p.dispatch({ type: 'instructor.inject', what: 'bronchospasm' }); p.run(600); const c0 = p.resp.paco2;
  p.dispatch({ type: 'niv.set', mode: 'hfno', flow: 60, fio2: 0.6 }); p.run(600);
  assert.ok(Math.abs(p.resp.fio2Eff - 0.6) < 0.03 && p.resp.paco2 <= c0, `FiO2 ${p.resp.fio2Eff.toFixed(2)}, PaCO2 ${c0.toFixed(0)} -> ${p.resp.paco2.toFixed(0)}`);
  const q = mk(); q.dispatch({ type: 'instructor.inject', what: 'bronchospasm' }); q.run(600); q.dispatch({ type: 'niv.set', mode: 'hfno', flow: 10, fio2: 0.6 }); q.run(300);
  assert.ok(q.resp.fio2Eff < 0.5, `low flow does not cover inspiration: FiO2 ${q.resp.fio2Eff.toFixed(2)}`);
});

test('metabolic acidosis is compensated by breathing (Winter: PaCO2 = 1.5 HCO3 + 8 +/- 4)', () => {
  const p = mk({ sex: 'F', age: 22, heightCm: 165, weightKg: 55, dka: true, ketones: 5.5, glucose: 28, potassium: 3.6, dehydrationL: 3.5 }); p.run(600);
  const a = sampleValues('abg', p), exp = 1.5 * a.hco3 + 8;
  assert.ok(Math.abs(a.paco2 - exp) <= 4, `HCO3 ${a.hco3}, PaCO2 ${a.paco2}, Winter ${exp.toFixed(0)}`);
});

test('DKA: JBDS picture (pH < 7.3, HCO3 < 15, ketones > 3, gap > 16, measured Na low); fixed-rate insulin clears ketones >= 0.5/h and drops K', () => {
  const spec = { sex: 'F', age: 22, heightCm: 165, weightKg: 55, dka: true, ketones: 5.5, glucose: 28, potassium: 3.6, dehydrationL: 3.5 };
  const p = mk(spec); p.run(600); const a = sampleValues('abg', p), c = sampleValues('chem', p);
  assert.ok(a.ph < 7.3 && a.hco3 < 15 && a.ag > 16 && sampleValues('ketones', p).ketones > 3 && c.na < 135 && c.osm > 295, JSON.stringify({ ph: a.ph, hco3: a.hco3, ag: a.ag, na: c.na, osm: c.osm }));
  const u = mk(spec); u.run(4200); assert.ok(sampleValues('abg', u).ph < a.ph, 'untreated it worsens');
  const k0 = p.lytes.k, g0 = p.lytes.glucose, ket0 = p.keto.ketones;
  p.dispatch({ type: 'fluid.bolus', volumeL: 3, minutes: 240, fluid: 'saline' }); p.dispatch({ type: 'drug.infusion', drug: 'insulin', rate: 0.1 * 55 / 60 }); p.run(4 * 3600);
  const fallKet = (ket0 - p.keto.ketones) / 4, fallGlu = (g0 - p.lytes.glucose) / 4;
  assert.ok(fallKet >= 0.5 && fallGlu >= 2 && fallGlu <= 6, `ketones -${fallKet.toFixed(2)}/h, glucose -${fallGlu.toFixed(1)}/h`);
  assert.ok(p.lytes.k < k0 - 0.8, `K ${k0.toFixed(1)} -> ${p.lytes.k.toFixed(1)} without replacement`);
  assert.equal(mk().dispatch({ type: 'drug.infusion', drug: 'hydrocortisone', rate: 1 }).ok, false, 'no infusion of a direct-effect drug');
});

test('status epilepticus: benzodiazepines early work in most cases, late less; levetiracetam second line; untreated rarely stops', () => {
  const sz = (seed, delay = 0) => { const p = mk({ sex: 'M', age: 34, heightCm: 178, weightKg: 80 }, { seed }); p.crises.trigger('seizure', p.t - 300); if (delay) p.run(delay); return p; };
  const stops = (p, s) => { for (let i = 0; i < s; i += 5) { p.run(5); if (!p.crises.se.active) return true; } return false; };
  const pct = (f) => { let n = 0, m = 0; for (let s = 1; s <= 30; s++) { const r = f(s); if (r === null) continue; m++; if (r) n++; } return n / m; };
  const im = pct(s => { const p = sz(s); p.dispatch({ type: 'drug.bolus', drug: 'midazolam', amount: 10, route: 'im' }); return stops(p, 600); });
  const lz = pct(s => { const p = sz(s); p.dispatch({ type: 'iv.access' }); p.dispatch({ type: 'drug.bolus', drug: 'lorazepam', amount: 4 }); return stops(p, 600); });
  const late = pct(s => { const p = sz(s, 1500); if (!p.crises.se.active) return null; p.dispatch({ type: 'iv.access' }); p.dispatch({ type: 'drug.bolus', drug: 'lorazepam', amount: 4 }); return stops(p, 600); });
  const none = pct(s => stops(sz(s), 1200));
  assert.ok(im >= 0.6 && im <= 0.9 && lz >= 0.5 && lz <= 0.8, `IM midazolam ${im.toFixed(2)}, IV lorazepam ${lz.toFixed(2)} (RAMPART 0.73 / 0.63)`);
  assert.ok(late < lz && none <= 0.2, `late lorazepam ${late.toFixed(2)}, untreated ${none.toFixed(2)}`);
  const lev = pct(s => { const p = sz(s); p.dispatch({ type: 'iv.access' }); p.dispatch({ type: 'drug.bolus', drug: 'lorazepam', amount: 4 }); if (stops(p, 600)) return null; p.dispatch({ type: 'drug.bolus', drug: 'levetiracetam', amount: 4500 }); return stops(p, 1800); });
  assert.ok(lev >= 0.2 && lev <= 0.65, `levetiracetam after a failed benzodiazepine ${lev.toFixed(2)} (ESETT 0.47 at 60 min)`);
  const v = sz(2); v.run(300); assert.ok(v.crises.seizure && v.resp.spo2 < 95 && v.circ.hr > 80, 'seizing: lower SpO2, tachycardia');
  const r = mk({}, { seed: 2 }); r.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 70 }); r.dispatch({ type: 'instructor.inject', what: 'seizure' }); r.run(120);
  assert.equal(r.crises.seizure, false, 'paralysis hides the convulsion'); assert.equal(r.crises.se.active, true, 'but the seizure goes on');
});

test('NIV, ketosis and seizures replay to the same hash', () => {
  const p = mk({ copd: 0.6, dka: true, ketones: 3, glucose: 20, dehydrationL: 1 }, { seed: 6 });
  for (const e of [{ type: 'niv.set', mode: 'bipap', ipap: 16, epap: 5, fio2: 0.3 }, { type: 'drug.infusion', drug: 'insulin', rate: 0.12 }, { type: 'instructor.inject', what: 'seizure' }, { type: 'drug.bolus', drug: 'midazolam', amount: 10, route: 'im' }, { type: 'fluid.bolus', volumeL: 0.5, minutes: 30, fluid: 'saline' }]) { p.dispatch(e); p.run(60); }
  p.run(300);
  const q = replay({ spec: p.spec, seed: 6, scenario: null, log: p.log.map(e => ({ ...e })), until: p.t }, {});
  assert.equal(q.stateHash(), p.stateHash());
});
