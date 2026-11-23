// Syringe pumps on the IV pole (src/web/syringe.js), driven by the real engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './helpers/bots.js';
import { syringePumps, pumpScreen, CONC, SYRINGE_ML, NEAR_END_ML, PUMPS, LABEL_RGB } from '../src/web/syringe.js';

test('no drug infusion: no pump', () => { assert.deepEqual(syringePumps(mk().run(5)), []); });

test('propofol at 8 mg/min: 48 mL/h from a 1 % syringe, and the plunger has pushed in what went in', () => {
  const p = mk(); p.dispatch({ type: 'drug.infusion', drug: 'propofol', rate: 8 }); p.run(25 * 60);
  const [q] = syringePumps(p);
  assert.equal(q.drug, 'propofol'); assert.ok(q.running && q.milky && q.label === 'yellow');
  assert.ok(Math.abs(q.rateMlH - 48) < 1e-9); assert.ok(Math.abs(q.ml - (SYRINGE_ML - 8 * 25 / CONC.propofol)) < 0.1, `${q.ml.toFixed(2)} mL left`);
});

test('rate changes are integrated piece by piece; a stopped pump keeps its syringe and goes dark', () => {
  const p = mk(); p.dispatch({ type: 'drug.infusion', drug: 'norepinephrine', rate: 8 }); p.run(600);
  p.dispatch({ type: 'drug.infusion', drug: 'norepinephrine', rate: 16 }); p.run(600);
  let [q] = syringePumps(p); const used = (8 * 10 + 16 * 10) / CONC.norepinephrine;
  assert.ok(Math.abs(q.ml - (SYRINGE_ML - used)) < 0.05, `${q.ml} vs ${SYRINGE_ML - used}`); assert.equal(q.label, 'violet');
  p.dispatch({ type: 'drug.stop', drug: 'norepinephrine' }); p.run(600); [q] = syringePumps(p);
  assert.ok(!q.running && q.rateMlH === 0 && Math.abs(q.ml - (SYRINGE_ML - used)) < 0.05, 'stopped: nothing more goes in');
});

test('nearly empty: the pump warns; once empty a full syringe replaces it', () => {
  const p = mk(); p.dispatch({ type: 'drug.infusion', drug: 'propofol', rate: 10 }); p.run(48.5 * 60);   // 48.5 of 50 mL
  let [q] = syringePumps(p); assert.ok(q.nearEnd && q.ml < NEAR_END_ML, `${q.ml.toFixed(2)} mL`);
  p.run(5 * 60); [q] = syringePumps(p); assert.ok(!q.nearEnd && q.ml > 40, `new syringe: ${q.ml.toFixed(1)} mL`);
});

test('insulin runs from its own pump; a drug the engine will not infuse, or an invalid rate, makes no pump', () => {
  const p = mk(); p.dispatch({ type: 'drug.infusion', drug: 'insulin', rate: 0.1 }); p.dispatch({ type: 'drug.infusion', drug: 'adenosine', rate: 1 });
  p.dispatch({ type: 'drug.infusion', drug: 'remifentanil', rate: 'fast' }); p.run(60);
  const qs = syringePumps(p); assert.deepEqual(qs.map(q => q.drug), ['insulin']); assert.ok(Math.abs(qs[0].rateMlH - 6) < 1e-9, '0.1 U/min = 6 mL/h of 1 U/mL');
});

test('at most four pumps, running ones first; label colours follow the ISO 26825 classes', () => {
  const p = mk();
  for (const [d, r] of [['midazolam', 0.05], ['rocuronium', 0.5], ['remifentanil', 8], ['norepinephrine', 6], ['nitroglycerin', 20]]) { p.dispatch({ type: 'drug.infusion', drug: d, rate: r }); p.run(30); }
  p.dispatch({ type: 'drug.stop', drug: 'nitroglycerin' }); p.run(10);
  const qs = syringePumps(p); assert.equal(qs.length, PUMPS); assert.ok(qs.every(q => q.running));
  const lab = Object.fromEntries(qs.map(q => [q.drug, q.label]));
  assert.deepEqual(lab, { norepinephrine: 'violet', remifentanil: 'blue', rocuronium: 'red', midazolam: 'orange' });
  for (const q of qs) assert.deepEqual(q.rgb, LABEL_RGB[q.label]);
});

test('the pump screen: drug, rate in mL/h to 0.1, volume left; a warning near the end; stopped', () => {
  const p = mk(); p.dispatch({ type: 'drug.infusion', drug: 'norepinephrine', rate: 8 }); p.run(600);
  let [q] = syringePumps(p), s = pumpScreen(q, 'Noradrénaline');
  assert.equal(s.tone, 'run'); assert.deepEqual(s.lines, ['NORADRÉNALINE', '6.0 mL/h', `${(SYRINGE_ML - 80 / CONC.norepinephrine).toFixed(1)} mL left`]);
  assert.equal(pumpScreen({ ...q, rateMlH: 150 }, 'x').lines[1], '150 mL/h', 'whole mL/h from 100 up');
  assert.deepEqual(pumpScreen({ ...q, nearEnd: true }, 'x', { left: 'mL restants', end: 'FIN PROCHE', stop: 'ARRÊT' }), { tone: 'end', lines: ['X', '6.0 mL/h', 'FIN PROCHE'] });
  p.dispatch({ type: 'drug.stop', drug: 'norepinephrine' }); p.run(1); [q] = syringePumps(p); s = pumpScreen(q, 'Norepinephrine');
  assert.equal(s.tone, 'stop'); assert.equal(s.lines[2], 'STOPPED');
});
