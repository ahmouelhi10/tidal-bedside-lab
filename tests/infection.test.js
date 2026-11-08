import test from 'node:test';
import assert from 'node:assert/strict';
import { Patient, replay, EVENT_TYPES } from '../src/engine/patient.js';
import { SCENARIOS, scoreSession } from '../src/engine/scenarios.js';
import { BREAKPOINTS, ABX, interpret, categorize, antibiogram, cockcroftGault, doseFor, fluidVolumeMl, isStable, EUCAST_VERSION } from '../src/engine/infection.js';
import { describeBody } from '../src/engine/anthropometrics.js';
import { scen, mk } from './helpers/bots.js';
import { wardExpert } from './helpers/ward.js';

const INF = ['inf_pyelo', 'inf_cap', 'inf_sab', 'inf_esbl'];
const D = (p, ev) => p.dispatch(ev);
const iso = id => SCENARIOS[id].ward.isolate;

// ------------------------------------------------------------------------------------------ EUCAST reading (REF eucast_v16_1, eucast_sir)
test('EUCAST v16.1: S <= s, R > r, I in between; boundaries are inclusive on the S side', () => {
  assert.equal(EUCAST_VERSION, '16.1');
  const cro = BREAKPOINTS.Enterobacterales.ceftriaxone;
  assert.deepEqual([0.5, 1, 2, 4].map(m => interpret(m, cro)), ['S', 'S', 'I', 'R']);
  const mero = BREAKPOINTS.Enterobacterales.meropenem;
  assert.deepEqual([2, 4, 8, 16].map(m => interpret(m, mero)), ['S', 'I', 'I', 'R']);
  assert.deepEqual([0.25, 0.5, 1].map(m => interpret(m, BREAKPOINTS.Enterobacterales.ciprofloxacin)), ['S', 'I', 'R']);
  assert.equal(interpret(0.5, BREAKPOINTS.Enterobacterales.tmpsmx), 'S');                       // v16.1: S <= 0.5, R > 0.5
  assert.equal(interpret(1, BREAKPOINTS.Enterobacterales.tmpsmx), 'R');
  assert.equal(interpret(0.06, BREAKPOINTS.S_pneumoniae.levofloxacin), 'I');                     // "(I) only": never S at the standard dose
});

test('EUCAST inference rules: staphylococcal beta-lactams from cefoxitin, pneumococcal screen, "-" reported R', () => {
  const mssa = iso('inf_sab'), mrsa = { ...mssa, mic: { ...mssa.mic, cefoxitin: 8 } };
  assert.equal(categorize(mssa, 'flucloxacillin').cat, 'S');
  assert.equal(categorize(mssa, 'amoxicillin').cat, 'R');                                        // penicillinase: benzylpenicillin MIC 1 > 0.125
  assert.equal(categorize(mssa, 'cefazolin').cat, 'I');                                          // MSSA cephalosporins reported I (high dose)
  assert.equal(categorize(mrsa, 'flucloxacillin').cat, 'R');
  assert.equal(categorize(mrsa, 'meropenem').cat, 'R');
  assert.equal(categorize(mrsa, 'vancomycin').cat, 'S');
  const pn = iso('inf_cap');
  for (const d of ['amoxicillin', 'amoxiclav', 'piptazo', 'ceftriaxone', 'meropenem']) assert.equal(categorize(pn, d).cat, 'S', d);
  assert.equal(categorize({ ...pn, mic: { ...pn.mic, benzylpenicillin: 0.5, ampicillin: 2 } }, 'amoxicillin').cat, 'R');   // screen positive: read the MIC
  assert.equal(categorize(pn, 'clarithromycin').cat, 'R');
  assert.equal(categorize(pn, 'levofloxacin').cat, 'I');
  assert.equal(categorize(iso('inf_pyelo'), 'vancomycin').cat, 'R');                            // "-" for Enterobacterales
  assert.equal(categorize(iso('inf_pyelo'), 'clarithromycin').basis, 'not_recommended');
});

