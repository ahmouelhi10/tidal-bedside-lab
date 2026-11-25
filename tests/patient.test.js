import test from 'node:test';
import assert from 'node:assert/strict';
import { Patient, replay } from '../src/engine/patient.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { Rng } from '../src/engine/rng.js';
import { mk, runScript } from './helpers/bots.js';

const allFinite = (o, path = '') => {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${path}${k} = ${v}`);
    else if (v && typeof v === 'object') allFinite(v, `${path}${k}.`);
  }
};

const SCRIPT = [
  [5, { type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, capnography: true } }],
  [8, { type: 'iv.access' }],
  [10, { type: 'drug.bolus', drug: 'propofol', amount: 140 }],
  [12, { type: 'drug.bolus', drug: 'rocuronium', amount: 80 }],
  [60, { type: 'fluid.bolus', volumeL: 0.5, minutes: 10 }],
  [90, { type: 'drug.infusion', drug: 'norepinephrine', rate: 0.05 }],
];

test('AT-DET-1: same spec + seed + events => identical state hash and snapshot', () => {
  const a = runScript(mk({}, { seed: 7 }), SCRIPT, 240);
  const b = runScript(mk({}, { seed: 7 }), SCRIPT, 240);
  assert.equal(a.stateHash(), b.stateHash());
  assert.deepEqual(a.snapshot(), b.snapshot());
});

test('AT-DET-2: a different seed or a different intervention changes the hash', () => {
  const a = runScript(mk({}, { seed: 7 }), SCRIPT, 240);
  const c = runScript(mk({}, { seed: 8 }), SCRIPT, 240);
  const d = runScript(mk({}, { seed: 7 }), SCRIPT.slice(0, 3), 240);
  assert.notEqual(a.stateHash(), c.stateHash());
  assert.notEqual(a.stateHash(), d.stateHash());
});

test('AT-DET-3: replay of the recorded event log reproduces the hash (server-side verification path)', () => {
  const a = runScript(mk({ sex: 'F', weightKg: 62, heightCm: 163, age: 34 }, { seed: 11 }), SCRIPT, 300);
  const r = replay({ spec: a.spec, seed: a.seed, scenario: null, log: a.log, until: a.t }, SCENARIOS);
  assert.equal(r.stateHash(), a.stateHash());
  assert.equal(r.n, a.n);
});

test('AT-DET-4: replay of a full scenario session (arrest, CPR, shock) reproduces the hash', () => {
  const p = new Patient(SCENARIOS.witnessed_vf.spec, { seed: 5, scenario: SCENARIOS.witnessed_vf });
  runScript(p, [
    [25, { type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true } }],
    [28, { type: 'cpr.start', mode: 'auto', opts: { rate: 110, depth: 5.5, ratio: '30:2' }, surface: 'hard' }],
    [30, { type: 'defib.pads' }], [31, { type: 'defib.setEnergy', energy: 200 }], [32, { type: 'defib.charge' }],
    [36, { type: 'defib.shock' }],
    [60, { type: 'drug.bolus', drug: 'epinephrine', amount: 1000 }],
  ], 180);
  const r = replay({ spec: p.spec, seed: p.seed, scenario: 'witnessed_vf', log: p.log, until: p.t }, SCENARIOS);
  assert.equal(r.stateHash(), p.stateHash());
});

test('a tampered log no longer verifies', () => {
  const a = runScript(mk({}, { seed: 3 }), SCRIPT, 240);
  const log = a.log.map(e => (e.type === 'drug.bolus' && e.drug === 'propofol' ? { ...e, amount: e.amount + 50 } : e));
  const r = replay({ spec: a.spec, seed: a.seed, scenario: null, log, until: a.t }, SCENARIOS);
  assert.notEqual(r.stateHash(), a.stateHash());
});

test('unknown events are rejected without throwing and are still logged', () => {
  const p = mk();
  assert.deepEqual({ ok: false }, { ok: p.dispatch({ type: 'nope' }).ok });
  assert.equal(p.log.length, 1);
});

test('malformed numeric parameters are rejected and cannot corrupt state', () => {
  const p = mk(); p.run(5);
  const h = p.stateHash();
  for (const e of [{ type: 'thermal.ambient', tempC: 10 }, { type: 'thermal.ambient', c: NaN }, { type: 'drug.bolus', drug: 'propofol', amount: 'a lot' },
    { type: 'drug.infusion', drug: 'propofol', rate: Infinity }, { type: 'fluid.bolus', volumeL: undefined }, { type: 'bleed.set', mlPerMin: null }]) {
    assert.equal(p.dispatch(e).ok, false, JSON.stringify(e));
  }
  assert.equal(p.stateHash(), h);                                   // nothing changed
  p.run(60); allFinite(p.snapshot());
});

test('impossible amounts are refused: a negative dose cannot cancel a real one, and a hand-made log gains nothing', () => {
  const bad = [{ type: 'drug.bolus', drug: 'propofol', amount: -200 }, { type: 'drug.bolus', drug: 'fentanyl', amount: 0 }, { type: 'drug.bolus', drug: 'propofol', amount: 1e9 },
    { type: 'drug.infusion', drug: 'propofol', rate: -5 }, { type: 'drug.infusion', drug: 'propofol', rate: 1e9 }, { type: 'drug.bolus', drug: 'potassiumChloride', amount: -40 },
    { type: 'fluid.bolus', volumeL: -5 }, { type: 'fluid.bolus', volumeL: 50 }, { type: 'fluid.bolus', volumeL: 1, minutes: 0 }, { type: 'bleed.set', mlPerMin: -500 },
    { type: 'bleed.set', mlPerMin: 1e7 }, { type: 'bicarb.bolus', mEq: -50 }, { type: 'thermal.ambient', c: 1e6 }, { type: 'thermal.cover', factor: -1 },
    { type: 'thermal.device', target: 90 }, { type: 'team.order', id: 1, act: { type: 'drug.bolus', drug: 'propofol', amount: -200 } }];
  const p = mk(); p.run(5); const h = p.stateHash();
  for (const e of bad) assert.equal(p.dispatch(e).ok, false, JSON.stringify(e));
  assert.equal(p.stateHash(), h);                                   // nothing changed
  // the real dose stays given: 200 mg then "-200 mg" leaves the 200 mg patient, exactly as 200 mg alone
  const a = mk(); a.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 200 }); a.run(60);
  const b = mk(); b.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 200 }); b.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: -200 }); b.run(60);
  assert.equal(b.stateHash(), a.stateHash());
  // and the refusal replays the same way (a submitted log with it verifies to the same hash)
  assert.equal(replay({ spec: b.spec, seed: b.seed, scenario: null, log: b.log, until: b.t }, SCENARIOS).stateHash(), b.stateHash());
  // what a learner can do with the dose buttons is still accepted, overdoses included
  const ok = [{ type: 'drug.bolus', drug: 'propofol', amount: 2000 }, { type: 'drug.bolus', drug: 'levetiracetam', amount: 4500 }, { type: 'drug.bolus', drug: 'neostigmine', amount: 12500 },
    { type: 'drug.bolus', drug: 'magnesium', amount: 4 }, { type: 'drug.infusion', drug: 'propofol', rate: 0 }, { type: 'fluid.bolus', volumeL: 2, minutes: 240 },
    { type: 'bleed.set', mlPerMin: 0 }, { type: 'thermal.ambient', c: 5 }, { type: 'thermal.cover', factor: 0.5 }, { type: 'thermal.device', target: 38, maxWatts: 50 }, { type: 'bicarb.bolus', mEq: 100 }];
  const q = mk(); for (const e of ok) assert.notEqual(q.dispatch(e).ok, false, JSON.stringify(e));
});

test('the state hash sees settings, devices, drug loads and scheduled effects at once, before they reach the vitals', () => {
  const edits = {
    'ventilator FiO2': p => { p.vent.fio2 = 0.5; }, 'ventilator mode': p => { p.vent.mode = 'ctrl'; }, 'oxygen mask': p => { p.o2 = { fio2: 0.6, seal: 0.9 }; },
    'apnoeic oxygen': p => { p.apOx = { fio2: 1, eff: 0.5 }; }, 'airway device': p => { p.airway.device = 'ett'; }, 'head up': p => { p.headUp = true; },
    'antiarrhythmic load': p => { p.antiarr = 0.5; }, 'bicarbonate given': p => { p.bicarbMmol = 1; }, 'LV function': p => { p.lv = 0.6; },
    'post-ROSC tone': p => { p.postRoscTone = 0.65; }, 'hypoxia timer': p => { p.timers.hypoxic = 12; }, 'defibrillator charged': p => { p.defib.charged = true; },
    'defibrillator energy': p => { p.defib.energy = 200; }, 'CPR running': p => { p.cpr.mode = 'auto'; }, 'IV access': p => { p.flags.ivAccess = !p.flags.ivAccess; },
    'a line that completes later': p => { p.pendingEvents.push({ at: p.t + 180, run: () => {} }); }, 'bleeding controlled': p => { p.bleedControlledAt = p.t; },
  };
  const base = mk(); base.run(5); const h = base.stateHash();
  for (const [what, edit] of Object.entries(edits)) { const p = mk(); p.run(5); edit(p); assert.notEqual(p.stateHash(), h, what); }
  const same = mk(); same.run(5); assert.equal(same.stateHash(), h);                  // and two untouched runs still agree
});

test('baseline sweep: every sex x BMI combination starts stable, finite and physiologic', () => {
  const rows = [];
  for (const sex of ['M', 'F']) {
    for (const bmi of [15, 18.5, 22, 27, 32, 38, 45, 55, 65]) {
      const heightCm = sex === 'M' ? 178 : 165, weightKg = bmi * (heightCm / 100) ** 2;
      const p = new Patient({ sex, age: 45, heightCm, weightKg }, { seed: 1 });
      p.run(60);
      const s = p.snapshot();
      allFinite(s, `${sex}${bmi}.`);
      rows.push(`${sex} BMI ${bmi}: MAP ${s.map} HR ${s.hr} SpO2 ${s.spo2} ETCO2 ${s.etco2} pH ${s.ph}`);
      assert.ok(s.map > 65 && s.map < 115, `MAP ${s.map} (${sex} ${bmi})`);
      assert.ok(s.hr > 50 && s.hr < 100, `HR ${s.hr} (${sex} ${bmi})`);
      assert.ok(s.spo2 >= 93, `SpO2 ${s.spo2} (${sex} ${bmi})`);
      assert.ok(s.etco2 > 30 && s.etco2 < 46, `ETCO2 ${s.etco2} (${sex} ${bmi})`);
      assert.ok(s.ph > 7.33 && s.ph < 7.47, `pH ${s.ph} (${sex} ${bmi})`);
      assert.ok(s.core > 36.3 && s.core < 37.4, `core ${s.core} (${sex} ${bmi})`);
      assert.equal(s.arrested, false);
    }
  }
  assert.equal(rows.length, 18);
});

test('physiology scales with body size: larger / obese patients have larger blood volume and cardiac output, lower BMI-normalised volume', () => {
  const mkb = (w) => { const p = new Patient({ sex: 'M', age: 40, heightCm: 178, weightKg: w }, { seed: 1 }); p.run(30); return p.snapshot(); };
  const lean = mkb(60), norm = mkb(80), obese = mkb(140);
  assert.ok(obese.bloodVolume > norm.bloodVolume && norm.bloodVolume > lean.bloodVolume);
  assert.ok(obese.co > norm.co && norm.co > lean.co);
  assert.ok(obese.bloodVolume / 140 < norm.bloodVolume / 80);       // mL/kg falls with adiposity (Lemmens 2006)
});

test('robustness: 40 random interventions never produce NaN/Infinity or throw (fuzz, seeded)', () => {
  const rng = new Rng(2026);
  const pick = a => a[Math.floor(rng.next() * a.length)];
  const EVENTS = [
    () => ({ type: 'drug.bolus', drug: pick(['propofol', 'fentanyl', 'rocuronium', 'succinylcholine', 'epinephrine', 'norepinephrine', 'phenylephrine', 'naloxone', 'sugammadex', 'atropine']), amount: pick([0, 1, 20, 100, 500]) }),
    () => ({ type: 'drug.infusion', drug: pick(['propofol', 'remifentanil', 'norepinephrine']), rate: pick([0, 0.05, 1, 5]) }),
    () => ({ type: 'fluid.bolus', volumeL: pick([0.25, 1, 2]), minutes: pick([1, 10, 30]) }),
    () => ({ type: 'bleed.set', mlPerMin: pick([0, 50, 300]) }),
    () => ({ type: 'vent.set', settings: { mode: 'ctrl', rate: pick([0, 6, 12, 30]), vt: pick([100, 450, 900]), fio2: pick([0.21, 1]), peep: pick([0, 5, 15]), seal: pick([0.2, 0.95]) } }),
    () => ({ type: 'airway.set', device: pick(['none', 'bvm', 'lma', 'ett']) }),
    () => ({ type: 'o2.mask', fio2: pick([0.21, 0.4, 1]), seal: pick([0.3, 0.9]) }),
    () => ({ type: 'cpr.start', mode: 'auto', opts: { rate: pick([60, 110, 160]), depth: pick([2, 5.5, 8]), ratio: pick(['30:2', 'continuous']) }, surface: pick(['hard', 'soft']) }),
    () => ({ type: 'cpr.stop' }),
    () => ({ type: 'defib.pads' }), () => ({ type: 'defib.charge' }), () => ({ type: 'defib.shock' }),
    () => ({ type: 'thermal.ambient', c: pick([10, 22, 35]) }),
    () => ({ type: 'position.set', position: pick(['supine', 'ramped', 'lateral']) }),
    () => ({ type: 'procedure.needle_decompression' }),
  ];
  for (const spec of [{}, { sex: 'F', weightKg: 40, heightCm: 150, age: 82 }, { weightKg: 170, heightCm: 172, age: 50 }]) {
    const p = mk(spec, { seed: 9 });
    for (let i = 0; i < 40; i++) { p.dispatch(pick(EVENTS)()); p.run(3 + Math.floor(rng.next() * 6)); }
    allFinite(p.snapshot());
    assert.ok(p.stateHash().length === 8);
  }
});

test('time is exact: n * dt, no drift after 30 min', () => {
  const p = mk(); p.run(1800);
  assert.equal(p.n, 18000);
  assert.ok(Math.abs(p.t - 1800) < 1e-6);
});

test('EVENT_TYPES lists exactly the events dispatch() understands', async () => {
  const { EVENT_TYPES } = await import('../src/engine/patient.js');
  assert.ok(Array.isArray(EVENT_TYPES) && EVENT_TYPES.length >= 35 && new Set(EVENT_TYPES).size === EVENT_TYPES.length);
  for (const type of EVENT_TYPES) {
    const p = mk(); let r;
    assert.doesNotThrow(() => { r = p.dispatch({ type }); }, type);
    assert.ok(!/unknown event/.test(r?.error || ''), type + ' is listed but not handled');
  }
  assert.match(mk().dispatch({ type: 'not.an.event' }).error, /unknown event/);
});

test('event payload validation: malformed nested payloads are rejected, logged, and never change state', () => {
  const p = mk({}); p.run(5);
  const before = p.stateHash();
  const bad = [
    { type: 'vent.set', settings: { mode: 'ctrl', rate: 'fast' } }, { type: 'vent.set', settings: { vt: 1e9 } }, { type: 'vent.set', settings: { evil: 1 } }, { type: 'vent.set' },
    { type: 'monitor.attach', items: { __proto__x: true } }, { type: 'monitor.attach', items: { ecgLeads: 'yes' } }, { type: 'monitor.attach', items: { padsOn: true } },
    { type: 'cpr.start', mode: 'turbo' }, { type: 'cpr.start', mode: 'auto', opts: { rate: 5000 } }, { type: 'cpr.start', mode: 'auto', opts: { ratio: '15:2' } }, { type: 'cpr.start', mode: 'auto', opts: { pauseUntil: 1e9 } },
    { type: 'cpr.compress', depth: NaN }, { type: 'cpr.compress', depth: '5' }, { type: 'cpr.surface', surface: 'lava' }, { type: 'defib.mode', mode: 'x' }, { type: 'blood.transfuse', kind: 'plasma-x' },
    { type: 'position.set', headUp: 'yes' }, { type: 'order', what: 'x'.repeat(100) }, { type: 'note', text: 7 },
  ];
  for (const ev of bad) { const r = p.dispatch(ev); assert.equal(r.ok, false, JSON.stringify(ev)); }
  assert.equal(p.log.length, bad.length, 'rejected events are still logged so a replay rejects them identically');
  assert.equal(p.stateHash(), before, 'state unchanged by rejected events');
  assert.equal(p.vent.mode, 'spont'); assert.equal(p.flags.padsOn, false); assert.equal(p.cpr.mode, 'off');
  // and well-formed ones still work
  assert.equal(p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: 450, fio2: 1, peep: 5, seal: 0.9 } }).ok, true);
  assert.equal(p.dispatch({ type: 'monitor.attach', items: { aline: true } }).ok, true);
  assert.equal(p.dispatch({ type: 'cpr.start', mode: 'auto', opts: { rate: 110, depth: 5.5, ratio: '30:2' }, surface: 'hard' }).ok, true);
});
