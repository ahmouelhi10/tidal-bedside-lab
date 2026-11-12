// Pre-brief before a scored case, self-assessment before the score, and the debrief in the four PEARLS phases
// (reactions, description, analysis, summary). The analysis comes from /engine/debrief.js on the replayed timeline.
import { t } from './i18n.js';
import { PREBRIEF_ITEMS, ANTS_CATEGORIES, PEARLS_PHASES, debriefMoments, calibration } from '/engine/debrief.js';

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
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } } };
const modal = (label, cls = '') => { const ov = el('div', { class: 'modal ' + cls, role: 'dialog', 'aria-modal': 'true', 'aria-label': label }); return ov; };

/** Pre-brief: fiction contract, safety, orientation, objectives (INACSL). Resolves when the learner is ready. */
export function prebrief(caseText, team = false) {
  return new Promise((resolve) => {
    if (store.get('tbl.skipPrebrief') === '1') { resolve({ team }); return; }
    const ov = modal(t('pb_title'), 'pb'), skip = el('input', { type: 'checkbox', id: 'pbSkip' }), tm = el('input', { type: 'checkbox', id: 'pbTeam', checked: team });
    const items = PREBRIEF_ITEMS.filter(k => k !== 'objectives').map(k => el('li', {}, el('b', { text: t('pb_h_' + k) }), el('span', { text: t('pb_' + k) })));
    const go = () => { if (skip.checked) store.set('tbl.skipPrebrief', '1'); ov.remove(); resolve({ team: tm.checked }); };
    ov.append(el('div', { class: 'box pb-box' },
      el('div', { class: 'phead' }, el('h2', { text: t('pb_title') + (caseText ? ' · ' + caseText.title : '') })),
      caseText ? el('p', { class: 'summary', text: caseText.summary }) : null,
      el('ul', { class: 'pb-list' }, ...items),
      caseText?.learning?.length ? el('div', {}, el('h4', { text: t('pb_h_objectives') }), el('ul', { class: 'muted' }, caseText.learning.map(l => el('li', { text: l })))) : null,
      el('label', { class: 'chk pb-team' }, tm, el('span', {}, el('b', { text: ' ' + t('tm_mode') }), el('span', { class: 'small muted', text: ' · ' + t('tm_mode_t') }))),
      el('div', { class: 'db-actions' }, el('label', { class: 'small muted pb-skip' }, skip, ' ' + t('pb_skip')), el('button', { class: 'primary', onclick: go, text: t('pb_go') }))));
    document.body.append(ov); ov.querySelector('button.primary')?.focus();
  });
}

/** Self-assessment before the score: estimated score and the four ANTS categories (1-4). Resolves null if skipped. */
export function selfAssess() {
  return new Promise((resolve) => {
    const ov = modal(t('db_self_title'));
    const pct = el('input', { type: 'range', min: 0, max: 100, step: 5, value: 60, 'aria-label': t('db_self_pct') }), pv = el('b', { text: '60 %' });
    pct.addEventListener('input', () => { pv.textContent = pct.value + ' %'; });
    const ants = {}, rows = ANTS_CATEGORIES.map(k => el('div', { class: 'sa-row' }, el('span', { text: t('db_a_' + k) }),
      el('div', { class: 'seg', role: 'radiogroup', 'aria-label': t('db_a_' + k) }, ...[1, 2, 3, 4].map(v => { const b = el('button', { type: 'button', title: t('db_ants_' + v), text: String(v), onclick: () => { ants[k] = v; for (const x of b.parentElement.children) x.classList.toggle('on', x === b); } }); return b; }))));
    const done = (v) => { ov.remove(); resolve(v); };
    ov.append(el('div', { class: 'box sa-box' },
      el('div', { class: 'phead' }, el('h2', { text: t('db_self_title') })),
      el('p', { class: 'muted small', text: t('db_self_note') }),
      el('div', { class: 'sa-row' }, el('span', { text: t('db_self_pct') }), pct, pv),
      el('h4', { text: t('db_self_ants') }), el('p', { class: 'muted small', text: t('db_ants_scale') }), ...rows,
      el('div', { class: 'db-actions' }, el('button', { class: 'ghost', onclick: () => done(null), text: t('db_self_skip') }), el('button', { class: 'primary', onclick: () => done({ pct: Number(pct.value), ants: { ...ants } }), text: t('db_self_go') }))));
    document.body.append(ov);
  });
}

