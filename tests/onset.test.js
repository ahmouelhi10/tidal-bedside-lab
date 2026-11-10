// When drug effects appear: time from an IV bolus to the first change a fully monitored patient shows (the drug panel's
// "visible on the monitor" timing, measured with the same thresholds as src/web/effects.js), checked against published bands.
// Bands come from the sources, never from the code: a drug cannot act before it reaches the heart (adenosine, which acts on
// first pass, blocks the AV node 17.5 +/- 1.0 s (SEM, n = 10) after an antecubital injection and 21.9 s after a hand vein, REF ng1999;
// heart-rate fall about 20 s after injection lasting < 10 s, REF watt1986); epinephrine raises BP in < 5 min and offsets within
// 15 min (REF label_epinephrine); phenylephrine acts rapidly and may persist up to 20 min (REF label_phenylephrine); atropine's
// maximum heart rate comes 7 to 8 min after IV dosing (REF label_atropine); adenosine converts 60 % of PSVT within one minute (REF label_adenosine).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Patient, replay } from '../src/engine/patient.js';
import { readVitals, diffVitals } from '../src/web/effects.js';

const SPEC = { sex: 'M', age: 40, heightCm: 175, weightKg: 75 };
const EARLIEST_S = 12;   // lower edge of the arm-to-heart first-pass times (ng1999 antecubital 17.5 +/- 1.0 SEM, n = 10)

function monitored(spec = SPEC, seed = 1) {
  const p = new Patient(spec, { seed });
  p.dispatch({ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, capnography: true, aline: true } });
  p.dispatch({ type: 'iv.access' }); p.run(5);
  return p;
}
/** bolus, then per-second readings: first visible change (s), and the readings themselves */
function course(drug, amount, seconds, spec, seed) {
  const p = monitored(spec, seed), base = readVitals(p);
  p.dispatch({ type: 'drug.bolus', drug, amount });
  const s = []; let onset = null;
  for (let i = 1; i <= seconds; i++) { p.run(1); const v = readVitals(p); s.push(v); if (onset == null && diffVitals(base, v).length) onset = i; }
  return { base, s, onset, p };
}

test('peripheral IV bolus: no single-compartment drug changes the monitor before it can reach the heart (>= 12 s)', () => {
  for (const [drug, dose] of [['epinephrine', 1000], ['phenylephrine', 100], ['vasopressin', 40], ['nitroglycerin', 400], ['adenosine', 6], ['atropine', 1000]]) {
    const r = course(drug, dose, 90);
    assert.ok(r.onset != null && r.onset >= EARLIEST_S, `${drug}: first visible change at ${r.onset} s`);
  }
});

test('epinephrine IV (no arrest): BP rises in < 5 min (20 mcg and 1 mg); a 20 mcg dose is back within 15 min', () => {
  for (const dose of [20, 1000]) {
    const r = course('epinephrine', dose, 1200);
    const up = r.s.findIndex(v => v.map - r.base.map >= 8) + 1;
    assert.ok(up >= EARLIEST_S && up < 300, `${dose} mcg: BP up at ${up} s`);
    if (dose > 20) continue;   // the label's offset is for its own (infusion-range) doses; a 1 mg bolus lasts longer
    let last = 0; r.s.forEach((v, i) => { if (Math.abs(v.map - r.base.map) >= 8) last = i + 1; });
    assert.ok(last <= 900, `BP back to baseline at ${last} s`);
  }
});

test('phenylephrine 100 mcg: rapid BP rise, gone within 20 min', () => {
  const r = course('phenylephrine', 100, 1500);
  const up = r.s.findIndex(v => v.map - r.base.map >= 8) + 1;
  assert.ok(up >= EARLIEST_S && up <= 60, `BP up at ${up} s`);
  assert.ok(Math.abs(r.s[1199].map - r.base.map) < 8, `MAP at 20 min ${r.s[1199].map} vs ${r.base.map}`);
});

test('adenosine 6 mg in sinus rhythm: transient AV block / heart-rate fall 12-25 s after injection, lasting < 10 s', () => {
  const r = course('adenosine', 6, 60);
  const blocked = r.s.map(v => v.rhythm !== 'NSR');
  const start = blocked.indexOf(true) + 1, end = blocked.lastIndexOf(true) + 1;
  assert.ok(start >= EARLIEST_S && start <= 25, `block at ${start} s`);
  assert.ok(end - start + 1 < 10, `block lasts ${end - start + 1} s`);
  assert.ok(Math.min(...r.s.map(v => v.hr)) <= r.base.hr - 8, 'heart rate falls visibly');
  assert.equal(r.s[59].rhythm, 'NSR');
});

test('adenosine 6 mg in SVT: conversions happen within one minute', () => {
  let converted = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const r = course('adenosine', 6, 90, { ...SPEC, rhythm: 'SVT' }, seed);
    const at = r.s.findIndex(v => v.rhythm === 'NSR') + 1;
    if (at > 0) { converted++; assert.ok(at >= EARLIEST_S && at <= 60, `seed ${seed}: NSR at ${at} s`); }
    else assert.equal(r.s[89].rhythm, 'SVT', `seed ${seed}: an unconverted SVT stays SVT`);
  }
  assert.ok(converted >= 3, `${converted}/8 converted`);
});

