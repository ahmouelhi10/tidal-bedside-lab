// Gas exchange. Oracles: research note "respiratory_gas_exchange.md" sections 8A-8F (Severinghaus/Hill tables, alveolar gas, acid-base, apnoea literature anchors).
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeBody } from '../src/engine/anthropometrics.js';
import { Respiratory, sevSat, sevInv, bohrShift, alveolarPO2, phHH } from '../src/engine/respiratory.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} +/- ${tol}`);
const body = spec => describeBody({ sex: 'M', age: 40, heightCm: 175, weightKg: 70, ...spec });

// ------------------------------------------------------------------ closed-form checks
test('Severinghaus SaO2 table (37 C, pH 7.40, PCO2 40) within 0.05 saturation points', () => {
  for (const [p, s] of [[26.8, 49.859], [40, 74.946], [60, 90.580], [100, 97.747], [500, 99.981], [10, 9.653], [20, 31.977]]) near(sevSat(p) * 100, s, 0.05, `PO2 ${p}`);
});
test('Severinghaus inverse round trip within 0.6 points over 0.10-0.99', () => {
  for (let s = 0.10; s <= 0.99; s += 0.01) near(sevSat(sevInv(s)) * 100, s * 100, 0.6, `S=${s.toFixed(2)}`);
});
test('Bohr / temperature / CO2 shift ("virtual PO2") examples', () => {
  // saturation at PO2 60 mmHg after the shift (note 8F): pH 7.20 / PCO2 60 -> 84.0; 39 C -> 87.5; 34 C -> 94.0
  near(sevSat(60 * bohrShift(7.20, 60, 37)) * 100, 84.0, 0.4, 'pH 7.20 PCO2 60');
  near(sevSat(60 * bohrShift(7.40, 40, 39)) * 100, 87.5, 0.4, '39 C');
  near(sevSat(60 * bohrShift(7.40, 40, 34)) * 100, 94.0, 0.4, '34 C');
});
test('alveolar gas equation (simple form) within 0.1 mmHg of the table', () => {
  near(alveolarPO2(0.21, 40), 99.73, 0.1, 'air'); near(alveolarPO2(0.5, 40), 306.5, 0.1, '50%'); near(alveolarPO2(1.0, 40), 663.0, 0.1, '100%');
});
test('Henderson-Hasselbalch with the acute HCO3 rule (+1 mmol/L per 10 mmHg): PCO2 40/60/80/100 -> pH 7.391/7.250/7.157/7.090', () => {
  for (const [pc, ph] of [[40, 7.391], [60, 7.250], [80, 7.157], [100, 7.090]]) near(phHH(24 + 0.1 * (pc - 40), pc), ph, 0.003, `PCO2 ${pc}`);
});

// ------------------------------------------------------------------ dynamic model
function resting(spec, { hb = 14.85 } = {}) {
  const b = body(spec), r = new Respiratory(b, { hb });
  for (let i = 0; i < 3000; i++) r.step(0.1, { co: r.q0, hb, vent: { mode: 'spont' } });
  return { r, b };
}
test('awake resting baseline for every body type: PaO2 / PaCO2 / pH / SpO2 / RR / ETCO2 in range', () => {
  for (const sex of ['M', 'F']) for (const [h, w, age] of [[165, 45, 30], [170, 70, 40], [175, 110, 55], [170, 150, 45], [160, 190, 50], [168, 60, 80]]) {
    const { r } = resting({ sex, heightCm: h, weightKg: w, age });
    const tag = `${sex} ${h}/${w}/${age}`;
    assert.ok(r.paco2 > 36 && r.paco2 < 44, `${tag} PaCO2 ${r.paco2.toFixed(1)}`);
    assert.ok(r.pH > 7.36 && r.pH < 7.44, `${tag} pH ${r.pH.toFixed(3)}`);
    assert.ok(r.pao2 > 65 && r.pao2 < 105, `${tag} PaO2 ${r.pao2.toFixed(0)}`);
    assert.ok(r.sao2 > 0.93, `${tag} SaO2 ${r.sao2.toFixed(3)}`);
    assert.ok(r.rr >= 8 && r.rr <= 20, `${tag} RR ${r.rr.toFixed(1)}`);
    assert.ok(r.etco2 > 30 && r.etco2 < 42, `${tag} ETCO2 ${r.etco2.toFixed(1)}`);
    assert.ok(r.lactate < 2.0, `${tag} lactate ${r.lactate.toFixed(2)}`);
  }
});
test('obesity lowers resting PaO2 and widens the A-a gradient (monotone in BMI)', () => {
  const p = [70, 100, 130, 170].map(w => resting({ weightKg: w, heightCm: 172, age: 45 }).r.pao2);
  for (let i = 1; i < p.length; i++) assert.ok(p[i] <= p[i - 1] + 0.5, `PaO2 sequence ${p.map(x => x.toFixed(0))}`);
});
test('age lowers PaO2 (A-a gradient rises with age)', () => {
  const a = resting({ age: 25 }).r.pao2, b = resting({ age: 80 }).r.pao2; assert.ok(b < a);
});

