// The patient's face (src/web/face.js): blinks, eyelids, jaw, grimace and gaze follow the clinical state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FaceAnim, faceTargets } from '../src/web/face.js';

const pt = (eff = {}, o = {}) => ({ drugs: { effects: () => ({ hyp: 0, loc: false, paralyzed: false, analgesia: 0, ...eff }) }, arrest: { arrested: false }, resp: { sao2: 0.97, rr: 14 }, airway: { device: 'none' }, ...o });
const run = (p, secs, ctx = {}) => { const f = new FaceAnim(), s = []; for (let t = 0; t < secs; t += 1 / 60) s.push([...f.update(1 / 60, p, ctx)]); return s; };
const blinks = (s) => s.filter((w, i) => w[0] > 0.9 && i > 0 && s[i - 1][0] <= 0.9).length;

test('awake: eyes open, a blink every few seconds, and the eyes move', () => {
  const s = run(pt(), 30);
  const n = blinks(s); assert.ok(n >= 5 && n <= 15, `${n} blinks in 30 s`);
  const open = s.filter(w => w[0] < 0.1).length / s.length; assert.ok(open > 0.95, 'open most of the time');
  const gaze = new Set(s.map(w => w[3].toFixed(1))); assert.ok(gaze.size > 4, 'gaze moves');
});

test('a blink is quick (under 0.3 s closed-to-open)', () => {
  const s = run(pt(), 20); const i = s.findIndex(w => w[0] > 0.9); assert.ok(i > 0);
  let j = i; while (j < s.length && s[j][0] > 0.2) j++; assert.ok((j - i) / 60 < 0.3);
});

test('anaesthetised: eyes closed, no blinks, jaw slack, gaze still', () => {
  const s = run(pt({ hyp: 0.7, loc: true }), 20);
  assert.equal(blinks(s), 0); assert.ok(s.at(-1)[0] > 0.9 && s.at(-1)[1] > 0.3 && Math.abs(s.at(-1)[3]) < 0.05);
});

test('cardiac arrest: eyes half open and fixed, mouth open', () => {
  const s = run(pt({}, { arrest: { arrested: true } }), 10), w = s.at(-1);
  assert.ok(w[0] > 0.4 && w[0] < 0.7 && w[1] > 0.5); assert.equal(blinks(s), 0);
});

test('pain: grimace during a painful procedure when awake; not under analgesia, sleep or paralysis', () => {
  const pain = (eff) => run(pt(eff), 2, { painful: true }).at(-1)[2];
  assert.ok(pain({}) > 0.8);
  assert.ok(pain({ analgesia: 0.9 }) < 0.2);
  assert.ok(pain({ hyp: 0.7, loc: true }) < 0.05);
  assert.ok(pain({ paralyzed: true }) === 0);
});

test('breathless: mouth open and a strained face', () => {
  const t = faceTargets(pt({}, { resp: { sao2: 0.8, rr: 34 } }));
  assert.ok(t.jaw > 0.4 && t.pain > 0.2, JSON.stringify(t));
});

test('a tube in the mouth holds the jaw open', () => {
  assert.ok(faceTargets(pt({ hyp: 0.7, loc: true }, { airway: { device: 'ett' } })).jaw >= 0.4);
});
