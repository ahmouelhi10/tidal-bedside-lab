// The bags on the IV pole and their drip (src/web/drip.js), driven by the real engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { DripAnim, dropAt, TRANSFUSE_S, STREAM, HOOKS, BLOOD_ML } from '../src/web/drip.js';

test('nothing running: one full spare bag, unconnected, no drops', () => {
  const o = new DripAnim().update(mk().run(5));
  assert.equal(o.bags.length, 1); assert.equal(o.bags[0].set, 'spare'); assert.equal(o.bags[0].leftMl, 1000);
  assert.ok(!o.fluid && !o.blood && o.bags[0].dropsPerS === 0);
});

test('a fluid bolus empties exactly as the engine runs it in, then the empty bag stays on the hook', () => {
  const p = mk(), a = new DripAnim(); p.dispatch({ type: 'fluid.bolus', volumeL: 0.5, minutes: 30, fluid: 'saline' }); p.run(1);
  let b = a.update(p).bags[0];
  assert.equal(b.kind, 'saline'); assert.equal(b.totalMl, 500); assert.ok(Math.abs(b.mlPerMin - 500 / 30) < 1e-6);
  assert.ok(Math.abs(b.dropsPerS - 500 / 30 / 60 * 20) < 1e-6, 'standard set: 20 drops per mL');
  p.run(15 * 60); b = a.update(p).bags[0];
  assert.ok(Math.abs(b.leftMl - p.vol.infusions[0].remaining * 1000) < 1e-6 && b.leftMl > 230 && b.leftMl < 260, `half way: ${b.leftMl.toFixed(0)} mL left`);
  p.run(16 * 60); const o = a.update(p); b = o.bags[0];
  assert.equal(p.vol.infusions.length, 0); assert.ok(b.leftMl === 0 && !b.running && b.set === 'fluid' && !o.fluid, 'given: the empty bag still hangs');
});

test('a case opened in the middle of a bolus shows the bag as far down as it is', () => {
  const p = mk(); p.dispatch({ type: 'fluid.bolus', volumeL: 1, minutes: 60 }); p.run(45 * 60);
  const b = new DripAnim().update(p).bags[0]; assert.equal(b.totalMl, 1000); assert.ok(b.leftMl > 230 && b.leftMl < 270, `${b.leftMl}`);
});

test('a blood unit hangs its bag and runs through in the display time; plasma is yellow, red cells dark red', () => {
  const p = mk(), a = new DripAnim(); p.dispatch({ type: 'blood.transfuse', kind: 'prbc' }); p.dispatch({ type: 'blood.transfuse', kind: 'ffp' }); p.run(1);
  let o = a.update(p); const rc = o.bags.find(b => b.kind === 'prbc'), pl = o.bags.find(b => b.kind === 'ffp');
  assert.ok(o.blood && rc.totalMl === BLOOD_ML.prbc && rc.dropsPerS > STREAM, 'a fast transfusion runs as a stream (blood set: 15 drops per mL)');
  assert.ok(rc.color[0] > 3 * rc.color[1] && pl.color[1] > 0.6, 'red cells red, plasma yellow');
  p.run(TRANSFUSE_S); o = a.update(p); assert.ok(o.bags.every(b => b.leftMl === 0) && !o.blood);
});

test('a rejected transfusion (unknown product) hangs nothing', () => {
  const p = mk(), a = new DripAnim(); p.dispatch({ type: 'blood.transfuse', kind: 'gold' }); p.run(1);
  assert.equal(a.update(p).bags[0].set, 'spare');
});

test('at most three hooks: running bags first, then the most recently hung', () => {
  const p = mk(), a = new DripAnim();
  for (let i = 0; i < 3; i++) { p.dispatch({ type: 'fluid.bolus', volumeL: 0.25, minutes: 1 }); p.run(1); a.update(p); p.run(120); a.update(p); }   // the scene looks every frame
  p.dispatch({ type: 'fluid.bolus', volumeL: 1, minutes: 60 }); p.run(1);
  const o = a.update(p); assert.equal(o.bags.length, HOOKS); assert.ok(o.bags[0].running && o.bags[0].totalMl === 1000); assert.ok(o.bags.slice(1).every(b => !b.running));
});

test('drops: grow at the nozzle then fall, about as often as the rate says; a stream when fast', () => {
  assert.equal(dropAt(0, 3), null); assert.deepEqual(dropAt(STREAM + 1, 3), { stream: true });
  let falls = 0, prev = 0; for (let t = 0; t < 10; t += 0.005) { const d = dropAt(1.5, t); if (d.y > 0 && prev === 0) falls++; prev = d.y; }
  assert.ok(falls >= 14 && falls <= 16, `${falls} drops in 10 s at 1.5 a second`);
});
