// The hands doing the procedures (src/web/gestures.js): which hand is drawn, and what its fingers do (opts.act / opts.relax,
// blended from the hands.glb morph targets) over the course of each gesture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gestures } from '../src/web/gestures.js';

const W = { neck: [0.7, 1.0, 0], rightArmIV: [0.2, 0.92, -0.3], sternum: [0.45, 1.0, 0], airway: [0.86, 1.0, 0], face: [0.85, 1.02, 0] };
const scene = () => ({ t: 0, world: W, siteFrame: () => null, armAxis: () => [-1, 0, 0], surfaceAt: (p) => ({ p, n: [0, 1, 0] }), normalAt: () => [0, 1, 0] });

/** Run one gesture and record every instrument / hand draw: [{ u, name, opts }]. */
function record(start) {
  const g = new Gestures(), sc = scene(), gest = start(g, sc), calls = [];
  const c = { scene: { ...sc, hands: { hand_pressL: true } }, inst: (name, p, n, a, opts = {}) => calls.push({ u: c.u, name, opts }), seg() {}, disc() {}, blob() {} };
  const dur = g.list[0].dur;
  for (let i = 0; i <= 200; i++) { c.u = i / 200; g.draw(c, c.u * dur); }
  return { calls, gest };
}
const at = (calls, name, u0, u1, f) => calls.filter(x => x.name === name && x.u >= u0 && x.u <= u1 && (!f || f(x)));
const max = (xs, k) => Math.max(0, ...xs.map(x => x.opts[k] || 0));

test('syringe: the port is scrubbed, the syringe connected, the thumb pushes the plunger home over the drug time, then a flush', () => {
  const { calls, gest } = record((g, sc) => { const r = g.start(sc, { type: 'drug.bolus', drug: 'fentanyl', amount: 100 }); return g.list[0]; });
  const P = gest.phs, U = (s) => s / gest.dur, withHand = (x) => !x.opts.noHand;
  assert.ok(at(calls, 'forcepsGauze', 0, U(P.swab[1]) - 0.005).length > 0, 'the port is cleaned first');
  assert.equal(at(calls, 'syringe', 0, U(P.swab[1]) - 0.005).length, 0, 'no syringe while cleaning');
  assert.ok(at(calls, 'syringe', 0, 1, x => x.opts.only).every(x => x.opts.noHand), 'the plunger moves without a hand of its own');
  assert.ok(max(at(calls, 'syringe', U(P.connect[0]), U(P.push[0]), withHand), 'act') < 0.05, 'thumb at rest until the push');
  const mid = at(calls, 'syringe', U((P.push[0] + P.push[1]) / 2) - 0.01, U((P.push[0] + P.push[1]) / 2) + 0.01, withHand);
  assert.ok(max(mid, 'act') > 0.3 && max(mid, 'act') < 0.7, 'half way through the push: half pushed (an even rate)');
  assert.ok(max(at(calls, 'syringe', U(P.push[1]) - 0.01, U(P.push[1]), withHand), 'act') > 0.95, 'plunger home at the end of the push');
  assert.ok(P.push[1] - P.push[0] >= 30 - 1e-6 && P.flush[1] > P.flush[0], 'fentanyl over 30 s, then a flush');
});

test('IV cannula: the index slides the catheter off the needle after the flashback, not before', () => {
  const { calls } = record((g, sc) => g.start(sc, { type: 'iv.access' }));
  assert.ok(max(at(calls, 'ivCannula', 0, 0.45), 'act') === 0);
  assert.ok(max(at(calls, 'ivCannula', 0.6, 0.62), 'act') > 0.95);
});

test('the other hand comes in loosely curled, lands flat, then stretches the skin', () => {
  const { calls } = record((g, sc) => g.start(sc, { type: 'iv.access' }));
  const h = (u) => at(calls, 'pressL', u - 0.003, u + 0.003)[0].opts;
  assert.ok(h(0).relax > 0.95 && h(0).act === 0);
  assert.ok(h(0.5).relax < 0.01 && h(0.5).act > 0.95);
  assert.ok(h(1).relax > 0.95, 'curls again as it leaves');
});

test('palpation: fingertips press three times; the hand is relaxed in the air', () => {
  const { calls } = record((g, sc) => g.start(sc, { type: 'exam.neck' })), p = at(calls, 'press', 0, 1);
  assert.ok(p[0].opts.relax > 0.95 && p.at(-1).opts.relax > 0.95);
  let presses = 0; for (let i = 1; i < p.length; i++) if (p[i].opts.act > 0.9 && p[i - 1].opts.act <= 0.9) presses++;
  assert.equal(presses, 3);
});

test('intubation: left hand on the laryngoscope firms up for the lift; the right hand appears only to pass the tube', () => {
  const { calls } = record((g, sc) => g.start(sc, { type: 'airway.intubate' })), tube = at(calls, 'ett', 0, 1);
  assert.ok(tube.length && Math.min(...tube.map(x => x.u)) > 0.38 && Math.max(...tube.map(x => x.u)) < 0.82);
  assert.ok(max(at(calls, 'laryngoscope', 0.45, 0.7), 'act') > 0.95 && max(at(calls, 'laryngoscope', 0, 0.3), 'act') === 0);
});

test('every finger weight stays within 0..1', () => {
  const evs = [{ type: 'drug.bolus' }, { type: 'iv.access' }, { type: 'procedure.needle_decompression', side: 'R' }, { type: 'procedure.chest_tube', side: 'R' },
    { type: 'procedure.cricothyroidotomy' }, { type: 'exam.pocus' }, { type: 'exam.chest' }, { type: 'exam.neck' }, { type: 'airway.intubate' }];
  for (const ev of evs) for (const x of record((g, sc) => g.start(sc, ev)).calls) for (const k of ['act', 'relax']) {
    const v = x.opts[k]; if (v != null) assert.ok(v >= 0 && v <= 1, `${ev.type} ${x.name} ${k} ${v}`);
  }
  for (const k of ['mask', 'scalpel']) for (const x of record((g, sc) => g.startStep(sc, k, W.face)).calls) for (const kk of ['act', 'relax']) {
    const v = x.opts[kk]; if (v != null) assert.ok(v >= 0 && v <= 1, `${k} ${kk} ${v}`);
  }
});
