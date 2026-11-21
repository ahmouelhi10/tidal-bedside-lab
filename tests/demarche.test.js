import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/engine/patient.js';
import { SCENARIOS, scoreSession } from '../src/engine/scenarios.js';
import { scoreDemarche, DEMARCHE } from '../src/engine/demarche.js';
import { REFERENCES } from '../src/engine/references.js';
import { scen, runScript } from './helpers/bots.js';
import { expertRun, idleRun } from './helpers/experts.js';

const item = (p, id) => scoreSession(p).items.find(i => i.id === 'demarche_' + id);

test('every démarche cites a known reference and has positive weights', () => {
  for (const [id, d] of Object.entries(DEMARCHE)) {
    assert.ok(REFERENCES[d.ref], id);
    for (const c of d.checks) assert.ok(c.w > 0 && c.label, `${id}.${c.id}`);
  }
});

test('not applicable until the procedure is performed: an idle learner has no démarche item', () => {
  for (const id of ['witnessed_vf', 'obese_rsi', 'tension_ptx', 'cico', 'tube_desat']) {
    const p = scen(id, 1); idleRun(p, id, 120);
    assert.equal(scoreSession(p).items.some(i => i.id.startsWith('demarche_')), false, id);
  }
});

test('the expert of each scenario follows the whole démarche', () => {
  for (const [id, proc] of [['witnessed_vf', 'defib'], ['obese_rsi', 'rsi'], ['tension_ptx', 'chest'], ['cico', 'fona'], ['tube_desat', 'bronch']]) {
    const p = scen(id, 1); expertRun(p, id);
    assert.equal(item(p, proc).frac, 1, `${id}: ${item(p, proc).detail}`);
  }
});

test('RSI: a rushed induction (no pre-oxygenation, no head-up, laryngoscopy 10 s after the relaxant) loses most of the démarche', () => {
  const rushed = scen('obese_rsi', 1);
  runScript(rushed, [[5, { type: 'drug.bolus', drug: 'propofol', amount: 200 }], [5, { type: 'drug.bolus', drug: 'rocuronium', amount: 100 }], [15, { type: 'airway.intubate' }]], 120);
  const r = scoreDemarche(rushed, 'rsi'), byId = Object.fromEntries(r.steps.map(s => [s.id, s.frac]));
  assert.equal(byId.preox, 0); assert.equal(byId.position, 0); assert.equal(byId.nmb, 1); assert.equal(byId.relaxed, 0, 'laryngoscopy 10 s after the relaxant: the patient was still moving');
  assert.equal(byId.monitor, 1, 'the scenario had the monitoring on before t = 0 and that is credited');
  const expert = scen('obese_rsi', 1); expertRun(expert, 'obese_rsi');
  assert.ok(r.frac < scoreDemarche(expert, 'rsi').frac - 0.4);
});

test('RSI: pre-oxygenation credit grows with its duration up to 3 min', () => {
  const at = (s) => { const p = scen('obese_rsi', 1); runScript(p, [[1, { type: 'o2.mask', fio2: 1, seal: 0.95 }], [1 + s, { type: 'drug.bolus', drug: 'propofol', amount: 200 }], [1 + s, { type: 'drug.bolus', drug: 'rocuronium', amount: 100 }], [61 + s, { type: 'airway.intubate' }]], 70 + s); return scoreDemarche(p, 'rsi').steps.find(x => x.id === 'preox').frac; };
  const a = at(60), b = at(120), c = at(200);
  assert.ok(a < b && b < c && c === 1, `${a} ${b} ${c}`);
});

test('defibrillation: charging with CPR stopped and not resuming compressions after the shock are penalised', () => {
  const p = scen('witnessed_vf', 1);
  runScript(p, [[30, { type: 'defib.pads' }], [31, { type: 'defib.setEnergy', energy: 200 }], [31, { type: 'defib.charge' }], [40, { type: 'defib.shock' }]], 80);
  const r = scoreDemarche(p, 'defib'), byId = Object.fromEntries(r.steps.map(s => [s.id, s.frac]));
  assert.equal(byId.cpr_first, 0); assert.equal(byId.charge_cpr, 0); assert.equal(byId.pads, 1);
  const good = scen('witnessed_vf', 1); expertRun(good, 'witnessed_vf');
  assert.ok(r.frac < scoreDemarche(good, 'defib').frac - 0.5);
});

