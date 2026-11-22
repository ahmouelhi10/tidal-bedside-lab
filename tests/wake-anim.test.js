// The patient moving as anaesthesia lightens (src/web/wake-anim.js): the joint maths, when movement happens, and when it must not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { WakeAnim, wakeDrive, movePoint } from '../src/web/wake-anim.js';

// body frame like the patient mesh: +x cranial, +y anterior, +z the patient's left; neck at x -0.26, chest half-width 0.2
const U0 = { axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], ref: [-0.5, -0.3, 0], cprRef: [-0.26, 0.07, 0.2, -1.75],
  arm: [-0.34, 0.08, 0.27, 0.3], armD: [-0.99, -0.03, 0.12, 0], leg: [-0.85, -1.28, 0.09, 0.06] };
const U = (move, move2 = [0, 0, 0, 0]) => ({ ...U0, move, move2 });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('no movement: every point stays where it is', () => {
  const q = [-0.6, 0.1, 0.3]; assert.deepEqual(movePoint(q, U([0, 0, 0, 0])), q);
});

test('reaching: the left hand comes up from beside the thigh to the face; the chest (not part of the arm) does not move', () => {
  const hand = [-1.0, 0.05, 0.36], face = [-0.15, 0.24, 0.02], q = movePoint(hand, U([0, 1.2, 2.15, 1.0]), [1, 0, 0]);
  assert.ok(dist(q, face) < 0.2 && dist(hand, face) > 0.8, `hand ends ${dist(q, face).toFixed(2)} m from the face`);
  const chest = [-0.45, 0.22, 0.05]; assert.ok(dist(movePoint(chest, U([0, 1.2, 2.15, 1.0])), chest) < 1e-9);
  const elbow = [-0.64, 0.07, 0.31], up = movePoint(elbow, U([0, 0, 2.0, 0]), [1, 0, 0]); assert.ok(dist(up, elbow) < 0.03, 'bending the elbow leaves the upper arm');
});

test('knee drawn up: the knee rises, the foot stays on the bed, the other leg stays', () => {
  const knee = [-1.28, 0.06, 0.1], foot = [-1.7, 0.03, 0.1], other = [-1.28, 0.06, -0.1], m = U([0, 0, 0, 0], [0.6, 0, 0, 0]);
  const L = [0, 1, 0], Rl = [0, 0, 1];
  assert.ok(movePoint(knee, m, L)[1] - knee[1] > 0.2, `knee +${(movePoint(knee, m, L)[1] - knee[1]).toFixed(2)} m`);
  assert.ok(Math.abs(movePoint(foot, m, L)[1] - foot[1]) < 0.06, 'foot near the bed');
  assert.ok(dist(movePoint(other, m, Rl), other) < 1e-9);
});

test('head turn: the face swings to the side, the shoulders stay', () => {
  const nose = [-0.15, 0.27, 0], m = U([0.45, 0, 0, 0, 0]);
  assert.ok(Math.abs(movePoint(nose, m)[2]) > 0.06); assert.ok(dist(movePoint([-0.4, 0.15, 0.18], m), [-0.4, 0.15, 0.18]) < 1e-9);
});

const pt = (eff = {}, o = {}) => ({ arrest: { arrested: false }, airway: { device: 'none' }, resp: { sao2: 0.97 }, drugs: { effects: () => ({ hyp: 0, nmb: 0, ...eff }) }, ...o });
const run = (p, secs, ctx = () => ({})) => { const a = new WakeAnim(), out = []; for (let t = 0; t < secs; t += 1 / 30) { const o = a.update(1 / 30, p, ctx(t)); out.push([...o.move, ...o.move2.slice(0, 2)]); } return out; };
const peak = (out, i) => Math.max(...out.map(v => Math.abs(v[i])));

test('emergence with a tube in: reaches for the face and turns the head within a minute', () => {
  const out = run(pt({ hyp: 0.22 }, { airway: { device: 'ett' } }), 60);
  assert.ok(peak(out, 1) > 0.6 && peak(out, 2) > 1.2, 'reach'); assert.ok(peak(out, 0) > 0.2 || peak(out, 4) > 0.2 || peak(out, 5) > 0.2, 'turns or shifts');
});

test('still: deep anaesthesia, full neuromuscular block, cardiac arrest', () => {
  for (const p of [pt({ hyp: 0.9, loc: true }, { airway: { device: 'ett' } }), pt({ hyp: 0.22, nmb: 0.97, paralyzed: true }, { airway: { device: 'ett' } }), pt({}, { arrest: { arrested: true } })]) {
    const out = run(p, 60); assert.ok(out.every(v => v.every(x => Math.abs(x) < 1e-6)));
  }
});

test('awake: only occasional, smaller movements', () => {
  const out = run(pt(), 90); let moving = 0; for (const v of out) if (v.some(x => Math.abs(x) > 0.05)) moving++;
  assert.ok(moving > 0 && moving / out.length < 0.5, `${(100 * moving / out.length).toFixed(0)} % of the time`); assert.ok(peak(out, 2) < 1.4);
});

test('pain in a light patient: a quick withdrawal; none with good analgesia; a busy part keeps still', () => {
  const pain = (eff, busy) => run(pt(eff), 3, (t) => ({ painful: t > 0.5 && t < 2.5, busy: new Set(busy) }));
  const w = pain({ hyp: 0.1 }, []); assert.ok(Math.max(peak(w, 0), peak(w, 2)) > 0.3);
  const a = pain({ hyp: 0.1, analgesia: 0.95 }, []); assert.ok(a.every(v => v.every(x => Math.abs(x) < 0.05)));
  const b = pain({ hyp: 0.1 }, ['head', 'armL', 'legL', 'legR']); assert.ok(b.every(v => v.every(x => Math.abs(x) < 1e-6)));
});

test('real engine: rocuronium stops all movement', () => {
  const p = mk(); p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 50 }); p.run(180);
  assert.equal(wakeDrive(p).motor < 0.1, true, `motor ${wakeDrive(p).motor}`);
  assert.ok(wakeDrive(mk().run(5)).motor > 0.99);
});
