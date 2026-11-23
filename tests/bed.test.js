// The head of the bed raised (src/web/bed.js): how the back section moves, what it carries, and what stays put.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mk } from './helpers/bots.js';
import { BedAnim, bendPoint, bendWeight, HEAD_UP_RAD, BEND_ZONE } from '../src/web/bed.js';

const U = [0.11, 0.86, HEAD_UP_RAD, 0];                    // hinge at the hips, pivot at the mattress top, 30°
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const deg = (r) => r * 180 / Math.PI;

test('the back section turns the trunk and head rigidly by 30° about the hinge; the legs stay on the flat part', () => {
  const face = [0.76, 1.13, 0], q = bendPoint(face, U), r0 = [face[0] - U[0], face[1] - U[1]], r1 = [q[0] - U[0], q[1] - U[1]];
  assert.ok(Math.abs(Math.hypot(...r0) - Math.hypot(...r1)) < 1e-9, 'same distance from the hinge');
  assert.ok(Math.abs(deg(Math.atan2(r1[1], r1[0]) - Math.atan2(r0[1], r0[0])) - 30) < 1e-6);
  assert.ok(q[1] - face[1] > 0.25, `the face rises ${(q[1] - face[1]).toFixed(2)} m`);
  const knee = [-0.4, 0.95, 0.1]; assert.deepEqual(bendPoint(knee, U), knee);
  assert.deepEqual(bendPoint(face, [U[0], U[1], 0, 0]), face, 'flat: nothing moves');
});

test('across the hips the turn is spread out: no tear between neighbouring points', () => {
  let worst = 0;
  for (let x = U[0] - 0.3; x < U[0] + 0.3; x += 0.002) { const a = [x, 1.0, 0.1], b = [x + 0.002, 1.0, 0.1]; worst = Math.max(worst, dist(bendPoint(a, U), bendPoint(b, U))); }
  assert.ok(worst < 0.006, `largest gap between points 2 mm apart: ${(worst * 1000).toFixed(1)} mm`);
  assert.ok(bendWeight([U[0] - BEND_ZONE, 1, 0], U) === 0 && bendWeight([U[0] + BEND_ZONE, 1, 0], U) === 1);
});

test('equipment off the bed stays put: the IV pole, the ventilator, a drain bottle on the floor', () => {
  for (const w of [[0.3, 1.25, -0.8], [1.25, 1.08, 0.83], [0.3, 0.16, 0.62]]) assert.ok(dist(bendPoint(w, U), w) < 1e-9, String(w));
  const hand = [0.4, 1.02, -0.66]; assert.ok(bendPoint(hand, U)[1] > hand[1] + 0.1, 'the right hand on the arm board still goes up with the trunk');
});

test('the bed motor: a case loads in its position; the back rises to 30° in under ten seconds and goes back down', () => {
  const b = new BedAnim(); assert.equal(b.update(0.016, { headUp: true }), HEAD_UP_RAD, 'first frame: already up');
  const c = new BedAnim(); c.update(0.016, { headUp: false });
  let t = 0; while (c.update(0.1, { headUp: true }) < HEAD_UP_RAD && t < 30) t += 0.1;
  assert.ok(t > 5 && t < 10, `${t.toFixed(1)} s to rise`);
  for (let i = 0; i < 40; i++) c.update(0.1, { headUp: false }); assert.ok(c.a < HEAD_UP_RAD * 0.6 && c.a > 0, 'part of the way down after 4 s');
  for (let i = 0; i < 100; i++) c.update(0.1, { headUp: false }); assert.equal(c.a, 0);
});

test('real engine: the "head-up" action raises the bed, "flat" lowers it', () => {
  const p = mk(), b = new BedAnim(); b.update(0, p); assert.equal(b.a, 0);
  p.dispatch({ type: 'position.set', headUp: true }); p.run(1); for (let i = 0; i < 200; i++) b.update(0.1, p); assert.equal(b.a, HEAD_UP_RAD);
  p.dispatch({ type: 'position.set', headUp: false }); p.run(1); for (let i = 0; i < 200; i++) b.update(0.1, p); assert.equal(b.a, 0);
});

test('the vertex shader uses the same hinge zone and the same limits as bendPoint', () => {
  const src = readFileSync(new URL('../src/web/gl/renderer.js', import.meta.url), 'utf8'), line = src.split('\n').find(l => l.includes('float k = smoothstep(uBend.x'));
  assert.ok(line, 'bendW weight line');
  for (const s of [`uBend.x - ${BEND_ZONE}`, `uBend.x + ${BEND_ZONE}`, 'smoothstep(0.62, 0.70, w.y)', 'smoothstep(0.70, 0.80, abs(w.z))']) assert.ok(line.includes(s), s);
});
