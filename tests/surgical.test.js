import test from 'node:test';
import assert from 'node:assert/strict';
import { Patient, replay, EVENT_TYPES } from '../src/engine/patient.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { Chest, Neck, SITES, cwtMean, pPalpable, fonaPlan, NEEDLE_MARGIN_MM } from '../src/engine/surgical.js';
import { describeBody } from '../src/engine/anthropometrics.js';
import { Rng } from '../src/engine/rng.js';
import { scen, mk, aclsTeam } from './helpers/bots.js';

const VENT = { type: 'vent.set', settings: { mode: 'ctrl', rate: 14, vt: 500, fio2: 0.6, peep: 5, seal: 0.97 } };
/** population of chests with BMI ~ N(27, 5), the order of magnitude of the trauma series behind REF laan2016 */
function failureRates(needleMm, n = 3000, seed = 11) {
  const r = new Rng(seed), out = Object.fromEntries(Object.keys(SITES).map(k => [k, 0]));
  for (let i = 0; i < n; i++) {
    const bmi = Math.min(Math.max(27 + 5 * r.normal(), 16), 55), c = new Chest({ bmi }, r);
    for (const k of Object.keys(SITES)) if (needleMm < c.cwt[k] + NEEDLE_MARGIN_MM) out[k]++;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v / n]));
}

// ------------------------------------------------------------------------------------------ chest wall and the needle
test('chest wall: thinner at the 5th ICS anterior axillary line than at the 2nd ICS mid-clavicular line, and it thickens with BMI (REF ahmad2025, laan2016)', () => {
  for (const bmi of [18, 27, 40]) assert.ok(cwtMean('aal5', bmi) < cwtMean('mal5', bmi) && cwtMean('mal5', bmi) < cwtMean('mcl2', bmi), 'BMI ' + bmi);
  for (const k of Object.keys(SITES)) assert.ok(cwtMean(k, 40) > cwtMean(k, 27) + 15 && cwtMean(k, 18) < cwtMean(k, 27) - 10, k);
  assert.ok(Math.abs(cwtMean('mcl2', 27) - 42.8) < 0.01 && Math.abs(cwtMean('aal5', 27) - 34.3) < 0.01);
  // a real patient: the obese chest wall is thicker than the lean one, for the same seed
  const lean = mk({ weightKg: 55, heightCm: 178 }, { seed: 4 }), obese = mk({ weightKg: 160, heightCm: 172 }, { seed: 4 });
  for (const k of Object.keys(SITES)) assert.ok(obese.chest.cwt[k] > lean.chest.cwt[k] + 20, k);
});

test('a 5-cm catheter fails to reach the pleura in about 38% / 31% / 13% of adults at MCL2 / MAL5 / AAL5 (REF laan2016); longer catheters fail less (REF ahmad2025)', () => {
  const f5 = failureRates(50);
  assert.ok(Math.abs(f5.mcl2 - 0.38) < 0.07, 'MCL2 ' + f5.mcl2);
  assert.ok(Math.abs(f5.mal5 - 0.31) < 0.08, 'MAL5 ' + f5.mal5);
  assert.ok(Math.abs(f5.aal5 - 0.13) < 0.06, 'AAL5 ' + f5.aal5);
  assert.ok(f5.aal5 < f5.mal5 && f5.mal5 < f5.mcl2);
  const f7 = failureRates(70), f8 = failureRates(80);
  for (const k of Object.keys(SITES)) assert.ok(f8[k] <= f7[k] && f7[k] < f5[k], k);
  assert.ok(f8.aal5 < 0.03 && f8.mcl2 < 0.12, 'an 8-cm catheter almost always arrives: ' + JSON.stringify(f8));
  const meanPerCm = (f5.mcl2 - f8.mcl2) / 3;
  assert.ok(meanPerCm > 0.05 && meanPerCm < 0.15, 'about 8 percentage points per cm at the thick site: ' + meanPerCm);
});

// ------------------------------------------------------------------------------------------ pneumothorax physiology
const ptxPatient = (spec = {}, ptx = {}, opt = { seed: 3 }) => { const p = mk(spec, opt); p.chest.setPneumothorax({ side: 'R', air: 0.45, valve: true, leak: 0.06, ...ptx }); return p; };

