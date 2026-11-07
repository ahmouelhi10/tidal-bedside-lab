// Circulation, volume kinetics and thermal balance. Targets: research note "hemodynamics_fluids_simulators.md" (AT-CV-*, AT-FL-*, AT-O2-*),
// ATLS hemorrhage classes (design bands: human HR thresholds are weakly supported), Sessler/Kurz heat-balance anchors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeBody } from '../src/engine/anthropometrics.js';
import { Circulation } from '../src/engine/cardio.js';
import { Volumes } from '../src/engine/fluids.js';
import { Thermal } from '../src/engine/thermal.js';

const PERF = { perfusing: true, rate: null };
function sim(spec, { seconds = 60, bleed = null, ctx = {}, volOpt = {} } = {}) {
  const body = describeBody({ sex: 'M', age: 40, heightCm: 178, weightKg: 75, ...spec });
  const cv = new Circulation(body), vol = new Volumes(body);
  const step = () => { vol.step(0.1, { map: cv.mapArt }); cv.step(0.1, { rhythm: PERF, bloodVolume: vol.bloodVolume, ...ctx }); };
  for (let i = 0; i < 300; i++) step();
  const base = { hr: cv.hr, co: cv.co, map: cv.mapArt, sbp: cv.sbp, dbp: cv.dbp, svr: cv.svr, cvp: cv.rap };
  if (bleed) { vol.setBleed(bleed.fraction * vol.bloodVolume * 1000 / bleed.minutes); for (let i = 0; i < bleed.minutes * 600; i++) step(); vol.setBleed(0); }
  for (let i = 0; i < seconds * 10; i++) step();
  return { cv, vol, body, base };
}

// ------------------------------------------------------------------ AT-CV-1 baseline across the population
test('AT-CV-1: resting baselines land in physiological ranges for every body type', () => {
  for (const sex of ['M', 'F']) for (const [h, w] of [[165, 45], [165, 60], [175, 75], [175, 110], [170, 140], [165, 170]]) for (const age of [25, 60, 85]) {
    const { cv, body } = sim({ sex, age, heightCm: h, weightKg: w });
    const tag = `${sex} ${h}/${w} age ${age} (BMI ${body.bmi.toFixed(0)})`;
    assert.ok(Math.abs(cv.co / cv.CO0 - 1) < 0.10, `${tag}: CO ${cv.co.toFixed(2)} vs target ${cv.CO0.toFixed(2)}`);
    assert.ok(cv.hr >= 60 && cv.hr <= 100, `${tag}: HR ${cv.hr.toFixed(0)}`);
    assert.ok(cv.mapArt >= 70 && cv.mapArt <= 105, `${tag}: MAP ${cv.mapArt.toFixed(0)}`);
    assert.ok(cv.rap >= 2 && cv.rap <= 6, `${tag}: CVP ${cv.rap.toFixed(1)}`);
    const si = cv.hr / cv.sbp; assert.ok(si >= 0.45 && si <= 0.75, `${tag}: shock index ${si.toFixed(2)}`);
  }
});

test('AT-CV-1: standard 70-kg man has CI near 3 L/min/m2 and SV 55-95 mL', () => {
  const { cv, body } = sim({ weightKg: 70, heightCm: 175 });
  assert.ok(cv.co / body.bsa > 2.5 && cv.co / body.bsa < 3.5, `CI ${(cv.co / body.bsa).toFixed(2)}`);
  assert.ok(cv.sv >= 55 && cv.sv <= 95, `SV ${cv.sv.toFixed(0)}`);
});

test('AT-CV-2: MAP = DBP + (SBP-DBP)/3', () => {
  const { cv } = sim({});
  assert.ok(Math.abs(cv.mapArt - (cv.dbp + (cv.sbp - cv.dbp) / 3)) < 0.5);
});

test('stroke volume and cardiac output scale with body size', () => {
  const small = sim({ sex: 'F', heightCm: 155, weightKg: 48 }).cv, big = sim({ sex: 'M', heightCm: 185, weightKg: 100 }).cv;
  assert.ok(big.co > small.co * 1.3);
});

