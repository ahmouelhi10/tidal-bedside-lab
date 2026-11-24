// Learner levels and in-case help. The level is chosen on the start screen, after the section:
//   beginner     - a live coach card: what to do next, the full checklist of the case with what is done, the key points;
//   intermediate - a senior doctor who answers when asked (3 times a case) and speaks up once or twice when nothing happens;
//   expert       - no help.
// The dock also points at the button of the next step (dock-hint.js): every step for a beginner, only after a senior hint
// for an intermediate, never for an expert.
// The checklist is read live from the case's own scoring criteria, so every case is covered and the advice always matches
// what is assessed. Help never changes the physiology: it only reads the patient. The level and each senior hint are written
// to the event log as notes, so the debrief, the replay and the research export show how much help was used.
import { SCENARIOS } from '/engine/scenarios.js';
import { t, getLang } from './i18n.js';
import { checklist as checklistOf, nextItem, helpUsed, keepAtStart } from './coach-eval.js';
export { helpUsed };

export const LEVELS = Object.freeze(['beginner', 'intermediate', 'expert']);
export const SENIOR_ASKS = 3;          // on-demand senior hints per case (intermediate)
export const SENIOR_AUTO = 2;          // unprompted nudges per case when the learner is stuck (intermediate)
export const STUCK_S = 120;            // simulated seconds without any learner action before the senior speaks up

const KEY = 'tbl.level';
export function loadLevel() { try { const v = localStorage.getItem(KEY); return LEVELS.includes(v) ? v : 'beginner'; } catch { return 'beginner'; } }
export function saveLevel(v) { try { localStorage.setItem(KEY, v); } catch { /* storage may be unavailable */ } }

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

/** Level step of a start-screen section: one large choice per level; picking one goes on to the cases (onPick). */
export function levelPicker(ui, onPick) {
  const list = el('div', { class: 'lvl-step', role: 'radiogroup', 'aria-label': t('lvl_title') });
  LEVELS.forEach((v, i) => list.append(el('button', { type: 'button', role: 'radio', class: 'lvl-card' + (v === ui.level ? ' on' : ''), 'aria-checked': String(v === ui.level), dataset: { level: v }, onclick: () => { ui.level = v; saveLevel(v); onPick(v); } },
    el('span', { class: 'lvl-dots' }, LEVELS.map((_, j) => el('i', { class: j <= i ? 'on' : '' }))),
    el('span', { class: 'lvl-txt' }, el('b', { text: t('lvl_' + v) }), el('span', { text: t('lvl_' + v + '_d') })),
    el('span', { class: 'lvl-go' }))));
  return el('div', { class: 'lvl-wrap' }, el('p', { class: 'muted', text: t('lvl_q') }), list);
}

/** Small reminder of the chosen level above the case list; clicking it goes back to the level step. */
export function levelChip(ui, onChange) {
  return el('button', { type: 'button', class: 'ghost lvl-chip', onclick: onChange },
    el('span', { class: 'muted', text: t('lvl_title') }), el('b', { text: t('lvl_' + ui.level) }), el('span', { class: 'lvl-chg', text: t('lvl_change') }));
}

