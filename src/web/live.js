// Live instructor control.
// LiveLink (learner's browser): opens the case's live channel, shows the join code and whether an instructor is watching,
// streams a state summary every second, and applies the instructor's changes as ordinary logged engine events.
// LiveConsole (instructor's browser): joins with the code, shows the true physiology and the learner's actions, and sends
// changes (vf, bleed, tension pneumothorax ...) and debrief markers.
import { t } from './i18n.js';

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
const SKIP = new Set(['note', 'nibp.cycle', 'instructor.inject']);

export class LiveLink {
  constructor({ sim, ui }) { this.sim = sim; this.ui = ui; this.es = null; this.timer = null; this.code = null; this.watchers = 0; }
  async start() {
    this.stop(); const token = this._token = {};                          // a newer start() supersedes this one
    const id = this.sim.session?.id; if (!id) return;                        // offline sessions have no live channel
    try {
      const r = await fetch(`/api/live/${id}/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!r.ok) return; this.code = (await r.json()).code;
    } catch { return; }
    if (this._token !== token || this.sim.session?.id !== id) return;       // a new case started meanwhile
    this.es = new EventSource(`/api/live/${id}/stream`);
    this.es.addEventListener('watchers', (e) => { this.watchers = JSON.parse(e.data).watchers; this._chip(); });
    this.es.addEventListener('cmd', (e) => this._apply(JSON.parse(e.data)));
    this.timer = setInterval(() => this._push(id), 1000);
    this._chip();
  }
  stop() { this._token = null; this.es?.close(); this.es = null; clearInterval(this.timer); this.timer = null; this.code = null; this.watchers = 0; this._chip(); }
  _apply(c) {
    if (!this.sim.patient || this.sim.finished) return;
    const { seq, ...cmd } = c;
    this.sim.act({ type: 'instructor.inject', ...cmd });                     // logged like any event: the session still replays
  }
  _push(id) {
    const p = this.sim.patient; if (!p || this.sim.session?.id !== id) return;
    const s = p.snapshot(), m = p.monitor;
    const feed = p.log.filter(e => !SKIP.has(e.type)).slice(-10).map(e => ({ t: e.t, text: this.ui.describe(e) || e.type }));
    const body = { t: +p.t.toFixed(0), finished: this.sim.finished, speed: this.sim.speed, rhythm: s.rhythm, arrested: s.arrested,
      truth: { hr: Math.round(s.hr), sbp: Math.round(s.sbp), dbp: Math.round(s.dbp), map: Math.round(s.map), spo2: Math.round(s.spo2True), etco2: Math.round(s.etco2), rr: Math.round(s.rr), temp: s.core, k: s.k, lost: Math.round(s.fractionLost * 100) },
      shown: { hr: m.hr, sbp: m.sbp, dbp: m.dbp, spo2: m.spo2, etco2: m.etco2, rr: m.rr, temp: m.temp }, feed };
    fetch(`/api/live/${id}/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => { if (r.status === 404 && this.sim.session?.id === id) this.stop(); }).catch(() => {});   // channel gone (server restarted)
  }
  _chip() {
    const c = this.ui.dom?.liveChip; if (!c) return;
    c.hidden = !this.code;
    if (!this.code) return;
    c.textContent = (this.watchers ? '👁 ' : '') + t('lv_chip', { code: this.code });
    c.title = this.watchers ? t('lv_watched', { n: this.watchers }) : t('lv_chip_t');
    c.classList.toggle('on', this.watchers > 0);
  }
}

/** Instructor's live console (full-window overlay). */
export class LiveConsole {
  constructor(ui) { this.ui = ui; this.es = null; this.root = null; }
  open(code) {
    code = String(code || '').trim().toUpperCase(); if (!code) return;
    this.close(); this.code = code;
    const d = this.d = {};
    d.status = el('span', { class: 'lv-status', text: t('lv_connecting') });
    d.title = el('b', { text: t('lv_title') + ' · ' + code });
    d.vit = el('div', { class: 'lv-vitals' }); d.feed = el('ol', { class: 'lv-feed small' }); d.sent = el('ol', { class: 'lv-sent small' });
    d.info = el('p', { class: 'muted small' });
    const B = (label, cmd, cls = '') => el('button', { class: 'lv-btn ' + cls, type: 'button', onclick: () => this.send(cmd()), text: label });
    const ml = el('input', { type: 'number', min: 20, max: 1000, step: 10, value: 300, 'aria-label': 'mL/min' });
    const side = el('select', { 'aria-label': t('lv_side') }, el('option', { value: 'R', text: t('lv_right') }), el('option', { value: 'L', text: t('lv_left') }));
    const note = el('input', { type: 'text', maxlength: 200, placeholder: t('lv_marker_ph') });
    const sendNote = () => { if (note.value.trim()) { this.send({ what: 'marker', text: note.value.trim() }); note.value = ''; } };
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendNote(); });
    const controls = el('div', { class: 'lv-ctl' },
      el('h4', { text: t('lv_rhythm') }), el('div', { class: 'lv-grid' }, B(t('lv_vf'), () => ({ what: 'vf' }), 'bad'), B(t('lv_pea'), () => ({ what: 'pea' }), 'bad'), B(t('lv_asys'), () => ({ what: 'asystole' }), 'bad'), B(t('lv_svt'), () => ({ what: 'svt' })), B(t('lv_af'), () => ({ what: 'af' })), B(t('lv_brady'), () => ({ what: 'brady' })), B(t('lv_avb3'), () => ({ what: 'avblock3' })), B(t('lv_tdp'), () => ({ what: 'torsades' }), 'bad'), B(t('lv_flutter'), () => ({ what: 'flutter' })), B(t('lv_avb1'), () => ({ what: 'avblock1' })), B(t('lv_avb2'), () => ({ what: 'avblock2' })), B(t('lv_wenck'), () => ({ what: 'wenckebach' })), B(t('lv_lbbb'), () => ({ what: 'lbbb' })), B(t('lv_rbbb'), () => ({ what: 'rbbb' })), B(t('lv_bbb_off'), () => ({ what: 'bbb_off' }))),
      el('h4', { text: t('lv_events') }),
      el('div', { class: 'lv-row' }, B(t('lv_bleed'), () => ({ what: 'bleed', mlPerMin: Number(ml.value) })), ml, el('span', { class: 'muted small', text: 'mL/min' }), B(t('lv_bleed_stop'), () => ({ what: 'bleed_stop' }))),
      el('div', { class: 'lv-row' }, B(t('lv_ptx'), () => ({ what: 'tension_ptx', side: side.value })), side),
      el('div', { class: 'lv-grid' }, B(t('lv_hyperk'), () => ({ what: 'hyperkalaemia' })), B(t('lv_seizure'), () => ({ what: 'seizure' }), 'bad'), B(t('lv_airway'), () => ({ what: 'airway_obstruction' })), B(t('lv_ana'), () => ({ what: 'anaphylaxis' }), 'bad'), B(t('lv_bronch'), () => ({ what: 'bronchospasm' })), B(t('lv_mh'), () => ({ what: 'mh' }), 'bad'), B(t('lv_hypo'), () => ({ what: 'hypoglycaemia' }))),
      el('h4', { text: t('lv_marker') }), el('p', { class: 'muted small', text: t('lv_marker_t') }),
      el('div', { class: 'lv-row' }, note, el('button', { class: 'primary', type: 'button', onclick: sendNote, text: t('lv_send') })),
      el('h4', { text: t('lv_sent') }), d.sent);
    this.root = el('div', { class: 'live', role: 'dialog', 'aria-label': t('lv_title') },
      el('header', { class: 'lv-head' }, d.title, d.status, el('button', { class: 'x', 'aria-label': t('close'), onclick: () => this.close(), text: '×' })),
      el('div', { class: 'lv-body' }, el('div', { class: 'lv-mon' }, d.info, d.vit, el('h4', { text: t('lv_feed') }), d.feed), controls));
    document.body.append(this.root);
    this.es = new EventSource(`/api/live/join/${encodeURIComponent(code)}`);
    this.es.addEventListener('hello', (e) => { const h = JSON.parse(e.data); this.hello = h; this._info(); this._status(h.learnerOnline); });
    this.es.addEventListener('learner', (e) => this._status(JSON.parse(e.data).online));
    this.es.addEventListener('state', (e) => this._state(JSON.parse(e.data)));
    this.es.addEventListener('sent', (e) => { const c = JSON.parse(e.data); d.sent.prepend(el('li', { text: `#${c.seq} ${c.what === 'marker' ? '📍 ' + c.text : t('lv_w_' + c.what) + (c.mlPerMin ? ` ${c.mlPerMin} mL/min` : '') + (c.side ? ` (${c.side})` : '')}` })); });
    this.es.onerror = () => { if (this.es?.readyState === EventSource.CLOSED) { d.status.textContent = t('lv_nocase'); d.status.className = 'lv-status bad'; } else { d.status.textContent = t('lv_connecting'); d.status.className = 'lv-status'; } };
  }
  close() { this.es?.close(); this.es = null; this.root?.remove(); this.root = null; }
  async send(cmd) {
    try {
      const r = await fetch(`/api/live/join/${encodeURIComponent(this.code)}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) this.ui.toast(b.error || `HTTP ${r.status}`, true); else if (!b.delivered) this.ui.toast(t('lv_offline'), true);
    } catch { this.ui.toast(t('offline'), true); }
  }
  _status(online) { this.d.status.textContent = online ? t('lv_online') : t('lv_learner_off'); this.d.status.className = 'lv-status ' + (online ? 'good' : 'warn'); }
  _info() {
    const h = this.hello; if (!h) return;
    const sc = h.scenario ? this.ui.scenarios.find(s => s.id === h.scenario) : null, x = sc ? this.ui.caseTextOf?.(sc) : null;
    const sp = h.spec ? `${h.spec.sex === 'F' ? t('female') : t('male')}, ${h.spec.age} ${t('rec_years')}, ${h.spec.weightKg} kg` : '';
    this.d.info.textContent = `${x ? x.title : t('free_play')} · ${h.learner || t('lv_anon')} · ${sp}`;
  }
  _state(s) {
    const T = s.truth || {}, S = s.shown || {};
    const tile = (label, v, shown, cls = '') => el('div', { class: 'lv-tile ' + cls }, el('i', { text: label }), el('b', { text: v }), el('span', { class: 'small muted', text: shown === undefined ? t('lv_truth_only') : shown == null ? t('lv_not_shown') : t('lv_shown', { v: shown }) }));
    this.d.vit.replaceChildren(
      el('div', { class: 'lv-tile wide ' + (s.arrested ? 'bad' : '') }, el('i', { text: t('lv_rhythm') }), el('b', { text: s.rhythm + (s.arrested ? ' · ' + t('lv_arrest') : '') }), el('span', { class: 'small muted', text: `${t('lv_time')} ${mmss(s.t)}${s.speed === 0 ? ' · ' + t('paused') : s.speed > 1 ? ` · ${s.speed}×` : ''}${s.finished ? ' · ' + t('lv_finished') : ''}` })),
      tile('HR', T.hr, S.hr, 'hr'), tile(t('ec_bp'), `${T.sbp}/${T.dbp}`, S.sbp == null ? null : `${S.sbp}/${S.dbp}`, 'co'), tile('SpO₂', T.spo2 + ' %', S.spo2 == null ? null : S.spo2 + ' %', 'sp'),
      tile('EtCO₂', T.etco2, S.etco2), tile(t('ec_rr'), T.rr, S.rr), tile('T°', T.temp?.toFixed?.(1) ?? T.temp, S.temp),
      tile('K⁺', T.k?.toFixed?.(1) ?? T.k, undefined), tile(t('lv_lost'), (T.lost ?? 0) + ' %', undefined));
    this.d.feed.replaceChildren(...(s.feed || []).slice().reverse().map(f => el('li', {}, el('span', { class: 'muted', text: mmss(f.t) + ' ' }), f.text)));
    if (!(s.feed || []).length) this.d.feed.append(el('li', { class: 'muted', text: t('lv_nofeed') }));
  }
}
