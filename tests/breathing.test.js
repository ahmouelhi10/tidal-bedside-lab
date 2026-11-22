// Visible breathing pattern (src/web/breathing.js): the shape and the clinical signs the 3D chest must show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breathPose, breathWave } from '../src/web/breathing.js';

const base = (o = {}) => ({ resp: { rr: 14, vt: 500 }, airway: { device: 'none', patency: 1 }, vent: { mode: 'spont' }, chest: {}, tube: {}, crises: { br: 0 }, neuraxial: { active: false, seg: 31 }, o2: null, ...o });
const peak = (p, n = 2) => { let L = 0, R = 0, A = 0, Lmin = 0; for (let i = 0; i < 200; i++) { const s = breathPose(p, n + i / 200); L = Math.max(L, s.L); R = Math.max(R, s.R); A = Math.max(A, s.A); Lmin = Math.min(Lmin, s.L); } return { L, R, A, Lmin }; };

test('inspiration is shorter than expiration, which ends in a pause', () => {
  let tPeak = 0, best = -1; for (let i = 0; i < 100; i++) { const v = breathWave(i / 100, 0.4, 4.2, false); if (v > best) { best = v; tPeak = i / 100; } }
  assert.ok(tPeak <= 0.42 && best > 0.99);
  assert.ok(breathWave(0.95, 0.4, 4.2, false) < 0.05, 'near rest before the next breath');
});

test('spontaneous supine breathing: the abdomen leads and moves more than the chest', () => {
  const p = base(), k = peak(p);
  assert.ok(k.A > k.L && k.L > 0.005, JSON.stringify(k));
  const early = breathPose(p, 2.1); assert.ok(early.A / k.A > early.L / k.L, 'abdomen ahead of the chest early in inspiration');
  assert.ok(Math.abs(k.L - k.R) < 1e-9, 'symmetrical');
});

test('positive-pressure ventilation: chest-dominant', () => {
  const k = peak(base({ airway: { device: 'ett', patency: 1 }, vent: { mode: 'ctrl' } }));
  assert.ok(k.L > k.A, JSON.stringify(k));
});

test('endobronchial (right mainstem) tube: the left chest barely moves', () => {
  const k = peak(base({ airway: { device: 'ett', patency: 1 }, vent: { mode: 'ctrl' }, tube: { mainstem: 'R' } }));
  assert.ok(k.L < 0.2 * k.R, JSON.stringify(k));
});

test('pneumothorax: the affected side moves less; under tension it stays hyperexpanded', () => {
  const k = peak(base({ chest: { side: 'L', air: 0.8, tension: 0 } }));
  assert.ok(k.L < 0.4 * k.R, JSON.stringify(k));
  const still = breathPose(base({ resp: { rr: 0, vt: 0 }, chest: { side: 'R', air: 0.9, tension: 0.8 } }), 0);
  assert.ok(still.R > 0 && still.L === 0);
});

test('obstructed airway with effort: see-saw (chest drawn in while the abdomen rises)', () => {
  const k = peak(base({ airway: { device: 'none', patency: 0.1 } }));
  assert.ok(k.Lmin < -0.002 && k.A > 0.005, JSON.stringify(k));
});

test('high spinal block: abdominal breathing only', () => {
  const k = peak(base({ neuraxial: { active: true, seg: 9 } }));
  assert.ok(k.L < 0.002 && k.A > 0.01, JSON.stringify(k));
});

test('bronchospasm: slow, incomplete expiration', () => {
  const late = (br) => breathPose(base({ crises: { br } }), 2.75).A;
  assert.ok(late(0.9) > 2 * late(0));
});

test('apnoea: no movement', () => {
  assert.deepEqual(breathPose(base({ resp: { rr: 0, vt: 0 } }), 1.3), { L: 0, R: 0, A: 0 });
});
