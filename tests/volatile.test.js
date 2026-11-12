// Sevoflurane: uptake and washout kinetics, age-adjusted MAC, hypnosis, haemodynamics, ventilation, bronchodilation,
// malignant hyperthermia trigger, replay. Bands from published data (REF yasuda1991, mapleson1996, label_sevoflurane,
// katoh1993, ebert1995).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { replay } from '../src/engine/patient.js';
import { macSevo } from '../src/engine/volatile.js';

const intubated = (spec = {}) => {
  const p = mk({ age: 40, weightKg: 70, ...spec }); p.run(30);
  p.dispatch({ type: 'o2.mask', fio2: 1, seal: 0.97 }); p.dispatch({ type: 'vaporizer.set', agent: 'sevoflurane', percent: 6 }); p.run(180);
  p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 42 }); p.run(90); p.dispatch({ type: 'airway.intubate' }); p.run(20);
  p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: 500, fio2: 0.5, peep: 5, seal: 0.97 } }); return p;
};

test('MAC falls with age as on the label (2.05 % at 40, ~1.85 at 60, ~1.6 at 80)', () => {
  assert.ok(Math.abs(macSevo(40) - 2.05) < 0.01); assert.ok(Math.abs(macSevo(60) - 1.85) < 0.06); assert.ok(Math.abs(macSevo(80) - 1.6) < 0.06);
});

test('uptake: FA/FI 0.6-0.8 at 5 min and 0.75-0.9 at 30 min; washout FA/FA0 0.1-0.3 at 5 min; awake within 5-15 min of stopping', () => {
  const p = mk({ age: 40, weightKg: 70 }); p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 42 }); p.run(90); p.dispatch({ type: 'airway.intubate' });
  p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: 500, fio2: 0.5, peep: 5, seal: 1 } }); p.dispatch({ type: 'vaporizer.set', percent: 2.5 });
  p.run(300); const r5 = p.volatile.fa / p.volatile.fi; p.run(1500); const r30 = p.volatile.fa / p.volatile.fi;
  assert.ok(r5 >= 0.6 && r5 <= 0.8 && r30 >= 0.75 && r30 <= 0.9, `FA/FI ${r5.toFixed(2)} at 5 min, ${r30.toFixed(2)} at 30 min`);
  const fa0 = p.volatile.fa; p.dispatch({ type: 'vaporizer.set', percent: 0 }); p.run(300);
  const w = p.volatile.fa / fa0; assert.ok(w >= 0.1 && w <= 0.3, `FA/FA0 ${w.toFixed(2)} at 5 min`);
  let awake = 300; while (p.drugs.effects({}).loc && awake < 1800) { p.run(10); awake += 10; }
  assert.ok(awake >= 300 && awake <= 900, `consciousness back ${awake} s after stopping`);
});

test('8 % by face mask: consciousness lost within 2 min; no agent without a circuit', () => {
  const p = mk({ age: 30 }); p.dispatch({ type: 'o2.mask', fio2: 1, seal: 0.97 }); p.dispatch({ type: 'vaporizer.set', percent: 8 });
  let t = 0; while (!p.drugs.effects({}).loc && t < 300) { p.run(5); t += 5; } assert.ok(t >= 20 && t <= 120, `loss of consciousness at ${t} s`);
  const q = mk(); q.dispatch({ type: 'vaporizer.set', percent: 8 }); q.run(120); assert.equal(q.volatile.fa, 0, 'room air: nothing delivered');
  assert.equal(q.dispatch({ type: 'vaporizer.set', percent: 12 }).ok, false, 'dial limited to 8 %');
});

test('~1 MAC: BIS 35-50 and MAP down 15-30 % (heart rate kept); spontaneous breathing: PaCO2 45-60 with fast shallow breaths', () => {
  const map0 = (() => { const q = mk({ age: 40, weightKg: 70 }); q.run(30); return q.circ.mapArt; })(), p = intubated(); p.dispatch({ type: 'vaporizer.set', percent: 2.3 }); p.run(1800);
  const bis = p.drugs.effects({}).bis, d = 1 - p.circ.mapArt / map0;
  assert.ok(p.volatile.macFrac > 0.8 && p.volatile.macFrac < 1.1, `brain ${p.volatile.macFrac.toFixed(2)} MAC`);
  assert.ok(bis >= 35 && bis <= 50, `BIS ${bis.toFixed(0)}`); assert.ok(d >= 0.15 && d <= 0.3, `MAP -${(d * 100).toFixed(0)} %`); assert.ok(p.circ.hr > 60 && p.circ.hr < 100);
  const s = mk({ age: 40, weightKg: 70 }); s.run(30); s.dispatch({ type: 'o2.mask', fio2: 1, seal: 0.97 }); s.dispatch({ type: 'vaporizer.set', percent: 3 }); s.run(1800);
  assert.ok(s.resp.paco2 >= 45 && s.resp.paco2 <= 60 && s.resp.vt < 400, `PaCO2 ${s.resp.paco2.toFixed(0)}, Vt ${s.resp.vt.toFixed(0)} at ${s.volatile.macFrac.toFixed(2)} MAC`);
});

test('sevoflurane relieves bronchospasm and triggers malignant hyperthermia in a susceptible patient', () => {
  const a = intubated(), b = intubated();
  for (const p of [a, b]) p.dispatch({ type: 'instructor.inject', what: 'bronchospasm' });
  a.dispatch({ type: 'vaporizer.set', percent: 0 }); a.dispatch({ type: 'drug.infusion', drug: 'propofol', rate: 8 }); b.dispatch({ type: 'vaporizer.set', percent: 2.5 });
  a.run(900); b.run(900); assert.ok(b.crises.br < 0.8 * a.crises.br, `bronchospasm ${a.crises.br.toFixed(2)} on propofol vs ${b.crises.br.toFixed(2)} on sevoflurane`);
  const m = mk({ mhSusceptible: true }); m.dispatch({ type: 'o2.mask', fio2: 1, seal: 0.97 }); m.dispatch({ type: 'vaporizer.set', percent: 3 });
  assert.ok(m.crises.mhAt != null && m.crises.mhAt <= m.t + 1800, 'a volatile triggers MH');
  const n = mk(); n.dispatch({ type: 'vaporizer.set', percent: 3 }); assert.equal(n.crises.mhAt, null, 'not in a normal patient');
});

