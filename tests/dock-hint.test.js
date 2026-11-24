// The dock pointer by learner level (src/web/dock-hint.js), read from the real cases' checklists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scen } from './helpers/bots.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { checklist, nextItem } from '../src/web/coach-eval.js';
import { dockOf, dockTarget, DOCK_TABS, DOCK_OF, HINT_S } from '../src/web/dock-hint.js';

const state = (p, id, extra = {}) => { const items = checklist(p, SCENARIOS[id]); return { level: 'beginner', items, next: nextItem(items), said: null, t: p.t, open: null, guiding: false, finished: false, ...extra }; };

test('every scored step of every case is placed on a dock button, or marked as nothing to press', () => {
  const used = new Set();
  for (const [id, sc] of Object.entries(SCENARIOS)) {
    if (!sc.score) continue;
    for (const c of sc.score()) {
      const tab = dockOf(c.id); used.add(c.id);
      assert.notEqual(tab, undefined, `${id}.${c.id} has no dock button`);
      if (tab !== null) assert.ok(DOCK_TABS.includes(tab), `${id}.${c.id} -> ${tab}`);
    }
    if (Object.values(sc.score()).some(c => c.id.startsWith('inf_'))) assert.ok(sc.score().filter(c => dockOf(c.id)).every(c => dockOf(c.id) === 'tab_ward'), `${id}: ward cases point only to the ward`);
  }
  for (const k of Object.keys(DOCK_OF)) assert.ok(used.has(k), `${k} is listed but no case scores it`);
});

test('beginner: the button of the next step, at every step, and it moves on as the learner acts', () => {
  const p = scen('hyperkalaemia', 1), first = dockTarget(state(p, 'hyperkalaemia'));
  assert.ok(first && first.why === 'next' && DOCK_TABS.includes(first.tab) && first.text);
  p.dispatch({ type: 'iv.access' }); p.dispatch({ type: 'order', what: 'ecg12' }); p.dispatch({ type: 'drug.bolus', drug: 'calciumGluconate', amount: 6.6 }); p.run(60);
  const s = state(p, 'hyperkalaemia'); assert.notEqual(s.next.id, 'hk_calcium');
  assert.equal(dockTarget(s)?.tab ?? null, dockOf(s.next.id), 'it follows the coach\'s next step');
  const vf = scen('witnessed_vf', 1); vf.run(40);
  assert.equal(dockTarget(state(vf, 'witnessed_vf')).tab, 'tab_circ', 'a VF arrest: compressions first, on the CPR / shock button');
});

test('with its section open it points at the control inside; it hides during a guided procedure, at the end, and for a result', () => {
  const vf = scen('witnessed_vf', 1); vf.run(40); const s = state(vf, 'witnessed_vf');
  const inn = dockTarget({ ...s, open: 'tab_circ' }); assert.ok(inn.inside && inn.tab === 'tab_circ' && inn.id === 't_first_compression');
  assert.deepEqual(criterionControl(inn.id), { sel: '#btnCpr' }, 'the start-CPR button');
  assert.equal(dockTarget({ ...s, open: 'tab_drugs' })?.inside, false, 'another panel open: the dock button');
  assert.equal(dockTarget({ ...s, guiding: true }), null); assert.equal(dockTarget({ ...s, finished: true }), null);
  assert.equal(dockTarget({ ...s, next: { id: 'outcome', text: 'alive', state: 'todo' } }), null);
});

test('every case step that has a dock button has a control in that section, and its action belongs to that section', () => {
  for (const [id, sc] of Object.entries(SCENARIOS)) {
    if (!sc.score) continue;
    for (const c of sc.score()) {
      const tab = dockOf(c.id); if (!tab || tab === 'tab_ward') continue;
      assert.ok(criterionControl(c.id), `${id}.${c.id}: nothing to press in ${tab}`);
      const ev = CRITERION_EVENT[c.id]; if (ev) assert.equal(TAB_OF_EVENT[ev.type], tab, `${c.id}: ${ev.type} is not in ${tab}`);
    }
  }
  for (const k of new Set(Object.values(CRITERION_EVENT).map(e => e.type))) assert.ok(controlOf({ type: k, drug: 'x', kind: 'abg', what: 'ecg12', items: { ecgLeads: true } }) || k === 'blood.transfuse', `${k}: no control`);
});