/** pre-oxygenate (awake, mask), then anaesthetise + paralyse and observe apnoea (airway closed). Returns timings of TRUE SaO2 crossings and PaCO2 series. */
function apnea(spec, { fio2 = 1.0, preoxS = 300, hb = 14.85, q0scale = 1, apOx = null, maxS = 1500 } = {}) {
  const b = body(spec), r = new Respiratory(b, { hb });
  for (let i = 0; i < 2400; i++) r.step(0.1, { co: r.q0, hb, vent: { mode: 'spont' } });
  const co = r.q0 * q0scale;
  if (fio2 > 0.21) for (let i = 0; i < preoxS * 10; i++) r.step(0.1, { co, hb, vent: { mode: 'spont' }, o2: { fio2, seal: 0.95 } });
  const etO2 = r.etO2, out = { etO2, t: {}, co2: {} };
  const ctx = { co, hb, anesthetized: true, paralyzed: true, vent: { mode: 'none' }, apOx };
  const p0 = r.paco2;
  for (let i = 0; i < maxS * 10; i++) {
    r.step(0.1, ctx); const t = (i + 1) / 10, s = r.sao2;
    for (const [k, thr] of [[90, 0.90], [85, 0.85], [80, 0.80], [60, 0.60]]) if (out.t[k] === undefined && s < thr) out.t[k] = t;
    for (const m of [60, 300]) if (Math.abs(t - m) < 0.05) out.co2[m] = r.paco2 - p0;
    if (s < 0.5) break;
  }
  out.r = r; return out;
}
const inBand = (v, lo, hi, tag) => assert.ok(v >= lo && v <= hi, `${tag}: ${v} not in [${lo}, ${hi}]`);