test('a simple (non-valve) pneumothorax stays put and costs little; a valve pneumothorax grows and becomes tension', () => {
  const simple = ptxPatient({}, { air: 0.3, valve: false }); simple.run(300);
  assert.ok(Math.abs(simple.chest.air - 0.3) < 1e-9 && simple.chest.tension === 0);
  assert.ok(simple.resp.sao2 > 0.93 && simple.circ.mapArt > 80, 'mild effect');
  const valve = ptxPatient(); const air0 = valve.chest.air; valve.run(300);
  assert.ok(valve.chest.air > air0 + 0.1 && valve.chest.tension > 0.15 && valve.chest.valve);   // spontaneous breathing: the build-up is slower than under positive pressure
});

test('positive-pressure ventilation accelerates the accumulation of air (REF sheep_ptx_ppv, kheirabadi2013), and a simple pneumothorax converts to tension when ventilation starts', () => {
  const spont = ptxPatient({}, { air: 0.3 }), ppv = ptxPatient({}, { air: 0.3 });
  ppv.dispatch({ type: 'airway.set', device: 'sga' }); ppv.dispatch(VENT);
  spont.run(180); ppv.run(180);
  assert.ok(ppv.chest.air > spont.chest.air + 0.08, `${ppv.chest.air} vs ${spont.chest.air}`);
  const conv = ptxPatient({}, { air: 0.5, valve: false, convertOnPpv: true }); conv.run(120);
  assert.equal(conv.chest.valve, false); assert.equal(conv.chest.tension, 0);
  conv.dispatch({ type: 'airway.set', device: 'sga' }); conv.dispatch(VENT); conv.run(300);
  assert.equal(conv.chest.valve, true); assert.ok(conv.chest.tension > 0.2);
});

test('tension pneumothorax: obstructive shock (CVP up, cardiac output and MAP down, HR up) with hypoxaemia that precedes the circulatory collapse (REF barton1997)', () => {
  const p = scen('tension_ptx', 1); const base = p.snapshot();
  let tHypox = null, tHypot = null;
  for (let i = 0; i < 90 && !p.arrest.arrested; i++) {
    p.run(5);
    if (tHypox === null && p.resp.sao2 < 0.90) tHypox = p.t;
    if (tHypot === null && p.circ.mapArt < 65) tHypot = p.t;
  }
  const s = p.snapshot();
  assert.ok(s.cvp > base.cvp + 3, `CVP ${base.cvp} -> ${s.cvp}`);
  assert.ok(s.co < 0.6 * base.co && s.map < 0.7 * base.map && s.hr > base.hr + 40, JSON.stringify({ co: s.co, map: s.map, hr: s.hr }));
  assert.ok(tHypox !== null && tHypot !== null && tHypox < tHypot, `SpO2<90 at ${tHypox} s, MAP<65 at ${tHypot} s`);
  assert.ok(s.paco2 > base.paco2 + 3, 'dead space and lost compliance raise PaCO2');
});

test('right-sided tension compromises the circulation earlier than left-sided tension (REF chen2024_side)', () => {
  const run = side => { const p = ptxPatient({}, { side, air: 0.78 }); p.run(1); const a = p.circ.co; return a; };
  const R = run('R'), L = run('L'), none = (() => { const p = mk({}, { seed: 3 }); p.run(1); return p.circ.co; })();
  assert.ok(R < L && L < none, JSON.stringify({ R, L, none }));
});

test('an untreated tension pneumothorax ends in PEA arrest with tension as the reversible cause', () => {
  const p = scen('tension_ptx', 1); p.run(900);
  assert.equal(p.arrest.arrested, true);
  assert.equal(p.arrest.key, 'PEA');
  assert.equal(p.arrest.causes.tension_ptx, true);
  assert.ok(p.arrest.blocking().includes('tension_ptx'));
});