/** The PEARLS stepper inside the debrief box. sections: { reactions, description, analysis, summary } element bodies. */
export function pearls(sections) {
  const tabs = PEARLS_PHASES.map((k, i) => el('button', { class: 'pl-tab', type: 'button', dataset: { k }, text: `${i + 1}. ${t('db_ph_' + k)}` }));
  const bodies = Object.fromEntries(PEARLS_PHASES.map(k => [k, el('section', { class: 'pl-body', hidden: true }, sections[k])]));
  const show = (k) => { tabs.forEach(b => b.classList.toggle('on', b.dataset.k === k)); for (const [n, b] of Object.entries(bodies)) b.hidden = n !== k; };
  tabs.forEach(b => b.addEventListener('click', () => show(b.dataset.k)));
  const next = (k) => { const i = PEARLS_PHASES.indexOf(k); return i < PEARLS_PHASES.length - 1 ? el('button', { class: 'ghost pl-next', type: 'button', onclick: () => show(PEARLS_PHASES[i + 1]), text: t('db_next') + ' → ' + t('db_ph_' + PEARLS_PHASES[i + 1]) }) : null; };
  for (const k of PEARLS_PHASES) { const n = next(k); if (n) bodies[k].append(n); }
  show('reactions');
  return { root: el('div', { class: 'pearls' }, el('div', { class: 'pl-tabs', role: 'tablist' }, ...tabs), ...Object.values(bodies)), show };
}

/** A reflection box whose text is kept in notes[key] (goes into the competency record). */
export function reflect(notes, key, prompt) {
  const ta = el('textarea', { rows: 3, maxlength: 1200, placeholder: t('db_write'), 'aria-label': prompt });
  ta.value = notes[key] || ''; ta.addEventListener('input', () => { notes[key] = ta.value; });
  return el('label', { class: 'f wide reflect' }, el('span', { text: prompt }), ta);
}

/** Calibration card: estimated vs verified score (shown in the analysis phase). */
export function calibrationCard(self, sc) {
  if (!self || !sc) return null;
  const c = calibration(self.pct, sc.pct); if (!c) return null;
  return el('div', { class: 'cal ' + c.verdict }, el('b', { text: t('db_cal_title') }), el('p', { text: t('db_cal_' + c.verdict, { s: self.pct, a: Math.round(sc.pct), d: Math.abs(c.diff) }) }));
}

/** Moments to discuss, each stated as an observation then an open question (advocacy-inquiry). onGoto(t) highlights the timeline. */
export function momentsList(tl, keyTimes, describe, onGoto) {
  const m = debriefMoments(tl, keyTimes);
  if (!m.length) return el('p', { class: 'muted', text: t('db_none') });
  return el('ol', { class: 'moments' }, ...m.map(x => {
    const vars = { t: mmss(x.t), dur: mmss(x.dur || 0), v: x.value ?? '' };
    const act = x.kind === 'no_monitoring' || x.kind === 'late_monitoring' ? null : x.action ? t('db_act', { a: describe(x.action.ev) || x.action.type, at: mmss(x.action.t) }) : x.kind === 'rejected' ? null : t('db_noact');
    return el('li', { class: 'mo sev' + x.severity },
      el('div', { class: 'mo-head' }, el('b', { text: t('db_m_' + x.kind, vars) }), x.t > 0 ? el('button', { class: 'ghost mo-go', type: 'button', onclick: () => onGoto(x.t), text: '⟶ ' + mmss(x.t) }) : null),
      act ? el('span', { class: 'small muted', text: act }) : null,
      el('p', { class: 'mo-q', text: t('db_q_' + x.kind, vars) }));
  }));
}
