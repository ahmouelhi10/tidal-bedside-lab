// Visible blood (src/web/blood.js), driven by the real engine: where it comes from, how it spreads, drips, stops and dries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk, scen } from './helpers/bots.js';
import { bloodState, SHEET_ML, MATTRESS_ML } from '../src/web/blood.js';

test('no haemorrhage: no blood shown', () => {
  const b = bloodState(mk().run(60)); assert.equal(b.source, null); assert.ok(b.r.stain === 0 && b.r.mat === 0 && b.r.floor === 0 && b.drips === 0);
});

test('trauma: a thigh wound soaks the sheet first, then pools on the mattress, then reaches the floor and drips', () => {
  const p = scen('hemorrhage'); p.run(60); const a = bloodState(p);
  assert.equal(a.source, 'thigh'); assert.ok(a.ml > 60 && a.ml < 200 && a.r.stain > 0.08 && a.r.mat === 0 && a.drips === 0, JSON.stringify(a));
  p.run(300); const b = bloodState(p);
  assert.ok(b.ml > SHEET_ML + MATTRESS_ML && b.r.mat > 0.15 && b.r.floor > 0 && b.drips > 0.5, JSON.stringify(b));
  assert.ok(b.r.stain > a.r.stain && b.r.stain <= 0.26);
});

test('the shown volume is what the engine says was lost since the case opened', () => {
  const p = scen('hemorrhage'); p.run(120); const lost = p.vol.totalLost * 1000;
  assert.ok(Math.abs(bloodState(p).ml - lost) < 1); assert.ok(Math.abs(bloodState(p, p.vol.totalLost).ml) < 1e-6, 'blood lost before the case opened is not shown');
});

test('controlled: nothing grows or drips, and it darkens over ten minutes', () => {
  const p = scen('hemorrhage'); p.run(240); p.dispatch({ type: 'bleed.control' }); p.run(5); const a = bloodState(p);
  assert.ok(!a.active && a.drips === 0 && a.dry < 0.05);
  p.run(300); const b = bloodState(p); assert.ok(Math.abs(b.ml - a.ml) < 1 && b.dry > 0.45 && b.dry < 0.55, JSON.stringify({ a: a.ml, b: b.ml, dry: b.dry }));
  p.run(400); assert.equal(bloodState(p).dry, 1);
});

test('variceal bleeding comes out of the mouth', () => {
  const p = scen('variceal_bleed'); p.run(120); const b = bloodState(p);
  assert.equal(b.source, 'mouth'); assert.ok(b.ml > 20 && b.r.stain <= 0.12, JSON.stringify(b));
});

test('a failing clotting makes puncture sites ooze; normal clotting does not', () => {
  assert.equal(bloodState(mk().run(10)).ooze, 0);
  assert.ok(bloodState({ vol: { totalLost: 0, rates: { bleed: 0 }, coagFn: 0.3 }, t: 0 }).ooze > 0.5);
});
