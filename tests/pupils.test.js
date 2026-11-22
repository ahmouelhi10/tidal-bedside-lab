// The pupils (src/web/pupils.js), driven by the real engine: size and light reaction in each situation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { pupilTargets, pupilFinding, PupilAnim } from '../src/web/pupils.js';

test('a healthy awake adult: mid-size (3-5 mm), reacting to light', () => {
  const g = pupilTargets(mk().run(10)); assert.ok(g.mm > 3 && g.mm < 5 && g.react, JSON.stringify(g));
  assert.equal(pupilFinding(g.mm, g.react).size, 'norm');
});

test('opioid: pinpoint; naloxone brings them back', () => {
  const p = mk(); p.dispatch({ type: 'drug.bolus', drug: 'fentanyl', amount: 400 }); p.run(240);
  const pin = pupilTargets(p).mm; assert.ok(pin < 2.2, `after fentanyl ${pin}`);
  p.dispatch({ type: 'drug.bolus', drug: 'naloxone', amount: 400 }); p.run(180);
  assert.ok(pupilTargets(p).mm > pin + 1, `after naloxone ${pupilTargets(p).mm}`);
});

test('cardiac arrest: dilated within about a minute, not reacting', () => {
  const p = mk(); p.dispatch({ type: 'instructor.inject', what: 'vf' }); p.run(5);
  const early = pupilTargets(p).mm; p.run(90); const g = pupilTargets(p);
  assert.ok(g.mm > 6.5 && g.mm > early + 1.5 && !g.react, JSON.stringify({ early, ...g }));
  assert.equal(pupilFinding(g.mm, g.react).size, 'dil');
});

test('older patients have smaller pupils', () => {
  assert.ok(pupilTargets(mk({ age: 85 }).run(5)).mm < pupilTargets(mk({ age: 25 }).run(5)).mm - 0.5);
});

test('light reflex: constricts within half a second, re-dilates more slowly; none when not reacting', () => {
  const p = mk().run(5), a = new PupilAnim(); for (let i = 0; i < 60; i++) a.update(1 / 60, p, 1 / 60);
  const before = a.mm; let v = before; for (let i = 0; i < 30; i++) v = a.update(1 / 60, p, 1 / 60, true);
  assert.ok(v < before * 0.7, `${before} -> ${v} in 0.5 s`);
  let back = v; for (let i = 0; i < 30; i++) back = a.update(1 / 60, p, 1 / 60, false);
  assert.ok(back < before - 0.3, 're-dilation is slower than constriction');
  const q = mk(); q.dispatch({ type: 'instructor.inject', what: 'vf' }); q.run(120);
  const b = new PupilAnim(); for (let i = 0; i < 60; i++) b.update(1 / 60, q, 1 / 60); const d0 = b.mm;
  for (let i = 0; i < 60; i++) b.update(1 / 60, q, 1 / 60, true); assert.ok(Math.abs(b.mm - d0) < 0.05, 'fixed pupils do not react');
});

test('a case loads in its current state, then drug changes act over seconds of patient time', () => {
  const p = mk(); p.dispatch({ type: 'drug.bolus', drug: 'fentanyl', amount: 400 }); p.run(240);
  assert.ok(new PupilAnim().update(1 / 60, p, 0) < 2.4, 'first frame takes the current state');
});
