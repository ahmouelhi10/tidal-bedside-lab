// Anaesthesia and emergency crises and their treatments: clinical target bands, replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { replay } from '../src/engine/patient.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { paceThreshold } from '../src/engine/crises.js';

/** anaesthetised, intubated, ventilated adult */
function ventilated(spec = {}, seed = 3) {
  const p = mk(spec, { seed });
  p.dispatch({ type: 'iv.access' }); p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 150 }); p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 80 });
  p.run(60); p.dispatch({ type: 'airway.intubate' }); p.run(40);
  p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: 500, fio2: 0.5, peep: 5 } });
  p.dispatch({ type: 'monitor.attach', items: { capnography: true, ecgLeads: true, tempProbe: true } }); p.run(60);
  return p;
}

test('anaphylaxis: untreated it causes shock with tachycardia; IM adrenaline 0.5 mg restores the pressure', () => {
  const a = mk({}, { seed: 3 }); a.dispatch({ type: 'instructor.inject', what: 'anaphylaxis' }); a.run(300);
  assert.ok(a.circ.mapArt < 65 && a.circ.hr > 110, `MAP ${a.circ.mapArt.toFixed(0)}, HR ${a.circ.hr.toFixed(0)}`);
  assert.ok(a.vol.vp < a.vol.vp0 * 0.95, 'capillary leak lowers plasma volume');
  a.dispatch({ type: 'drug.bolus', drug: 'epinephrine', amount: 500, route: 'im' }); a.run(600);
  assert.ok(a.circ.mapArt > 75, `MAP ${a.circ.mapArt.toFixed(0)} 10 min after IM adrenaline`);
  assert.equal(mk().dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 100, route: 'im' }).ok, false, 'IM route only where the drug allows it');
});

test('bronchospasm raises airway pressure and lowers ventilation; salbutamol relieves it', () => {
  const p = ventilated(), pp0 = p.crises.airwayResistance;
  p.dispatch({ type: 'instructor.inject', what: 'bronchospasm' }); p.run(120);
  const br = p.crises.br;
  assert.ok(br > 0.5 && p.crises.airwayResistance > pp0 + 10, `bronchospasm ${br.toFixed(2)}`);
  const co2 = p.resp.paco2;
  p.dispatch({ type: 'drug.bolus', drug: 'salbutamol', amount: 5 }); p.run(600);
  assert.ok(p.crises.br < br * 0.5, `relieved ${br.toFixed(2)} -> ${p.crises.br.toFixed(2)}`);
  assert.ok(p.resp.paco2 <= co2 + 2, 'ventilation recovers');
});

test('malignant hyperthermia: EtCO2 > 55 within 10 min on fixed ventilation, temperature and potassium rise; dantrolene stops it', () => {
  const p = ventilated(); const t0 = p.therm.tc;
  p.dispatch({ type: 'instructor.inject', what: 'mh' }); p.run(600);
  assert.ok(p.resp.etco2 > 55, `EtCO2 ${p.resp.etco2.toFixed(0)} (Larach 1994: > 55 with controlled ventilation)`);
  p.run(900);
  assert.ok(p.therm.tc - t0 >= 0.7, `core +${(p.therm.tc - t0).toFixed(2)} C in 25 min`);
  assert.ok(p.lytes.k > 5.0, `K ${p.lytes.k.toFixed(2)}`);
  const q = ventilated(); q.dispatch({ type: 'instructor.inject', what: 'mh' }); q.run(300);
  q.dispatch({ type: 'drug.bolus', drug: 'dantrolene', amount: 200 }); q.run(1200);
  assert.ok(q.crises.mh < 0.25 && q.resp.etco2 < p.resp.etco2 - 20, `treated mh ${q.crises.mh.toFixed(2)}, EtCO2 ${q.resp.etco2.toFixed(0)}`);
  const s = ventilated({ mhSusceptible: true }); s.dispatch({ type: 'drug.bolus', drug: 'succinylcholine', amount: 120 }); s.run(900);
  assert.ok(s.crises.mh > 0.3, 'succinylcholine triggers it in a susceptible patient');
});

test('local anaesthetic toxicity: an IV bupivacaine bolus stops the heart, the same dose as a nerve block does not, lipid protects', () => {
  let arrests = 0, lipidArrests = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const p = mk({}, { seed }); p.dispatch({ type: 'drug.bolus', drug: 'bupivacaine', amount: 150 }); p.run(300);
    if (p.arrest.arrested) { arrests++; assert.equal(p.arrest.causes.local_anaesthetic, true); }
    const q = mk({}, { seed }); q.dispatch({ type: 'drug.bolus', drug: 'bupivacaine', amount: 150 }); q.run(20);
    q.dispatch({ type: 'drug.bolus', drug: 'lipid', amount: 120 }); q.dispatch({ type: 'drug.infusion', drug: 'lipid', rate: 20 }); q.run(280);
    if (q.arrest.arrested) lipidArrests++;
  }
  assert.ok(arrests >= 5, `${arrests}/6 arrested after 150 mg IV`);
  assert.ok(lipidArrests < arrests, `lipid ${lipidArrests} vs ${arrests}`);
  const r = mk(); r.dispatch({ type: 'drug.bolus', drug: 'bupivacaine', amount: 150, route: 'regional' }); let mx = 0;
  for (let i = 0; i < 90; i++) { r.run(60); mx = Math.max(mx, r.drugs.cp('bupivacaine')); }
  assert.ok(mx > 0.5 && mx < 2.5 && !r.arrest.arrested, `block peak ${mx.toFixed(2)} mg/L`);
});