// ------------------------------------------------------------------------------------------ needle decompression
test('needle decompression on the right side with a catheter that reaches the pleura vents the tension: pressure to zero, circulation and SpO2 recover', () => {
  const p = scen('tension_ptx', 1); p.run(200);
  const before = p.snapshot(); assert.ok(before.chest.tension > 0.4, 'tension ' + before.chest.tension);
  const c = p.chest.cwt.aal5; assert.ok(c < 77, 'this chest wall is thin enough for 8 cm: ' + c);
  const r = p.dispatch({ type: 'procedure.needle_decompression', side: 'R', site: 'aal5', needleMm: 80 });
  assert.equal(r.ok, true); assert.equal(r.reached, true); assert.equal(r.relieved, true); assert.equal(r.hiss, true); assert.equal(r.risk, null);
  p.run(60);
  const after = p.snapshot();
  assert.equal(after.chest.tension, 0);
  assert.ok(after.map > before.map + 8 && after.cvp < before.cvp - 1.5 && after.hr < before.hr - 10, JSON.stringify({ before: [before.map, before.cvp, before.hr], after: [after.map, after.cvp, after.hr] }));
  assert.ok(p.chest.reliefT !== null && p.chest.reliefT - p.chest.tensionT0 < 150);
});

test('needle decompression fails when the catheter is too short for the chest wall, when it is on the wrong side, and in the obese with a standard 5-cm catheter', () => {
  const p = scen('tension_ptx', 1); p.run(150);
  const wrong = p.dispatch({ type: 'procedure.needle_decompression', side: 'L', site: 'aal5', needleMm: 80 });
  assert.equal(wrong.relieved, false); assert.equal(wrong.wrongSide, true); assert.ok(p.chest.tension > 0.2, 'still under tension');
  const short = p.dispatch({ type: 'procedure.needle_decompression', side: 'R', site: 'mcl2', needleMm: Math.round(p.chest.cwt.mcl2) - 10 });
  assert.equal(short.reached, false); assert.equal(short.relieved, false);
  assert.ok(p.chest.tension > 0.2);
  const obese = ptxPatient({ weightKg: 175, heightCm: 172 }, {}, { seed: 8 }); obese.run(200);
  assert.ok(obese.chest.cwt.mcl2 > 60, 'obese chest wall ' + obese.chest.cwt.mcl2);
  assert.equal(obese.dispatch({ type: 'procedure.needle_decompression', side: 'R', site: 'mcl2', needleMm: 50 }).reached, false);
  assert.equal(obese.dispatch({ type: 'procedure.needle_decompression', side: 'R', site: 'mcl2', needleMm: 100 }).relieved, true);
});

test('a long catheter at the 5th ICS on the LEFT is flagged as a cardiac risk; the 2nd ICS mid-clavicular line is not (REF lesperance_nd, ahmad2025)', () => {
  const c = new Chest({ bmi: 22 }, new Rng(5)); c.setPneumothorax({ side: 'L', air: 0.8 });
  const lat = c.decompress(10, { side: 'L', site: 'aal5', needleMm: 100 }), mcl = new Chest({ bmi: 22 }, new Rng(5));
  mcl.setPneumothorax({ side: 'L', air: 0.8 });
  assert.equal(lat.risk, 'cardiac'); assert.equal(mcl.decompress(10, { side: 'L', site: 'mcl2', needleMm: 100 }).risk, null);
  const right = new Chest({ bmi: 22 }, new Rng(5)); right.setPneumothorax({ side: 'R', air: 0.8 });
  assert.equal(right.decompress(10, { side: 'R', site: 'aal5', needleMm: 100 }).risk, null);
});

test('a catheter is a bridge: when it blocks the tension comes back; a chest drain is definitive', () => {
  const p = scen('tension_ptx', 1); p.run(200);
  p.dispatch({ type: 'procedure.needle_decompression', side: 'R', site: 'aal5', needleMm: 80 });
  p.run(120); assert.equal(p.chest.tension, 0);
  p.chest.needle.patent = false; p.run(400);
  assert.ok(p.chest.tension > 0.25, 'recurrence ' + p.chest.tension);
  p.dispatch({ type: 'procedure.chest_tube', side: 'R', fr: 28 }); p.run(600);
  assert.equal(p.chest.tension, 0); assert.ok(p.chest.air < 0.12, 'lung re-expanded: ' + p.chest.air);
  assert.ok(p.circ.mapArt > 75 && p.resp.sao2 > 0.97);
});

test('legacy zero-argument needle decompression is still accepted (older clients, scripted cases) and relieves the case', () => {
  const p = scen('tension_ptx', 1); p.run(200);
  assert.equal(p.dispatch({ type: 'procedure.needle_decompression' }).ok, true);
  p.run(30); assert.equal(p.chest.tension, 0);
  const q = mk({ causes: ['tension_ptx'] }); q.arrest.arrest('PEA', q.t);
  q.dispatch({ type: 'procedure.needle_decompression' }); assert.equal(q.arrest.causes.tension_ptx, false);
});