// ------------------------------------------------------------------ hemorrhage (ATLS-class bands) and monotonicity
test('hemorrhage: ATLS-class response, 3 min after the bleed stops', () => {
  const r = f => sim({}, { bleed: { fraction: f, minutes: 0.5 }, seconds: 170 }).cv;
  const c1 = r(0.10), c2 = r(0.20), c3 = r(0.30), c4 = r(0.40);
  assert.ok(c1.hr < 100 && c1.mapArt > 75, 'class I (<15%): HR < 100, MAP maintained');
  assert.ok(c2.hr > 80 && c2.hr < 120 && c2.mapArt > 70, `class II (15-30%): HR ${c2.hr.toFixed(0)} MAP ${c2.mapArt.toFixed(0)}`);
  assert.ok(c3.hr > 95 && c3.hr < 140, `class III start (~30%): HR ${c3.hr.toFixed(0)}`);
  assert.ok(c4.hr > 110 && c4.hr < 160 && c4.sbp < 100, `class III-IV (~40%): HR ${c4.hr.toFixed(0)} SBP ${c4.sbp.toFixed(0)}`);
});

test('hemorrhage: HR and shock index rise, pulse pressure and CVP fall monotonically with blood loss', () => {
  let prev = null;
  for (const f of [0, 0.05, 0.10, 0.20, 0.30, 0.40]) {
    const { cv } = sim({}, f ? { bleed: { fraction: f, minutes: 0.5 }, seconds: 170 } : {});
    const cur = { hr: cv.hr, pp: cv.sbp - cv.dbp, si: cv.hr / cv.sbp, cvp: cv.rap, co: cv.co };
    if (prev) { assert.ok(cur.hr > prev.hr - 0.5, `HR at ${f}`); assert.ok(cur.pp < prev.pp + 0.5, `PP at ${f}`); assert.ok(cur.si > prev.si - 0.005, `SI at ${f}`); assert.ok(cur.cvp < prev.cvp + 0.2, `CVP at ${f}`); assert.ok(cur.co < prev.co + 0.05, `CO at ${f}`); }
    prev = cur;
  }
});

test('massive hemorrhage (>45%) is not survivable without treatment: MAP collapses below 40', () => {
  const { cv } = sim({}, { bleed: { fraction: 0.5, minutes: 0.5 }, seconds: 170 });
  assert.ok(cv.mapArt < 40);
});

test('hemorrhage with blood replacement restores MAP and HR', () => {
  const body = describeBody({ sex: 'M', age: 40, heightCm: 178, weightKg: 75 });
  const cv = new Circulation(body), vol = new Volumes(body);
  const step = () => { vol.step(0.1, { map: cv.mapArt }); cv.step(0.1, { rhythm: PERF, bloodVolume: vol.bloodVolume }); };
  for (let i = 0; i < 300; i++) step();
  vol.setBleed(0.30 * vol.bloodVolume * 1000 / 5); for (let i = 0; i < 3000; i++) step(); vol.setBleed(0);
  for (let i = 0; i < 600; i++) step();
  const hurt = cv.mapArt, hrHurt = cv.hr;
  for (let u = 0; u < 5; u++) vol.transfuse('whole');
  for (let i = 0; i < 1800; i++) step();
  assert.ok(cv.mapArt > hurt && cv.hr < hrHurt, `MAP ${hurt.toFixed(0)} -> ${cv.mapArt.toFixed(0)}, HR ${hrHurt.toFixed(0)} -> ${cv.hr.toFixed(0)}`);
  assert.ok(cv.mapArt > 70);
});

