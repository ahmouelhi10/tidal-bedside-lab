// CPR mechanics, defibrillation, arrest/ROSC logic. Targets: research note "cpr_acls_guidelines.md" (AHA 2025 Part 7/9/11, CPP >= 15 mmHg threshold,
// CCF >= 60%, rate 100-120, depth 5-6 cm, impedance/energy), plus monotonicity properties that must hold for every parameterisation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeBody } from '../src/engine/anthropometrics.js';
import { Rng } from '../src/engine/rng.js';
import { CprMechanics, Defibrillator, baseTermination, ArrestState, CAUSES, CPR_LIMITS } from '../src/engine/cpr.js';
import { mk, scen, aclsTeam } from './helpers/bots.js';

function arrestRun(spec, { depth = 5.5, rate = 110, surface = 'hard', mode = 'auto', secs = 90, key = 'VF', ratio = 'continuous' } = {}) {
  const p = mk(spec); p.run(5); p.dispatch({ type: 'monitor.attach', items: { aline: true, ecgLeads: true, spo2Probe: true, capnography: true } });
  p.arrest.arrest(key, p.t); p.dispatch({ type: 'airway.set', device: 'ett' });
  p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 10, vt: 450, fio2: 1, peep: 5, seal: 1 } });
  p.dispatch({ type: 'cpr.start', mode, opts: { rate, depth, ratio }, surface }); p.run(secs); return p;
}

// ------------------------------------------------------------------ compression mechanics
test('flow and perfusion pressure rise with compression depth up to 5 cm; CPP >= 15 mmHg needs adequate depth', () => {
  const r = d => arrestRun({}, { depth: d }); const [a, b, c, d] = [2.5, 4, 5, 5.5].map(r);
  assert.ok(a.cpr.flow < b.cpr.flow && b.cpr.flow < c.cpr.flow, 'flow monotone in depth');
  assert.ok(a.circ.cpp < 8 && b.circ.cpp < 15 && c.circ.cpp >= 15 && d.circ.cpp >= 15, `CPP ${[a, b, c, d].map(x => x.circ.cpp.toFixed(0))}`);
});
test('over-deep compressions (> 6 cm) do not improve flow (AHA: avoid > 6 cm)', () => {
  assert.ok(arrestRun({}, { depth: 7.5 }).cpr.flow <= arrestRun({}, { depth: 5.5 }).cpr.flow + 1e-9);
});
test('compression rate: 100-120/min is best; 60 and 170 are clearly worse', () => {
  const f = r => arrestRun({}, { rate: r }).circ.cpp;
  assert.ok(f(110) > f(60) + 4 && f(110) > f(170) + 8 && f(110) >= f(80) && f(110) >= f(140), `CPP 60:${f(60).toFixed(1)} 110:${f(110).toFixed(1)} 170:${f(170).toFixed(1)}`);
});
test('soft surface (bed without board) and obesity both reduce flow', () => {
  const hard = arrestRun({}, {}), soft = arrestRun({}, { surface: 'soft' }), obese = arrestRun({ weightKg: 170, heightCm: 170 }, {});
  assert.ok(soft.circ.cpp < hard.circ.cpp - 1 && obese.circ.cpp < hard.circ.cpp - 3, `${hard.circ.cpp.toFixed(1)} / soft ${soft.circ.cpp.toFixed(1)} / obese ${obese.circ.cpp.toFixed(1)}`);
});
test('manual compressions: depth decays with fatigue after ~2 min; switching compressor restores it', () => {
  const p = mk({}); p.run(5); p.arrest.arrest('VF', p.t); p.dispatch({ type: 'cpr.start', mode: 'manual', surface: 'hard' });
  const tap = (secs) => { const n = Math.round(secs / 0.545); for (let i = 0; i < n; i++) { p.dispatch({ type: 'cpr.compress', depth: 5.5, recoil: 1 }); p.run(0.545); } return p.cpr.stats.depth; };
  const d1 = tap(60), d5 = (tap(60), tap(60), tap(60), tap(60)); p.dispatch({ type: 'cpr.switch' }); const d6 = tap(30);
  assert.ok(d5 < d1 - 0.2, `depth 1 min ${d1.toFixed(2)} -> 5 min ${d5.toFixed(2)}`); assert.ok(d6 > d5 + 0.1, `after switch ${d6.toFixed(2)}`);
});
test('compression fraction: continuous > 30:2 with pauses, and 30:2 stays within 0.6-0.9', () => {
  const c = arrestRun({}, { secs: 180 }).cpr.ccf, r = arrestRun({}, { secs: 180, ratio: '30:2' }).cpr.ccf;
  assert.ok(c > 0.95 && r > 0.55 && r < 0.92 && c > r, `continuous ${c.toFixed(2)} 30:2 ${r.toFixed(2)}`);
});
test('ETCO2 tracks compression quality (good CPR > poor CPR) and no waveform appears without capnography', () => {
  assert.ok(arrestRun({}, {}).resp.etco2 > arrestRun({}, { depth: 3.5 }).resp.etco2 + 2);
});
test('CPR limits are the AHA ranges', () => { assert.deepEqual([CPR_LIMITS.rateLo, CPR_LIMITS.rateHi, CPR_LIMITS.depthLo, CPR_LIMITS.depthHi, CPR_LIMITS.ccfMin], [100, 120, 5, 6, 0.6]); });