test('antibiograms: the four case isolates read as intended', () => {
  const cat = (id, d, r = 'iv') => categorize(iso(id), d, r).cat;
  assert.deepEqual(['amoxicillin', 'ceftriaxone', 'ciprofloxacin', 'tmpsmx'].map(d => cat('inf_pyelo', d)), ['R', 'S', 'S', 'R']);
  assert.equal(cat('inf_pyelo', 'ciprofloxacin', 'po'), 'S');
  assert.deepEqual(['ceftriaxone', 'cefepime', 'piptazo', 'ertapenem', 'meropenem', 'ciprofloxacin', 'tmpsmx', 'amikacin'].map(d => cat('inf_esbl', d)), ['R', 'R', 'S', 'S', 'S', 'R', 'R', 'S']);
  for (const id of INF) {
    const rows = antibiogram(iso(id));
    assert.ok(rows.length >= 8, id);
    for (const r of rows) assert.ok(['S', 'I', 'R'].includes(r.cat), `${id} ${r.key} ${r.cat}`);
  }
});

test('every antibiotic has EUCAST standard dosing for each of its routes', () => {
  for (const [k, a] of Object.entries(ABX)) for (const r of a.routes) assert.ok(a.dose[r]?.std, `${k} ${r}`);
});

// ------------------------------------------------------------------------------------------ dosing depends on the body
test('weight-based doses: gentamicin 6-7 mg/kg and vancomycin loading 25 mg/kg (max 3 g) scale with actual body weight; 30 mL/kg fluids', () => {
  const thin = describeBody({ sex: 'F', age: 78, heightCm: 158, weightKg: 52 }), big = describeBody({ sex: 'M', age: 40, heightCm: 180, weightKg: 140 });
  assert.deepEqual(doseFor('gentamicin', 'iv', 'std', thin).mg, [310, 360]);
  assert.ok(doseFor('gentamicin', 'iv', 'std', big).mg[0] > 2.5 * doseFor('gentamicin', 'iv', 'std', thin).mg[0]);
  assert.equal(doseFor('vancomycin', 'iv', 'std', thin).loadingMg, 1250);
  assert.equal(doseFor('vancomycin', 'iv', 'std', big).loadingMg, 3000);                      // capped
  assert.equal(fluidVolumeMl(thin), 1550);
  assert.equal(doseFor('ertapenem', 'iv', 'high', thin).level, 'std');                        // no high dose listed: falls back to standard
  assert.equal(doseFor('amoxicillin', 'po', 'high', thin).text, '0.75-1 g x 3');
});

test('Cockcroft-Gault creatinine clearance (worked example) and its sex factor', () => {
  const v = cockcroftGault({ age: 78, weightKg: 52, sex: 'F' }, 130);
  assert.ok(Math.abs(v - 25.9) < 0.2, String(v));
  assert.ok(Math.abs(cockcroftGault({ age: 78, weightKg: 52, sex: 'M' }, 130) / v - 1 / 0.85) < 1e-9);
});

// ------------------------------------------------------------------------------------------ course over days (REF design, calibrated targets)
test('prompt active therapy: clinically stable within 1-4 days, cured after the expert course', () => {
  for (const id of INF) {
    const p = scen(id, 2);
    assert.equal(p.ward.stable(), false, id + ' unstable at admission');
    wardExpert(p, id);
    assert.ok(p.ward.stableH >= 24 && p.ward.stableH <= 96, `${id} stable at ${p.ward.stableH} h`);
    const s = p.ward.summary(); assert.ok(s.cured && !s.relapse && !s.icu, id);
  }
});

test('untreated sepsis deteriorates to intensive care within 3 days; inactive empirical therapy behaves like none', () => {
  for (const id of ['inf_pyelo', 'inf_esbl']) {
    const p = scen(id, 1); D(p, { type: 'ward.advance', hours: 72 });
    assert.ok(p.ward.icuH !== null && p.ward.icuH <= 72, `${id} ICU at ${p.ward.icuH}`);
  }
  const p = scen('inf_esbl', 1); D(p, { type: 'ward.rx.start', drug: 'ceftriaxone', route: 'iv' }); D(p, { type: 'ward.advance', hours: 72 });
  assert.ok(p.ward.icuH !== null, 'ceftriaxone does not treat an ESBL producer');
  assert.equal(p.ward.firstActiveH, null);
});