// ------------------------------------------------------------------ pharmacological levers and failure modes
test('vasoconstrictor raises MAP and vasodilator / venodilator lowers it', () => {
  const base = sim({}).cv.mapArt;
  const up = sim({}, { ctx: { fx: { svr: 1.5, inotropy: 1, ven: 0, chrono: 1, hrAdd: 0, baro: 1 } } }).cv.mapArt;
  const dn = sim({}, { ctx: { fx: { svr: 0.6, inotropy: 1, ven: 0, chrono: 1, hrAdd: 0, baro: 1 } } }).cv.mapArt;
  assert.ok(up > base * 1.04 && dn < base * 0.96,   // baroreflex buffers open-loop changes (closed-loop effect size is validated with the drug tests)
     `${dn.toFixed(0)} < ${base.toFixed(0)} < ${up.toFixed(0)}`);
});

test('failing ventricle: lower LV function lowers CO and MAP, raises CVP', () => {
  const ok = sim({}).cv, bad = sim({}, { ctx: { lvFunction: 0.45 } }).cv;
  assert.ok(bad.co < ok.co * 0.9 && bad.rap > ok.rap, `CO ${ok.co.toFixed(1)}->${bad.co.toFixed(1)} CVP ${ok.rap.toFixed(1)}->${bad.rap.toFixed(1)}`);
});

test('cardiac arrest without compressions: flow ~0, MAP falls to a low plateau', () => {
  const body = describeBody({ sex: 'M', age: 50, heightCm: 175, weightKg: 80 });
  const cv = new Circulation(body);
  for (let i = 0; i < 300; i++) cv.step(0.1, { rhythm: PERF, bloodVolume: body.bloodVolume });
  for (let i = 0; i < 600; i++) cv.step(0.1, { rhythm: { perfusing: false }, bloodVolume: body.bloodVolume, cprFlow: 0, arrestTone: 1 });
  assert.ok(cv.co < 0.3 && cv.mapArt < 25, `CO ${cv.co.toFixed(2)} MAP ${cv.mapArt.toFixed(0)}`);
});

// ------------------------------------------------------------------ fluids
function infusionRun(minutes, anesthetized) {
  const b = describeBody({ sex: 'M', age: 40, heightCm: 178, weightKg: 75 }), v = new Volumes(b), vp0 = v.vp;
  v.startInfusion(1.0, minutes, 'crystalloid');
  let t = 0; for (; t < minutes * 60; t += 0.1) v.step(0.1, { map: 90, anesthetized });
  const atEnd = (v.vp - vp0);
  for (; t < (minutes + 30) * 60; t += 0.1) v.step(0.1, { map: 90, anesthetized });
  return { atEnd, post30: v.vp - vp0, urine: v.urine };
}
test('AT-FL-1: plasma expansion by 1 L Ringer falls with infusion time (75/60/50% +/- 10 points) and settles at 15-30%', () => {
  const r10 = infusionRun(10, false), r20 = infusionRun(20, false), r30 = infusionRun(30, false);
  assert.ok(r10.atEnd > 0.65 && r10.atEnd < 0.85, `10 min: ${r10.atEnd.toFixed(2)}`);
  assert.ok(r20.atEnd > 0.50 && r20.atEnd < 0.70, `20 min: ${r20.atEnd.toFixed(2)}`);
  assert.ok(r30.atEnd > 0.40 && r30.atEnd < 0.60, `30 min: ${r30.atEnd.toFixed(2)}`);
  assert.ok(r10.atEnd > r20.atEnd && r20.atEnd > r30.atEnd);
  for (const r of [r10, r20, r30]) assert.ok(r.post30 > 0.14 && r.post30 < 0.32, `30 min after: ${r.post30.toFixed(2)}`);
});
test('AT-FL-1: urine output is ~10x lower under general anaesthesia and the plasma keeps more of the fluid', () => {
  const awake = infusionRun(30, false), an = infusionRun(30, true);
  assert.ok(awake.urine > 5 * an.urine, `urine ${awake.urine.toFixed(2)} vs ${an.urine.toFixed(2)}`);
  assert.ok(an.post30 > awake.post30);
});
test('volume bookkeeping: infused crystalloid is conserved (plasma + interstitial + third space + urine)', () => {
  const b = describeBody({ sex: 'F', age: 30, heightCm: 165, weightKg: 62 }), v = new Volumes(b);
  const tot0 = v.vp + v.vi + v.v3 + v.urine; v.startInfusion(2.0, 20, 'crystalloid');
  for (let t = 0; t < 7200; t += 0.1) v.step(0.1, { map: 90 });
  assert.ok(Math.abs((v.vp + v.vi + v.v3 + v.urine) - tot0 - 2.0) < 1e-3);
});
test('Hct falls with crystalloid hemodilution and with hemorrhage + crystalloid, rises with pRBC (AT-O2-1 Hb scaling)', () => {
  const b = describeBody({ sex: 'M', age: 40, heightCm: 178, weightKg: 75 }), v = new Volumes(b); const hct0 = v.hct;
  v.startInfusion(2.0, 15, 'crystalloid'); for (let t = 0; t < 900; t += 0.1) v.step(0.1, { map: 90 });
  assert.ok(v.hct < hct0 - 0.01);
  const h1 = v.hct; v.transfuse('prbc'); assert.ok(v.hct > h1);
  assert.ok(Math.abs(hct0 * 33 - 14.85) < 1, 'resting Hb of a man ~14-15 g/dL');
});
test('AT-O2-1: oxygen content / delivery arithmetic (Hb 15 g/dL, CO 5 L/min -> CaO2 ~200 mL/L, DO2 ~1000 mL/min)', async () => {
  const { capContent } = await import('../src/engine/respiratory.js');
  const cao2 = capContent(0.98, 100, 15) * 10;          // mL/L  (sat, PO2, Hb g/dL)
  assert.ok(Math.abs(cao2 - 200) < 12 && Math.abs(cao2 * 5 - 1000) < 60, `CaO2 ${cao2.toFixed(0)}`);
  const half = capContent(0.98, 100, 7.5) * 10; assert.ok(Math.abs(half - 101) < 8);
});

