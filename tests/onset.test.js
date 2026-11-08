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
