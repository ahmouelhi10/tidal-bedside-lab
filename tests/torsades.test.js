// Torsades de pointes on a long QT, magnesium, isoprenaline: clinical target bands (REF drew2010, erc2025), replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mk, scen } from './helpers/bots.js';
import { replay } from '../src/engine/patient.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { ecg12 } from '../src/engine/clinical.js';

/** long-QT substrate: QT-prolonging drug, hypokalaemia, sinus bradycardia */
function longQt(seed, { mg = false, iso = false } = {}) {
  const p = mk({ sex: 'F', age: 66, heightCm: 162, weightKg: 60, rhythm: 'SINUS_BRADY' }, { seed });
  p.crises.qtDrug = 120; p.lytes.kBase = 2.9; p.dispatch({ type: 'iv.access' });
  if (mg) p.dispatch({ type: 'drug.bolus', drug: 'magnesium', amount: 2 });
  if (iso) p.dispatch({ type: 'drug.infusion', drug: 'isoprenaline', rate: 5 });
  return p;
}
const runsIn = (p, s) => { for (let k = 0; k < s && !(p.tdpCount > 0); k++) p.run(1); return p.tdpCount || 0; };

test('long QT (> 500 ms) with hypokalaemia and bradycardia gives torsades; a normal QT does not', () => {
  const q = longQt(1); q.run(1);
  const e = ecg12(q); assert.ok(e.qtc > 520 && e.findings.includes('long_qt'), `QTc ${e.qtc}`);
  let hit = 0; for (let s = 1; s <= 6; s++) if (runsIn(longQt(s), 600) > 0) hit++;
  assert.ok(hit >= 5, `${hit}/6 seeds had torsades within 10 min`);
  const n = mk({}, { seed: 2 }); n.run(1800); assert.equal(n.tdpCount || 0, 0, 'no torsades with a normal QT');
  assert.ok(ecg12(n).qtc < 450, `normal QTc ${ecg12(n).qtc}`);
});

test('magnesium 2 g and a faster rate (isoprenaline) delay and prevent the runs', () => {
  const first = (o) => { let sum = 0; for (let s = 1; s <= 8; s++) { const p = longQt(s, o); let k = 0; while (k < 900 && !(p.tdpCount > 0)) { p.run(1); k++; } sum += k; } return sum / 8; };
  const none = first({}), mg = first({ mg: true }), both = first({ mg: true, iso: true });
  assert.ok(none < 180, `untreated: first run after ${none.toFixed(0)} s on average`);
  assert.ok(mg > 2.5 * none, `magnesium: ${mg.toFixed(0)} s vs ${none.toFixed(0)} s`);
  assert.ok(both > mg, `magnesium + isoprenaline: ${both.toFixed(0)} s`);
});

test('torsades is shockable, often stops on its own, and some runs degenerate to VF', () => {
  const p = mk({}, { seed: 4 }); p.dispatch({ type: 'instructor.inject', what: 'torsades' });
  assert.equal(p.arrest.key, 'TORSADES'); assert.equal(p.arrest.arrested, true);
  p.dispatch({ type: 'defib.pads' }); p.dispatch({ type: 'defib.charge' }); p.run(5);
  const r = p.dispatch({ type: 'defib.shock' });
  assert.notEqual(r.result?.note ?? r.note, 'non-shockable rhythm');
  let self = 0, vf = 0;
  for (let s = 1; s <= 20; s++) {
    const q = mk({}, { seed: s }); q.dispatch({ type: 'instructor.inject', what: 'torsades' });
    for (let k = 0; k < 240 && q.arrest.key === 'TORSADES'; k++) q.run(1);
    if (!q.arrest.arrested) self++; else if (q.arrest.key === 'VF') vf++;
  }
  assert.ok(self >= 8 && vf >= 2, `self-terminated ${self}/20, VF ${vf}/20`);
});

test('isoprenaline speeds the escape rhythm of complete heart block; atropine does not', () => {
  const base = () => { const p = mk({ rhythm: 'AV_BLOCK3', age: 78 }, { seed: 1 }); p.dispatch({ type: 'iv.access' }); p.run(30); return p; };
  const a = base(), h0 = a.circ.hr; a.dispatch({ type: 'drug.bolus', drug: 'atropine', amount: 1000 }); a.run(480);
  assert.ok(a.circ.hr - h0 < 5, `atropine: ${h0.toFixed(0)} -> ${a.circ.hr.toFixed(0)}`);
  const i = base(); i.dispatch({ type: 'drug.infusion', drug: 'isoprenaline', rate: 5 }); i.run(600);
  assert.ok(i.circ.hr - h0 > 12 && i.circ.hr < 75, `isoprenaline 5 mcg/min: ${h0.toFixed(0)} -> ${i.circ.hr.toFixed(0)}`);
  const n = mk({}, { seed: 1 }), hn = (n.run(30), n.circ.hr); n.dispatch({ type: 'drug.infusion', drug: 'isoprenaline', rate: 5 }); n.run(600);
  assert.ok(n.circ.hr - hn > 10, `sinus rhythm: ${hn.toFixed(0)} -> ${n.circ.hr.toFixed(0)}`);
});

test('torsades scenario replays to the same hash', () => {
  const p = scen('torsades', 3); p.dispatch({ type: 'drug.bolus', drug: 'magnesium', amount: 2 }); p.run(400);
  const r = replay({ spec: SCENARIOS.torsades.spec, seed: 3, scenario: 'torsades', log: p.log.map(e => ({ ...e })), until: p.t }, SCENARIOS);
  assert.equal(r.stateHash(), p.stateHash());
});
