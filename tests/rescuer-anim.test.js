// The CPR rescuers (src/web/rescuer-anim.js), driven by the real engine: who compresses, the switch, hands on and off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { readFileSync } from 'node:fs';
import { RescuerAnim, LIFT_S, WALK_S, posture, rescuerFlex, flexPoint } from '../src/web/rescuer-anim.js';

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

const PEOPLE = JSON.parse(readFileSync(new URL('../src/web/assets/rescuer.json', import.meta.url), 'utf8')).people;
const midS = (m, F) => { const a = flexPoint(m.shoulderL, F), b = flexPoint(m.shoulderR, F); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; };
const Zof = (m) => (m.shoulderL[2] + m.shoulderR[2]) / 2 - m.hip[2];
const pushQ = { role: 'push', hands: 1, lift: 0, fatigue: 0, effort: 0, base: [0, 0] };

test('pushing from the hips with locked elbows: the elbows go down as far as the hands, the legs do not move', () => {
  for (const m of Object.values(PEOPLE)) {
    const el = (F) => { const a = flexPoint(m.elbowL, F, [1, 0]), b = flexPoint(m.elbowR, F, [1, 0]); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; };
    const Z = (m.elbowL[2] + m.elbowR[2]) / 2 - m.hip[2];
    const e0 = el(rescuerFlex(m, posture(pushQ, 0, Z, 0))), F = rescuerFlex(m, posture(pushQ, 0.055, Z, 0)), e1 = el(F);
    assert.ok(Math.abs((e0[1] - e1[1]) - 0.055) < 0.006, `elbows down ${((e0[1] - e1[1]) * 100).toFixed(1)} cm for a 5.5 cm push`);
    const knee = [0.1, 0.5, 0.05], k1 = flexPoint(knee, F, [0, 0]); assert.ok(Math.hypot(k1[0] - knee[0], k1[1] - knee[1], k1[2] - knee[2]) < 1e-9);
  }
});

test('the posture: hands lifted, they lean back; through the breaths they ease up and look up; waiting, they stand upright', () => {
  const m = PEOPLE.m, Z = Zof(m);
  assert.ok(posture({ ...pushQ, lift: 1, base: [-0.12, -0.1] }, -0.1, Z, 0).trunk < -0.1);
  const a = new RescuerAnim(), p = mk(); p.arrest.arrested = true; p.dispatch({ type: 'cpr.start', mode: 'auto' });
  let pauseHead = null, pushHead = null;
  for (let t = 0; t < 40; t += 0.1) { p.run(0.1); const o = a.update(0.1, p); const q = o.people[o.who]; if (q.role !== 'push') continue;
    if (o.breaths && t > 18) pauseHead = Math.min(pauseHead ?? 9, q.base[1]); else if (!o.breaths && t > 5) pushHead = Math.max(pushHead ?? -9, q.base[1]); }
  assert.ok(pauseHead < -0.1 && pushHead > -0.05, `head ${pauseHead?.toFixed(2)} in the breath pause, ${pushHead?.toFixed(2)} while pushing`);
  const o = a.update(0.1, p), w = o.people[1 - o.who]; assert.equal(w.role, 'wait');
  const up = midS(m, rescuerFlex(m, posture(w, 0, Z, 3))), lean = midS(m, rescuerFlex(m, posture(pushQ, 0, Z, 3)));
  assert.ok(up[1] > lean[1] + 0.08 && posture(w, 0, Z, 3).trunk < -0.35, 'the one waiting stands up straighter');
});

