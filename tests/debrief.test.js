// Structured debrief: moment detection on replayed timelines and self-assessment calibration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk, scen } from './helpers/bots.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { buildTimeline, keyActionTimes } from '../src/engine/timeline.js';
import { findEpisodes, debriefMoments, calibration, MIN_EPISODE_S, MAX_MOMENTS, PEARLS_PHASES } from '../src/engine/debrief.js';

const synth = (spo2) => ({ t: spo2.map((_, i) => i * 5), spo2, hr: spo2.map(() => 80), map: spo2.map(() => 80), arrested: spo2.map(() => 0), events: [] });

test('episodes: only runs below the threshold lasting at least a minute count, with their nadir', () => {
  const tl = synth([97, 97, 88, 85, 84, 86, 87, 88, 89, 88, 87, 86, 85, 88, 89, 95, 96, 89, 88, 97]);
  const ep = findEpisodes(tl, 'spo2', v => v < 90);
  assert.equal(ep.length, 1, 'the 10 s dip at the end is too short');
  assert.equal(ep[0].start, 10); assert.ok(ep[0].dur >= MIN_EPISODE_S); assert.equal(ep[0].extreme, 84);
});

test('a cardiac arrest case: the arrest is a moment, and low SpO2 / MAP during it are not raised separately', () => {
  const id = 'witnessed_vf';                          // collapses into VF about half a minute in
  const p = scen(id, 3);
  p.run(10); p.dispatch({ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true } });
  p.run(40); p.dispatch({ type: 'cpr.start' }); p.run(120);
  const tl = buildTimeline({ spec: p.spec, seed: 3, scenario: id, log: p.log, until: p.t }, SCENARIOS, 5);
  const m = debriefMoments(tl, keyActionTimes(tl.events));
  const arrest = m.find(x => x.kind === 'arrest');
  assert.ok(arrest, 'arrest raised: ' + JSON.stringify(m.map(x => x.kind)));
  assert.equal(arrest.action?.type, 'cpr.start', 'first action after the arrest began is reported');
  assert.ok(!m.some(x => x.kind === 'hypoxaemia' || x.kind === 'hypotension'), 'no duplicate moments inside the arrest');
});

test('a well-run healthy case raises nothing physiological; missing monitoring is raised', () => {
  const p = mk(); p.run(300);
  const tl = buildTimeline({ spec: p.spec, seed: 1, scenario: null, log: p.log, until: p.t }, SCENARIOS, 5);
  const m = debriefMoments(tl, keyActionTimes(tl.events));
  assert.deepEqual(m.map(x => x.kind), ['no_monitoring']);
});

test('haemorrhage without treatment: hypotension is raised with its nadir, at most a few moments', () => {
  const p = mk(); p.dispatch({ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, nibp: true } });
  p.dispatch({ type: 'bleed.set', mlPerMin: 250 }); p.run(900);
  const tl = buildTimeline({ spec: p.spec, seed: 1, scenario: null, log: p.log, until: p.t }, SCENARIOS, 5);
  const m = debriefMoments(tl, keyActionTimes(tl.events));
  const h = m.find(x => x.kind === 'hypotension');
  assert.ok(h && h.value < 65, JSON.stringify(m));
  assert.ok(m.length <= MAX_MOMENTS);
  for (let i = 1; i < m.length; i++) assert.ok(m[i].t >= m[i - 1].t, 'in time order');
});

test('calibration: within 10 points is accurate, otherwise over- or under-estimation', () => {
  assert.deepEqual(calibration(75, 70), { diff: 5, verdict: 'accurate' });
  assert.deepEqual(calibration(90, 55), { diff: 35, verdict: 'over' });
  assert.deepEqual(calibration(40, 72), { diff: -32, verdict: 'under' });
  assert.equal(calibration(NaN, 50), null);
  assert.deepEqual([...PEARLS_PHASES], ['reactions', 'description', 'analysis', 'summary']);
});
