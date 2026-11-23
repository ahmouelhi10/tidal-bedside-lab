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

test('the pointer hides while that panel is open, during a guided procedure, at the end, and for a result with nothing to press', () => {
  const vf = scen('witnessed_vf', 1); vf.run(40); const s = state(vf, 'witnessed_vf');
  assert.equal(dockTarget({ ...s, open: 'tab_circ' }), null);
  assert.equal(dockTarget({ ...s, open: 'tab_drugs' })?.tab, 'tab_circ', 'another panel open: still points');
  assert.equal(dockTarget({ ...s, guiding: true }), null); assert.equal(dockTarget({ ...s, finished: true }), null);
  assert.equal(dockTarget({ ...s, next: { id: 'outcome', text: 'alive', state: 'todo' } }), null);
});

test('intermediate: only after a senior hint, for that step, until it is done or HINT_S has passed; expert: never', () => {
  const p = scen('hyperkalaemia', 1), s = state(p, 'hyperkalaemia', { level: 'intermediate' });
  assert.equal(dockTarget(s), null, 'no hint asked: no pointer');
  const said = { id: 'hk_calcium', t: p.t };
  assert.deepEqual(dockTarget({ ...s, said }), { tab: 'tab_drugs', text: s.items.find(i => i.id === 'hk_calcium').text, why: 'senior' });
  assert.equal(dockTarget({ ...s, said, t: p.t + HINT_S + 1 }), null, 'the hint has gone stale');
  p.dispatch({ type: 'iv.access' }); p.dispatch({ type: 'drug.bolus', drug: 'calciumGluconate', amount: 6.6 }); p.run(60);
  assert.equal(dockTarget(state(p, 'hyperkalaemia', { level: 'intermediate', said: { id: 'hk_calcium', t: p.t - 30 } })), null, 'done since the hint');
  assert.equal(dockTarget({ ...state(scen('witnessed_vf', 1).run(40), 'witnessed_vf'), level: 'expert' }), null);
});

// Guided procedures: every step points at the dock button where that action is found in a real case.
import { PROCEDURES, Guide } from '../src/web/procedures.js';
import { mk } from './helpers/bots.js';
import { guideTarget, tabOfEvents, TAB_OF_EVENT } from '../src/web/dock-hint.js';

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

test('guided levels: beginner every step, intermediate only the first use of each button, expert none; another panel open points back', () => {
  const tabs = ['tab_orders', null, 'tab_airway', 'tab_drugs', 'tab_drugs', 'tab_airway'];
  const at = (level, i, open = 'tab_guide') => guideTarget({ level, tabs, i, open, finished: false });
  assert.deepEqual(tabs.map((_, i) => at('beginner', i)?.tab ?? null), tabs);
  assert.deepEqual(tabs.map((_, i) => at('intermediate', i)?.tab ?? null), ['tab_orders', null, 'tab_airway', 'tab_drugs', null, null]);
  assert.ok(tabs.every((_, i) => at('expert', i) === null));
  assert.deepEqual(at('beginner', 3, 'tab_drugs'), { tab: 'tab_guide', why: 'back' });
  assert.equal(at('expert', 3, 'tab_drugs'), null);
  assert.equal(guideTarget({ level: 'beginner', tabs, i: 6, open: null, finished: false }), null, 'past the last step');
});