test('effort: builds over the two minutes of pushing (head drops, sways, breathes harder), wears off while waiting', () => {
  const a = new RescuerAnim(), p = mk(); p.arrest.arrested = true; p.dispatch({ type: 'cpr.start', mode: 'auto' });
  let o = null; for (let t = 0; t < 30; t += 0.1) { p.run(0.1); o = a.update(0.1, p); }
  const early = o.people[o.who].fatigue; for (let t = 0; t < 150; t += 0.1) { p.run(0.1); o = a.update(0.1, p); }
  const q = o.people[o.who]; assert.ok(early === 0 && q.fatigue > 0.6, `fatigue ${early} at 30 s, ${q.fatigue.toFixed(2)} at 3 min`);
  assert.ok(q.base[1] > 0.06, 'the head drops');
  const sw = Math.max(...Array.from({ length: 50 }, (_, i) => Math.abs(posture(q, 0.05, 0.28, i * 0.1).sway)));
  assert.ok(sw > 0.01, `sways ${sw.toFixed(3)} rad`);
  p.dispatch({ type: 'cpr.switch' }); for (let t = 0; t < 120; t += 0.1) { p.run(0.1); o = a.update(0.1, p); }
  assert.ok(o.people[1 - o.who].effort < 0.15, `rested after two minutes: ${o.people[1 - o.who].effort.toFixed(2)}`);
});

test('the shader bends the rescuer the same way (same hinge weights)', () => {
  const src = readFileSync(new URL('../src/web/gl/renderer.js', import.meta.url), 'utf8');
  assert.ok(src.includes('smoothstep(-0.02, 0.05, dot(p0.yz - uFlex2.xy, uFlex2.zw))') && src.includes('smoothstep(uFlex.x - 0.05, uFlex.x + 0.12, p0.y)'));
});

import { bagger } from '../src/web/rescuer-anim.js';
test('the third rescuer bags only while the engine ventilates by bag during CPR, two squeezes in each 30:2 pause', () => {
  const P = (o = {}) => ({ t: 100, vent: { mode: 'ctrl', rate: 10 }, airway: { device: 'none' }, cpr: { mode: 'auto', auto: { ratio: '30:2', pauseUntil: 104.5 } }, ...o });
  assert.equal(bagger(P(), false), null, 'no CPR');
  assert.equal(bagger(P({ vent: { mode: 'none' } }), true), null, 'ventilation not started: nobody bags');
  assert.equal(bagger(P({ airway: { device: 'ett', intubated: true } }), true), null, 'a tube goes on the ventilator');
  const at = (t) => bagger(P({ t }), true);
  assert.equal(at(100.2).squeeze, 0, 'the pause has just begun');
  assert.ok(at(101.2).squeeze > 0.95, 'first breath'); assert.ok(at(102.2).squeeze < 0.05, 'released');
  assert.ok(at(103.2).squeeze > 0.95, 'second breath'); assert.ok(at(106).squeeze < 0.05, 'compressions again');
  assert.ok((at(101.2).cycles % 1) > 0 && (at(101.2).cycles % 1) < 0.33, 'the chest is rising during the squeeze');
  const sga = bagger(P({ airway: { device: 'sga' } }), true); assert.equal(sga.mask, false);
  const s = []; for (let t = 0; t < 60; t += 0.1) s.push(bagger(P({ t, airway: { device: 'sga' }, cpr: { mode: 'auto', auto: { ratio: 'continuous' } } }), true).squeeze > 0.9 ? 1 : 0);
  assert.equal(s.filter((v, i) => v && !s[i - 1]).length, 10, 'continuous compressions: 10 breaths a minute');
});

test('at a switch the arms are never swapped with the hands on the chest: the one leaving lifts them off first, the one arriving puts them on', () => {
  const p = arrest(), a = new RescuerAnim(); p.dispatch({ type: 'cpr.start', mode: 'auto' }); run(p, a, 5);
  p.dispatch({ type: 'cpr.switch' }); const seen = [];
  run(p, a, 3, (o) => o.people.forEach((q, i) => { if (q.hands > 0) seen.push([i, q.role, q.hands, q.u]); }));
  assert.ok(seen.every(([, role]) => role === 'push'), 'hands on or near the chest: always in the arms-on pose');
  const leaving = seen.filter(([i]) => i === 0); assert.ok(leaving.length >= 3, 'the lift is seen over several frames');
  assert.ok(leaving.every(([, , , u]) => u === 0), 'still at the chest while lifting');
  assert.ok(leaving.some(([, , h]) => h > 0.2 && h < 0.8), 'hands part way off');
});
