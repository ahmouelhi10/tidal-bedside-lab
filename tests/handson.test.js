import test from 'node:test';
import assert from 'node:assert/strict';
import { evalPlace, evalStroke, evalPush, evalRotate, evalHold, nearestSite, describe } from '../src/web/handson-eval.js';
import { PROCEDURES } from '../src/web/procedures.js';

test('place: inside the radius is ok, quality falls off with distance', () => {
  const t = [0, 0, 0];
  assert.equal(evalPlace([0.01, 0, 0], t, 0.03).ok, true);
  const far = evalPlace([0.06, 0, 0], t, 0.03);
  assert.equal(far.ok, false); assert.equal(far.distCm, 6);
  assert.ok(evalPlace([0.01, 0, 0], t, 0.03).quality > far.quality);
});

test('stroke: position, length and direction all count', () => {
  const t = [0, 0, 0], body = [1, 0, 0];
  const good = evalStroke([-0.015, 0, 0], [0.015, 0, 0], t, 0.03, { minCm: 2.5, maxCm: 5, dir: body });
  assert.equal(good.ok, true); assert.equal(good.lengthCm, 3); assert.equal(good.angleDeg, 0);
  assert.equal(evalStroke([-0.005, 0, 0], [0.005, 0, 0], t, 0.03, { minCm: 2.5, maxCm: 5 }).ok, false, 'too short');
  const across = evalStroke([0, 0, -0.015], [0, 0, 0.015], t, 0.03, { minCm: 2.5, maxCm: 5, dir: body });
  assert.equal(across.ok, false); assert.equal(across.angleDeg, 90);
});

test('push, rotate and hold', () => {
  assert.equal(evalPush(4, { minCm: 3, maxCm: 8 }).ok, true);
  assert.equal(evalPush(1, { minCm: 3, maxCm: 8 }).tooShallow, true);
  assert.equal(evalPush(11, { minCm: 3, maxCm: 8 }).tooDeep, true);
  assert.equal(evalRotate(85).ok, true); assert.equal(evalRotate(20).ok, false);
  assert.equal(evalHold(2.5, 2).ok, true); assert.equal(evalHold(0.5, 2).ok, false);
});

test('the drop point chooses the nearest site; the description lists only what applies', () => {
  const sites = { R_mal5: [0, 0, -0.15], L_mal5: [0, 0, 0.15] };
  assert.equal(nearestSite([0, 0, 0.12], sites).key, 'L_mal5');
  assert.equal(describe({ distCm: 1.2, depthCm: 4 }), 'dist 1.2 cm, depth 4 cm');
});

test('every hands-on step names a known instrument, a gesture and sensible limits', () => {
  const tools = new Set(['syringe', 'needle14G', 'scalpel', 'bougie', 'chestDrain', 'forcepsGauze', 'tourniquet', 'ivCannula', 'defibPadRight']);
  let n = 0;
  for (const pr of PROCEDURES) for (const st of pr.steps) {
    if (!st.hand) continue; n++;
    const h = st.hand;
    assert.ok(tools.has(h.tool), `${pr.id}.${st.id} tool`);
    assert.ok(['place', 'hold', 'stroke', 'push', 'rotate'].includes(h.gesture), `${pr.id}.${st.id} gesture`);
    assert.ok(h.radiusCm > 0 && h.radiusCm <= 10, `${pr.id}.${st.id} radius`);
    if (h.gesture === 'push' || h.gesture === 'stroke') assert.ok(h.minCm < h.maxCm, `${pr.id}.${st.id} limits`);
  }
  assert.ok(n >= 12, `${n} hands-on steps`);
});

test('a failed gesture says what to correct: distance, depth, length, direction, turn, hold time', async () => {
  const { faults } = await import('../src/web/handson-eval.js');
  const k = (r, h) => faults(r, h).map(f => f.k);
  assert.deepEqual(faults(evalPlace([0, 0, 0], [0, 0, 0], 0.04), { radiusCm: 4 }), [], 'a good gesture has no fault');
  assert.deepEqual(faults(evalPlace([0.07, 0, 0], [0, 0, 0], 0.04), { radiusCm: 4 }), [{ k: 'far', v: 7, lim: 4 }]);
  const push = (cm) => ({ ...evalPlace([0, 0, 0], [0, 0, 0], 0.04), ...evalPush(cm, { minCm: 1, maxCm: 3.5 }), ok: false });
  assert.deepEqual(k(push(0.4), { radiusCm: 4, minCm: 1, maxCm: 3.5, gesture: 'push' }), ['shallow']);
  assert.deepEqual(k(push(5), { radiusCm: 4, minCm: 1, maxCm: 3.5, gesture: 'push' }), ['deep']);
  assert.deepEqual(k(evalStroke([0, 0, 0], [0.01, 0, 0], [0.005, 0, 0], 0.03, { minCm: 2, maxCm: 5 }), { radiusCm: 3, minCm: 2, maxCm: 5, gesture: 'stroke' }), ['short']);
  assert.deepEqual(k(evalStroke([0, 0, 0], [0, 0, 0.03], [0, 0, 0.015], 0.03, { dir: [1, 0, 0] }), { radiusCm: 3, minCm: 2, maxCm: 5, gesture: 'stroke' }), ['angle']);
  assert.deepEqual(k({ ...evalRotate(20), ok: false }, { gesture: 'rotate' }), ['turn']);
  assert.deepEqual(k({ ...evalPlace([0, 0, 0], [0, 0, 0], 0.04), ...evalHold(0.8, 2), ok: false }, { radiusCm: 4, holdS: 2, gesture: 'hold' }), ['brief']);
  assert.deepEqual(k({ ok: false }, {}), ['other'], 'never an empty explanation');
});