test('EUCAST I needs the high dose: levofloxacin is only half as effective at the standard dose against the pneumococcus', () => {
  const run = dose => { const p = scen('inf_cap', 1); D(p, { type: 'ward.rx.start', drug: 'levofloxacin', route: 'iv', dose }); D(p, { type: 'ward.advance', hours: 48 }); return p.ward.b; };
  assert.ok(run('high') < 0.1 && run('std') > 3 * run('high'));
});

test('stopping after 3 days relapses; 7 days of active therapy does not', () => {
  const go = days => { const p = scen('inf_pyelo', 1); D(p, { type: 'ward.rx.start', drug: 'ceftriaxone', route: 'iv' }); for (let d = 0; d < days; d++) D(p, { type: 'ward.advance', hours: 24 }); D(p, { type: 'ward.rx.stop', drug: 'ceftriaxone' }); for (let i = 0; i < 6; i++) D(p, { type: 'ward.advance', hours: 24 }); return p.ward.summary(); };
  assert.equal(go(3).relapse, true);
  const s7 = go(7); assert.equal(s7.relapse, false); assert.equal(s7.cured, true);
});

test('S. aureus line infection: the bacteraemia persists while the line stays in, clears after removal', () => {
  const run = (remove) => {
    const p = scen('inf_sab', 1); D(p, { type: 'ward.sample', kind: 'blood' }); D(p, { type: 'ward.rx.start', drug: 'flucloxacillin', route: 'iv' });
    if (remove) D(p, { type: 'ward.order', what: 'remove_line' });
    D(p, { type: 'ward.advance', hours: 48 }); D(p, { type: 'ward.sample', kind: 'blood' }); D(p, { type: 'ward.advance', hours: 48 });
    return p.ward;
  };
  const kept = run(false), out = run(true);
  assert.equal(kept.samples[1].positive, true); assert.equal(kept.stable(), false);
  assert.equal(out.samples[1].positive, false); assert.equal(out.milestones().clearH, 48);
});

test('microbiology: Gram stain, identification and antibiogram arrive in order; cultures after the first dose lose about half their yield', () => {
  const p = scen('inf_pyelo', 5); D(p, { type: 'ward.sample', kind: 'blood' }); D(p, { type: 'ward.sample', kind: 'urine' });
  const kinds = () => p.ward.reports().flatMap(r => r.lines.map(l => l.k));
  assert.ok(kinds().every(k => k === 'pending'));
  D(p, { type: 'ward.advance', hours: 1 }); assert.ok(kinds().includes('stain'));
  D(p, { type: 'ward.advance', hours: 30 }); assert.ok(kinds().includes('bc_pos') && kinds().includes('id'));
  D(p, { type: 'ward.advance', hours: 24 }); assert.ok(kinds().includes('ast'));
  const m = p.ward.milestones(); assert.ok(m.gram <= m.id && m.id <= m.ast);
  let pos = 0; const N = 300;
  for (let s = 1; s <= N; s++) { const q = scen('inf_pyelo', s); D(q, { type: 'ward.rx.start', drug: 'ceftriaxone', route: 'iv' }); D(q, { type: 'ward.sample', kind: 'blood' }); if (q.ward.samples[0].positive) pos++; }
  assert.ok(pos / N > 0.43 && pos / N < 0.63, `post-antibiotic yield ${pos / N}`);        // REF fabled2019 (sensitivity ~53 %)
});

// ------------------------------------------------------------------------------------------ scoring
test('stewardship scoring separates good from poor practice', () => {
  const sc = (id, opts) => { const p = scen(id, 1); wardExpert(p, id, opts); return scoreSession(p); };
  const item = (s, k) => s.items.find(i => i.id === k);
  assert.ok(sc('inf_pyelo').pct >= 95);
  assert.ok(item(sc('inf_pyelo', { days: 14 }), 'inf_duration').frac < 0.1, '14 days scored as too long');
  assert.equal(item(sc('inf_pyelo', { noCultures: true }), 'inf_cultures').frac, 0);
  assert.ok(item(sc('inf_pyelo', { delayH: 6 }), 'inf_abx_time').frac < 0.2);
  assert.ok(item(sc('inf_pyelo', { empiric: [['ceftriaxone', 'iv', 'std'], ['vancomycin', 'iv', 'std']] }), 'inf_empiric').frac <= 0.7, 'unneeded MRSA cover');
  assert.ok(item(sc('inf_cap', { empiric: [['ceftriaxone', 'iv', 'std']] }), 'inf_empiric').frac <= 0.8, 'no atypical cover');
  assert.ok(item(sc('inf_sab', { targeted: [['vancomycin', 'iv', 'std']] }), 'inf_deesc').frac === 0, 'vancomycin kept for MSSA');
  assert.ok(item(sc('inf_esbl', { targeted: [['piptazo', 'iv', 'high']] }), 'inf_esbl_agent').frac === 0);
  const noLine = scen('inf_sab', 1); wardExpert(noLine, 'inf_sab', { line: false });
  const s = scoreSession(noLine); assert.equal(item(s, 'inf_line').frac, 0); assert.ok(s.pct < 75, String(s.pct));
});

