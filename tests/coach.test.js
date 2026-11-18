// Learner levels: the beginner coach's live checklist, the senior's next hint, and the help recorded in the log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scen } from './helpers/bots.js';
import { expertRun } from './helpers/experts.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { replay } from '../src/engine/patient.js';
import { checklist, nextItem, helpUsed } from '../src/web/coach-eval.js';

test('every case has a checklist that evaluates at the start, mid-case and after an expert run, with a next step at the start', () => {
  for (const id of Object.keys(SCENARIOS)) {
    const p = scen(id, 2), start = checklist(p, SCENARIOS[id]);
    assert.ok(start.length >= 4, `${id}: ${start.length} items`);
    for (const i of start) assert.ok(['done', 'part', 'todo', 'later'].includes(i.state) && i.text && typeof i.detail === 'string', `${id}.${i.id}`);
    assert.ok(nextItem(start), `${id}: nothing to do at the start`);
    p.run(120); checklist(p, SCENARIOS[id]);
  }
});

test('the checklist ticks as the learner acts, and the next step moves on', () => {
  const p = scen('hyperkalaemia', 1), sc = SCENARIOS.hyperkalaemia, st = (id) => checklist(p, sc).find(i => i.id === id).state;
  assert.equal(st('hk_calcium'), 'todo'); const first = nextItem(checklist(p, sc)).id;
  p.dispatch({ type: 'iv.access' }); p.dispatch({ type: 'order', what: 'ecg12' }); p.dispatch({ type: 'drug.bolus', drug: 'calciumGluconate', amount: 6.6 }); p.run(60);
  assert.equal(st('hk_calcium'), 'done');
  assert.notEqual(nextItem(checklist(p, sc))?.id, first, 'the next step changed');
  const e = scen('svt', 1); expertRun(e, 'svt');
  const done = checklist(e, SCENARIOS.svt).filter(i => i.state === 'done').length; assert.ok(done >= 5, `expert ticks ${done} of 6`);
});

test('the level and the senior hints are recorded as notes, and they do not change the physiology or the replay', () => {
  const a = scen('anaphylaxis', 3), b = scen('anaphylaxis', 3);
  a.dispatch({ type: 'note', text: 'level: intermediate' }); a.run(90); a.dispatch({ type: 'note', text: 'senior hint: ana_adrenaline' }); a.run(90);
  b.run(180);
  assert.equal(a.circ.mapArt, b.circ.mapArt); assert.equal(a.resp.spo2, b.resp.spo2);
  assert.deepEqual(helpUsed(a.log), { level: 'intermediate', hints: 1 });
  assert.deepEqual(helpUsed(b.log), { level: null, hints: 0 });
  const q = replay({ spec: SCENARIOS.anaphylaxis.spec, seed: 3, scenario: 'anaphylaxis', log: a.log.map(e => ({ ...e })), until: a.t }, SCENARIOS);
  assert.equal(q.stateHash(), a.stateHash());
});

test('items already met before the learner acts are shown as "to watch", not as done', async () => {
  const { keepAtStart } = await import('../src/web/coach-eval.js');
  const p = scen('spinal_hypotension', 1), sc = SCENARIOS.spinal_hypotension, keep = keepAtStart(p, sc);
  const st = (id) => checklist(p, sc, keep).find(i => i.id === id).state;
  assert.ok(keep.has('sp_vaso') && st('sp_vaso') === 'keep', 'vasopressor item is not ticked before the pressure falls');
  p.run(900);
  assert.equal(st('sp_vaso'), 'todo', 'once the MAP has fallen without a vasopressor it becomes a task');
  assert.ok(!['keep', 'done'].includes(nextItem(checklist(p, sc, keep))?.state));
});
