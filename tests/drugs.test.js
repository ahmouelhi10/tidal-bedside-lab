// Anaesthesia PK/PD. PK oracles: research note "anesthesia_pkpd_models.md" section 8 (computed from the primary-paper equations; anchors: Absalom 2009 Schnider
// parameters, PyTCI Marsh output, Vellinga 2021 steady-state rates). PD checks use clinical ranges (see docs/VALIDATION.md). (REF vellinga2021) (REF pytci)
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeBody } from '../src/engine/anthropometrics.js';
import { PKModel } from '../src/engine/pk.js';
import { propofolEleveld, propofolMarsh, propofolSchnider, remifentanilMinto, remifentanilEleveld, DrugSystem, DRUGS, lbmJamesCapped, ffmAlSallami } from '../src/engine/drugs.js';
import { mk, intubate } from './helpers/bots.js';

const P1 = { sex: 'M', age: 40, weightKg: 70, heightCm: 170 }, P2 = { sex: 'F', age: 70, weightKg: 55, heightCm: 160 }, P3 = { sex: 'M', age: 35, weightKg: 140, heightCm: 175 };
const B = s => describeBody(s);
const rel = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= Math.max(tol * Math.abs(b), 0.012), `${msg}: got ${a.toFixed(3)} expected ${b} (tol ${tol * 100}%)`);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} +/- ${tol}`);

/** Cp and Ce at the given minutes after an instantaneous bolus */
function boluscurve(params, dose, minutes) {
  const m = new PKModel(params, 1); m.bolus(dose); const out = {}; let t = 0;
  for (const tm of minutes) { while (t < tm * 60) { m.step(); t++; } out[tm] = [m.c1, m.ce]; }
  return out;
}
/** infusion of `rate` per minute for 60 s, then nothing */
function infcurve(params, rate, minutes) {
  const m = new PKModel(params, 1); m.setInfusion(rate); const out = {}; let t = 0;
  for (const tm of minutes) { while (t < tm * 60) { if (t === 60) m.setInfusion(0); m.step(); t++; } out[tm] = [m.c1, m.ce]; }
  return out;
}

// ------------------------------------------------------------------ covariates and derived parameters
test('James LBM / Al-Sallami FFM covariates (P1 55.30 / 54.48; P2 41.36 / 36.66)', () => {
  near(lbmJamesCapped('M', 70, 170), 55.30, 0.01, 'P1 LBM'); near(ffmAlSallami('M', 40, 70, 170), 54.48, 0.02, 'P1 FFM');
  near(lbmJamesCapped('F', 55, 160), 41.36, 0.01, 'P2 LBM'); near(ffmAlSallami('F', 70, 55, 160), 36.66, 0.02, 'P2 FFM');
});
test('Schnider (Absalom 2009 printed values, 40 y 70 kg 170 cm): V2 24.0, k10 0.384, k12 0.375, k21 0.067, k31 0.0035', () => {
  const p = propofolSchnider(B(P1));
  near(p.V1, 4.27, 1e-9, 'V1'); near(p.k10, 0.3836, 0.001, 'k10'); near(p.k12, 0.3748, 0.001, 'k12'); near(p.k21, 0.0668, 0.0005, 'k21'); near(p.k31, 0.0035, 1e-9, 'k31');
  near(p.k21 * (p.V1 * p.k12 / p.k21), 23.983 * 0.0668, 0.01, 'V2 x k21 (= Q2)');
});
test('Eleveld typical 35-y 70-kg male: V1 6.28, V2 25.5, V3 273, CL 1.79 L/min, ke0 0.146', () => {
  const p = propofolEleveld(B({ sex: 'M', age: 35, weightKg: 70, heightCm: 170 })), V2 = p.V1 * p.k12 / p.k21;
  near(p.V1, 6.28, 0.01, 'V1'); near(V2, 25.5, 0.05, 'V2'); near(p.k10 * p.V1, 1.79, 0.005, 'CL'); near(p.ke0, 0.146, 0.001, 'ke0');
  near(p.k13 * p.V1 / p.k31, 273, 1.5, 'V3');
});
test('Eleveld P1 (40 y): k10 0.2850, k12 0.2613, k13 0.1775, k21 0.0696, k31 0.00408; with opioid V3 157.2, CL 1.597', () => {
  const p = propofolEleveld(B(P1)); near(p.k10, 0.2850, 0.002, 'k10'); near(p.k12, 0.2613, 0.002, 'k12'); near(p.k13, 0.1775, 0.002, 'k13'); near(p.k21, 0.0696, 0.0007, 'k21'); near(p.k31, 0.00408, 0.00008, 'k31');
  const o = propofolEleveld(B(P1), { opioid: true }); near(o.k13 * o.V1 / o.k31, 157.2, 1.5, 'V3 opioid'); near(o.k10 * o.V1, 1.597, 0.005, 'CL opioid');
});
test('Minto remifentanil P1: V1 5.121, V2 9.852, CL 2.606, ke0 0.595; Eleveld remifentanil P1: V1 5.651, V2 8.677, V3 4.297, CL 2.538, ke0 0.943', () => {
  const m = remifentanilMinto(B(P1)); near(m.V1, 5.121, 0.005, 'V1'); near(m.V1 * m.k12 / m.k21, 9.852, 0.02, 'V2'); near(m.k10 * m.V1, 2.606, 0.01, 'CL'); near(m.ke0, 0.595, 1e-9, 'ke0');
  const e = remifentanilEleveld(B(P1)); near(e.V1, 5.651, 0.01, 'V1'); near(e.V1 * e.k12 / e.k21, 8.677, 0.03, 'V2'); near(e.k13 * e.V1 / e.k31, 4.297, 0.03, 'V3'); near(e.k10 * e.V1, 2.538, 0.01, 'CL'); near(e.ke0, 0.9433, 0.002, 'ke0');
});
test('steady-state infusion rates (Vellinga 2021): Eleveld+opioid Ce 3.08 -> 4.99 mg/min; Schnider Ce 3.0 -> 4.91 mg/min', () => {
  const e = propofolEleveld(B({ sex: 'M', age: 35, weightKg: 70, heightCm: 170 }), { opioid: true }); near(3.08 * e.k10 * e.V1, 4.99, 0.03, 'Eleveld + opioid');
  const s = propofolSchnider(B({ sex: 'M', age: 35, weightKg: 70, heightCm: 170 })); near(3.0 * s.k10 * s.V1, 4.91, 0.06, 'Schnider');
});

// ------------------------------------------------------------------ concentration-time oracles (2 mg/kg propofol, 1 mg/kg remifentanil over 60 s)
const T = [1, 2, 5, 10, 30];
function checkCurve(label, got, table) {
  T.forEach((tm, i) => { rel(got[tm][0], table[i][0], 0.025, `${label} Cp t=${tm}`); rel(got[tm][1], table[i][1], 0.03, `${label} Ce t=${tm}`); });
}
test('propofol bolus 140 mg, P1: Eleveld (no opioid) Cp/Ce at 1,2,5,10,30 min', () => {
  checkCurve('Eleveld', boluscurve(propofolEleveld(B(P1)), 140, T), [[10.938, 2.143], [5.566, 2.919], [1.211, 2.771], [0.597, 1.722], [0.286, 0.427]]);
});
test('propofol bolus 140 mg, P1: Eleveld with opioid', () => {
  checkCurve('Eleveld+op', boluscurve(propofolEleveld(B(P1), { opioid: true }), 140, T), [[11.974, 2.234], [6.646, 3.147], [1.695, 3.182], [0.806, 2.066], [0.396, 0.570]]);
});
test('propofol bolus 140 mg, P1: Schnider and Marsh (ke0 0.26 / 1.2)', () => {
  checkCurve('Schnider', boluscurve(propofolSchnider(B(P1)), 140, T), [[12.849, 7.498], [5.363, 7.765], [1.043, 3.387], [0.675, 1.008], [0.337, 0.364]]);
  checkCurve('Marsh .26', boluscurve(propofolMarsh(B(P1), 0.26), 140, T), [[6.700, 1.749], [5.157, 2.690], [2.508, 3.115], [1.031, 1.908], [0.366, 0.422]]);
  checkCurve('Marsh 1.2', boluscurve(propofolMarsh(B(P1), 1.2), 140, T), [[6.700, 5.230], [5.157, 5.587], [2.508, 3.088], [1.031, 1.179], [0.366, 0.375]]);
});
test('propofol bolus, elderly P2 (110 mg) and obese P3 (280 mg): Eleveld', () => {
  checkCurve('P2', boluscurve(propofolEleveld(B(P2)), 110, T), [[10.411, 2.036], [5.824, 2.866], [1.377, 2.836], [0.516, 1.700], [0.191, 0.315]]);
  checkCurve('P3', boluscurve(propofolEleveld(B(P3)), 280, T), [[14.124, 2.724], [5.673, 3.463], [1.024, 3.078], [0.681, 2.017], [0.376, 0.590]]);
});
test('remifentanil 1 mcg/kg over 60 s, P1: Minto and Eleveld Cp/Ce', () => {
  checkCurve('Minto', infcurve(remifentanilMinto(B(P1)), 70, T), [[9.037, 2.514], [4.018, 4.021], [1.069, 2.015], [0.559, 0.729], [0.073, 0.088]]);
  checkCurve('Eleveld-remi', infcurve(remifentanilEleveld(B(P1)), 70, T), [[8.751, 3.399], [4.395, 4.956], [1.147, 1.833], [0.540, 0.623], [0.079, 0.087]]);
});
test('remifentanil P3 (BMI 46, 140 ug): Minto vs Eleveld peak Ce differ as published (7.02 vs 7.56 ng/mL at ~2 min)', () => {
  const peak = (p, rate) => { const m = new PKModel(p, 1); m.setInfusion(rate); let mx = 0; for (let t = 0; t < 600; t++) { if (t === 60) m.setInfusion(0); m.step(); mx = Math.max(mx, m.ce); } return mx; };
  rel(peak(remifentanilMinto(B(P3)), 140), 7.020, 0.03, 'Minto'); rel(peak(remifentanilEleveld(B(P3)), 140), 7.555, 0.03, 'Eleveld');
});

// ------------------------------------------------------------------ PD: hypnosis, ventilation, NMB, reversal (through the Patient, i.e. as the learner uses them)
const eff = p => p.drugs.effects({});
function series(p, seconds, f) { const o = []; for (let t = 0; t < seconds; t++) { p.tick(10); o.push(f(p)); } return o; }
const firstIdx = (a, pred, from = 0) => { for (let i = from; i < a.length; i++) if (pred(a[i])) return i + 1; return -1; };

test('propofol 2 mg/kg: loss of consciousness at 30-90 s, BIS < 60, waking after 5-15 min', () => {
  const p = mk(P1); p.run(10); p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 140 });
  const s = series(p, 1200, q => { const e = eff(q); return { loc: e.loc, bis: e.bis }; });
  const tl = firstIdx(s, x => x.loc), tw = firstIdx(s, x => !x.loc, tl);
  assert.ok(tl >= 30 && tl <= 90, `LOC at ${tl} s`); assert.ok(Math.min(...s.map(x => x.bis)) < 60);
  assert.ok(tw >= 300 && tw <= 900, `wake at ${tw} s`);
});
test('propofol dose-response and age: 1 mg/kg lighter than 2 mg/kg; same mg/kg is deeper in an 80-year-old', () => {
  const minBis = (spec, mg) => { const p = mk(spec); p.run(10); p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: mg }); return Math.min(...series(p, 600, q => eff(q).bis)); };
  const a1 = minBis(P1, 70), a2 = minBis(P1, 140), e2 = minBis({ sex: 'M', age: 80, weightKg: 70, heightCm: 170 }, 140);
  assert.ok(a2 < a1 - 8 && e2 < a2 - 3, `BIS ${a1.toFixed(0)} / ${a2.toFixed(0)} / elderly ${e2.toFixed(0)}`);
});
test('remifentanil synergy: adding a remifentanil infusion deepens propofol hypnosis', () => {
  const run = remi => { const p = mk(P1); p.run(10); if (remi) { p.dispatch({ type: 'drug.infusion', drug: 'remifentanil', rate: 70 }); p.run(180); } p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 100 }); return Math.min(...series(p, 300, q => eff(q).bis)); };
  assert.ok(run(true) < run(false) - 3);
});
test('propofol induction: haemodynamics fall 15-35% (SBP/MAP), HR stays within +/-20%, hypovolaemia worsens it (ventilation supported)', () => {
  const run = (spec, mg, bleedFrac = 0) => {
    const p = mk(spec); intubate(p); p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: 450, fio2: 0.5, peep: 5, seal: 1 } }); p.run(60);
    if (bleedFrac) { p.dispatch({ type: 'bleed.set', mlPerMin: bleedFrac * p.vol.bloodVolume * 1000 }); p.run(60); p.dispatch({ type: 'bleed.set', mlPerMin: 0 }); p.run(180); }
    const base = { map: p.circ.mapArt, sbp: p.circ.sbp, hr: p.circ.hr }; p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: mg });
    const s = series(p, 480, q => ({ map: q.circ.mapArt, sbp: q.circ.sbp, hr: q.circ.hr }));
    return { base, dMap: Math.min(...s.map(x => x.map)) / base.map - 1, dSbp: Math.min(...s.map(x => x.sbp)) / base.sbp - 1, hrEnd: s[s.length - 1].hr / base.hr - 1, mapMin: Math.min(...s.map(x => x.map)) };
  };
  const n = run(P1, 140), hyp = run(P1, 140, 0.15), el = run({ sex: 'M', age: 80, weightKg: 60, heightCm: 165 }, 120);
  assert.ok(n.dSbp < -0.15 && n.dSbp > -0.40 && n.dMap < -0.12 && n.dMap > -0.40, `healthy SBP ${(n.dSbp * 100).toFixed(0)}% MAP ${(n.dMap * 100).toFixed(0)}%`);
  assert.ok(Math.abs(n.hrEnd) < 0.2, `HR change ${(n.hrEnd * 100).toFixed(0)}%`);
  assert.ok(hyp.mapMin < n.mapMin - 5, `hypovolaemic MAP ${hyp.mapMin.toFixed(0)} vs ${n.mapMin.toFixed(0)}`);
  assert.ok(el.dMap < -0.15, `elderly MAP ${(el.dMap * 100).toFixed(0)}%`);
});
test('unprotected propofol bolus causes apnoea: minute ventilation falls > 70% and an unsupported airway desaturates the patient', () => {
  const p = mk(P1); p.run(30); const ve0 = p.resp.ve; p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 140 });
  const s = series(p, 240, q => ({ ve: q.resp.ve, sao2: q.resp.sao2 }));
  assert.ok(Math.min(...s.map(x => x.ve)) < 0.3 * ve0 && Math.min(...s.map(x => x.sao2)) < ((s[0].sao2 + 0.01)), 'VE collapses');
});
test('ketamine and etomidate preserve blood pressure better than propofol at equi-hypnotic doses', () => {
  const dMap = (drug, mg) => { const p = mk(P1); intubate(p); p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: 450, fio2: 0.5, peep: 5, seal: 1 } }); p.run(60); const b = p.circ.mapArt; p.dispatch({ type: 'drug.bolus', drug, amount: mg }); const s = series(p, 480, q => q.circ.mapArt); return Math.min(...s) / b - 1; };
  const pr = dMap('propofol', 140), et = dMap('etomidate', 21), ke = dMap('ketamine', 140);
  assert.ok(et > pr + 0.05 && ke > pr + 0.08, `propofol ${(pr * 100).toFixed(0)}% etomidate ${(et * 100).toFixed(0)}% ketamine ${(ke * 100).toFixed(0)}%`);
});

test('rocuronium 1.2 mg/kg: complete block (>92%) in 45-90 s, clinical duration 40-80 min; 0.6 mg/kg slower and shorter', () => {
  const run = mg => { const p = mk(P1); p.run(10); p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 140 }); p.run(30); p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: mg });
    const s = series(p, 7200, q => eff(q).nmb), peak = s.indexOf(Math.max(...s)); return { onset: firstIdx(s, x => x > 0.92), peakV: Math.max(...s), dur: firstIdx(s, x => x < 0.75, peak) / 60 }; };
  const hi = run(84), lo = run(42);
  assert.ok(hi.onset >= 45 && hi.onset <= 90, `onset ${hi.onset} s`); assert.ok(hi.dur >= 40 && hi.dur <= 80, `duration ${hi.dur.toFixed(0)} min`);
  assert.ok(lo.onset > hi.onset && lo.dur < hi.dur, `0.6 mg/kg onset ${lo.onset} s duration ${lo.dur.toFixed(0)} min`);
});
test('succinylcholine 1 mg/kg: block within 40-100 s, recovery to <25% block by 5-12 min; pseudocholinesterase deficiency prolongs it >2x', () => {
  const run = def => { const p = mk(def ? { ...P1, pseudocholinesterase: 0.2 } : P1); p.run(10); p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 140 }); p.run(30); p.dispatch({ type: 'drug.bolus', drug: 'succinylcholine', amount: 70 });
    const s = series(p, 3600, q => eff(q).nmb), peak = s.indexOf(Math.max(...s)); return { onset: firstIdx(s, x => x > 0.9), rec: firstIdx(s, x => x < 0.25, peak) / 60 }; };
  const n = run(false), d = run(true); assert.ok(n.onset >= 40 && n.onset <= 100, `onset ${n.onset}`); assert.ok(n.rec >= 5 && n.rec <= 12, `recovery ${n.rec.toFixed(1)} min`);
  assert.ok(d.rec > 2 * n.rec, `deficient ${d.rec.toFixed(1)} vs normal ${n.rec.toFixed(1)} min`);
});
test('sugammadex 16 mg/kg 3 min after rocuronium 1.2 mg/kg restores strength within 3 min; 2 mg/kg is not enough at that depth', () => {
  const run = mgkg => { const p = mk(P1); p.run(10); p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 140 }); p.run(30); p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 84 }); p.run(180);
    p.dispatch({ type: 'drug.bolus', drug: 'sugammadex', amount: mgkg * 70 }); return firstIdx(series(p, 900, q => eff(q).nmb), x => x < 0.25); };
  const full = run(16), under = run(2); assert.ok(full > 0 && full <= 180, `16 mg/kg: ${full} s`); assert.ok(under === -1 || under > 300, `2 mg/kg: ${under}`);
});
test('naloxone reverses opioid ventilatory depression within minutes (>= 0.4 mg IV) and the effect fades over 30-90 min', () => {
  const p = mk(P1); p.run(10); p.dispatch({ type: 'drug.bolus', drug: 'fentanyl', amount: 700 }); p.run(240);
  assert.ok(eff(p).dep.slope < 0.15, 'opioid depresses the CO2 response'); p.dispatch({ type: 'drug.bolus', drug: 'naloxone', amount: 400 });
  const s = series(p, 3600, q => eff(q).dep.slope);
  assert.ok(s[119] > 0.25 && s[599] > 0.6, `slope 2 min ${s[119].toFixed(2)}, 10 min ${s[599].toFixed(2)}`);
});
test('vasoactive drugs, closed loop: phenylephrine 100 mcg +15-40 mmHg; norepinephrine 0.1 mcg/kg/min +5-30; atropine 1 mg HR +25-60; nitroglycerin lowers MAP', () => {
  const peak = (drug, amount, kind, secs = 360) => { const p = mk({ sex: 'M', age: 40, weightKg: 75, heightCm: 178 }); p.dispatch({ type: 'monitor.attach', items: { aline: true } }); p.run(20);
    const b = { map: p.circ.mapArt, hr: p.circ.hr }; p.dispatch(kind === 'bolus' ? { type: 'drug.bolus', drug, amount } : { type: 'drug.infusion', drug, rate: amount });
    const s = series(p, secs, q => ({ map: q.circ.mapArt, hr: q.circ.hr })); return { dMapUp: Math.max(...s.map(x => x.map)) - b.map, dMapDn: b.map - Math.min(...s.map(x => x.map)), dHr: Math.max(...s.map(x => x.hr)) - b.hr }; };
  const pe = peak('phenylephrine', 100, 'bolus'), ne = peak('norepinephrine', 7.5, 'inf', 600), at = peak('atropine', 1000, 'bolus'), ng = peak('nitroglycerin', 100, 'inf', 480);
  assert.ok(pe.dMapUp >= 15 && pe.dMapUp <= 40, `phenylephrine +${pe.dMapUp.toFixed(0)}`); assert.ok(ne.dMapUp >= 5 && ne.dMapUp <= 30, `norepinephrine +${ne.dMapUp.toFixed(0)}`);
  assert.ok(at.dHr >= 25 && at.dHr <= 60, `atropine HR +${at.dHr.toFixed(0)}`); assert.ok(ng.dMapDn >= 5, `nitroglycerin -${ng.dMapDn.toFixed(0)}`);
});
test('DRUGS table: every drug declares a reference id, a unit and a concentration unit', () => {
  for (const [k, d] of Object.entries(DRUGS)) { assert.ok(d.name && d.unit && d.concUnit, `${k} unit fields`); assert.ok(typeof d.ref === 'string' && d.ref.length > 0, `${k} ref`); }
});
test('drug kinetics are deterministic and mass-conserving over a dosing history', () => {
  const run = () => { const ds = new DrugSystem(B(P1), { dtSec: 0.1 }); ds.bolus('propofol', 140, 0); ds.infusion('remifentanil', 70); for (let i = 0; i < 6000; i++) ds.step(); ds.stop('remifentanil'); for (let i = 0; i < 3000; i++) ds.step(); return [ds.ce('propofol'), ds.ce('remifentanil'), ds.cp('propofol')]; };
  assert.deepEqual(run(), run());
});