// ------------------------------------------------------------------ thermal
function therm(w, anesthetized, { device = null, cover = 1, hours = 3, vd = 0.3, amb = 21 } = {}) {
  const b = describeBody({ sex: 'M', age: 40, heightCm: 178, weightKg: w }), th = new Thermal(b);
  th.setAmbient(amb); th.cover = cover; if (device) th.setDevice(device);
  const vo2 = b.vo2 * (anesthetized ? 0.8 : 1); const at = {};
  for (let t = 0; t <= hours * 3600; t += 0.1) { th.step(0.1, { vo2, anesthetized, vasodilation: anesthetized ? vd : 0, perfusion: 1 }); for (const m of [60, 180]) if (Math.abs(t - m * 60) < 0.05) at[m] = th.tc; }
  return { tc: th.tc, at };
}
test('awake patient on a sheet in a 21 C room keeps core temperature within 0.5 C of 37', () => {
  const r = therm(75, false); assert.ok(r.tc > 36.5 && r.tc < 37.1, `${r.tc.toFixed(2)}`);
});
test('general anaesthesia without warming: 1-2 C redistribution drop in the first hour, plateau 34-35.5 C (Sessler)', () => {
  const r = therm(75, true, { hours: 5 }), drop = 37 - r.at[60];
  assert.ok(drop > 0.8 && drop < 2.0, `1 h drop ${drop.toFixed(2)}`);
  assert.ok(r.tc > 34 && r.tc < 35.5, `5 h core ${r.tc.toFixed(2)}`);
});
test('obese patients lose less core temperature by redistribution than lean patients', () => {
  assert.ok(therm(140, true).at[60] > therm(55, true).at[60]);
});
test('active warming and insulation prevent hypothermia under anaesthesia', () => {
  assert.ok(therm(75, true, { device: { targetC: 37, maxWatts: 300 } }).tc > 36.5);
  assert.ok(therm(75, true, { cover: 0.5 }).tc > therm(75, true).tc + 0.4);
});
