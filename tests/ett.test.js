import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/engine/patient.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { mk, scen, runScript } from './helpers/bots.js';

/** an anaesthetised, paralysed, ventilated patient with a tube placed at the optimal depth */
function ventilated(spec = {}) {
  const p = mk(spec);
  p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 150 }); p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 80 });
  p.dispatch({ type: 'airway.set', device: 'ett' });
  p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 14, vt: Math.round(6 * p.body.pbw), fio2: 0.4, peep: 5, seal: 0.97 } });
  p.dispatch({ type: 'drug.infusion', drug: 'propofol', rate: 6 });
  return p;
}

test('a tube at the optimal depth sits about 4 cm above the carina and adds nothing to the shunt', () => {
  for (const h of [150, 175, 200]) {
    const p = ventilated({ heightCm: h, weightKg: Math.round(22 * (h / 100) ** 2) });
    assert.equal(p.tube.tipAboveCarina, 4, `height ${h}`);
    assert.equal(p.tube.mainstem, null); assert.equal(p.tube.shuntExtra, 0); assert.equal(p.tube.vaMult, 1);
  }
  const tall = ventilated({ heightCm: 200 }), short = ventilated({ heightCm: 150, weightKg: 50 });
  assert.ok(tall.tube.optimalDepth > short.tube.optimalDepth, 'deeper tube for a taller patient');
});

test('a tube pushed past the carina ventilates only the right lung: shunt up, SpO2 down; pulling it back restores it', () => {
  const ok = ventilated(), deep = ventilated();
  const r = deep.dispatch({ type: 'airway.tube_adjust', cm: 5 });
  assert.equal(r.ok, true); assert.equal(deep.tube.mainstem, 'R'); assert.ok(r.tipAboveCarinaCm < 0);
  ok.run(180); deep.run(180);
  assert.ok(deep.resp.shunt > ok.resp.shunt + 0.2, `shunt ${deep.resp.shunt} vs ${ok.resp.shunt}`);
  assert.ok(deep.resp.spo2 < ok.resp.spo2 - 3, `SpO2 ${deep.resp.spo2} vs ${ok.resp.spo2}`);
  deep.dispatch({ type: 'airway.tube_adjust', cm: -5 }); deep.run(240);
  assert.equal(deep.tube.mainstem, null);
  assert.ok(Math.abs(deep.resp.spo2 - ok.resp.spo2) < 1.5, 'oxygenation recovers once the tube is pulled back');
});

test('intubation honours the chosen depth: a tube taped too deep is endobronchial from the start', () => {
  let found = false;
  for (let seed = 1; seed <= 10 && !found; seed++) {
    const p = mk({}, { seed });
    p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 150 }); p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 100 });
    for (let k = 0; k < 30 && !(p.drugs.effects({ inArrest: false }).nmb > 0.9); k++) p.run(10);
    const r = p.dispatch({ type: 'airway.intubate', depthCm: p.tube.optimalDepth + 6 }); p.run((r.willTakeS || 30) + 1);
    if (p.airway.intubated) { found = true; assert.equal(p.tube.depth, p.tube.optimalDepth + 6); assert.equal(p.tube.mainstem, 'R'); }
  }
  assert.ok(found, 'at least one successful laryngoscopy in ten seeds');
});

test('secretions build up slowly: negligible in the first 20 min, obstructive after an hour, cleared by suction through the scope', () => {
  const p = ventilated();
  p.run(1200); assert.ok(p.tube.shuntExtra < 0.005, `20 min: ${p.tube.shuntExtra}`);
  p.run(2400); const plugged = p.tube.shuntExtra; assert.ok(plugged > 0.05, `60 min: ${plugged}`);
  assert.equal(p.dispatch({ type: 'bronch.suction', where: 'R' }).ok, false, 'suction needs the scope in');
  assert.equal(p.dispatch({ type: 'bronch.insert' }).ok, true);
  for (const where of ['trachea', 'R', 'L']) assert.ok(p.dispatch({ type: 'bronch.suction', where }).cleared > 0.3);
  p.dispatch({ type: 'bronch.remove' }); p.run(300);
  assert.ok(p.tube.shuntExtra < plugged / 2, `after suction ${p.tube.shuntExtra}`);
});

test('the scope in the tube lowers effective ventilation a little (PaCO2 rises), and bronchoscopy needs a tracheal tube', () => {
  assert.equal(mk().dispatch({ type: 'bronch.insert' }).ok, false);
  const a = ventilated(), b = ventilated(); a.run(240); b.run(240);
  b.dispatch({ type: 'bronch.insert' }); a.run(300); b.run(300);
  assert.ok(b.resp.paco2 > a.resp.paco2 + 1, `PaCO2 ${b.resp.paco2} vs ${a.resp.paco2}`);
});

test('extubation removes the tube state; malformed tube and bronchoscopy events are rejected, logged and change nothing', () => {
  const p = ventilated();
  for (const ev of [{ type: 'airway.tube_adjust', cm: 0 }, { type: 'airway.tube_adjust', cm: 9 }, { type: 'airway.tube_adjust', cm: 'x' }, { type: 'bronch.suction', where: 'nose' }, { type: 'airway.intubate', depthCm: 50 }]) {
    const before = p.stateHash(), n = p.log.length;
    assert.equal(p.dispatch(ev).ok, false, JSON.stringify(ev));
    assert.equal(p.log.length, n + 1); assert.equal(p.stateHash(), before);
  }
  p.dispatch({ type: 'airway.set', device: 'none' });
  assert.equal(p.tube.placed, false); assert.equal(p.tube.shuntExtra, 0);
});

test('a scenario that starts intubated has a well-placed tube; a bronchoscopy session replays bit-for-bit', () => {
  const p = scen('tension_ptx', 3);
  assert.equal(p.tube.tipAboveCarina, 4);
  runScript(p, [[10, { type: 'bronch.insert' }], [20, { type: 'airway.tube_adjust', cm: 4 }], [40, { type: 'bronch.suction', where: 'trachea' }], [50, { type: 'airway.tube_adjust', cm: -4 }], [60, { type: 'bronch.remove' }]], 120);
  const r = replay({ spec: p.spec, seed: p.seed, scenario: 'tension_ptx', log: p.log, until: p.t }, SCENARIOS);
  assert.equal(r.stateHash(), p.stateHash());
});