test('declared steps count only when performed, carry a small share, and a skipped step earns nothing', () => {
  const run = (note) => { const p = scen('obese_rsi', 1); runScript(p, [...(note ? [[0, { type: 'note', text: note }]] : []), [1, { type: 'o2.mask', fio2: 1, seal: 0.95 }], [200, { type: 'drug.bolus', drug: 'propofol', amount: 200 }], [200, { type: 'drug.bolus', drug: 'rocuronium', amount: 100 }], [260, { type: 'airway.intubate' }]], 270); return scoreDemarche(p, 'rsi').frac; };
  const none = run(null), skipped = run('guide rsi: prep (skipped)'), done = run('guide rsi: prep');
  assert.equal(skipped, none);
  assert.ok(done > none && done - none < 0.06, `declared share ${done - none}`);
});

test('chest: decompressing without examining, reassessing or analgesia scores low; the scenario total still rewards the relief', () => {
  const p = scen('tension_ptx', 1);
  runScript(p, [[20, { type: 'procedure.needle_decompression', side: 'R', site: 'aal5', needleMm: 80 }], [30, { type: 'procedure.chest_tube', side: 'R', fr: 28 }]], 300);
  assert.ok(scoreDemarche(p, 'chest').frac < 0.25);
  assert.ok(scoreSession(p).items.find(i => i.id === 'tension_relief').frac > 0.9);
});

test('démarche scoring is a pure function of the log: a replay gives the same items', () => {
  const p = scen('cico', 2); expertRun(p, 'cico');
  const r = replay({ spec: p.spec, seed: p.seed, scenario: 'cico', log: p.log, until: p.t }, SCENARIOS);
  assert.deepEqual(item(r, 'fona'), item(p, 'fona'));
});

test('guided bronchoscopy skill: doing every step in order fixes the tube and earns the whole démarche', async () => {
  const { PROCEDURES } = await import('../src/web/procedures.js');
  const pr = PROCEDURES.find(x => x.id === 'bronch'), p = scen('tube_desat', 1);
  assert.equal(p.tube.mainstem, 'R', 'the case starts with the tube in the right main bronchus');
  const ex = p.dispatch({ type: 'exam.chest' }).findings;
  assert.ok(ex.includes('breath_sounds_reduced_L') && !ex.includes('chest_normal'), `the left lung is silent: ${ex}`);
  const msgs = [];
  for (const st of pr.steps) {                                                   // what ui.guideDo does: check, run the events, note the step
    p.run(10);
    const ctx = { p, b: p.body, prm: {} };
    assert.equal(st.check?.(ctx) ?? null, null, `${st.id} is done in a good state`);
    for (const ev of st.run ? st.run(ctx) : []) assert.notEqual(p.dispatch(ev)?.ok, false, `${st.id}: ${ev.type}`);
    if (st.msg) msgs.push(st.msg(ctx).en);
    p.dispatch({ type: 'note', text: `guide bronch: ${st.id}` });
  }
  assert.match(msgs[0], /right main bronchus/, 'the scope shows the tube too deep');
  assert.match(msgs[1], /^Carina \d/, 'after the pull the carina is seen below the tip');
  p.run(SCENARIOS.tube_desat.durationS - p.t);
  const tip = p.tube.tipAboveCarina;
  assert.ok(tip >= 2 && tip <= 6, `tip ${tip} cm above the carina`);
  assert.equal(item(p, 'bronch').frac, 1, item(p, 'bronch').detail);
  for (const id of ['tube_reposition', 'tube_depth_final', 'secretions']) assert.equal(scoreSession(p).items.find(i => i.id === id).frac, 1, id);
});

test('bronchoscopy: moving the tube blind, low FiO2 and a long look are penalised; the scenario rewards the fix itself', () => {
  const p = scen('tube_desat', 1);
  runScript(p, [[20, { type: 'airway.tube_adjust', cm: -3 }], [40, { type: 'bronch.insert' }], [400, { type: 'bronch.remove' }]], 500);
  const r = scoreDemarche(p, 'bronch'), byId = Object.fromEntries(r.steps.map(s => [s.id, s.frac]));
  assert.equal(byId.fio2, 0); assert.equal(byId.look_first, 0); assert.equal(byId.short, 0); assert.equal(byId.capno, 1);
  assert.ok(scoreSession(p).items.find(i => i.id === 'tube_reposition').frac === 1, 'the tube is back in the trachea all the same');
});
