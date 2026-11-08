// Focused echocardiography: guideline cut-offs (asserted as quoted in the sources), the image model against the published normal
// ranges and patterns, the pericardial effusion and RV-overload physiology, the echo events and replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Patient, replay } from '../src/engine/patient.js';
import { SCENARIOS, scoreSession } from '../src/engine/scenarios.js';
import { ECHO_CUTOFFS, lvefGrade, focusLvClass, rapFromIvc, ivcModel, echoState, reportTruth, Pericardium } from '../src/engine/echo.js';

const mk = (spec = {}, seed = 1) => new Patient({ sex: 'M', age: 45, heightCm: 175, weightKg: 80, ...spec }, { seed });

test('cut-offs are the published ones (Lang 2015, Rudski 2010, Via 2014)', () => {
  // Lang 2015 Table 4 (LVEF %, 2D biplane)
  assert.deepEqual(ECHO_CUTOFFS.lvef.M.normal, [52, 72]); assert.deepEqual(ECHO_CUTOFFS.lvef.F.normal, [54, 74]);
  assert.equal(lvefGrade(52, 'M'), 'normal'); assert.equal(lvefGrade(51, 'M'), 'mild'); assert.equal(lvefGrade(53, 'F'), 'mild');
  assert.equal(lvefGrade(40, 'F'), 'moderate'); assert.equal(lvefGrade(29, 'M'), 'severe'); assert.equal(lvefGrade(75, 'M'), 'above');
  assert.equal(focusLvClass(80, 'M'), 'hyperkinetic'); assert.equal(focusLvClass(60, 'F'), 'normokinetic');
  assert.equal(focusLvClass(45, 'M'), 'hypokinetic'); assert.equal(focusLvClass(20, 'F'), 'severely_hypokinetic');
  assert.equal(ECHO_CUTOFFS.tapseAbnormalBelowMm, 17); assert.equal(ECHO_CUTOFFS.rvBasalUpperMm, 41);
  // Rudski 2010 Table 3
  assert.equal(rapFromIvc(18, 60).rap, 3); assert.equal(rapFromIvc(21, 51).rap, 3);
  assert.equal(rapFromIvc(24, 30).rap, 15);
  assert.equal(rapFromIvc(18, 40).rap, 8); assert.equal(rapFromIvc(24, 60).rap, 8);
  assert.deepEqual(rapFromIvc(11, 0, { ventilated: true }), { rap: null, below10: true });   // collapse unusable under positive pressure; <= 12 mm -> RA < 10
  assert.equal(ECHO_CUTOFFS.ivcHypovolaemiaMm, 10);
});

test('IVC model: the Rudski category it produces contains the true RA pressure over the whole range', () => {
  const range = { 3: [0, 5], 8: [5, 10], 15: [10, 20] };
  for (let rap = -2; rap <= 20; rap += 0.25) {
    const v = ivcModel(rap), cat = rapFromIvc(v.max, v.sniff).rap, [lo, hi] = range[cat];
    assert.ok(rap <= hi + 1e-9 && (rap >= lo - 1e-9 || cat === 3), `RA ${rap} -> ${cat} (${v.max.toFixed(1)} mm, ${v.sniff.toFixed(0)} %)`);
    if (rap > 10) assert.ok(v.quiet < ECHO_CUTOFFS.quietCollapsePct, 'quiet-breathing collapse < 20 % when RA pressure is high');
  }
  assert.equal(ivcModel(5, true).sniff, 0);
});

test('a resting adult has a normal echo in both sexes (Lang 2015 normal ranges)', () => {
  for (const [sex, h, w] of [['M', 178, 78], ['F', 163, 60]]) {
    const p = mk({ sex, heightCm: h, weightKg: w }).run(60), s = echoState(p), c = ECHO_CUTOFFS;
    const [efLo, efHi] = c.lvef[sex].normal, [dLo, dHi] = c.lveddMm[sex];
    assert.ok(s.ef >= efLo && s.ef <= efHi, `${sex} EF ${s.ef}`);
    assert.ok(s.lvedd >= dLo && s.lvedd <= dHi, `${sex} LVEDD ${s.lvedd}`);
    assert.ok(s.tapse >= c.tapseAbnormalBelowMm && s.rvBasal <= c.rvBasalUpperMm && s.rvMid <= c.rvMidUpperMm);
    assert.equal(s.effusionMm, 0); assert.equal(s.raCollapse || s.rvCollapse, false);
    assert.deepEqual(reportTruth(s), { lv: 'normokinetic', rv: 'normal', rap: 3, peri: 'none', dx: 'normal' });
  }
});

test('blood loss: small hyperdynamic LV and a small IVC (Via 2014 hypovolaemic pattern)', () => {
  const p = mk({}, 2); p.vol.setBleed(150); p.run(600); p.vol.setBleed(0); p.run(30);
  const s = echoState(p), base = echoState(mk({}, 2).run(60));
  assert.ok(p.vol.fractionLost > 0.2);
  assert.ok(s.ef > ECHO_CUTOFFS.lvef.M.normal[1], `EF ${s.ef}`);
  assert.ok(s.lvedd < base.lvedd - 5, `LVEDD ${s.lvedd} vs ${base.lvedd}`);
  assert.ok(s.ivcMax < ECHO_CUTOFFS.ivcHypovolaemiaMm, `IVC ${s.ivcMax}`);
  assert.equal(reportTruth(s).dx, 'hypovolaemia');
});

