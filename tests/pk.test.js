import test from 'node:test';
import assert from 'node:assert/strict';
import { PKModel, rk4Reference } from '../src/engine/pk.js';

const P = { V1: 4.27, k10: 0.4, k12: 0.3, k21: 0.1, k13: 0.19, k31: 0.0035, ke0: 0.456 };

test('exact stepping matches an independent RK4 integration (bolus + infusion)', () => {
  const m = new PKModel(P, 1);
  m.bolus(140); m.setInfusion(20);
  for (let i = 0; i < 600; i++) m.step();          // 10 min at 1 s
  const ref = rk4Reference(P, 140, 20, 10);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(m.a[i] - ref[i]) < 1e-3 * Math.max(1, ref[i]), `a${i}`);
  assert.ok(Math.abs(m.ce - ref[3]) < 1e-4);
});

test('step size does not change the exact solution', () => {
  const a = new PKModel(P, 0.1), b = new PKModel(P, 5);
  a.bolus(100); b.bolus(100);
  for (let i = 0; i < 3000; i++) a.step();          // 300 s
  for (let i = 0; i < 60; i++) b.step();            // 300 s
  assert.ok(Math.abs(a.ce - b.ce) < 1e-9);
  assert.ok(Math.abs(a.a[0] - b.a[0]) < 1e-9);
});

test('mass balance: input = body amount + eliminated', () => {
  const m = new PKModel(P, 0.1);
  m.bolus(50); m.setInfusion(10);
  for (let i = 0; i < 6000; i++) m.step();
  const diff = m.cumulativeIn - (m.totalAmount + m.cumulativeOut);
  assert.ok(Math.abs(diff) < 1e-6, `mass imbalance ${diff}`);
});

test('effect site equilibrates with plasma at steady infusion', () => {
  const m = new PKModel({ ...P, k13: 0, k31: 0 }, 1);
  m.setInfusion(10);
  for (let i = 0; i < 60 * 120; i++) m.step();
  assert.ok(Math.abs(m.ce - m.c1) / m.c1 < 1e-3);
});