test('intermediate: only after a senior hint, for that step, until it is done or HINT_S has passed; expert: never', () => {
  const p = scen('hyperkalaemia', 1), s = state(p, 'hyperkalaemia', { level: 'intermediate' });
  assert.equal(dockTarget(s), null, 'no hint asked: no pointer');
  const said = { id: 'hk_calcium', t: p.t };
  assert.deepEqual(dockTarget({ ...s, said }), { tab: 'tab_drugs', id: 'hk_calcium', text: s.items.find(i => i.id === 'hk_calcium').text, why: 'senior', act: { type: 'drug.bolus', drug: 'calciumGluconate' }, inside: false });
  assert.equal(dockTarget({ ...s, said, t: p.t + HINT_S + 1 }), null, 'the hint has gone stale');
  p.dispatch({ type: 'iv.access' }); p.dispatch({ type: 'drug.bolus', drug: 'calciumGluconate', amount: 6.6 }); p.run(60);
  assert.equal(dockTarget(state(p, 'hyperkalaemia', { level: 'intermediate', said: { id: 'hk_calcium', t: p.t - 30 } })), null, 'done since the hint');
  assert.equal(dockTarget({ ...state(scen('witnessed_vf', 1).run(40), 'witnessed_vf'), level: 'expert' }), null);
});

// Guided procedures: every step points at the dock button where that action is found in a real case.
import { PROCEDURES, Guide } from '../src/web/procedures.js';
import { mk } from './helpers/bots.js';
import { guideTarget, tabOfEvents, TAB_OF_EVENT, controlOf, criterionControl, CRITERION_EVENT, criterionAction } from '../src/web/dock-hint.js';

const tabsOf = (pr, p) => { const g = new Guide(pr, p), ctx = { p, b: p.body, prm: g.prm }; return pr.steps.map(st => tabOfEvents(st.run ? st.run(ctx) : [])); };

test('every event a guided step dispatches has a dock button, and every procedure points somewhere', () => {
  const p = mk();
  for (const pr of PROCEDURES) {
    const g = new Guide(pr, p), ctx = { p, b: p.body, prm: g.prm };
    for (const st of pr.steps) for (const e of (st.run ? st.run(ctx) : [])) assert.ok(e.type === 'note' || TAB_OF_EVENT[e.type], `${pr.id}.${st.id}: ${e.type} has no dock button`);
    const tabs = tabsOf(pr, p); assert.ok(tabs.some(Boolean), `${pr.id}: no step points`);
    for (const k of tabs) if (k) assert.ok(DOCK_TABS.includes(k));
  }
  const rsi = Object.fromEntries(PROCEDURES.find(x => x.id === 'rsi').steps.map((st, i) => [st.id, tabsOf(PROCEDURES.find(x => x.id === 'rsi'), p)[i]]));
  assert.equal(rsi.monitor, 'tab_orders'); assert.equal(rsi.prep, null, 'the checklist has no button of its own');
});

test('every guided step that has a section has a control in it', () => {
  const p = mk();
  for (const pr of PROCEDURES) {
    const g = new Guide(pr, p), ctx = { p, b: p.body, prm: g.prm };
    for (const st of pr.steps) { const ev = (st.run ? st.run(ctx) : []).find(e => TAB_OF_EVENT[e.type]); if (ev && !st.hand) assert.ok(controlOf(ev), `${pr.id}.${st.id}: ${ev.type} has no control`); }
  }
});