test('every infectiology criterion cites a registry entry and only applies once it can be judged', () => {
  const p = scen('inf_pyelo', 1);
  const ids = scoreSession(p).items.map(i => i.id);
  assert.ok(!ids.includes('inf_deesc') && !ids.includes('inf_oral'), 'not applicable before the antibiogram');
});

// ------------------------------------------------------------------------------------------ event contract and determinism
test('ward events are declared, validated and rejected outside an infectiology case', () => {
  for (const t of ['ward.advance', 'ward.sample', 'ward.rx.start', 'ward.rx.stop', 'ward.order']) assert.ok(EVENT_TYPES.includes(t));
  const p = scen('inf_pyelo', 1);
  for (const bad of [{ type: 'ward.advance', hours: 0 }, { type: 'ward.advance', hours: 2.5 }, { type: 'ward.advance', hours: 'x' }, { type: 'ward.advance', hours: 100 },
    { type: 'ward.sample', kind: 'csf' }, { type: 'ward.rx.start', drug: 'toString', route: 'iv' }, { type: 'ward.rx.start', drug: 'ceftriaxone', route: 'im' },
    { type: 'ward.rx.start', drug: 'ceftriaxone', route: 'po' }, { type: 'ward.rx.start', drug: 'ceftriaxone', route: 'iv', dose: 'huge' }, { type: 'ward.rx.stop', drug: 'ceftriaxone' }, { type: 'ward.order', what: 'mri' }])
    assert.equal(D(p, bad).ok, false, JSON.stringify(bad));
  assert.equal(p.ward.h, 0); assert.equal(p.ward.rx.length, 0);
  assert.equal(D(mk(), { type: 'ward.advance', hours: 1 }).ok, false);
  assert.equal(D(p, { type: 'ward.rx.start', drug: 'ceftriaxone', route: 'iv' }).ok, true);
  assert.equal(D(p, { type: 'ward.rx.start', drug: 'ceftriaxone', route: 'iv' }).ok, false, 'duplicate prescription');
});

test('replay: an expert admission replays to the same hash and score; the ward never perturbs the physiology streams', () => {
  for (const id of INF) {
    const p = scen(id, 7); p.run(5); wardExpert(p, id); p.run(3);
    const r = replay({ spec: p.spec, seed: p.seed, scenario: id, log: p.log, until: p.t }, SCENARIOS);
    assert.equal(r.stateHash(), p.stateHash(), id);
    assert.deepEqual(scoreSession(r), scoreSession(p), id);
  }
  const a = scen('inf_cap', 9), b = scen('inf_cap', 9);
  a.run(20); b.run(20); wardExpert(b, 'inf_cap'); a.run(20); b.run(20);
  assert.equal(a.rng.state, b.rng.state); assert.equal(a.circ.mapArt, b.circ.mapArt);
  const h0 = scen('inf_cap', 9).stateHash(), c = scen('inf_cap', 9); D(c, { type: 'ward.advance', hours: 1 });
  assert.notEqual(c.stateHash(), h0, 'ward state is part of the hash');
});

test('clinical stability uses all seven criteria', () => {
  const ok = { temp: 37.5, hr: 90, rr: 20, sbp: 110, spo2: 95, alert: true, eating: true };
  assert.equal(isStable(ok), true);
  for (const [k, v] of [['temp', 37.9], ['hr', 101], ['rr', 25], ['sbp', 89], ['spo2', 89], ['alert', false], ['eating', false]]) assert.equal(isStable({ ...ok, [k]: v }), false, k);
});
