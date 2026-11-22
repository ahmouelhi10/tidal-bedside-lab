// What the skin shows (src/web/skin.js), driven by the real engine: each sign appears in its situation and not in a healthy patient.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk, scen } from './helpers/bots.js';
import { skinTargets, SkinAnim } from '../src/web/skin.js';

test('a healthy patient: no sweat, mottling, cyanosis, hives or distended neck veins', () => {
  const s = skinTargets(mk().run(10));
  for (const k of ['sweat', 'mottle', 'cyanC', 'cyanP', 'hives', 'jvd']) assert.ok(s[k] < 0.1, `${k} ${s[k]}`);
});

test('tension pneumothorax: distended neck veins', () => {
  const p = scen('tension_ptx'); p.run(240);
  assert.ok(skinTargets(p).jvd > 0.3, `jvd ${skinTargets(p).jvd} rap ${p.circ.rap}`);
});

test('haemorrhage: a conscious patient sweats, then mottles as it worsens; neck veins flat', () => {
  const p = mk(); p.dispatch({ type: 'bleed.set', mlPerMin: 300 }); p.run(420);
  const s = skinTargets(p); assert.ok(s.sweat > 0.4 && s.mottle > 0.2 && s.jvd === 0, JSON.stringify({ ...s, map: p.circ.mapArt, lost: p.vol.fractionLost }));
});

test('hypoglycaemia: sweating', () => {
  const p = mk(); p.dispatch({ type: 'instructor.inject', what: 'hypoglycaemia' }); p.run(300);
  assert.ok(skinTargets(p).sweat > 0.4, `glucose ${p.lytes.glucose}`);
});

test('anaphylaxis: urticaria and flush', () => {
  const p = mk(); p.dispatch({ type: 'instructor.inject', what: 'anaphylaxis' }); p.run(180);
  const s = skinTargets(p); assert.ok(s.hives > 0.4 && s.flush > 0.2, JSON.stringify(s));
});

test('hypoxaemia: the lips go blue before the hands and feet', () => {
  const p = mk(); p.dispatch({ type: 'instructor.inject', what: 'airway_obstruction' }); p.run(150);
  const s = skinTargets(p); assert.ok(s.cyanC > 0.3 && s.cyanC >= s.cyanP, JSON.stringify({ ...s, sao2: p.resp.sao2 }));
});

test('cardiac arrest: mottled, blue hands and feet, flat neck veins', () => {
  const p = mk(); p.dispatch({ type: 'instructor.inject', what: 'vf' }); p.run(30);
  const s = skinTargets(p); assert.ok(s.mottle > 0.5 && s.cyanP > 0.5 && s.jvd === 0);
});

test('sweat and mottling build up over a minute; a case loads in its current state', () => {
  const a = new SkinAnim(), p = { circ: { mapArt: 85, co: 5, rap: 6 }, resp: { sao2: 0.98 }, arrest: { arrested: false }, vol: { fractionLost: 0 }, lytes: { glucose: 5 }, crises: {}, therm: { tc: 37 } };
  assert.ok(a.update(0.016, p, 0).sweat < 0.05);
  p.lytes.glucose = 1.8; let v = a.update(0.016, p, 5); assert.ok(v.sweat > 0.05 && v.sweat < 0.3, String(v.sweat));
  for (let i = 0; i < 30; i++) v = a.update(0.016, p, 10); assert.ok(v.sweat > 0.9);
  assert.ok(new SkinAnim().update(0.016, p, 0).sweat > 0.9, 'first frame takes the current state');
});