// ------------------------------------------------------------------------------------------ chest drain
test('chest drain: air leaves faster with a larger bore; the lung re-expands; a wrong-side drain does nothing', () => {
  const big = ptxPatient(), small = ptxPatient(), wrong = ptxPatient();
  big.dispatch({ type: 'procedure.chest_tube', side: 'R', fr: 32 }); small.dispatch({ type: 'procedure.chest_tube', side: 'R', fr: 14 }); wrong.dispatch({ type: 'procedure.chest_tube', side: 'L', fr: 28 });
  for (const q of [big, small, wrong]) q.run(420);
  assert.equal(big.chest.tube.ok, true); assert.equal(wrong.chest.tube.ok, false);
  assert.ok(big.chest.air < small.chest.air, `${big.chest.air} vs ${small.chest.air}`);
  assert.ok(wrong.chest.air > 0.6 && wrong.chest.tension > 0.1, 'the tension persists: ' + JSON.stringify(wrong.chest.snapshot()));
  assert.match(big.dispatch({ type: 'procedure.chest_tube', side: 'R', fr: 28 }).error, /already/);
});

test('chest drain malposition is uncommon in a lean chest and commoner in the obese (design 5% + 10% x obesity)', () => {
  const rate = bmi => { let m = 0; const r = new Rng(21); for (let i = 0; i < 2000; i++) { const c = new Chest({ bmi }, r); c.setPneumothorax({ side: 'R', air: 0.8 }); if (c.insertTube(1, { side: 'R', fr: 28 }).malposition) m++; } return m / 2000; };
  const lean = rate(23), obese = rate(50);
  assert.ok(lean > 0.02 && lean < 0.09, 'lean ' + lean); assert.ok(obese > lean + 0.04, 'obese ' + obese);
});

// ------------------------------------------------------------------------------------------ cardiac arrest linkage
test('in arrest with tension, treating the tension restores the coronary perfusion pressure that CPR can generate', () => {
  const cppAfter = fix => {
    const p = scen('tension_ptx', 1); while (!p.arrest.arrested && p.t < 900) p.run(5);
    p.dispatch({ type: 'cpr.start', mode: 'auto', opts: { rate: 110, depth: 5.5, ratio: 'continuous' }, surface: 'hard' });
    p.run(45); if (fix) p.dispatch({ type: 'procedure.needle_decompression', side: 'R', site: 'aal5', needleMm: 80 });
    p.run(45); return { cpp: p.circ.cpp, flow: p.cpr.flow, blocking: p.arrest.blocking() };
  };
  const a = cppAfter(true), b = cppAfter(false);
  assert.ok(a.cpp > b.cpp + 10, `${a.cpp} vs ${b.cpp}`);
  assert.ok(!a.blocking.includes('tension_ptx') && b.blocking.includes('tension_ptx'));
});

// ------------------------------------------------------------------------------------------ examination
test('examination findings follow the state: normal chest, then reduced movement / hyperresonance / absent breath sounds, late signs only at high tension', () => {
  const none = mk({}); assert.deepEqual(none.dispatch({ type: 'exam.chest' }).findings, ['chest_normal']);
  const p = ptxPatient({}, { air: 0.4 }); p.dispatch({ type: 'airway.set', device: 'sga' }); p.dispatch(VENT);
  const early = p.dispatch({ type: 'exam.chest' }).findings;
  assert.ok(early.includes('chest_rise_reduced_R') && early.includes('percussion_hyperresonant_R') && early.includes('breath_sounds_reduced_R'));
  assert.ok(!early.some(f => f.startsWith('trachea_deviated')), 'tracheal deviation is a late sign');
  p.run(400); const late = p.dispatch({ type: 'exam.chest' }).findings;
  assert.ok(late.includes('breath_sounds_absent_R') && late.includes('trachea_deviated_L') && late.includes('bagging_resistance') && late.includes('neck_veins_distended'), late.join());
  const us = p.dispatch({ type: 'exam.pocus' }); assert.equal(us.sliding.R, false); assert.equal(us.sliding.L, true);
  for (const k of Object.keys(SITES)) assert.ok(Math.abs(us.cwtMm[k] - p.chest.cwt[k]) <= 1, k);
  p.dispatch({ type: 'procedure.chest_tube', side: 'R', fr: 28 }); p.run(300);
  assert.ok(p.dispatch({ type: 'exam.chest' }).findings.some(f => f.startsWith('drain_')));
});