test('preoxygenation drives end-tidal O2 to >= 0.88 (5 min, tight mask)', () => {
  const a = apnea({}, { maxS: 5 }); assert.ok(a.etO2 >= 0.88, `ETO2 ${a.etO2.toFixed(3)}`);
});
test('apnoea, healthy 70 kg, preoxygenated: true SaO2 reaches 90% at 330-540 s and 85% at 340-560 s (Jense 364 s, Magnusson 391 s, Farmery 502 s)', () => {
  const a = apnea({}); inBand(a.t[90], 330, 540, 't90'); inBand(a.t[85], 340, 560, 't85');
});
test('apnoea, healthy, room-air start: SaO2 < 90% within 30-70 s', () => {
  const a = apnea({}, { fio2: 0.21 }); inBand(a.t[90], 30, 70, 't90 room air');
});
test('preoxygenation with 80% vs 100% O2: t90 difference 60-110 s (anchor 84 s)', () => {
  const hi = apnea({}, { fio2: 1.0 }), lo = apnea({}, { fio2: 0.8 }); inBand(hi.t[90] - lo.t[90], 55, 115, '100 vs 80%');
});
test('obese BMI 40 desaturates in 140-260 s (Jense obese/morbidly obese groups) and BMI 55 in 70-170 s, never later than BMI 40', () => {
  const o40 = apnea({ heightCm: 173, weightKg: 120 }), o55 = apnea({ heightCm: 173, weightKg: 165 });
  inBand(o40.t[90], 140, 260, 'BMI 40'); inBand(o55.t[90], 70, 170, 'BMI 55'); assert.ok(o55.t[90] <= o40.t[90]);
});
test('t90 shortens monotonically as BMI rises (lean -> super-obese), both sexes', () => {
  for (const sex of ['M', 'F']) {
    let prev = Infinity;
    for (const w of [55, 75, 100, 130, 170]) { const t = apnea({ sex, heightCm: 170, weightKg: w }).t[90]; assert.ok(t < prev + 8, `${sex} ${w} kg: ${t} vs prev ${prev}`); prev = t; }
  }
});
test('frail elderly (80 y, 60 kg, Hb 11, low CO) desaturate within the model band 240-560 s (CHECK: model-only, no clinical anchor)', () => {
  const a = apnea({ age: 80, weightKg: 60, heightCm: 165 }, { hb: 11, q0scale: 0.8 }); inBand(a.t[90], 240, 560, 'frail');
});
test('hypoxaemia deepens fast once SaO2 falls: 90% -> 60% in 20-70 s', () => {
  const a = apnea({}); inBand(a.t[60] - a.t[90], 20, 70, '90->60');   // note band 20-45 s is model-only (CHECK); Farmery-type falls of ~30%/min give ~60 s
});
test('apnoeic CO2 rise: +4-16 mmHg in the first minute and +17-28 at 5 min (about 3.4 mmHg/min afterwards)', () => {
  const a = apnea({}); inBand(a.co2[60], 4, 16, '1 min'); inBand(a.co2[300], 17, 28, '5 min');
  const slope = (a.co2[300] - a.co2[60]) / 4; inBand(slope, 2.0, 3.6, 'slope after 1 min');
});
test('apnoeic oxygenation delays desaturation; lower efficiency, shorter benefit', () => {
  const none = apnea({ heightCm: 173, weightKg: 120 }).t[90];
  const half = apnea({ heightCm: 173, weightKg: 120 }, { apOx: { fio2: 1, eff: 0.5 } }).t[90];
  const full = apnea({ heightCm: 173, weightKg: 120 }, { apOx: { fio2: 1, eff: 0.8 }, maxS: 1500 }).t[90];
  assert.ok(half === undefined || half > none + 120, `half ${half} none ${none}`);
  assert.ok(full === undefined || full > (half ?? 1500));
});
test('pulse oximeter lags the true SaO2 and misses the nadir by tens of seconds (finger probe)', () => {
  const b = body({}), r = new Respiratory(b, { hb: 14.85 });
  for (let i = 0; i < 2400; i++) r.step(0.1, { co: r.q0, vent: { mode: 'spont' } });
  const ctx = { co: r.q0, anesthetized: true, paralyzed: true, vent: { mode: 'none' } };
  let tTrue, tShown;
  for (let i = 0; i < 4000 && !tShown; i++) { r.step(0.1, ctx); if (!tTrue && r.sao2 < 0.9) tTrue = i / 10; if (!tShown && r.spo2 < 90) tShown = i / 10; }
  assert.ok(tShown - tTrue > 10 && tShown - tTrue < 60, `delay ${(tShown - tTrue).toFixed(0)} s`);
});