/** Coach card in the right column; one instance per UI, restarted at each case. */
export class Coach {
  constructor(ui) { this.ui = ui; this.box = el('section', { class: 'card coach', hidden: true, 'aria-live': 'polite' }); this.reset(); }
  checklist(p, id) { if (this._live && this._live.p === p && this._live.t === p.t && this._live.n === p.log.length) return this._live.items; const items = checklistOf(p, SCENARIOS[id], this.keep); this._live = { p, t: p.t, n: p.log.length, items }; return items; }   // memo: the card and the dock pointer read it in the same frame
  /** What the dock pointer needs (dock-hint.js): null when the coach is off (expert, free play, skills training). */
  dockState() {
    const p = this.ui.sim.patient, id = this.ui.sim.scenarioId; if (!p || !id || this.box.hidden || this.level === 'expert') return null;
    const items = this.checklist(p, id); return { level: this.level, items, next: nextItem(items), said: this.said, t: p.t, p };
  }
  reset() { this._live = null; this.keep = null; this.asks = 0; this.autos = 0; this.said = null; this.lastSig = ''; this._t = -1; this._stuckFrom = 0; }
  get level() { return this.ui.level; }
  /** Called at the start of every session. */
  start() {
    this.reset();
    const p = this.ui.sim.patient, id = this.ui.sim.scenarioId;
    if (p) this.ui.sim.act({ type: 'note', text: `level: ${this.level}` });
    if (p && id && SCENARIOS[id]) this.keep = keepAtStart(p, SCENARIOS[id]);
    this.box.hidden = !id || this.level === 'expert' || !SCENARIOS[id]?.score;
    this.box.replaceChildren(); this.render(true);
  }
  _lastActionT(p) { for (let i = p.log.length - 1; i >= 0; i--) if (p.log[i].type !== 'note') return p.log[i].t; return 0; }
  _senior(p, item, auto) {
    if (!item) { this.said = { text: t('sn_none'), t: p.t }; return; }
    this.said = { text: t(auto ? 'sn_auto' : 'sn_hint', { x: item.text }), t: p.t, id: item.id };
    this.ui.sim.act({ type: 'note', text: `senior hint${auto ? ' (unprompted)' : ''}: ${item.id}` });
  }
  ask() {
    const p = this.ui.sim.patient; if (!p || this.asks >= SENIOR_ASKS || this.ui.sim.finished) return;
    this.asks++; this._senior(p, nextItem(this.checklist(p, this.ui.sim.scenarioId)), false); this.render(true);
  }
  /** Refresh (called from the UI loop); cheap when nothing changed. */
  tick() {
    const p = this.ui.sim.patient, id = this.ui.sim.scenarioId;
    if (!p || this.box.hidden || !id) return;
    if (Math.abs(p.t - this._t) < 1 && this._t >= 0) return; this._t = p.t;
    if (this.level === 'intermediate' && !this.ui.sim.finished && this.autos < SENIOR_AUTO) {
      const since = p.t - Math.max(this._lastActionT(p), this._stuckFrom);
      if (since >= STUCK_S) { const it = nextItem(this.checklist(p, id)); if (it) { this.autos++; this._stuckFrom = p.t; this._senior(p, it, true); this.render(true); return; } }
    }
    this.render(false);
  }
  render(force) {
    const p = this.ui.sim.patient, id = this.ui.sim.scenarioId; if (!p || !id) return;
    if (this.level === 'beginner') {
      const items = this.checklist(p, id), nx = nextItem(items), en = getLang() !== 'fr';   // criterion details are written in English
      const sig = items.map(i => i.state + i.detail).join('|') + (nx?.id ?? '');
      if (!force && sig === this.lastSig) return; this.lastSig = sig;
      const ICON = { done: '✓', part: '◐', todo: '○', later: '·', keep: '◇' };
      const learn = SCENARIOS[id]?.learning || [];
      this.box.replaceChildren(
        el('h3', { text: t('co_title') }),
        nx ? el('div', { class: 'co-next' }, el('span', { class: 'co-k', text: t('co_next') }), el('b', { text: nx.text }), nx.detail && en ? el('span', { class: 'muted small', text: nx.detail }) : null)
          : el('div', { class: 'co-next ok' }, el('b', { text: t('co_alldone') })),
        el('ol', { class: 'co-list' }, items.map(i => el('li', { class: 'co-' + i.state, title: en ? i.detail || '' : '' }, el('span', { class: 'co-i', text: ICON[i.state] }), el('span', { text: i.text })))),
        el('p', { class: 'muted small', text: t('co_legend') }),
        learn.length ? el('details', { class: 'co-learn' }, el('summary', { text: t('co_points') }), el('ul', { class: 'small' }, learn.map(x => el('li', { text: x })))) : null);
      return;
    }
    if (this.level === 'intermediate') {
      const sig = `${this.asks}|${this.autos}|${this.said?.t ?? ''}|${this.ui.sim.finished}`;
      if (!force && sig === this.lastSig) return; this.lastSig = sig;
      const left = SENIOR_ASKS - this.asks;
      this.box.replaceChildren(
        el('h3', { text: t('sn_title') }),
        el('p', { class: 'co-said' + (this.said ? '' : ' muted small'), text: this.said ? this.said.text : t('sn_intro') }),
        el('button', { class: 'act', disabled: left <= 0 || this.ui.sim.finished, onclick: () => this.ask(), text: left > 0 ? t('sn_ask', { n: left }) : t('sn_noask') }));
    }
  }
}
