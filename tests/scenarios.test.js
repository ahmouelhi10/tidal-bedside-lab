import test from 'node:test';
import assert from 'node:assert/strict';
import { Patient, replay } from '../src/engine/patient.js';
import { SCENARIOS, scenarioList, scoreSession } from '../src/engine/scenarios.js';
import { REFERENCES } from '../src/engine/references.js';
import { scen, mk, runScript, aclsTeam } from './helpers/bots.js';
import { expertRun, idleRun } from './helpers/experts.js';

const IDS = Object.keys(SCENARIOS);
const KINDS = new Set(['ACLS', 'Anaesthesia', 'Trauma', 'Echo', 'Infectiology', 'Emergency']);

test('catalogue: every scenario is complete, serialisable and keyed consistently', () => {
  assert.deepEqual(IDS.sort(), ['cico', 'echo_hypovolaemia', 'echo_lv_failure', 'echo_rv', 'echo_tamponade', 'hemorrhage', 'inf_cap', 'inf_esbl', 'inf_pyelo', 'inf_sab', 'obese_rsi', 'opioid_pea', 'stemi_vf', 'tension_ptx', 'tube_desat', 'witnessed_vf', 'anaphylaxis', 'mh_crisis', 'last_block', 'heart_block', 'torsades', 'dka', 'status_epilepticus', 'copd_exacerbation', 'svt', 'hyperkalaemia', 'hypoglycaemia', 'mobitz_brady'].sort());
  for (const id of IDS) {
    const s = SCENARIOS[id];
    assert.equal(s.id, id);
    assert.ok(KINDS.has(s.kind), id + ' kind');
    assert.ok(s.title && s.summary && s.durationS > 0 && s.learning.length >= 2, id + ' metadata');
    assert.equal(typeof s.score, 'function');
    assert.ok(['beginner', 'intermediate', 'advanced'].includes(s.difficulty));
    const p = scen(id, 1);                                               // initialises without throwing
    assert.equal(p.n, 0);
    assert.ok(Number.isFinite(p.circ.mapArt));
  }
  const list = scenarioList();
  assert.equal(list.length, IDS.length);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(list)));          // API payload has no functions
  assert.ok(list.every(x => !('score' in x) && !('init' in x)));
});

test('the catalogue covers lean, normal and obese patients of both sexes', () => {
  const bmis = IDS.map(id => { const sp = SCENARIOS[id].spec; return { sex: sp.sex, bmi: sp.weightKg / (sp.heightCm / 100) ** 2 }; });
  assert.ok(bmis.some(b => b.sex === 'F') && bmis.some(b => b.sex === 'M'));
  assert.ok(bmis.some(b => b.bmi >= 40), 'a class III obese case');
});

const RESULTS = {};
for (const id of IDS) {
  test(`scoring (${id}): an expert scores high, an idle learner scores low, items are well-formed`, () => {
    const expert = scen(id, 1); expertRun(expert, id);
    const idle = scen(id, 1); idleRun(idle, id);
    const e = scoreSession(expert), i = scoreSession(idle);
    RESULTS[id] = { e: e.pct, i: i.pct };
    for (const s of [e, i]) {
      assert.ok(s.items.length >= 4);
      assert.ok(s.pct >= 0 && s.pct <= 100 && s.total <= s.max + 1e-9);
      for (const it of s.items) {
        assert.ok(it.frac >= 0 && it.frac <= 1, `${id}.${it.id} frac ${it.frac}`);
        assert.ok(it.weight > 0 && it.label && typeof it.detail === 'string');
        assert.ok(REFERENCES[it.ref], `${id}.${it.id} cites unknown reference ${it.ref}`);
      }
    }
    assert.ok(e.pct >= 80, `${id}: expert ${e.pct}% ${JSON.stringify(e.items.filter(x => x.frac < 0.8).map(x => x.id + ':' + x.frac))}`);
    assert.ok(i.pct <= 40, `${id}: idle ${i.pct}%`);
    assert.ok(e.pct - i.pct >= 40);
  });
}