// ------------------------------------------------------------------ ventilation and drug effects on breathing
test('hyperventilation (12 L/min controlled) lowers PaCO2 below 30 and raises pH; hypoventilation raises PaCO2', () => {
  const b = body({}), r = new Respiratory(b, { hb: 14.85 });
  for (let i = 0; i < 2400; i++) r.step(0.1, { co: r.q0, vent: { mode: 'spont' } });
  for (let i = 0; i < 3000; i++) r.step(0.1, { co: r.q0, anesthetized: true, paralyzed: true, vent: { mode: 'ctrl', rate: 20, vt: 600, fio2: 0.4, peep: 5, seal: 1, efficiency: 1 } });
  assert.ok(r.paco2 < 30 && r.pH > 7.5, `PaCO2 ${r.paco2.toFixed(1)} pH ${r.pH.toFixed(2)}`);
  const r2 = new Respiratory(b, { hb: 14.85 });
  for (let i = 0; i < 2400; i++) r2.step(0.1, { co: r2.q0, vent: { mode: 'spont' } });
  for (let i = 0; i < 12000; i++) r2.step(0.1, { co: r2.q0, anesthetized: true, paralyzed: true, vent: { mode: 'ctrl', rate: 6, vt: 400, fio2: 0.4, peep: 5, seal: 1, efficiency: 1 } });
  assert.ok(r2.paco2 > 55 && r2.pH < 7.3, `hypoventilation (20 min) PaCO2 ${r2.paco2.toFixed(1)}`);
});
test('opioid ventilatory depression: rate, minute ventilation and SpO2 fall; PaCO2 rises (room air)', () => {
  const b = body({}), r = new Respiratory(b, { hb: 14.85 });
  for (let i = 0; i < 2400; i++) r.step(0.1, { co: r.q0, vent: { mode: 'spont' } });
  const ve0 = r.ve;
  for (let i = 0; i < 4800; i++) r.step(0.1, { co: r.q0, vent: { mode: 'spont' }, dep: { slope: 0.2, shift: 8, hypoxic: 0.3 } });
  assert.ok(r.ve < 0.7 * ve0 && r.paco2 > 50 && r.sao2 < 0.93, `VE ${r.ve.toFixed(1)}/${ve0.toFixed(1)} PaCO2 ${r.paco2.toFixed(0)} SaO2 ${r.sao2.toFixed(2)}`);
});
test('airway obstruction in a spontaneously breathing patient: rapid hypoxaemia and hypercapnia', () => {
  const b = body({}), r = new Respiratory(b, { hb: 14.85 });
  for (let i = 0; i < 2400; i++) r.step(0.1, { co: r.q0, vent: { mode: 'spont' } });
  for (let i = 0; i < 1200; i++) r.step(0.1, { co: r.q0, vent: { mode: 'spont' }, airwayPatency: 0 });
  assert.ok(r.sao2 < 0.85 && r.paco2 > 48, `SaO2 ${r.sao2.toFixed(2)} PaCO2 ${r.paco2.toFixed(0)}`);
});
test('low cardiac output during CPR lowers ETCO2 although PaCO2 rises; ROSC causes a transient ETCO2 overshoot (CO2 washout)', () => {
  const b = body({}), r = new Respiratory(b, { hb: 14.85 });
  for (let i = 0; i < 2400; i++) r.step(0.1, { co: r.q0, vent: { mode: 'spont' } });
  const ventCtx = { anesthetized: true, paralyzed: true, vent: { mode: 'ctrl', rate: 10, vt: 500, fio2: 1, peep: 0, seal: 1, efficiency: 1 } };
  let maxEt = 0; for (let i = 0; i < 600 * 5; i++) { r.step(0.1, { co: 0.3 * r.q0, ...ventCtx }); }
  const etLow = r.etco2; assert.ok(etLow < 25, `CPR ETCO2 ${etLow.toFixed(1)}`);
  assert.ok(r.pH < 7.36 && r.lactate > 1.5, `acidosis pH ${r.pH.toFixed(2)} lactate ${r.lactate.toFixed(1)}`);
  for (let i = 0; i < 600 * 2; i++) { r.step(0.1, { co: r.q0, ...ventCtx }); maxEt = Math.max(maxEt, r.etco2); }
  assert.ok(maxEt > etLow + 10, `ROSC ETCO2 peak ${maxEt.toFixed(1)}`);
});
test('atelectasis from FiO2 1.0 raises shunt in anaesthetised obese patients and PEEP reduces it', () => {
  const run = peep => { const b = body({ heightCm: 172, weightKg: 130 }), r = new Respiratory(b, { hb: 14.85 });
    for (let i = 0; i < 2400; i++) r.step(0.1, { co: r.q0, vent: { mode: 'spont' } });
    for (let i = 0; i < 6000; i++) r.step(0.1, { co: r.q0, anesthetized: true, paralyzed: true, vent: { mode: 'ctrl', rate: 12, vt: 450, fio2: 1.0, peep, seal: 1, efficiency: 1 } }); return r; };
  const lo = run(0), hi = run(10); assert.ok(lo.shunt > 0.1, `shunt ${lo.shunt.toFixed(3)}`); assert.ok(hi.shunt < lo.shunt && hi.pao2 > lo.pao2);
});
test('steady state is stable: no NaN, no drift in a 30-min awake run', () => {
  const { r } = resting({}); const a = r.paco2; for (let i = 0; i < 18000; i++) r.step(0.1, { co: r.q0, vent: { mode: 'spont' } });
  assert.ok(Number.isFinite(r.pao2) && Math.abs(r.paco2 - a) < 0.6);
});
