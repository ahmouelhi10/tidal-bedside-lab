import test from 'node:test';
import assert from 'node:assert/strict';
import { PROCEDURES, Guide, SKILL_CASE as CASE } from '../src/web/procedures.js';
import { mk, scen } from './helpers/bots.js';

test('every guided skill has unique step ids and a label and teaching text in both languages', () => {
  for (const pr of PROCEDURES) {
    assert.ok(pr.en && pr.fr, pr.id);
    assert.equal(new Set(pr.steps.map(s => s.id)).size, pr.steps.length, `${pr.id}: duplicate step id`);
    for (const s of pr.steps) {
      assert.ok(s.en && s.fr, `${pr.id}.${s.id} label`);
      if (s.why) assert.ok(s.why.en && s.why.fr, `${pr.id}.${s.id} why`);
      if (s.wait) assert.ok(pr.steps.some(x => x.id === s.wait.after), `${pr.id}.${s.id} waits for a step that exists`);
    }
  }
});

test('every 3D step gesture is one the renderer can draw, at a site it knows', () => {
  const kinds = new Set(['touch', 'swab', 'scalpel', 'mask', 'pads', 'probe', 'steth', 'needle', 'syringe', 'tourniquet', 'scope']);   // gestures.js startStep
  const sites = new Set(['face', 'chest', 'neck', 'arm', 'groin', 'abdomen', 'chestSite']);                                              // scene.siteOf
  for (const pr of PROCEDURES) for (const s of pr.steps) if (s.g) {
    assert.ok(kinds.has(s.g), `${pr.id}.${s.id}: gesture ${s.g}`);
    assert.ok(sites.has(s.at), `${pr.id}.${s.id}: site ${s.at}`);
  }
});

test('every guided skill can be played to the end: no event is refused and every wait clears', () => {
  for (const pr of PROCEDURES) {
    assert.ok(pr.id in CASE, `${pr.id} has a case`);
    const p = CASE[pr.id] ? scen(CASE[pr.id], 1) : mk({}, { seed: 1 }), g = new Guide(pr, p);
    for (const s of pr.steps) {
      p.run(5);
      const ctx = () => ({ p, b: p.body, prm: g.prm });
      while ((g.remaining(p) > 0 || s.ready?.(ctx())) && p.t < 1800) p.run(10);   // what a learner does with the clock: wait for it
      assert.equal(g.remaining(p), 0, `${pr.id}.${s.id}: still waiting`);
      assert.equal(s.ready?.(ctx()) ?? null, null, `${pr.id}.${s.id}: never ready`);
      for (const ev of s.run ? s.run(ctx()) : []) { const r = p.dispatch(ev); assert.notEqual(r?.ok, false, `${pr.id}.${s.id}: ${ev.type} refused (${r?.error})`); }
      if (s.msg) assert.ok(s.msg(ctx()).en, `${pr.id}.${s.id} message`);
      p.dispatch({ type: 'note', text: `guide ${pr.id}: ${s.id}` });
      g.done[s.id] = p.t; g.i++;
    }
    assert.ok(g.finished, pr.id);
  }
});

test('the new skills leave the patient as the procedure should', () => {
  const play = (id) => { const pr = PROCEDURES.find(x => x.id === id), p = mk({}, { seed: 1 }); for (const s of pr.steps) { p.run(5); while (s.ready?.({ p, b: p.body }) && p.t < 1800) p.run(10); for (const ev of s.run ? s.run({ p, b: p.body, prm: {} }) : []) p.dispatch(ev); } p.run(60); return p; };
  assert.equal(play('lma').airway.device, 'sga');
  assert.equal(play('bmv').airway.device, 'opa');
  assert.ok(play('aline').flags.aline, 'arterial line in place');
  assert.ok(play('cvc').flags.cvc, 'central line in place');
  assert.ok(play('ng').flags.ngTube && play('uc').flags.urineCath);
  assert.notEqual(play('spinal').neuraxial.sensory, 'none', 'the spinal block is up');
});

test('skills training: each procedure starts without the equipment it puts on (the learner places it); the removal replays', async () => {
  const { equipmentOf, hasEquipment, PARAMS } = await import('../src/web/procedures.js');
  const { replay } = await import('../src/engine/patient.js');
  const { SCENARIOS } = await import('../src/engine/scenarios.js');
  for (const pr of PROCEDURES) {
    const id = CASE[pr.id], p = id ? scen(id, 3) : mk(), prm = Object.fromEntries((pr.params || []).map(k => [k, PARAMS[k]?.opts?.[0]?.[0]]));
    const off = equipmentOf(pr, { p, b: p.body, prm }).filter(k => hasEquipment(p, k));
    if (off.length) assert.equal(p.dispatch({ type: 'equipment.remove', items: off }).ok, true, pr.id);
    for (const k of equipmentOf(pr, { p, b: p.body, prm })) assert.equal(hasEquipment(p, k), false, `${pr.id}: ${k} already on the patient`);
    p.run(30);
    const q = replay({ spec: p.spec, seed: p.seed, scenario: id || null, log: p.log.map(e => ({ ...e })), until: p.t }, SCENARIOS);
    assert.equal(q.stateHash(), p.stateHash(), pr.id + ' replays');
  }
  const p = mk(); assert.equal(p.dispatch({ type: 'equipment.remove', items: ['heart'] }).ok, false, 'unknown equipment refused');
  assert.equal(p.dispatch({ type: 'equipment.remove', items: 'ivAccess' }).ok, false, 'a list is required');
});
