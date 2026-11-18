// Spinal and epidural blocks, nausea and vomiting, postoperative shivering: clinical target bands
// (REF hocking2004, carpenter1992, guay2006, apfel1999, apfel2004, gan2020, kranke2002, kurz1997, sessler2016), replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk, scen } from './helpers/bots.js';
import { replay } from '../src/engine/patient.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { segName } from '../src/engine/neuraxial.js';

const spinal = (dose, spec = {}, seed = 1) => {
  const p = mk({ sex: 'F', age: 70, heightCm: 160, weightKg: 60, ...spec }, { seed }); p.dispatch({ type: 'iv.access' }); p.run(60);
  const m0 = p.circ.mapArt, h0 = p.circ.hr; p.dispatch({ type: 'neuraxial.spinal', amount: dose }); return { p, m0, h0 };
};
const minOver = (p, s, f) => { let m = Infinity; for (let i = 0; i < s / 30; i++) { p.run(30); m = Math.min(m, f(p)); } return m; };

test('spinal: the peak level follows the dose (7.5 mg about T10, 12.5 mg about T4), rises over ~20 min and then regresses', () => {
  assert.equal(segName(12), 'T4'); assert.equal(segName(4), 'C4'); assert.equal(segName(23), 'L3');
  const lo = spinal(7.5).p, hi = spinal(12.5).p;
  lo.run(1500); hi.run(300); const early = hi.neuraxial.seg; hi.run(1200);
  assert.ok(lo.neuraxial.seg >= 15 && lo.neuraxial.seg <= 20, `7.5 mg: ${lo.neuraxial.sensory}`);
  assert.ok(hi.neuraxial.seg >= 10 && hi.neuraxial.seg <= 14, `12.5 mg: ${hi.neuraxial.sensory}`);
  assert.ok(early > hi.neuraxial.seg + 1, 'still spreading at 5 min');
  const peak = hi.neuraxial.seg; hi.run(5400); assert.ok(hi.neuraxial.seg >= peak + 2, `regressed to ${hi.neuraxial.sensory} by 2 h`);
  const r = hi.dispatch({ type: 'neuraxial.assess' }); assert.ok(r.sensory.startsWith('T') && r.bromage >= 2, JSON.stringify(r));
  assert.equal(hi.dispatch({ type: 'neuraxial.spinal', amount: 10 }).ok, false, 'one spinal only');
  assert.equal(mk().dispatch({ type: 'neuraxial.spinal', amount: 40 }).ok, false, 'dose out of range');
});

test('spinal hypotension: a T4 block lowers the MAP by 20-40 % in an 80-year-old, less in a 30-year-old, little at T10; phenylephrine restores it', () => {
  const old = spinal(12.5, { age: 82 }), young = spinal(12.5, { age: 30, heightCm: 165 }), low = spinal(7.5, { age: 82 });
  const fall = (x) => 1 - minOver(x.p, 1200, q => q.circ.mapArt) / x.m0;
  const fo = fall(old), fy = fall(young), fl = fall(low);
  assert.ok(fo >= 0.2 && fo <= 0.4, `elderly T4: -${(fo * 100).toFixed(0)} %`);
  assert.ok(fy < fo - 0.05, `young -${(fy * 100).toFixed(0)} % vs elderly -${(fo * 100).toFixed(0)} %`);
  assert.ok(fl < 0.15, `T10 block -${(fl * 100).toFixed(0)} %`);
  assert.ok(old.p.circ.hr < old.h0 + 8, 'no reflex tachycardia with a high block');
  const m1 = old.p.circ.mapArt; old.p.dispatch({ type: 'drug.bolus', drug: 'phenylephrine', amount: 100 }); old.p.run(90);
  assert.ok(old.p.circ.mapArt > m1 + 8, `phenylephrine ${m1.toFixed(0)} -> ${old.p.circ.mapArt.toFixed(0)}`);
});