test('guided levels: beginner is led at every step (dock button, then the control; the instrument; the step button), intermediate only on the first use of each button, expert never', () => {
  const tabs = ['tab_orders', null, 'tab_airway', 'tab_drugs', 'tab_drugs', 'tab_airway', 'tab_orders'], hands = [false, false, false, false, false, false, true];
  const at = (level, i, open = 'tab_guide') => guideTarget({ level, tabs, hands, i, open, finished: false });
  assert.deepEqual(at('beginner', 0), { tab: 'tab_orders', why: 'where', inside: null }, 'from the guide: open the section');
  assert.deepEqual(at('beginner', 0, 'tab_orders'), { tab: null, why: null, inside: 'control' }, 'in the section: the control');
  assert.deepEqual(at('beginner', 1), { tab: null, why: null, inside: 'do' }, 'a check with no section: the step button');
  assert.deepEqual(at('beginner', 1, 'tab_drugs'), { tab: 'tab_guide', why: 'back', inside: null });
  assert.deepEqual(at('beginner', 4, 'tab_drugs'), { tab: null, why: null, inside: 'control' }, 'next step in the same section: straight to its control');
  assert.deepEqual(at('beginner', 6), { tab: null, why: null, inside: 'tool' }, 'an instrument step: the instrument on the tray');
  assert.deepEqual(at('beginner', 6, 'tab_orders'), { tab: 'tab_guide', why: 'back', inside: null });
  assert.deepEqual(tabs.map((_, i) => at('intermediate', i)?.tab ?? null), ['tab_orders', null, 'tab_airway', 'tab_drugs', null, null, null]);
  assert.ok(tabs.every((_, i) => at('expert', i) === null && at('expert', i, 'tab_drugs') === null));
  assert.equal(guideTarget({ level: 'beginner', tabs, hands, i: 7, open: null, finished: false }), null, 'past the last step');
});

test('a step that needs something first points at that first: pads, charge, then shock; a line before an IV drug; ventilation, then capnography', () => {
  const p = scen('witnessed_vf', 1); p.run(40);
  assert.equal(criterionAction('t_first_shock', p).type, 'defib.pads');
  p.dispatch({ type: 'defib.pads' }); assert.equal(criterionAction('t_first_shock', p).type, 'defib.charge');
  p.dispatch({ type: 'defib.charge' }); assert.equal(criterionAction('t_first_shock', p).type, 'defib.shock', 'charging: not the charge again (it would restart)'); p.run(10); assert.equal(criterionAction('t_first_shock', p).type, 'defib.shock');
  const k = scen('hyperkalaemia', 1), s = state(k, 'hyperkalaemia', { p: k, said: { id: 'hk_calcium', t: k.t }, level: 'intermediate' });
  assert.deepEqual(dockTarget(s).act, { type: 'iv.access' }); assert.equal(dockTarget(s).tab, 'tab_orders', 'no line yet: the line is in the orders');
  k.dispatch({ type: 'iv.access' }); assert.equal(dockTarget({ ...s, p: k }).tab, 'tab_drugs');
  assert.equal(criterionAction('copd_bronchodilator', mk()).type, 'drug.bolus', 'nebulised salbutamol needs no line');
  const a = scen('witnessed_vf', 1); a.run(40); assert.equal(criterionAction('airway_vent', a).type, 'vent.set');
  a.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 10, vt: 500, fio2: 1, peep: 5 } }); assert.deepEqual(criterionAction('airway_vent', a), { type: 'monitor.attach', items: { capnography: true } });
  a.dispatch({ type: 'monitor.attach', items: { capnography: true } }); assert.deepEqual(criterionAction('airway_vent', a), { type: 'airway.set', device: 'sga' }, 'then an advanced airway');
});

test('after ROSC the bundle is pointed part by part: 12-lead, temperature control, then the targets', () => {
  const p = scen('witnessed_vf', 1); p.run(40); p.dispatch({ type: 'defib.pads' }); p.dispatch({ type: 'defib.charge' }); p.run(8); p.dispatch({ type: 'defib.shock' }); p.run(60);
  if (!p.arrest.roscCount) return;                                              // this seed has no ROSC: nothing to point at yet
  assert.deepEqual(criterionAction('post_rosc', p), { type: 'order', what: 'ecg12' });
  p.dispatch({ type: 'order', what: 'ecg12' }); assert.deepEqual(criterionAction('post_rosc', p), { type: 'order', what: 'temperature_control' });
  p.dispatch({ type: 'order', what: 'temperature_control' }); assert.notDeepEqual(criterionAction('post_rosc', p), { type: 'order', what: 'temperature_control' });
});