test('sevoflurane replays to the same hash', () => {
  const p = mk({}, { seed: 4 }); p.dispatch({ type: 'o2.mask', fio2: 1, seal: 0.97 }); p.dispatch({ type: 'vaporizer.set', percent: 6 }); p.run(200); p.dispatch({ type: 'vaporizer.set', percent: 0 }); p.run(200);
  const q = replay({ spec: p.spec, seed: 4, scenario: null, log: p.log.map(e => ({ ...e })), until: p.t }, {});
  assert.equal(q.stateHash(), p.stateHash());
});

test('isoflurane, desflurane, sevoflurane: uptake and washout in the published order (desflurane fastest, isoflurane slowest)', () => {
  const run = (agent, pct) => { const p = mk({ age: 40, weightKg: 70 }); p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 42 }); p.run(90); p.dispatch({ type: 'airway.intubate' });
    p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: 500, fio2: 0.5, peep: 5, seal: 1 } }); p.dispatch({ type: 'vaporizer.set', agent, percent: pct }); p.run(1800);
    const r30 = p.volatile.fa / p.volatile.fi, fa0 = p.volatile.fa; p.dispatch({ type: 'vaporizer.set', agent, percent: 0 }); p.run(300); return { r30, w5: p.volatile.fa / fa0 }; };
  const des = run('desflurane', 6), sev = run('sevoflurane', 2), iso = run('isoflurane', 1.2);
  assert.ok(des.r30 > sev.r30 && sev.r30 > iso.r30, `FA/FI at 30 min: des ${des.r30.toFixed(2)}, sevo ${sev.r30.toFixed(2)}, iso ${iso.r30.toFixed(2)}`);
  assert.ok(des.r30 >= 0.85 && iso.r30 >= 0.6 && iso.r30 <= 0.8, 'Yasuda 1991 bands');
  assert.ok(des.w5 < sev.w5 && sev.w5 < iso.w5, `washout at 5 min: des ${des.w5.toFixed(2)}, sevo ${sev.w5.toFixed(2)}, iso ${iso.w5.toFixed(2)}`);
});

test('desflurane: fast rise raises HR and BP; pungent through a mask; isoflurane MAC 1.15 % at 44 and desflurane 6.0 % at 45', async () => {
  const { macOf } = await import('../src/engine/volatile.js');
  assert.ok(Math.abs(macOf('isoflurane', 44) - 1.15) < 0.05 && Math.abs(macOf('desflurane', 45) - 6.0) < 0.1 && Math.abs(macOf('desflurane', 70) - 5.17) < 0.1);
  const p = intubated(); p.dispatch({ type: 'vaporizer.set', agent: 'desflurane', percent: 4 }); p.run(1200); const hr0 = p.circ.hr, m0 = p.circ.mapArt;
  p.dispatch({ type: 'vaporizer.set', agent: 'desflurane', percent: 12 }); let hr = 0, mp = 0; for (let i = 0; i < 60; i++) { p.run(5); hr = Math.max(hr, p.circ.hr - hr0); mp = Math.max(mp, p.circ.mapArt - m0); }
  assert.ok(hr >= 10 && mp >= 5, `HR +${hr.toFixed(0)}, MAP +${mp.toFixed(0)}`);
  const m = mk(); m.dispatch({ type: 'o2.mask', fio2: 1, seal: 0.97 }); m.dispatch({ type: 'vaporizer.set', agent: 'desflurane', percent: 12 }); m.run(60);
  assert.ok(m.volatile.irritation > 0.5, 'airway irritation through a mask');
  assert.equal(mk().dispatch({ type: 'vaporizer.set', agent: 'isoflurane', percent: 6 }).ok, false, 'isoflurane dial limited to 5 %');
});

test('nitrous oxide: caps FiO2, adds to MAC, and stopping it onto air causes diffusion hypoxia (not onto oxygen)', () => {
  const run = (fio2After) => { const p = intubated(); p.dispatch({ type: 'vaporizer.set', percent: 0 }); p.dispatch({ type: 'drug.infusion', drug: 'propofol', rate: 8 });
    p.dispatch({ type: 'vent.set', settings: { fio2: 1 } }); p.dispatch({ type: 'n2o.set', percent: 70 }); p.run(60);
    const fio2 = p.resp.fio2Eff; p.run(3540); const mac = p.volatile.n2oMac;
    p.dispatch({ type: 'vent.set', settings: { fio2: fio2After } }); p.dispatch({ type: 'n2o.set', percent: 0 }); let lo = 100; for (let i = 0; i < 60; i++) { p.run(5); lo = Math.min(lo, p.resp.sao2 * 100); } return { fio2, mac, lo }; };
  const air = run(0.21), o2 = run(1.0);
  assert.ok(air.fio2 <= 0.33, `FiO2 ${air.fio2.toFixed(2)} with 70 % nitrous oxide`); assert.ok(air.mac > 0.4 && air.mac < 0.8, `${air.mac.toFixed(2)} MAC`);
  assert.ok(air.lo < o2.lo - 3 && o2.lo > 95, `lowest SaO2 onto air ${air.lo.toFixed(0)} %, onto oxygen ${o2.lo.toFixed(0)} %`);
});