test('high / total spinal: the diaphragm fails and consciousness is lost; controlled ventilation keeps the saturation', () => {
  const p = mk({ age: 50 }); p.dispatch({ type: 'iv.access' }); p.run(30); const va0 = p.resp.vaNow;
  p.dispatch({ type: 'instructor.inject', what: 'high_spinal' }); p.run(360);
  assert.ok(p.neuraxial.seg < 3 && p.neuraxial.out.loc, `block ${p.neuraxial.sensory}`);
  assert.ok(p.resp.vaNow < 0.2 * va0, `alveolar ventilation ${p.resp.vaNow.toFixed(0)} vs ${va0.toFixed(0)} mL/min`);
  const q = mk({ age: 50 }); q.dispatch({ type: 'iv.access' }); q.run(30); q.dispatch({ type: 'instructor.inject', what: 'high_spinal' });
  q.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: 500, fio2: 1, peep: 5, seal: 0.9 } }); q.run(900);
  assert.ok(q.resp.spo2 > 95 && !q.arrest.arrested, `ventilated: SpO2 ${q.resp.spo2.toFixed(0)}`);
});

test('epidural test dose: intravascular raises the HR >= 10/min within a minute, intrathecal gives a fast motor block, epidural neither', () => {
  const run = (catheter) => { const p = mk({ age: 45, catheter }); p.dispatch({ type: 'iv.access' }); p.run(30); const h0 = p.circ.hr; p.dispatch({ type: 'neuraxial.epidural', action: 'test' }); p.run(50); const dh = p.circ.hr - h0; p.run(250); return { p, dh }; };
  const iv = run('intravascular'), it = run('intrathecal'), ep = run('epidural');
  assert.ok(iv.dh >= 10, `intravascular +${iv.dh.toFixed(0)}/min`); assert.equal(iv.p.neuraxial.bromage, 0);
  assert.ok(it.p.neuraxial.bromage >= 2 && it.dh < 10, `intrathecal: Bromage ${it.p.neuraxial.bromage}`);
  assert.ok(ep.dh < 10 && ep.p.neuraxial.bromage === 0, 'epidural: nothing');
  ep.p.dispatch({ type: 'neuraxial.epidural', action: 'topup', volumeMl: 15 }); ep.p.run(1500);
  assert.ok(ep.p.neuraxial.seg >= 11 && ep.p.neuraxial.seg <= 17, `15 mL epidural: ${ep.p.neuraxial.sensory}`);
  const tox = mk({ age: 45, catheter: 'intravascular' }); tox.dispatch({ type: 'iv.access' }); tox.dispatch({ type: 'neuraxial.epidural', action: 'topup', volumeMl: 20 }); tox.run(120);
  assert.ok(tox.crises.seizure || tox.crises.laCv > 0.3, 'an intravascular top-up is local anaesthetic toxicity');
  assert.equal(mk().dispatch({ type: 'neuraxial.epidural', action: 'topup' }).ok, false, 'a top-up needs a volume');
});

test('PONV: the Apfel score counts its four factors; an untreated high-risk patient vomits, ondansetron stops it, dexamethasone is too slow', () => {
  const pt = (extra = {}) => { const p = mk({ sex: 'F', age: 34, heightCm: 165, weightKg: 62, pacu: true, ponvHistory: true, ...extra }); p.dispatch({ type: 'iv.access' }); p.drugs.bolus('morphine', 10, 0); return p; };
  assert.deepEqual([pt().ponv.apfel(pt().drugs).score, mk({ sex: 'M', smoker: true }).ponv.apfel(mk().drugs).score], [4, 0]);
  assert.equal(pt().ponv.apfel(pt().drugs).risk, 0.8);
  const a = pt(); a.run(1800); assert.ok(a.ponv.vomits.length >= 2, `untreated: ${a.ponv.vomits.length} episodes`);
  const b = pt(); b.run(240); b.dispatch({ type: 'drug.bolus', drug: 'ondansetron', amount: 4 }); b.run(300); const vb = b.ponv.vomits.length; b.run(1200);
  assert.ok(b.ponv.vomits.length - vb === 0 && b.ponv.nausea < 0.4, `after ondansetron: ${b.ponv.vomits.length - vb} more, nausea ${b.ponv.nausea.toFixed(2)}`);
  const c = pt(); c.run(240); c.dispatch({ type: 'drug.bolus', drug: 'dexamethasone', amount: 8 }); c.run(1200); assert.ok(c.ponv.vomits.length >= 2, 'dexamethasone does not rescue in 20 min');
  const m = pt({ smoker: true, ponvHistory: false, sex: 'M' }); m.run(1800); assert.equal(m.ponv.vomits.length, 0, 'low risk: no vomiting');
});