test('a step already done that now only needs time is skipped: the beginner is pointed at the next step that has something to press', () => {
  const p = scen('tension_ptx', 1); p.run(20);
  p.dispatch({ type: 'exam.chest' }); p.dispatch({ type: 'procedure.needle_decompression', side: p.chest.side || 'R', site: 'mal5', needleMm: 80 }); p.run(5);
  assert.equal(criterionAction('needle_technique', p).type, 'skip', 'only the first needle attempt is scored');
  const d = dockTarget(state(p, 'tension_ptx', { p })); assert.ok(d && d.id !== 'needle_technique' && d.id !== 'tension_relief', `points at ${d?.id}`);
  const e = scen('witnessed_vf', 1); e.run(40); e.dispatch({ type: 'iv.access' }); e.dispatch({ type: 'drug.bolus', drug: 'epinephrine', amount: 1 }); e.run(60);
  assert.equal(criterionAction('epi_timing', e).type, 'skip', 'the next adrenaline is not due yet'); e.run(150); assert.equal(criterionAction('epi_timing', e).type, 'drug.bolus', 'due again after 3 min');
});

test('pre-oxygenation points at head-up, then the 100 % face mask in the airway section, then waits for the end-tidal O2', () => {
  assert.equal(DOCK_OF.preox, 'tab_airway');
  const p = scen('obese_rsi', 1);
  if (!p.headUp) { assert.deepEqual(criterionAction('preox', p), { type: 'position.set', headUp: true }); p.dispatch({ type: 'position.set', headUp: true }); }
  const m = criterionAction('preox', p); assert.equal(m.type, 'o2.mask'); assert.deepEqual(m.set, [['#selO2', 'fm100']]);
  p.dispatch({ type: 'o2.mask', fio2: 0.85, seal: 0.9 }); assert.equal(criterionAction('preox', p).type, 'o2.mask', 'the non-rebreather is not enough');
  p.dispatch({ type: 'o2.mask', fio2: 1, seal: 0.97 }); assert.equal(criterionAction('preox', p).type, 'wait', 'then the end-tidal O2 has to rise');
  p.run(300); assert.ok((p.preoxEtO2Max ?? 0) >= 0.9, `ETO2 ${p.preoxEtO2Max}`); assert.equal(criterionAction('preox', p).type, 'skip');
});

test('while a step can only wait, the beginner is told why instead of losing the pointer: the end-tidal O2, the relaxant', () => {
  const p = scen('obese_rsi', 1); p.dispatch({ type: 'position.set', headUp: true }); p.dispatch({ type: 'o2.mask', fio2: 1, seal: 0.97 }); p.run(20);
  const st = (open) => ({ level: 'beginner', items: checklist(p, SCENARIOS.obese_rsi), p, t: p.t, open });
  const w = dockTarget(st(null)); assert.equal(w?.wait, true); assert.equal(w.id, 'preox'); assert.equal(w.tab, 'tab_airway'); assert.equal(w.act.why, 'preox');
  assert.ok(w.act.pct > 21 && w.act.pct < 100 && w.act.left > 0 && w.act.left <= 180, JSON.stringify(w.act));
  assert.equal(dockTarget(st('tab_airway')).inside, true, 'its section open: shown at the control, still without pointing');
  assert.equal(dockTarget({ ...st(null), level: 'expert' }), null);
  const q = scen('obese_rsi', 1); q.dispatch({ type: 'iv.access' }); q.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 200 }); q.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 100 }); q.run(5);
  const a = criterionAction('intubation', q); assert.equal(a.type, 'wait'); assert.equal(a.why, 'nmb'); assert.ok(a.pct >= 0 && a.pct < 90, `${a.pct}`);
  q.run(120); assert.equal(criterionAction('intubation', q).type, 'airway.intubate', 'relaxed: intubate');
});