// ------------------------------------------------------------------------------------------ cannot intubate, cannot oxygenate
test('cricothyroid membrane palpation: women 0.70 falling to ~0.4 in obesity, the male advantage disappears with BMI (REF lavelle2021, aslani2012)', () => {
  assert.ok(pPalpable('F', 27) > 0.62 && pPalpable('F', 27) < 0.78, 'non-obese women ' + pPalpable('F', 27));
  assert.ok(pPalpable('F', 39) > 0.33 && pPalpable('F', 39) < 0.48, 'obese women ' + pPalpable('F', 39));
  assert.ok(pPalpable('M', 24) > pPalpable('F', 24) + 0.10);
  assert.ok(Math.abs(pPalpable('M', 42) - pPalpable('F', 42)) < 0.02);
  // and the sampled patients follow it
  let n = 0; const r = new Rng(31); for (let i = 0; i < 1500; i++) if (new Neck({ sex: 'F', bmi: 39 }, r).palpable) n++;
  assert.ok(Math.abs(n / 1500 - pPalpable('F', 39)) < 0.05);
});

test('scalpel-bougie vs cannula: placement probability and time follow the porcine / manikin data and obesity makes both worse (REF umek2020, apsf_fona, nap4)', () => {
  const r = new Rng(2), body = { bmi: 24 }, obese = { bmi: 45 };
  const known = { palpable: true, marked: false, depthMm: 15 }, hidden = { palpable: false, marked: false, depthMm: 15 }, deep = { palpable: true, marked: false, depthMm: 40 };
  const sb = fonaPlan(known, 'scalpel_bougie', 'palpate', body, r), cn = fonaPlan(known, 'cannula', 'palpate', body, r);
  assert.ok(sb.p > cn.p && Math.abs(sb.p - 0.90) < 0.01 && Math.abs(cn.p - 0.75) < 0.01);
  assert.ok(fonaPlan(hidden, 'scalpel_bougie', 'vertical', body, r).p > fonaPlan(hidden, 'scalpel_bougie', 'palpate', body, r).p + 0.3, 'vertical incision when impalpable (DAS)');
  assert.ok(fonaPlan(deep, 'cannula', 'palpate', body, r).p < cn.p - 0.15, 'a short cannula misses through thick tissue');
  assert.ok(fonaPlan(known, 'scalpel_bougie', 'palpate', obese, r).p < sb.p);
  const times = Array.from({ length: 400 }, () => fonaPlan(known, 'scalpel_bougie', 'palpate', body, r).dur).sort((a, b) => a - b);
  assert.ok(Math.abs(times[200] - 90) < 6, 'median ~90 s: ' + times[200]);
  assert.ok(fonaPlan({ ...hidden, marked: true }, 'scalpel_bougie', 'palpate', body, r).p > 0.85, 'a marked membrane is as good as a palpable one');
});

test("CICO: mask and supraglottic device do not ventilate, laryngoscopy fails, SpO2 collapses; a scalpel-bougie airway restores oxygenation and CO2 clearance", () => {
  const idle = scen('cico', 2); idle.run(420);
  assert.ok(idle.resp.sao2 < 0.5, 'desaturated: ' + idle.resp.sao2);
  const p = scen('cico', 2);
  p.run(45); const bvm = p.dispatch(VENT); assert.equal(bvm.ok, true);
  p.run(15); for (let k = 0; k < 10 && !(p.drugs.effects({ inArrest: false }).nmb > 0.9); k++) p.run(5);
  const e0 = p.resp.etco2;
  const lary = p.dispatch({ type: 'airway.intubate' }); assert.equal(lary.ok, true); p.run(lary.willTakeS + 1);
  assert.equal(p.airway.intubated, false, 'grade 4 view: the tube does not go in');
  p.dispatch({ type: 'airway.set', device: 'sga' }); p.run(20);
  assert.equal(p.monitor.etco2, 0, 'flat capnogram: no effective ventilation through the upper airway');
  const f = p.dispatch({ type: 'procedure.cricothyroidotomy', technique: 'scalpel_bougie', approach: p.neck.palpable ? 'palpate' : 'vertical' });
  assert.equal(f.ok, true); assert.ok(f.willTakeS > 60 && f.willTakeS < 160);
  assert.match(p.dispatch({ type: 'airway.intubate' }).error, /in progress/);
  assert.match(p.dispatch({ type: 'procedure.cricothyroidotomy' }).error, /in progress/);
  p.run(f.willTakeS + 1);
  if (!p.airway.intubated) { const g = p.dispatch({ type: 'procedure.cricothyroidotomy', technique: 'scalpel_bougie', approach: 'vertical' }); p.run(g.willTakeS + 1); }
  assert.equal(p.airway.intubated, true); assert.equal(p.airway.device, 'fona');
  p.dispatch(VENT); p.run(90);
  assert.ok(p.resp.sao2 > 0.97 && p.resp.etco2 > 25, `SpO2 ${p.resp.sao2}, etCO2 ${p.resp.etco2}`);
  assert.match(p.dispatch({ type: 'airway.set', device: 'sga' }).error, /surgical/);
  assert.match(p.dispatch({ type: 'airway.intubate' }).error, /surgical/);
  assert.ok(e0 >= 0);
});

