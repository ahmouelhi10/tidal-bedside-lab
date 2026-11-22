// What chest compressions look like (src/web/cpr-anim.js): the push and recoil, leaning, the mattress, and the body following.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CprAnim, compressionShape } from '../src/web/cpr-anim.js';

test('a compression goes down in under half the cycle and fully recoils', () => {
  const T = 0.55; let peakAt = 0, best = 0;
  for (let a = 0; a <= T; a += 0.005) { const s = compressionShape(a, T); if (s > best) { best = s; peakAt = a; } }
  assert.ok(best > 0.99 && peakAt <= 0.5 * T + 0.01);
  assert.ok(compressionShape(0.9 * T, T) < 0.02, 'back up before the next push');
});

test('leaning (no full recoil) leaves the chest partly pressed', () => {
  assert.ok(compressionShape(0.9 * 0.55, 0.55, false) >= 0.18);
});

const pt = (surface = 'hard', recoil = true) => {
  const p = { t: 0, cpr: { surface, events: [] } };
  return { p, run(secs, rate = 110) { const f = new CprAnim(); let maxS = 0, maxSink = 0, maxHead = 0, maxArms = 0, next = 0; const out = [];
    for (let i = 0; i < secs * 120; i++) { p.t += 1 / 120; if (p.t >= next) { p.cpr.events.push({ t: p.t, depth: 5.5, recoil }); next += 60 / rate; }
      const o = f.update(1 / 120, p); maxS = Math.max(maxS, o.sternum); maxSink = Math.max(maxSink, o.sink); maxHead = Math.max(maxHead, Math.abs(o.head)); maxArms = Math.max(maxArms, Math.abs(o.arms)); out.push({ ...o }); }
    return { maxS, maxSink, maxHead, maxArms, out, f }; } };
};

test('the sternum reaches the delivered depth; the body sinks more on a soft mattress', () => {
  const hard = pt('hard').run(5), soft = pt('soft').run(5);
  assert.ok(Math.abs(hard.maxS - 0.055) < 0.002, String(hard.maxS));
  assert.ok(soft.maxSink > 3 * hard.maxSink && hard.maxSink > 0);
});

test('head rocks a few degrees, arms jiggle, and everything settles when compressions stop', () => {
  const r = pt().run(5);
  const deg = r.maxHead * 180 / Math.PI; assert.ok(deg > 1.5 && deg < 8, `${deg.toFixed(1)} deg`);
  assert.ok(r.maxArms > 0.005 && r.maxArms < 0.04);
  // stop: the last compression ages out and the springs come to rest
  const f = r.f, p = { t: 1000, cpr: { surface: 'hard', events: [{ t: 0, depth: 5.5, recoil: true }] } }; let o;
  for (let i = 0; i < 600; i++) o = f.update(1 / 120, p);
  assert.ok(!o.active && o.sternum === 0 && Math.abs(o.head) < 1e-3 && Math.abs(o.arms) < 1e-3);
});

test('a long frame cannot make the springs explode', () => {
  const p = { t: 1, cpr: { surface: 'hard', events: [{ t: 0.9, depth: 6, recoil: true }] } }, f = new CprAnim();
  const o = f.update(2.5, p); assert.ok(Number.isFinite(o.head) && Math.abs(o.head) < 1);
});

test('rhythm-change entries in the event list are not compressions', () => {
  const p = { t: 1, cpr: { surface: 'hard', events: [{ t: 0.9, depth: 5.5, recoil: true }, { t: 0.95, type: 'rhythm' }] } };
  assert.ok(new CprAnim().update(1 / 60, p).sternum > 0);
});