test('complete heart block: transcutaneous pacing captures above the threshold and needs pads', () => {
  const p = mk({}, { seed: 2 }); p.dispatch({ type: 'instructor.inject', what: 'avblock3' }); p.run(60);
  assert.ok(p.circ.hr < 45);
  assert.equal(p.dispatch({ type: 'pacing.set', on: true, rate: 70, mA: 80 }).ok, false, 'pads first');
  p.dispatch({ type: 'defib.pads' });
  p.dispatch({ type: 'pacing.set', on: true, rate: 70, mA: Math.round(paceThreshold(p.body.bmi) - 10) }); p.run(30);
  assert.equal(p.crises.captured, false, 'below threshold: no capture');
  p.dispatch({ type: 'pacing.set', on: true, mA: Math.round(paceThreshold(p.body.bmi) + 10) }); p.run(60);
  assert.ok(p.crises.captured && Math.abs(p.circ.hr - 70) < 5, `paced HR ${p.circ.hr.toFixed(0)}`);
});

test('hypoglycaemia lowers consciousness and glucose corrects it; insulin lowers glucose and potassium', () => {
  const p = mk(); p.dispatch({ type: 'instructor.inject', what: 'hypoglycaemia' }); p.run(60);
  assert.ok(p.lytes.glucose < 2.2 && p.crises.out.loc);
  p.dispatch({ type: 'drug.bolus', drug: 'glucose', amount: 25 }); p.run(60);
  assert.ok(p.lytes.glucose > 4 && !p.crises.out.loc);
  const q = mk(), k0 = q.lytes.k, g0 = q.lytes.glucose; q.dispatch({ type: 'drug.bolus', drug: 'insulin', amount: 10 }); q.run(3600);
  assert.ok(q.lytes.k < k0 - 0.4 && q.lytes.glucose < g0, 'insulin without glucose');
});

test('rate control, vasopressors and inotropes move the expected variables', () => {
  const f = mk(); f.dispatch({ type: 'instructor.inject', what: 'af' }); f.run(60); const hr = f.circ.hr;
  f.dispatch({ type: 'drug.bolus', drug: 'esmolol', amount: 40 }); f.run(120);
  assert.ok(f.circ.hr < hr - 10, `AF ${hr.toFixed(0)} -> ${f.circ.hr.toFixed(0)}`);
  const d = mk(), co = d.circ.co; d.dispatch({ type: 'drug.infusion', drug: 'dobutamine', rate: 400 }); d.run(600);
  assert.ok(d.circ.co > co * 1.1, 'dobutamine 5 mcg/kg/min raises cardiac output');
  const e = ventilated(), m0 = e.circ.mapArt; e.dispatch({ type: 'drug.bolus', drug: 'ephedrine', amount: 10 }); e.run(180);
  assert.ok(e.circ.mapArt - m0 > 3 && e.circ.mapArt - m0 < 30, `ephedrine +${(e.circ.mapArt - m0).toFixed(1)} mmHg`);
});

test('trauma: shock with bleeding consumes fibrinogen; tranexamic acid prevents it; furosemide raises urine output', () => {
  const run = (txa) => { const p = mk({}, { seed: 4 }); p.dispatch({ type: 'bleed.set', mlPerMin: 200 }); if (txa) p.dispatch({ type: 'drug.bolus', drug: 'tranexamicAcid', amount: 1000 }); p.run(1200); return p.vol.fibAmt / p.vol.vp; };
  assert.ok(run(true) > run(false) + 0.1, 'more fibrinogen left with tranexamic acid');
  const a = mk(), b = mk(); a.dispatch({ type: 'fluid.bolus', volumeL: 1, minutes: 10 }); b.dispatch({ type: 'fluid.bolus', volumeL: 1, minutes: 10 });
  b.dispatch({ type: 'drug.bolus', drug: 'furosemide', amount: 40 }); a.run(3600); b.run(3600);
  assert.ok(b.vol.urine > a.vol.urine * 1.5, `urine ${a.vol.urine.toFixed(2)} vs ${b.vol.urine.toFixed(2)} L`);
});

test('crisis sessions replay to the same hash', () => {
  const p = ventilated({}, 9);
  p.dispatch({ type: 'instructor.inject', what: 'anaphylaxis' }); p.run(60);
  p.dispatch({ type: 'drug.bolus', drug: 'epinephrine', amount: 500, route: 'im' }); p.run(60);
  p.dispatch({ type: 'io.access' }); p.dispatch({ type: 'drug.bolus', drug: 'salbutamol', amount: 5 }); p.run(120);
  const q = replay({ spec: p.spec, seed: 9, scenario: null, log: p.log.map(e => ({ ...e })), until: p.t }, SCENARIOS);
  assert.equal(q.stateHash(), p.stateHash());
});