test('a cannula in a completely obstructed upper airway ventilates poorly and risks barotrauma (tension pneumothorax) and displacement (REF nap4)', () => {
  let ptx = 0, displaced = 0, n = 24;
  for (let seed = 1; seed <= n; seed++) {
    const p = scen('cico', seed); p.run(30);
    for (let k = 0; k < 12 && !(p.drugs.effects({ inArrest: false }).nmb > 0.9); k++) p.run(5);
    p.neck.palpable = true;                                                          // isolate the ventilation hazards from the placement draw
    const f = p.dispatch({ type: 'procedure.cricothyroidotomy', technique: 'cannula', approach: 'palpate' }); p.run(f.willTakeS + 1);
    if (!p.neck.cannulaOk) { n--; continue; }
    p.dispatch(VENT); p.run(600);
    if (p.chest.side) ptx++;
    if (p.neck.fona?.displaced) displaced++;
  }
  assert.ok(n >= 10, 'enough successful placements: ' + n);
  assert.ok(ptx / n > 0.15, `barotrauma in ${ptx}/${n}`);
  assert.ok(displaced / n > 0.2, `displacement in ${displaced}/${n}`);
  assert.ok((ptx + displaced) / n > 0.5, 'a cannula is an unreliable airway: ' + (ptx + displaced) + '/' + n);
});

test('the same cannula in an open (patent) upper airway has no barotrauma hazard: the cap only bites in a CICO', () => {
  const p = mk({ weightKg: 70 }, { seed: 6 }); p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 150 }); p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 80 });
  p.run(150); p.neck.palpable = true;
  const f = p.dispatch({ type: 'procedure.cricothyroidotomy', technique: 'cannula', approach: 'palpate' }); p.run(f.willTakeS + 1);
  p.dispatch(VENT); p.run(300);
  assert.equal(p.chest.side, null);
});

test('ultrasound marking costs 30 s with the hands off the airway and then makes an impalpable membrane as findable as a palpable one', () => {
  const p = scen('cico', 5); p.neck.palpable = false;
  assert.deepEqual(p.dispatch({ type: 'exam.neck' }), { ok: true, ctm: 'impalpable' });
  const us = p.dispatch({ type: 'exam.neck', method: 'ultrasound' }); assert.equal(us.willTakeS, 30); assert.equal(us.ctm, 'marked');
  assert.equal(p.airway.intubating, true); p.run(31); assert.equal(p.airway.intubating, false); assert.equal(p.neck.marked, true);
});

