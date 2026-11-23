// The CPR rescuers (src/web/rescuer-anim.js), driven by the real engine: who compresses, the switch, hands on and off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { RescuerAnim, LIFT_S, WALK_S } from '../src/web/rescuer-anim.js';

const FPS = 0.1;                                         // the engine steps in 0.1 s
/** Run engine and animation together for `secs`; returns the last animation state. */
function run(p, a, secs, each) { let o = null; for (let t = 0; t < secs; t += FPS) { p.run(FPS); o = a.update(FPS, p); each?.(o, t); } return o; }
const arrest = () => { const p = mk(); p.arrest.arrested = true; return p; };

test('nobody before CPR; when it starts the first rescuer steps up to the chest and the second waits', () => {
  const p = arrest(), a = new RescuerAnim();
  assert.equal(run(p, a, 2), null);
  p.dispatch({ type: 'cpr.start', mode: 'auto' });
  const o = run(p, a, LIFT_S + WALK_S + 0.2);
  assert.equal(o.who, 0); assert.deepEqual([o.people[0].to, o.people[0].u, o.people[0].hands], ['C', 1, 1]);
  assert.equal(o.people[1].to, 'R1'); assert.equal(o.people[1].hands, 0);
});

test('a switch: the compressor steps down, the other steps up and has the hands on within two seconds', () => {
  const p = arrest(), a = new RescuerAnim(); p.dispatch({ type: 'cpr.start', mode: 'auto' }); run(p, a, 5);
  p.dispatch({ type: 'cpr.switch' });
  let handsOffFor = 0; const o = run(p, a, 2, (s) => { if (s.people.every(q => q.hands < 0.5)) handsOffFor += FPS; });
  assert.equal(o.who, 1); assert.deepEqual([o.people[1].to, o.people[1].hands], ['C', 1]); assert.equal(o.people[0].to, 'R0');
  assert.ok(handsOffFor > 0.5 && handsOffFor < 1.8, `hands off the chest for ${handsOffFor.toFixed(2)} s`);
});

test('the waiting place alternates, so the two never walk to the same place or through each other', () => {
  const p = arrest(), a = new RescuerAnim(); p.dispatch({ type: 'cpr.start', mode: 'auto' }); run(p, a, 3);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    p.dispatch({ type: 'cpr.switch' }); const o = run(p, a, 3);
    const off = o.people[1 - o.who];
    assert.equal(o.people[o.who].to, 'C'); assert.notEqual(off.to, 'C'); seen.push(off.to);
  }
  assert.deepEqual(seen, ['R0', 'R1', 'R0', 'R1']);
});

test('hands stay on through the pauses for breaths, come off when the defibrillator is charged ("all clear")', () => {
  const p = arrest(), a = new RescuerAnim(); p.dispatch({ type: 'cpr.start', mode: 'auto' });
  let maxLift = 0; run(p, a, 40, (o) => { maxLift = Math.max(maxLift, o.people[o.who].lift); });   // 30:2 with several pauses for breaths
  assert.ok(maxLift < 0.05, `lifted ${maxLift.toFixed(2)} during the breath pauses`);
  p.dispatch({ type: 'defib.pads' }); p.dispatch({ type: 'defib.charge' });
  const o = run(p, a, 8); assert.ok(p.defib.charged); assert.ok(o.people[o.who].lift > 0.95);
});

test('CPR stopped: hands off for the rhythm check, then the rescuers leave', () => {
  const p = arrest(), a = new RescuerAnim(); p.dispatch({ type: 'cpr.start', mode: 'auto' }); run(p, a, 5);
  p.dispatch({ type: 'cpr.stop' });
  const o = run(p, a, 3); assert.ok(o && o.people[o.who].lift > 0.9, 'hands up while checking');
  assert.equal(run(p, a, 3), null, 'gone after a few seconds without CPR');
});

test('a case opened in the middle of CPR starts with the current number of switches (no switch played at load)', () => {
  const p = arrest(); p.dispatch({ type: 'cpr.start', mode: 'auto' }); p.dispatch({ type: 'cpr.switch' }); p.dispatch({ type: 'cpr.switch' }); p.run(5);
  const a = new RescuerAnim(); const o = run(p, a, 2);
  assert.equal(o.who, 0); assert.equal(o.people[0].to, 'C'); assert.equal(o.people[1].from, o.people[1].to);
});