test('scoring is a pure function of the recorded session: a replay yields the same score', () => {
  for (const id of ['witnessed_vf', 'obese_rsi']) {
    const p = scen(id, 4); expertRun(p, id);
    const r = replay({ spec: p.spec, seed: p.seed, scenario: id, log: p.log, until: p.t }, SCENARIOS);
    assert.equal(r.stateHash(), p.stateHash(), id);
    assert.deepEqual(scoreSession(r), scoreSession(p), id);
  }
});

test('scoring a patient with no scenario is empty, not an error', () => {
  assert.deepEqual(scoreSession(mk()), { items: [], total: 0, max: 0, pct: 0, grade: '-' });
});

// ------------------------------------------------------------------------------------------ opioid overdose
test('opioid overdose: ignoring it ends in hypoxic bradycardia then PEA (design timeline 4-9 min)', () => {
  const p = scen('opioid_pea', 2); p.run(120);
  assert.ok(p.resp.spo2 < 70 && p.resp.rr < 8, `SpO2 ${p.resp.spo2} rr ${p.resp.rr}`);
  let tArrest = null; for (let t = 120; t <= 600 && tArrest === null; t += 5) { p.run(5); if (p.arrest.arrested) tArrest = p.t; }
  assert.ok(tArrest !== null && tArrest > 200 && tArrest < 540, 'arrest at ' + tArrest);
  assert.equal(p.arrest.key, 'PEA');
  assert.equal(p.arrest.causes.hypoxia, true);
});

test('opioid overdose: ventilation prevents arrest; naloxone alone (no airway care) also prevents the arrest', () => {
  const vent = scen('opioid_pea', 2);
  runScript(vent, [[10, { type: 'airway.set', device: 'bvm' }], [15, { type: 'vent.set', settings: { mode: 'ctrl', rate: 10, vt: 450, fio2: 1, peep: 5, seal: 0.9 } }]], 420);
  assert.equal(vent.arrest.arrested, false);
  assert.ok(vent.resp.sao2 > 0.9, 'SpO2 ' + vent.resp.spo2);
  const nal = scen('opioid_pea', 2); runScript(nal, [[20, { type: 'drug.bolus', drug: 'naloxone', amount: 400 }]], 420);
  assert.equal(nal.arrest.arrested, false, 'naloxone reverses the central depression');
});

test('opioid overdose: late hypoxic PEA + immediate CPR with ventilation => hypoxia resolves in every case, ROSC in a substantial minority-to-majority within 10 min (n=8)', () => {
  let rosc = 0, resolved = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const p = scen('opioid_pea', seed);
    while (!p.arrest.arrested && p.t < 700) p.run(5);
    assert.ok(p.arrest.arrested, 'seed ' + seed);
    aclsTeam(p, { endT: p.t + 600, reaction: 8 });
    if (p.arrest.roscCount > 0) rosc++;
    if (p.arrest.causes.hypoxia === false) resolved++;
  }
  assert.equal(resolved, 8, 'hypoxia auto-resolves once SaO2 >= 92% on ventilation');
  assert.ok(rosc >= 3 && rosc <= 8, `ROSC ${rosc}/8`);
  const idle = scen('opioid_pea', 1); while (!idle.arrest.arrested && idle.t < 700) idle.run(5); idle.run(600);
  assert.equal(idle.arrest.roscCount, 0, 'no ROSC without CPR');
});

// ------------------------------------------------------------------------------------------ obese RSI
test('obese RSI: pre-oxygenated (head-up, FiO2 1.0, mask kept on) keeps SpO2 >= 90%; skipping pre-oxygenation drops it far lower', () => {
  const run = (preoxS) => {
    const p = scen('obese_rsi', 1);
    runScript(p, [[0, { type: 'position.set', headUp: preoxS > 100 }], ...(preoxS > 100 ? [[1, { type: 'o2.mask', fio2: 1, seal: 0.95 }]] : []), [2, { type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, capnography: true } }]], preoxS);
    p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 200 }); p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 100 });
    for (let k = 0; k < 30 && !(p.drugs.effects({ inArrest: false }).nmb > 0.9); k++) p.run(10);   // wait for relaxation
    const r = p.dispatch({ type: 'airway.intubate' }); p.run((r.willTakeS || 30) + 2);
    p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: 6 * p.body.pbw, fio2: 1, peep: 8, seal: 0.97 } }); p.run(120);
    return p;
  };
  const prep = run(240), none = run(10);
  assert.ok(prep.minSpo2 >= 90, 'pre-oxygenated nadir ' + prep.minSpo2);
  assert.ok(none.minSpo2 < prep.minSpo2 - 20, `no preox nadir ${none.minSpo2} vs ${prep.minSpo2}`);
  assert.ok(prep.resp.spo2 > 95 && none.resp.spo2 > 90, 'both recover once ventilated');
});