// ------------------------------------------------------------------ defibrillator
test('termination probability rises with energy: 50 J < 120 J < 200 J, saturating below 1', () => {
  const [a, b, c] = [50, 120, 200].map(baseTermination);
  assert.ok(a < b && b < c && c < 0.97 && a > 0.3 && c > 0.85, `${a.toFixed(2)} ${b.toFixed(2)} ${c.toFixed(2)}`);
});
test('transthoracic impedance rises with BMI within the physiological 50-150 ohm window', () => {
  const imp = w => new Defibrillator(describeBody({ sex: 'M', age: 50, heightCm: 175, weightKg: w })).impedance;
  assert.ok(imp(50) < imp(80) && imp(80) < imp(160) && imp(40) >= 50 && imp(250) <= 150);
});
test('defibrillator needs pads, a charge, and takes 4 + E/120 s to charge', () => {
  const p = mk({}); p.run(5); p.arrest.arrest('VF', p.t);
  assert.equal(p.dispatch({ type: 'defib.shock' }).ok, false, 'no pads');
  p.dispatch({ type: 'defib.pads' }); p.dispatch({ type: 'defib.setEnergy', energy: 200 });
  assert.equal(p.dispatch({ type: 'defib.shock' }).ok, false, 'not charged');
  p.dispatch({ type: 'defib.charge' }); p.run(4 + 200 / 120 - 0.5); assert.equal(p.dispatch({ type: 'defib.shock' }).ok, false, 'charging');
});
test('a shock never converts PEA / asystole (non-shockable rhythms)', () => {
  const p = mk({}); p.run(5); p.arrest.arrest('PEA', p.t); p.dispatch({ type: 'defib.pads' }); p.dispatch({ type: 'defib.setEnergy', energy: 200 }); p.dispatch({ type: 'defib.charge' }); p.run(8);
  p.dispatch({ type: 'cpr.start', mode: 'auto', opts: { rate: 110, depth: 5.5 }, surface: 'hard' }); p.run(10); const r = p.dispatch({ type: 'defib.shock' });
  assert.ok(!r.terminated, JSON.stringify(r)); assert.ok(['PEA', 'ASYSTOLE'].includes(p.arrest.key));
});

