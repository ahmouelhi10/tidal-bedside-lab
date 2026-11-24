// The patient's voice and the stethoscope (src/web/voice.js), driven by the real engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scen } from './helpers/bots.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { scores } from '../src/engine/clinical.js';
import { patientLine, Speaker, auscultation, LINES, REPEAT_S } from '../src/web/voice.js';

const line = (p, id, n = 0) => patientLine(p, id, n, scores(p));

test('every case has its own complaint, in English and French', () => {
  for (const id of Object.keys(SCENARIOS)) {
    if (id === 'tube_desat') continue;                                   // intubated from the start: never speaks
    const l = LINES[id]; assert.ok(l?.length, `no complaint for ${id}`);
    for (const x of l) assert.ok(x.en && x.fr && x.en !== x.fr, id);
  }
});

test('an awake patient says the complaint of the case; silent in cardiac arrest, asleep, paralysed or intubated', () => {
  const p = scen('svt', 1); p.run(5); const l = line(p, 'svt'); assert.equal(l?.key, 'svt', JSON.stringify(l));
  const vf = scen('witnessed_vf', 1); vf.run(5); vf.arrest.arrested = true; assert.equal(line(vf, 'witnessed_vf'), null);
  const r = scen('obese_rsi', 1); r.run(2); assert.equal(line(r, 'obese_rsi')?.key, 'obese_rsi', 'awake before the induction');
  r.dispatch({ type: 'iv.access' }); r.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 200 }); r.run(48); assert.equal(line(r, 'obese_rsi')?.key, 'confused', 'drowsy while going under'); r.run(45); assert.equal(line(r, 'obese_rsi'), null, 'asleep');
  r.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 100 }); r.run(90); r.dispatch({ type: 'airway.intubate' }); r.run(5); assert.equal(line(r, 'obese_rsi'), null, 'intubated');
});

test('short of oxygen: gasped words instead of the complaint', () => {
  const p = scen('copd_exacerbation', 1); p.run(5); p.resp.sao2 = 0.8; assert.equal(line(p, 'copd_exacerbation').key, 'breathless');
});

test('the speaker talks at the start, again when what they say changes, and repeats only every REPEAT_S', () => {
  const p = scen('svt', 1), s = new Speaker(), said = [];
  for (let i = 0; i < 1200; i++) { p.run(0.1); const l = s.say(p, 'svt', scores(p)); if (l) said.push([+p.t.toFixed(1), l.key]); }
  assert.ok(said.length >= 2 && said.length <= 4, JSON.stringify(said)); assert.ok(said[0][0] < 5);
  for (let i = 1; i < said.length; i++) assert.ok(said[i][0] - said[i - 1][0] >= REPEAT_S - 0.11 || said[i][1] !== said[i - 1][1]);
});

test('auscultation: a tension pneumothorax silences one side; bronchospasm wheezes; oedema crackles; no heart sounds in arrest', () => {
  const t = scen('tension_ptx', 1); t.run(60); const r = t.dispatch({ type: 'exam.chest' }); const a = auscultation(t, r.findings);
  const side = t.chest.side; assert.ok(a.breath[side] < 0.5 && a.breath[side === 'R' ? 'L' : 'R'] === 1, JSON.stringify([side, a.breath, r.findings]));
  const n = scen('svt', 1); n.run(5); const b = auscultation(n, n.dispatch({ type: 'exam.chest' }).findings);
  assert.deepEqual(b.breath, { R: 1, L: 1 }); assert.ok(b.rr > 6 && b.heart.hr > 120, JSON.stringify(b)); assert.equal(b.wheeze, 0);
  n.crises.br = 0.7; n.oedema = 0.5; const c = auscultation(n, []); assert.ok(c.wheeze > 0.5 && c.crackles > 0.5);
  const v = scen('witnessed_vf', 1); v.run(5); v.arrest.arrested = true; v.resp.rr = 0; const d = auscultation(v, []); assert.equal(d.heart, null); assert.equal(d.rr, 0);
});

test('pneumonia: the chest exam finds crackles at the right base, and the stethoscope plays them on that side only', () => {
  const p = scen('inf_cap', 1); p.run(5); const r = p.dispatch({ type: 'exam.chest' });
  assert.ok(r.findings.includes('crackles_R') && !r.findings.includes('chest_normal'), JSON.stringify(r.findings));
  const a = auscultation(p, r.findings); assert.ok(a.crackles > 0.3 && a.crackleSide.R === 1 && a.crackleSide.L === 0, JSON.stringify(a));
  const n = scen('svt', 1); n.run(5); const b = n.dispatch({ type: 'exam.chest' });
  assert.ok(!b.findings.some(f => f.startsWith('crackles_')) && auscultation(n, b.findings).crackles === 0, 'no crackles without pneumonia');
});