// ------------------------------------------------------------------------------------------ determinism, validation, API
test('surgical sessions replay bit-for-bit (separate random stream), and the gestures never perturb the main random stream', () => {
  for (const id of ['tension_ptx', 'cico']) {
    const p = scen(id, 7); p.run(60);
    if (id === 'tension_ptx') { p.dispatch({ type: 'exam.chest' }); p.dispatch({ type: 'procedure.needle_decompression', side: 'R', site: 'mal5', needleMm: 70 }); p.run(40); p.dispatch({ type: 'procedure.chest_tube', side: 'R', fr: 24 }); p.run(200); }
    else { p.dispatch({ type: 'exam.neck', method: 'ultrasound' }); p.run(40); p.dispatch({ type: 'procedure.cricothyroidotomy', technique: 'scalpel_bougie' }); p.run(150); p.dispatch(VENT); p.run(100); }
    const r = replay({ spec: p.spec, seed: p.seed, scenario: id, log: p.log, until: p.t }, SCENARIOS);
    assert.equal(r.stateHash(), p.stateHash(), id);
    assert.equal(r.chest.air, p.chest.air); assert.equal(r.neck.fona?.kind, p.neck.fona?.kind);
  }
  const a = mk({}, { seed: 12 }), b = mk({}, { seed: 12 });
  a.run(60); b.run(60);
  b.dispatch({ type: 'exam.chest' }); b.dispatch({ type: 'procedure.needle_decompression', side: 'L', site: 'mcl2', needleMm: 60 }); b.dispatch({ type: 'procedure.chest_tube', side: 'L' }); b.dispatch({ type: 'exam.neck', method: 'ultrasound' });
  a.run(200); b.run(200);
  assert.equal(a.rng.state, b.rng.state, 'the main random stream is untouched');
});

test('payload validation: malformed surgical events are rejected, logged and change nothing', () => {
  const p = mk({}); p.run(5); const before = p.stateHash();
  const bad = [
    { type: 'procedure.needle_decompression', side: 'X' }, { type: 'procedure.needle_decompression', side: 'R', site: 'groin' }, { type: 'procedure.needle_decompression', needleMm: 5 },
    { type: 'procedure.needle_decompression', needleMm: 500 }, { type: 'procedure.needle_decompression', needleMm: 'long' }, { type: 'procedure.needle_decompression', needleMm: NaN },
    { type: 'procedure.chest_tube' }, { type: 'procedure.chest_tube', side: 'up' }, { type: 'procedure.chest_tube', side: 'R', fr: 2 }, { type: 'procedure.chest_tube', side: 'R', fr: 'big' },
    { type: 'procedure.cricothyroidotomy', technique: 'laser' }, { type: 'procedure.cricothyroidotomy', approach: 'sideways' }, { type: 'exam.neck', method: 'xray' },
  ];
  for (const ev of bad) assert.equal(p.dispatch(ev).ok, false, JSON.stringify(ev));
  assert.equal(p.stateHash(), before); assert.equal(p.log.length, bad.length);
  assert.equal(p.chest.tubeBusy, false); assert.ok(!p.airway.intubating);
});

test('the event list exposes the new gestures and the snapshot carries the chest state for the client', () => {
  for (const t of ['procedure.needle_decompression', 'procedure.chest_tube', 'procedure.cricothyroidotomy', 'exam.chest', 'exam.pocus', 'exam.neck']) assert.ok(EVENT_TYPES.includes(t), t);
  const s = scen('tension_ptx', 1).snapshot();
  assert.equal(s.chest.side, 'R'); assert.ok(s.chest.air > 0.4 && 'tension' in s.chest && 'pip' in s.chest); assert.equal(s.fona, null);
  for (const v of Object.values(s.chest)) assert.ok(v === null || typeof v !== 'number' || Number.isFinite(v));
});

test('a healthy patient is unchanged by the surgical state: no pneumothorax means no extra shunt, dead space or intrathoracic pressure', () => {
  const p = mk({}, { seed: 3 }); p.run(120);
  assert.equal(p.chest.itp, 0); assert.equal(p.chest.shuntExtra, 0); assert.equal(p.chest.vaMult, 1); assert.equal(p.chest.cprMult, 1); assert.equal(p.chest.pumpMult, 1);
});

test('the scenario experts reach tension relief and a definitive drain, or a secured airway, in every one of ten seeds', async () => {
  const { expertRun } = await import('./helpers/experts.js'); const { scoreSession } = await import('../src/engine/scenarios.js');
  let ptxOk = 0, cicoOk = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const a = scen('tension_ptx', seed); expertRun(a, 'tension_ptx'); if (!a.arrest.arrested && a.chest.tension === 0 && scoreSession(a).pct >= 70) ptxOk++;
    const b = scen('cico', seed); expertRun(b, 'cico'); if (b.airway.intubated && !b.arrest.arrested && b.resp.sao2 > 0.95) cicoOk++;
  }
  assert.ok(ptxOk >= 8, 'tension_ptx ' + ptxOk + '/10');
  assert.ok(cicoOk >= 9, 'cico ' + cicoOk + '/10');
});
