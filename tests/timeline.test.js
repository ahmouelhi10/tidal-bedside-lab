// Debrief timeline: the replayed curves are the recorded session (same final hash), with the learner's actions on them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scen } from './helpers/bots.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { buildTimeline, keyActionTimes } from '../src/engine/timeline.js';

function played() {
  const id = Object.keys(SCENARIOS).find(k => SCENARIOS[k].kind === 'ACLS');
  const p = scen(id, 3);
  p.run(20); p.dispatch({ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, capnography: true } });
  p.run(15); p.dispatch({ type: 'iv.access' });
  p.run(10); p.dispatch({ type: 'note', text: 'guide x: y' });
  p.run(30); p.dispatch({ type: 'drug.bolus', drug: 'epinephrine', amount: 1000 });
  p.run(60);
  return { id, p };
}

test('the timeline replays the session to the same final state', () => {
  const { id, p } = played();
  const tl = buildTimeline({ spec: p.spec, seed: 3, scenario: id, log: p.log, until: p.t }, SCENARIOS);
  assert.equal(tl.hash, p.stateHash(), 'sampling does not disturb the replay');
  assert.ok(Math.abs(tl.end - p.t) < 0.11);
});

test('curves are sampled through the whole case and actions are placed at their times', () => {
  const { id, p } = played();
  const tl = buildTimeline({ spec: p.spec, seed: 3, scenario: id, log: p.log, until: p.t }, SCENARIOS, 5);
  assert.ok(tl.t.length >= Math.floor(p.t / 5), `${tl.t.length} samples over ${p.t.toFixed(0)} s`);
  for (const k of ['hr', 'map', 'spo2', 'etco2', 'rr']) assert.equal(tl[k].length, tl.t.length);
  assert.ok(tl.events.every(e => e.type !== 'note'), 'guided-step notes are not drawn as actions');
  const epi = tl.events.find(e => e.type === 'drug.bolus');
  assert.ok(epi && Math.abs(epi.t - 75) < 0.2, 'epinephrine at 75 s');
  const k = keyActionTimes(tl.events);
  assert.ok(Math.abs(k.monitoring - 20) < 0.2 && Math.abs(k.ivAccess - 35) < 0.2 && Math.abs(k.firstDrug - 75) < 0.2);
  assert.equal(k.firstShock, null);
});
