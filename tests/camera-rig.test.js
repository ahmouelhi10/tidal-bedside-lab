// Camera motion (src/web/camera-rig.js): moves end exactly on their framing, carry on smoothly when interrupted, and the
// hand-held life is small, stronger in close-ups and off on request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CamMove, hermite5, moveDuration, handheld, handheldAmp } from '../src/web/camera-rig.js';

const A = { yaw: -0.5, pitch: 0.4, dist: 3.1, target: [0.05, 0.9, 0] }, B = { yaw: 0.35, pitch: 0.52, dist: 1.45, target: [0.82, 0.95, 0] };
const still = { yaw: 0, pitch: 0, dist: 0, target: [0, 0, 0] };

test('a move from rest is minimum-jerk: no overshoot, ends exactly on the framing, at rest', () => {
  const m = new CamMove(A, still, B, 1.5); let prev = A.yaw;
  for (let t = 0; t <= 1.5; t += 0.01) { const o = m.at(t); assert.ok(o.yaw >= prev - 1e-12 && o.yaw <= B.yaw + 1e-12); prev = o.yaw; }
  const end = m.at(1.5); assert.ok(end.done && Math.abs(end.yaw - B.yaw) < 1e-12 && Math.abs(end.target[0] - B.target[0]) < 1e-12 && end.lift < 1e-9);
  const v = (m.at(1.5).dist - m.at(1.49).dist) / 0.01; assert.ok(Math.abs(v) < 0.005, 'arrives at rest');
  assert.ok(Math.abs(m.at(0.01).yaw - A.yaw) < 1e-4, 'starts gently');
});

test('a move that interrupts another carries on with the same velocity (no jolt)', () => {
  const m1 = new CamMove(A, still, B, 1.5), t = 0.6, h = 1e-3;
  const vel = { yaw: (m1.at(t).yaw - m1.at(t - h).yaw) / h, pitch: (m1.at(t).pitch - m1.at(t - h).pitch) / h, dist: (m1.at(t).dist - m1.at(t - h).dist) / h, target: [0, 1, 2].map(i => (m1.at(t).target[i] - m1.at(t - h).target[i]) / h) };
  const m2 = new CamMove(m1.at(t), vel, A, 1.5);                                        // turn back mid-way
  const v2 = (m2.at(h).yaw - m2.at(0).yaw) / h;
  assert.ok(Math.abs(v2 - vel.yaw) < 0.02 * Math.abs(vel.yaw), `${v2} vs ${vel.yaw}`);
  assert.ok(Math.abs(m2.at(1.5).yaw - A.yaw) < 1e-12);
});

test('a hitch cannot fling the camera: carried velocity is capped', () => {
  const m = new CamMove(A, { yaw: 500, pitch: NaN, dist: -90, target: [80, 0, 0] }, B, 1.2);
  for (let t = 0; t <= 1.2; t += 0.05) { const o = m.at(t); assert.ok(Math.abs(o.yaw - A.yaw) < 1.5 && Number.isFinite(o.pitch) && o.dist > 0.5); }
});

test('bigger moves take longer, within 0.9-2.2 s', () => {
  const small = moveDuration(A, { ...A, yaw: A.yaw + 0.05 }).dur, big = moveDuration(A, B).dur;
  assert.ok(small >= 0.9 && big > small && big <= 2.2);
  assert.equal(hermite5(2, 0, 5, 1, 1), 5);
});

test('hand-held: a few milliradians, stronger in close-up than in the overview, nothing when turned off', () => {
  let maxClose = 0, maxFar = 0, maxT = 0;
  for (let t = 0; t < 60; t += 0.05) {
    const c = handheld(t, handheldAmp(0.6)), f = handheld(t, handheldAmp(3.1));
    maxClose = Math.max(maxClose, Math.abs(c.yaw)); maxFar = Math.max(maxFar, Math.abs(f.yaw)); maxT = Math.max(maxT, ...c.target.map(Math.abs));
  }
  assert.ok(maxClose > 0.004 && maxClose < 0.012, String(maxClose)); assert.ok(maxFar < 0.4 * maxClose); assert.ok(maxT < 0.002);
  const z = handheld(12.3, 0); assert.ok(z.yaw === 0 && z.pitch === 0 && z.dist === 0 && z.target.every(v => v === 0));
});

test('hand-held motion is smooth (no visible jitter frame to frame at 60 fps)', () => {
  let worst = 0;
  for (let t = 0; t < 30; t += 1 / 60) worst = Math.max(worst, Math.abs(handheld(t + 1 / 60, 1).yaw - handheld(t, 1).yaw));
  assert.ok(worst < 0.0003, String(worst));                                              // < 0.02 degree per frame
});