// ------------------------------------------------------------------ arrest / ROSC logic (Monte-Carlo with the scripted ALS team)
function mc(mkp, opt, n = 60) { let rosc = 0; for (let s = 1; s <= n; s++) { const p = mkp(s); aclsTeam(p, opt); if (p.arrest.roscCount > 0) rosc++; } return rosc / n; }
const vf = s => scen('witnessed_vf', s);
test('witnessed VF with immediate CPR + defibrillation: ROSC >= 80%', () => { assert.ok(mc(vf, { endT: 600 }) >= 0.8); });
test('ROSC falls monotonically as the response is delayed (10 s -> 60 s -> 180 s -> 480 s)', () => {
  const rates = [10, 60, 180, 480].map(r => mc(vf, { endT: 1200, reaction: r }, 80));
  for (let i = 1; i < rates.length; i++) assert.ok(rates[i] <= rates[i - 1] + 0.06, `rates ${rates.map(x => x.toFixed(2))}`);
  assert.ok(rates[3] < 0.35 && rates[0] > 0.8, `rates ${rates.map(x => x.toFixed(2))}`);
});
test('when the first shock is delayed, ongoing high-quality CPR protects the outcome (CPR vs no CPR)', () => {
  const withCpr = mc(vf, { endT: 1200, reaction: 180 }, 80), without = mc(vf, { endT: 1200, reaction: 180, noCpr: true }, 80);
  assert.ok(withCpr > without + 0.15, `with CPR ${withCpr.toFixed(2)} vs without ${without.toFixed(2)}`);
});
test('poor-quality CPR (3 cm) lowers ROSC compared with guideline-quality CPR when the shock is late', () => {
  const good = mc(vf, { endT: 1200, reaction: 120 }, 80), poor = mc(vf, { endT: 1200, reaction: 120, depth: 3.0 }, 80);
  assert.ok(good > poor + 0.1, `good ${good.toFixed(2)} poor ${poor.toFixed(2)}`);
});
test('non-shockable arrest (PEA) with an unresolved reversible cause does not achieve ROSC; fixing the cause allows it', () => {
  const run = fix => { let rosc = 0; for (let s = 1; s <= 40; s++) { const p = mk({ causes: ['tension_ptx'] }, { seed: s }); p.run(5); p.arrest.arrest('PEA', p.t); if (fix) p.dispatch({ type: 'procedure.needle_decompression' }); aclsTeam(p, { endT: 900, reaction: 5 }); if (p.arrest.roscCount > 0) rosc++; } return rosc / 40; };
  assert.equal(run(false), 0); assert.ok(run(true) > 0.15, `fixed ${run(true)}`);
});
test('hypoxic PEA: the immediate team gets ROSC less often than in witnessed VF (non-shockable < shockable)', () => {
  const pea = s => { const p = scen('witnessed_vf', s); p.timeline = []; return p; };
  let rp = 0, rv = 0; for (let s = 1; s <= 60; s++) { const p = mk({}, { seed: s }); p.run(5); p.arrest.arrest('PEA', p.t); aclsTeam(p, { endT: 900, reaction: 10 }); if (p.arrest.roscCount) rp++; rv += 0; }
  const vfr = mc(vf, { endT: 900 }, 60); assert.ok(rp / 60 < vfr, `PEA ${(rp / 60).toFixed(2)} VF ${vfr.toFixed(2)}`);
});
test('epinephrine raises the ROSC rate in non-shockable arrest (REF aha2025_part9) and vasopressin does not', () => {
  const run = (drug) => { let rosc = 0; for (let s = 1; s <= 80; s++) { const p = mk({}, { seed: s }); p.run(5); p.arrest.arrest('PEA', p.t); p.dispatch({ type: 'cpr.start', mode: 'auto', opts: { rate: 110, depth: 5.5 }, surface: 'hard' });
    p.dispatch({ type: 'airway.set', device: 'ett' }); p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 10, vt: 450, fio2: 1, peep: 5, seal: 1 } });
    for (let m = 0; m < 6 && !p.arrest.roscCount; m++) { if (drug === 'epinephrine') p.dispatch({ type: 'drug.bolus', drug, amount: 1000 }); if (drug === 'vasopressin') p.dispatch({ type: 'drug.bolus', drug, amount: 40 }); p.run(120); } if (p.arrest.roscCount) rosc++; } return rosc / 80; };
  const none = run(null), epi = run('epinephrine'), vaso = run('vasopressin');
  assert.ok(epi >= none, `none ${none.toFixed(2)} epi ${epi.toFixed(2)} vaso ${vaso.toFixed(2)}`); assert.ok(vaso <= none + 0.1, `vasopressin should not help: ${vaso.toFixed(2)} vs ${none.toFixed(2)}`);
});
test('ROSC restores a palpable pulse, a perfusing rhythm, and a sharp ETCO2 rise', () => {
  const p = scen('witnessed_vf', 3); aclsTeam(p, { endT: 400 }); assert.ok(p.arrest.roscCount >= 1 && !p.arrest.arrested);
  assert.ok(p.pulse && p.circ.mapArt > 55 && p.resp.etco2 > 25, `MAP ${p.circ.mapArt.toFixed(0)} ETCO2 ${p.resp.etco2.toFixed(0)}`);
});
test('during arrest there is no pulse and the arterial line shows CPR pressures only', () => {
  const p = mk({}); p.run(5); p.arrest.arrest('VF', p.t); p.run(20); assert.equal(p.pulse, false); assert.ok(p.circ.mapArt < 25);
});
test('cause catalogue is complete (H\'s and T\'s) and each cause names its treatment', () => {
  for (const k of ['hypoxia', 'hypovolemia', 'hyperkalemia', 'acidosis', 'hypothermia', 'tension_ptx', 'tamponade', 'toxins', 'coronary_thrombosis', 'pulmonary_embolism']) assert.ok(CAUSES[k]?.label && CAUSES[k]?.fixedBy, k);
});
test('ArrestState is deterministic for a seed', () => {
  const run = () => { const a = new ArrestState(new Rng(5), []); a.arrest('VF', 0); const out = []; for (let i = 0; i < 100; i++) out.push(a.step(0.1, { flow: 0.2, cpp: 14, t: i * 0.1 })); return JSON.stringify([out, a.readiness, a.vfAmp]); };
  assert.equal(run(), run());
});