test('LV systolic failure: severely reduced EF, dilated LV, higher filling pressure', () => {
  const s = echoState(mk({ lvFunction: 0.3, age: 68 }).run(120)), base = echoState(mk({ age: 68 }).run(120));
  assert.equal(lvefGrade(s.ef, 'M'), 'severe');
  assert.ok(s.lvedd > ECHO_CUTOFFS.lveddMm.M[1], `LVEDD ${s.lvedd}`);
  assert.ok(s.rap > base.rap + 2);
  assert.equal(reportTruth(s).dx, 'lv_failure');
});

test('pericardial effusion: pressure rises steeply with volume, tamponade signs appear, drainage reverses them', () => {
  const peri = new Pericardium(0); assert.equal(peri.pressure, 0); assert.equal(peri.depthMm, 0);
  const pr = [100, 250, 400].map(v => new Pericardium(v).pressure); assert.ok(pr[1] - pr[0] < pr[2] - pr[1], 'convex P-V curve');
  const base = mk({ age: 55 }).run(120), p = mk({ age: 55, effusionMl: 440 }); p.vol.startInfusion(1.2, 10, 'crystalloid'); p.run(300);
  const s = echoState(p);
  assert.ok(!p.arrest.arrested && p.circ.co < base.circ.co * 0.85, `CO ${p.circ.co.toFixed(2)} vs ${base.circ.co.toFixed(2)}`);
  assert.ok(p.circ.rap > base.circ.rap + 3 && p.circ.hr > base.circ.hr + 8);
  assert.ok(s.effusionMm > 10 && s.raCollapse && s.rvCollapse);
  assert.equal(reportTruth(s).peri, 'tamponade');
  const r = p.dispatch({ type: 'procedure.pericardiocentesis' }); p.run(120);
  const s2 = echoState(p);
  assert.ok(r.drainedMl > 300 && !s2.rvCollapse && p.circ.co > base.circ.co * 0.9, `after drainage CO ${p.circ.co.toFixed(2)}`);
});

test('acute RV pressure overload: dilated RV, low TAPSE, D-shaped LV, underfilled LV (Lang 2015 cut-offs)', () => {
  const base = mk({ age: 61 }).run(120), p = mk({ age: 61, rvLoad: 0.7 }).run(120), s = echoState(p), b = echoState(base);
  assert.ok(s.rvBasal > ECHO_CUTOFFS.rvBasalUpperMm && s.tapse < ECHO_CUTOFFS.tapseAbnormalBelowMm && s.dShape);
  assert.ok(s.lvedd < b.lvedd && p.circ.co < base.circ.co && p.circ.rap > base.circ.rap);
  assert.equal(reportTruth(s).dx, 'rv_failure');
});

test('echo events: validated, logged, change nothing in the physiology, and replay to the same hash', () => {
  const a = mk({}, 9), b = mk({}, 9);
  assert.equal(a.dispatch({ type: 'echo.view', view: 'plax', quality: 0.9 }).ok, true);
  assert.equal(a.dispatch({ type: 'echo.measure', what: 'tapse', value: 23 }).ok, true);
  assert.equal(a.dispatch({ type: 'echo.report', lv: 'normokinetic', rv: 'normal', rap: 3, peri: 'none', dx: 'normal' }).ok, true);
  for (const bad of [{ type: 'echo.view', view: 'apical2', quality: 1 }, { type: 'echo.view', view: 'plax', quality: 2 }, { type: 'echo.measure', what: 'tapse', value: 'x' },
    { type: 'echo.measure', what: 'gls', value: 3 }, { type: 'echo.report', lv: 'great' }, { type: 'echo.report', mood: 'ok' }]) assert.equal(a.dispatch(bad).ok, false, JSON.stringify(bad));
  a.run(60); b.run(60);
  assert.equal(a.stateHash(), b.stateHash(), 'looking does not change the patient');
  assert.equal(a.echo.measures[0].truth, echoState(mk({}, 9)).tapse);
  const r = replay({ spec: a.spec, seed: 9, scenario: null, log: a.log, until: a.t }, SCENARIOS);
  assert.equal(r.stateHash(), a.stateHash()); assert.equal(r.echo.views.length, 1);
});

test('echo scoring: wrong measurements and a wrong diagnosis cost points', () => {
  const p = new Patient(SCENARIOS.echo_rv.spec, { seed: 4, scenario: SCENARIOS.echo_rv });
  for (const view of ['ivc', 'plax', 'a4c']) { p.run(20); p.dispatch({ type: 'echo.view', view, quality: 0.9 }); }
  p.dispatch({ type: 'echo.measure', what: 'tapse', value: 24 });                                  // a normal-looking TAPSE: 7 mm off
  p.dispatch({ type: 'echo.report', lv: 'hyperkinetic', rv: 'normal', rap: 3, peri: 'none', dx: 'hypovolaemia' });
  const sc = scoreSession(p), it = Object.fromEntries(sc.items.map(i => [i.id, i]));
  assert.equal(it.echo_views.frac, 0.6); assert.equal(it.echo_dx.frac, 0);
  assert.ok(it.echo_order.frac < 0.6 && it.echo_measures.frac < 0.25 && it.echo_interp.frac <= 0.5);
  assert.ok(sc.pct < 40);
});
