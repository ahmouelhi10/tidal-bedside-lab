// Respiratory mechanics during controlled ventilation: clinical target bands, and no effect on the trajectory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { mechanics, waveAt } from '../src/engine/mechanics.js';

/** intubated, paralysed and on volume control, through the public dispatch API */
function ventilated(spec = {}, settings = {}) {
  const p = mk(spec);
  p.dispatch({ type: 'iv.access' });
  p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: Math.round(2.5 * p.body.lbm) });
  p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: Math.round(1.2 * p.body.ibw) });
  let r = null;
  for (let i = 0; i < 6 && !(r && r.ok !== false); i++) { p.run(30); r = p.dispatch({ type: 'airway.intubate' }); }
  assert.ok(r.ok !== false, 'intubation accepted: ' + JSON.stringify(r));
  for (let i = 0; i < 120 && !p.airway.intubated; i++) p.run(1);
  assert.ok(p.airway.intubated, 'intubated');
  p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: Math.round(7 * p.body.pbw), fio2: 0.5, peep: 5, ...settings } });
  p.run(20);
  return p;
}

test('healthy anaesthetised adult, 7 mL/kg PBW: compliance and pressures in the expected bands', () => {
  const m = mechanics(ventilated());
  assert.ok(m, 'mechanics available on controlled ventilation');
  assert.ok(m.crs >= 30 && m.crs <= 60, `Crs ${m.crs} mL/cmH2O within 30-60 (anaesthetised elastance ~23-26 cmH2O/L)`);
  assert.ok(m.pplat > 10 && m.pplat < 25, `Pplat ${m.pplat} cmH2O well under the 30 cmH2O lung-protective limit`);
  const resistive = m.ppeak - m.pplat;
  assert.ok(resistive > 1 && resistive < 10, `Ppeak - Pplat ${resistive.toFixed(1)} cmH2O: resistive pressure of an intubated adult`);
  assert.ok(m.peepi < 1, `no intrinsic PEEP at 12/min (${m.peepi})`);
});

test('morbid obesity lowers compliance and raises plateau pressure at the same tidal volume', () => {
  const lean = mechanics(ventilated({ weightKg: 70 }));
  const obese = mechanics(ventilated({ weightKg: 140 }));
  assert.ok(obese.crs < lean.crs * 0.8, `obese Crs ${obese.crs} at least 20% below ${lean.crs}`);
  assert.ok(obese.pplat > lean.pplat, 'higher plateau pressure');
});

test('endobronchial intubation (tube pushed in) raises peak and plateau pressures', () => {
  const p = ventilated(), before = mechanics(p);
  p.dispatch({ type: 'airway.tube_adjust', cm: 4 });
  p.dispatch({ type: 'airway.tube_adjust', cm: 4 });   // each adjustment is limited to 5 cm
  p.run(5);
  const after = mechanics(p);
  assert.ok(p.tube.mainstem, `tube endobronchial (tip ${p.tube.tipAboveCarina} cm above the carina)`);
  assert.ok(after.pplat > before.pplat + 3, `Pplat ${before.pplat} -> ${after.pplat}`);
  assert.ok(after.ppeak > before.ppeak + 3, `Ppeak ${before.ppeak} -> ${after.ppeak}`);
});

test('a high rate shortens expiration and creates intrinsic PEEP', () => {
  const m = mechanics(ventilated({}, { rate: 35 }));
  assert.ok(m.peepi > 0.3, `intrinsic PEEP ${m.peepi} cmH2O at 35/min`);
});

test('waveforms follow the breath: pressure peaks at end-inspiration, flow reverses in expiration', () => {
  const m = mechanics(ventilated());
  const endInsp = waveAt(m, m.ti - 1e-3), midExp = waveAt(m, m.ti + m.te / 2);
  assert.ok(Math.abs(endInsp.p - m.ppeak) < 0.5, 'end-inspiratory pressure = Ppeak');
  assert.ok(endInsp.f > 0 && midExp.f < 0, 'inspiratory flow positive, expiratory flow negative');
  assert.ok(Math.abs(endInsp.v - m.vt) < 5, 'volume reaches the set tidal volume');
});

test('reading the mechanics never changes the simulated trajectory', () => {
  const a = ventilated(), b = ventilated();
  for (let i = 0; i < 50; i++) { mechanics(a); a.run(1); b.run(1); }
  assert.equal(a.stateHash(), b.stateHash());
});

test('no mechanics without controlled ventilation', () => {
  assert.equal(mechanics(mk()), null);
});