test('nausea after a spinal follows the pressure: correcting the hypotension relieves it', () => {
  const x = spinal(12.5, { age: 82 }); x.p.run(900); assert.ok(x.p.ponv.nausea > 0.5, `nausea ${x.p.ponv.nausea.toFixed(2)}`);
  x.p.dispatch({ type: 'drug.infusion', drug: 'phenylephrine', rate: 50 }); x.p.run(600);
  assert.ok(x.p.ponv.nausea < 0.3 && x.p.circ.mapArt > 0.8 * x.m0, `nausea ${x.p.ponv.nausea.toFixed(2)}, MAP ${x.p.circ.mapArt.toFixed(0)}`);
});

test('postoperative shivering raises the oxygen consumption; pethidine 25 mg stops it', () => {
  const cold = () => { const p = mk({ sex: 'F', age: 40 }); p.therm.tc = 35.3; p.therm.tp = 30; /* a typical cold arrival in recovery */ p.dispatch({ type: 'iv.access' }); p.run(60); return p; };
  const warm = mk({ sex: 'F', age: 40 }); warm.run(60);
  const a = cold(); assert.ok(a.therm.shivering > 0.3 && a.resp.vo2Eff > 1.2 * warm.resp.vo2Eff, `shivering ${a.therm.shivering.toFixed(2)}, VO2 ${a.resp.vo2Eff.toFixed(0)} vs ${warm.resp.vo2Eff.toFixed(0)}`);
  a.dispatch({ type: 'drug.bolus', drug: 'pethidine', amount: 25 }); a.run(600);
  const b = cold(); b.run(600);
  assert.ok(a.therm.shivering < 0.1 && b.therm.shivering > 0.3, `pethidine ${a.therm.shivering.toFixed(2)} vs none ${b.therm.shivering.toFixed(2)}`);
});

test('the regional and recovery cases replay to the same hash', () => {
  for (const id of ['spinal_hypotension', 'high_spinal', 'pacu_ponv']) {
    const p = scen(id, 3);
    for (const e of [{ type: 'neuraxial.assess' }, { type: 'drug.bolus', drug: 'phenylephrine', amount: 100 }, { type: 'drug.bolus', drug: 'ondansetron', amount: 4 }, { type: 'neuraxial.epidural', action: 'test' }, { type: 'instructor.inject', what: 'ponv' }, { type: 'drug.bolus', drug: 'pethidine', amount: 25 }]) { p.dispatch(e); p.run(40); }
    p.run(400);
    const q = replay({ spec: SCENARIOS[id].spec, seed: 3, scenario: id, log: p.log.map(e => ({ ...e })), until: p.t }, SCENARIOS);
    assert.equal(q.stateHash(), p.stateHash(), id);
  }
  const s = mk({}, { seed: 9 }); s.dispatch({ type: 'neuraxial.spinal', amount: 10 }); s.run(600);
  const r = replay({ spec: {}, seed: 9, scenario: null, log: s.log.map(e => ({ ...e })), until: s.t }, SCENARIOS); assert.equal(r.stateHash(), s.stateHash());
});
