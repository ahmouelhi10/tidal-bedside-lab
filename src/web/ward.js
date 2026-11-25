// Infectiology ward workspace: clock in days, observations, microbiology and antibiogram, prescriptions and orders.
// Reads the engine's Ward (p.ward) and changes it only through ui.act() -> Patient.dispatch (so every case replays).
import { t, getLang } from './i18n.js';
import { ABX, ABX_KEYS, antibiogram, doseFor, fluidVolumeMl, cockcroftGault, EUCAST_VERSION } from '/engine/infection.js';
import { bmiOf } from '/engine/anthropometrics.js';

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'dataset') Object.assign(e.dataset, v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const ADMIT_HOUR = 8;                                  // admission at 08:00 on day 1 (presentation only)
export const wardClock = (h) => { const a = h + ADMIT_HOUR; return t('wd_clock', { d: Math.floor(a / 24) + 1, hh: String(a % 24).padStart(2, '0') }); };
export const abxName = (k) => t('abx_' + k);
const catCls = c => (c === 'S' ? 'good' : c === 'I' ? 'warn' : c === 'R' ? 'bad' : 'muted');
const num = x => String(+x.toPrecision(3));

export class WardView {
  constructor(ui) { this.ui = ui; this.quiz = true; this.answers = {}; this.form = { drug: 'ceftriaxone', route: 'iv', dose: 'std' }; this.results = []; }
  get p() { return this.ui.sim.patient; }
  get w() { return this.p?.ward; }
  act(ev, label) { const r = this.ui.act(ev, label); if (r && r.ok !== false && ev.type === 'ward.order') this.results.push({ h: this.w.h, what: ev.what, r }); this.redraw(); return r; }
  /** rebuild the panel and keep the reader where they were */
  redraw() { const P = this.ui.dom.panel, y = P.scrollTop; this.ui.buildTabs(); P.scrollTop = y; }

  render(P) {
    const w = this.w; if (!w) { P.append(el('p', { class: 'muted', text: t('wd_none') })); return; }
    P.classList.add('ward');
    P.append(this.head(w), this.obsBox(w), this.microBox(w), this.rxBox(w), this.ordersBox(w));
  }

  // ---------------------------------------------------------------- clock and time
  head(w) {
    const adv = (h) => this.act({ type: 'ward.advance', hours: h });
    const toMorning = () => { const a = (w.h + ADMIT_HOUR) % 24; return a < 8 ? 8 - a : 32 - a; };
    const sp = this.p.spec, b = this.p.body;
    return el('div', { class: 'wd-head card' },
      el('div', { class: 'wd-clock' }, el('b', { text: wardClock(w.h) }), el('span', { class: 'muted small', text: t('wd_hours', { h: w.h }) })),
      el('div', { class: 'wd-time' }, el('span', { class: 'small muted', text: t('wd_advance') }),
        ...[1, 4, 12, 24].map(h => el('button', { class: 'ghost', dataset: { adv: h }, onclick: () => adv(h), text: `+${h} h` })),
        el('button', { class: 'ghost', onclick: () => adv(toMorning()), text: t('wd_morning') })),
      el('div', { class: 'small muted', text: t('wd_patient', { sex: t(sp.sex === 'F' ? 'female' : 'male'), age: sp.age, h: sp.heightCm, w: sp.weightKg, bmi: bmiOf(sp.weightKg, sp.heightCm).toFixed(1), ibw: Math.round(b.ibw) }) }));
  }

  // ---------------------------------------------------------------- observations and labs
  obsBox(w) {
    const v = w.vitals(), crit = [['wd_temp', `${v.temp} °C`, v.temp <= 37.8], ['wd_hr', `${v.hr}/min`, v.hr <= 100], ['wd_rr', `${v.rr}/min`, v.rr <= 24], ['wd_bp', `${v.sbp}/${v.dbp}`, v.sbp >= 90],
      ['wd_spo2', `${v.spo2} %`, v.spo2 >= 90], ['wd_mental', t(v.alert ? 'wd_alert' : 'wd_confused'), v.alert], ['wd_eating', t(v.eating ? 'wd_yes' : 'wd_no'), v.eating]];
    const rows = w.obs.slice(-6).reverse();
    const box = el('section', { class: 'wd-box' }, el('h4', { text: t('wd_obs') }),
      el('div', { class: 'wd-vitals' }, crit.map(([k, val, ok]) => el('div', { class: 'wd-v ' + (ok ? 'ok' : 'off') }, el('span', { class: 'small muted', text: t(k) }), el('b', { text: val })))),
      el('p', { class: 'small muted', text: t('wd_stab_hint') }));
    if (rows.length > 1) box.append(el('table', { class: 'wd-tab small' }, el('tr', {}, ['wd_when', 'wd_temp', 'wd_hr', 'wd_bp', 'wd_rr', 'wd_spo2'].map(k => el('th', { text: t(k) }))),
      rows.map(o => el('tr', {}, el('td', { text: wardClock(o.h) }), el('td', { text: o.temp }), el('td', { text: o.hr }), el('td', { text: `${o.sbp}/${o.dbp}` }), el('td', { text: o.rr }), el('td', { text: o.spo2 })))));
    const last = w.labs[w.labs.length - 1];
    if (last) box.append(el('div', { class: 'small wd-labs' }, el('b', { text: t('wd_labs_at', { when: wardClock(last.h) }) }), ' ',
      t('wd_labs_line', { wbc: last.wbc, crp: last.crp, pct: last.pct, lac: last.lactate, cr: last.creat, crcl: last.crcl })));
    return box;
  }

  // ---------------------------------------------------------------- microbiology
  microBox(w) {
    const S = (kind) => this.act({ type: 'ward.sample', kind }, t('wd_s_' + kind));
    const box = el('section', { class: 'wd-box' }, el('h4', { text: t('wd_micro') }),
      el('div', { class: 'wd-btns' }, ['blood', 'urine', 'sputum', 'uag'].map(k => el('button', { class: 'ghost', dataset: { ws: k }, onclick: () => S(k), text: t('wd_s_' + k) }))));
    const reps = w.reports();
    if (!reps.length) box.append(el('p', { class: 'small muted', text: t('wd_no_samples') }));
    let showAst = false;
    for (const r of reps) {
      const lines = r.lines.map(l => { if (l.k === 'ast') showAst = true; return t('wd_r_' + l.k, { gram: l.gram ? t('wd_g_' + l.gram) : '', org: l.org || '' }); });
      box.append(el('div', { class: 'wd-rep small' }, el('b', { text: `${t('wd_s_' + r.kind)} · ${wardClock(r.h)}${w.samples[r.i].preAbx ? '' : ' · ' + t('wd_on_abx')}` }), el('span', { text: lines.join(' · ') })));
    }
    if (showAst) box.append(this.astTable(w));
    return box;
  }
  astTable(w) {
    const iso = w.iso, rows = antibiogram(iso);
    const wrap = el('div', { class: 'wd-ast' }, el('div', { class: 'wd-ast-h' }, el('b', { text: t('wd_ast_title', { org: iso.name, v: EUCAST_VERSION }) }),
      el('label', { class: 'chk small' }, el('input', { type: 'checkbox', checked: this.quiz, onchange: e => { this.quiz = e.target.checked; this.redraw(); } }), ' ', t('wd_quiz'))));
    const tab = el('table', { class: 'wd-tab small' }, el('tr', {}, ['wd_agent', 'MIC', 'S ≤', 'R >', 'wd_cat'].map(k => el('th', { text: k.startsWith('wd_') ? t(k) : k }))));
    for (const r of rows) {
      const key = iso.name + ':' + r.key, ans = this.answers[key];
      const name = t('bp_' + r.key) !== 'bp_' + r.key ? t('bp_' + r.key) : abxName(r.key);
      let cell;
      if (r.inferred) cell = el('span', { class: catCls(r.cat), text: `${r.cat} (${t('wd_inferred')})` });
      else if (!this.quiz || ans) cell = el('span', {}, el('b', { class: catCls(r.cat), text: r.cat }), ans ? el('span', { class: ans === r.cat ? 'good' : 'bad', text: ans === r.cat ? ' ✓' : ` ✗ (${ans})` }) : '');
      else cell = el('span', { class: 'wd-quiz' }, ['S', 'I', 'R'].map(c => el('button', { class: 'ghost tiny', onclick: () => { this.answers[key] = c; this.redraw(); }, text: c })));
      tab.append(el('tr', {}, el('td', { text: name + (r.bracket ? ' ()' : '') + (r.screen ? ` (${t('wd_screen')})` : '') }), el('td', { text: r.inferred ? '-' : num(r.mic) }),
        el('td', { text: r.inferred ? '' : (r.s === 0.001 ? '(I)' : num(r.s)) }), el('td', { text: r.inferred ? '' : num(r.r) }), el('td', {}, cell)));
    }
    wrap.append(tab, el('p', { class: 'small muted', text: t('wd_sir_def') }));
    const done = Object.keys(this.answers).filter(k => k.startsWith(iso.name + ':'));
    if (this.quiz && done.length) { const ok = done.filter(k => rows.find(r => iso.name + ':' + r.key === k)?.cat === this.answers[k]).length; wrap.append(el('p', { class: 'small', text: t('wd_quiz_score', { ok, n: done.length }) })); }
    return wrap;
  }

  // ---------------------------------------------------------------- prescriptions
  rxBox(w) {
    const f = this.form, a = ABX[f.drug]; if (!a.routes.includes(f.route)) f.route = a.routes[0];
    const dose = doseFor(f.drug, f.route, f.dose, this.p.body);
    const sel = (id, opts, val, on) => el('select', { id, onchange: e => { on(e.target.value); this.redraw(); } }, opts.map(([v, txt]) => el('option', { value: v, text: txt, selected: v === val })));
    const drugSel = sel('wdDrug', ABX_KEYS.map(k => [k, abxName(k)]).sort((x, y) => x[1].localeCompare(y[1], getLang())), f.drug, v => { f.drug = v; });
    const routeSel = sel('wdRoute', a.routes.map(r => [r, t('wd_' + r)]), f.route, v => { f.route = v; });
    const doseSel = sel('wdDose', [['std', t('wd_std')], ...(a.dose[f.route]?.high ? [['high', t('wd_high')]] : [])], dose?.level ?? 'std', v => { f.dose = v; });
    const doseTxt = dose ? [dose.text, dose.mg ? t('wd_mg_range', { a: dose.mg[0], b: dose.mg[1], w: this.p.spec.weightKg }) : '', dose.loadingMg ? t('wd_loading', { mg: dose.loadingMg, w: this.p.spec.weightKg }) : ''].filter(Boolean).join(' · ') : '';
    const box = el('section', { class: 'wd-box' }, el('h4', { text: t('wd_rx') }),
      el('div', { class: 'wd-form' }, drugSel, routeSel, doseSel, el('button', { class: 'primary', id: 'wdRx', onclick: () => this.act({ type: 'ward.rx.start', drug: f.drug, route: f.route, dose: dose?.level ?? 'std' }, abxName(f.drug)), text: t('wd_prescribe') })),
      el('p', { class: 'small muted', text: `${t('wd_eucast_dose')}: ${doseTxt}` }));
    const last = w.labs[w.labs.length - 1];
    box.append(el('p', { class: 'small muted', text: last ? t('wd_crcl', { v: Math.round(cockcroftGault(this.p.spec, last.creat)) }) : t('wd_crcl_none') }));
    if (!w.rx.length) box.append(el('p', { class: 'small muted', text: t('wd_no_rx') }));
    for (const r of w.rx) {
      const days = ((w.h - r.startH) / 24).toFixed(1), dd = doseFor(r.drug, r.route, r.dose, this.p.body);
      box.append(el('div', { class: 'wd-rx' }, el('span', {}, el('b', { text: abxName(r.drug) }), ` ${t('wd_' + r.route)} · ${dd?.text ?? ''} · ${t('wd_since', { when: wardClock(r.startH), d: days })}`),
        el('button', { class: 'ghost danger tiny', dataset: { stop: r.drug }, onclick: () => this.act({ type: 'ward.rx.stop', drug: r.drug }, t('wd_stop') + ' ' + abxName(r.drug)), text: t('wd_stop') })));
    }
    const past = w.courses.filter(r => r.stopH !== null);
    if (past.length) box.append(el('p', { class: 'small muted', text: t('wd_past') + ': ' + past.map(r => `${abxName(r.drug)} ${t('wd_' + r.route)} (${((r.stopH - r.startH) / 24).toFixed(1)} ${t('wd_days')})`).join(', ') }));
    box.append(el('p', { class: 'small muted', text: t('wd_active_days', { d: (w.activeH / 24).toFixed(1) }) }));
    return box;
  }

  // ---------------------------------------------------------------- orders and end of case
  ordersBox(w) {
    const vol = fluidVolumeMl(this.p.body);
    const list = [['labs', t('wd_o_labs')], ['lactate', t('wd_o_lactate')], ['fluids30', t('wd_o_fluids', { ml: vol, w: this.p.spec.weightKg })], ['cxr', t('wd_o_cxr')], ['renal_us', t('wd_o_renal_us')], ['tte', t('wd_o_tte')], ...(w.lineIn ? [['remove_line', t('wd_o_remove_line')]] : [])];
    const box = el('section', { class: 'wd-box' }, el('h4', { text: t('wd_orders') }),
      el('div', { class: 'wd-btns' }, list.map(([k, txt]) => el('button', { class: 'ghost', dataset: { wo: k }, onclick: () => this.act({ type: 'ward.order', what: k }, txt), text: txt }))));
    for (const x of this.results.filter(x => x.r.finding || x.r.volumeMl).slice(-5).reverse()) box.append(el('div', { class: 'small wd-rep' }, el('b', { text: `${t('wd_o_' + x.what, { ml: x.r.volumeMl ?? '', w: this.p.spec.weightKg })} · ${wardClock(x.h)}` }), el('span', { text: x.r.finding ? t('wd_f_' + x.r.finding) : t('wd_given') })));
    box.append(el('div', { class: 'wd-end' }, el('p', { class: 'small muted', text: t('wd_end_hint') }), el('button', { class: 'primary', id: 'wdEnd', onclick: () => this.ui.onFinish?.(), text: t('wd_end') })));
    return box;
  }
}