test('atropine 1 mg: maximum heart rate 4-11 min after the bolus (label: 7-8 min)', () => {
  const r = course('atropine', 1000, 1200), hr = r.p.circ.hr;
  const p = monitored(); p.dispatch({ type: 'drug.bolus', drug: 'atropine', amount: 1000 });
  let best = 0, at = 0;
  for (let i = 1; i <= 1200; i++) { p.run(1); if (p.circ.hr > best) { best = p.circ.hr; at = i; } }
  assert.ok(at >= 240 && at <= 660, `peak HR at ${at} s`);
  assert.ok(r.onset != null && r.onset >= EARLIEST_S && hr > r.base.hr, `first visible change at ${r.onset} s`);
});

test('drugs in transit are part of the replay state: stateHash sees them and replay reproduces them', () => {
  const at = dose => { const p = new Patient(SPEC, { seed: 3 }); p.run(10); p.dispatch({ type: 'drug.bolus', drug: 'phenylephrine', amount: dose }); p.run(5); return p; };
  const a = at(100), b = at(200);
  assert.equal(a.drugs.inTransit('phenylephrine'), 100);
  assert.notEqual(a.stateHash(), b.stateHash(), 'the queued amount is hashed');
  const r = replay({ spec: SPEC, seed: 3, scenario: null, log: a.log, until: a.t }, {});
  assert.equal(r.stateHash(), a.stateHash());
  a.run(15); assert.equal(a.drugs.inTransit('phenylephrine'), 0); assert.ok(a.drugs.cp('phenylephrine') > 0, 'arrived after the transit');
});

// ---------------------------------------------------------------- hypnotic onset: ventilatory and sedative PD
// The PD targets are the published measurements, not values read back from the code:
//  - propofol 1 ug/mL steady state depresses ventilation at a fixed PetCO2 of 55 mmHg by 44.3 +/- 3.9 % (REF nieuwenhuijs2003);
//  - midazolam 0.13-0.15 mg/kg IV lowers the CO2-response slope by 29 +/- 5 % (REF gross1991) to about 33 % (REF forster1980);
//  - midazolam IV induction without premedication takes 2 to 2.5 min (REF label_midazolam).
/** ventilation the respiratory model would produce at a fixed PaCO2, for a drug held at a steady effect-site concentration */
function ventAt(drug, ce, pco2 = 55) {
  const p = new Patient(SPEC, { seed: 1 });
  p.drugs.model(drug); p.drugs.pk[drug].ce = ce; p.drugs.hemo[drug] = ce;
  const e = p.drugs.effects({});
  const V = (slope, shift) => 2.0 * slope * (pco2 - (36.75 + shift));   // the hypercapnic drive of src/engine/respiratory.js
  return { rel: V(e.dep.slope, e.dep.shift) / V(1, 0), slope: e.dep.slope };
}

test('propofol ventilatory depression matches the published concentration-response (-44.3 +/- 3.9 % at 1 ug/mL)', () => {
  const drop = (1 - ventAt('propofol', 1.0).rel) * 100;
  assert.ok(drop >= 36 && drop <= 53, `ventilation at PetCO2 55 fell ${drop.toFixed(1)} % (published 44.3 +/- 3.9 %)`);
  assert.ok(ventAt('propofol', 2.0).rel < ventAt('propofol', 1.0).rel, 'dose-dependent');
});

test('propofol induction dose: ventilation collapses 30-60 s after the bolus', () => {
  for (const perKg of [2.0, 2.5]) {                            // the label induction range for a healthy adult
    const p = new Patient(SPEC, { seed: 1 }); p.run(5);
    const ve0 = p.resp.ve;
    p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: perKg * SPEC.weightKg });
    let at = null;
    for (let s = 1; s <= 300 && at == null; s++) { p.run(1); if (p.resp.ve < 0.3 * ve0) at = s; }
    assert.ok(at != null && at >= 20 && at <= 60, `${perKg} mg/kg: ventilation below 30 % of baseline at ${at} s`);
  }
});

test('midazolam CO2-response depression matches the published slope fall (-29 to -33 % at 0.13-0.15 mg/kg)', () => {
  const p = new Patient(SPEC, { seed: 1 }); p.run(5);
  p.dispatch({ type: 'drug.bolus', drug: 'midazolam', amount: 0.14 * SPEC.weightKg });
  let worst = 1;
  for (let s = 1; s <= 900; s++) { p.run(1); worst = Math.min(worst, p.drugs.effects({}).dep.slope); }
  const drop = (1 - worst) * 100;
  assert.ok(drop >= 22 && drop <= 42, `CO2-response slope fell ${drop.toFixed(1)} % (published 29-33 %)`);
});

test('midazolam IV induction (0.3 mg/kg) takes 2-2.5 min, and a premedication dose does not induce', () => {
  const loc = (spec, mgPerKg) => {
    const p = new Patient(spec, { seed: 1 }); p.run(5);
    p.dispatch({ type: 'drug.bolus', drug: 'midazolam', amount: +(mgPerKg * spec.weightKg).toFixed(1) });
    for (let s = 1; s <= 900; s++) { p.run(1); if (p.drugs.effects({}).loc) return s; }
    return null;
  };
  const young = loc(SPEC, 0.3);
  assert.ok(young >= 105 && young <= 165, `induction at ${young} s (label 2-2.5 min)`);
  assert.equal(loc(SPEC, 0.07), null, 'a premedication dose does not reach loss of consciousness');
  for (const spec of [{ sex: 'F', age: 70, heightCm: 160, weightKg: 55 }, { sex: 'M', age: 85, heightCm: 170, weightKg: 60 }]) {
    assert.ok(loc(spec, 0.3) != null, `an induction dose still induces at age ${spec.age}`);
  }
});