test('obese RSI: intubating an un-paralysed patient fails and is recorded as a failed attempt', () => {
  const p = scen('obese_rsi', 1); p.run(10);
  const r = p.dispatch({ type: 'airway.intubate' });
  assert.equal(r.ok, false);
  assert.ok((p.failedAttempts || 0) >= 1);
  assert.equal(p.airway.intubated, false);
});

// ------------------------------------------------------------------------------------------ haemorrhage
test('haemorrhage: earlier source control => smaller peak loss; crystalloid alone does not replace blood', () => {
  const at = (tControl, blood) => {
    const p = scen('hemorrhage', 1);
    const script = [[5, { type: 'iv.access' }], [tControl, { type: 'bleed.control' }]];
    if (blood) script.push([tControl + 20, { type: 'blood.transfuse', kind: 'prbc' }], [tControl + 40, { type: 'blood.transfuse', kind: 'prbc' }]); else script.push([tControl + 20, { type: 'fluid.bolus', volumeL: 1.0, minutes: 10 }]);
    runScript(p, script, 900); return p;
  };
  const early = at(60, true), late = at(500, true);
  assert.ok(early.peakLost < late.peakLost * 0.5, `peak loss ${early.peakLost} vs ${late.peakLost}`);
  const crys = at(400, false), bl = at(400, true);
  assert.ok(bl.vol.hb > crys.vol.hb + 0.4, `Hb ${bl.vol.hb} vs ${crys.vol.hb}`);
  assert.ok(scoreSession(early).pct > scoreSession(late).pct);
});

test('haemorrhage: uncontrolled bleeding deteriorates (HR up, SBP down, lactate rising) in the ATLS direction', () => {
  const p = scen('hemorrhage', 1); p.run(60); const a = p.snapshot(); p.run(1440); const b = p.snapshot();
  assert.ok(b.fractionLost > 0.35 && b.hr > a.hr + 40 && b.sbp < a.sbp - 20, JSON.stringify({ a: [a.hr, a.sbp], b: [b.hr, b.sbp, b.fractionLost] }));
});

// ------------------------------------------------------------------------------------------ STEMI
test('STEMI: ECG order returns the STEMI finding; oxygen at SpO2 >= 90% and vasopressin are penalised; nitroglycerin is safe at normal BP', () => {
  const p = scen('stemi_vf', 1); p.run(30);
  const r = p.dispatch({ type: 'order', what: 'ecg12' });
  assert.equal(r.result.stemi, true);
  p.dispatch({ type: 'o2.mask', fio2: 1.0, seal: 0.9 });
  const sc = scoreSession(p), o2 = sc.items.find(i => i.id === 'no_routine_o2');
  assert.ok(o2 && o2.frac < 0.5, 'routine oxygen penalised');
  const q = scen('witnessed_vf', 1); aclsTeam(q, { endT: 25, reaction: 2 });
  q.dispatch({ type: 'drug.bolus', drug: 'vasopressin', amount: 40 });
  const a3 = scoreSession(q).items.find(i => i.id === 'avoid_class3');
  assert.ok(a3 && a3.frac < 1, 'vasopressin is Class 3 in AHA 2025');
});

test('STEMI: the patient fibrillates at t=600 s whatever the learner does, and defibrillation within 2 min is usually successful', () => {
  let ok = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const p = scen('stemi_vf', seed); p.run(599); assert.equal(p.arrest.arrested, false); p.run(3);
    assert.equal(p.arrest.arrested, true); assert.equal(p.arrest.key, 'VF');
    aclsTeam(p, { endT: p.t + 400, reaction: 10 }); if (p.arrest.roscCount > 0) ok++;
  }
  assert.ok(ok >= 5, `ROSC ${ok}/6`);
});

test.after(() => { console.log('# scenario scores (expert / idle):', JSON.stringify(RESULTS)); });
