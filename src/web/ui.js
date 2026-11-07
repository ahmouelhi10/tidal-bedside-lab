// DOM user interface: scenario/patient setup, intervention panels, event log, trends, teaching overlay, debrief. No framework.
import { t, getLang, setLang, drugName, scenarioText, CRITERION_FR } from './i18n.js';
import { SPEEDS } from './sim.js';
import { DRUGS } from '/engine/drugs.js';
import { bmiOf, bmiClass } from '/engine/anthropometrics.js';
import { SKIN_TONES } from './gl/body.js';
import { CAMERAS } from './scene.js';
import { PROCEDURES, PARAMS, Guide } from './procedures.js';
import { icon, stepIcon } from './icons.js';
import { TOOLS } from './handson.js';

/** Skills training: the case each procedure is practised on (the condition that makes the procedure meaningful). */
const SKILL_CASE = { iv: '', rsi: 'obese_rsi', defib: 'witnessed_vf', needle: 'tension_ptx', drain: 'tension_ptx', fona: 'cico' };
/** Instruments on the table besides the ones the procedure needs: choosing the right one is part of the skill. */
const DISTRACTORS = ['scalpel', 'syringe', 'tourniquet', 'bougie', 'forcepsGauze'];

const L = (o) => (o ? (getLang() === 'fr' ? o.fr : o.en) ?? o.en : '');
/** Event types that already play their own hand gesture and frame the camera (see Gestures.start). */
const GESTURE_TYPES = new Set(['drug.bolus', 'bicarb.bolus', 'iv.access', 'procedure.needle_decompression', 'procedure.chest_tube', 'procedure.cricothyroidotomy', 'exam.pocus', 'exam.chest', 'exam.neck', 'airway.intubate']);

const SVG_NS = 'http://www.w3.org/2000/svg';
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'dataset') Object.assign(e.dataset, v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

const svg = (d) => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  drugs: svg('<path d="M18 2l4 4M15 5l4 4M7 13l8-8 4 4-8 8H7z"/><path d="M5 19l-3 3"/>'),
  fluids: svg('<path d="M12 3C8 9 5 12 5 15a7 7 0 0014 0c0-3-3-6-7-12z"/>'),
  airway: svg('<path d="M12 3v8M12 11c-2 0-3-1-4-1-3 1-5 5-5 9 0 1 1 2 2 2 3 0 5-1 6-4M12 11c2 0 3-1 4-1 3 1 5 5 5 9 0 1-1 2-2 2-3 0-5-1-6-4"/>'),
  cpr: svg('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
  proc: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  orders: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h6"/>'),
  guide: svg('<path d="M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h7"/><path d="M3.5 6.5l1 1 2-2"/>'),
};
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const round = (x, step) => Math.round(x / step) * step;
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
/** Wrap every numeric field in [-][value][+]. The input stays first in the DOM, so a surrounding <label> still targets it. */
function stepify(root) {
  for (const inp of root.querySelectorAll('input[type=number]')) {
    if (inp.parentElement?.classList.contains('stp')) continue;
    const step = Number(inp.step) || 1, min = inp.min === '' ? -Infinity : Number(inp.min), max = inp.max === '' ? Infinity : Number(inp.max);
    const dec = (String(inp.step).split('.')[1] || '').length;
    const bump = (k) => { const v = Math.min(max, Math.max(min, (Number(inp.value) || 0) + k * step)); inp.value = v.toFixed(dec); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); };
    const w = el('div', { class: 'stp' }); inp.replaceWith(w);
    w.append(inp, el('button', { type: 'button', tabindex: '-1', 'aria-label': '-', text: '−', style: 'order:-1', onclick: () => bump(-1) }), el('button', { type: 'button', tabindex: '-1', 'aria-label': '+', text: '+', onclick: () => bump(1) }));
  }
}

/** dose table: perKg x basis weight. basis: lbm | ibw | tbw | fixed. inf: infusion units shown to the user and conversion to engine units/min. */
const DRUG_UI = [
  { g: 'g_hypnotics', items: [
    { k: 'propofol', per: 2.0, basis: 'lbm', step: 10, inf: { unit: 'mg/kg/h', def: 6, step: 0.5, toEngine: (v, b) => v * b.weightKg / 60 } },
    { k: 'etomidate', per: 0.3, basis: 'lbm', step: 1 },
    { k: 'ketamine', per: 1.5, basis: 'lbm', step: 5 },
    { k: 'midazolam', per: 0.03, basis: 'tbw', step: 0.5 },
    { k: 'dexmedetomidine', per: 0.5, basis: 'tbw', step: 5, inf: { unit: 'mcg/kg/h', def: 0.5, step: 0.1, toEngine: (v, b) => v * b.weightKg / 60 } },
  ] },
  { g: 'g_opioids', items: [
    { k: 'fentanyl', per: 1.0, basis: 'lbm', step: 25 },
    { k: 'remifentanil', per: 0.5, basis: 'lbm', step: 10, inf: { unit: 'mcg/kg/min', def: 0.15, step: 0.01, toEngine: (v, b) => v * b.lbm } },
    { k: 'naloxone', fixed: 400, step: 100 },
  ] },
  { g: 'g_nmb', items: [
    { k: 'rocuronium', per: 1.2, basis: 'ibw', step: 5 },
    { k: 'succinylcholine', per: 1.5, basis: 'tbw', step: 10 },
    { k: 'sugammadex', per: 4, basis: 'tbw', step: 10 },
  ] },
  { g: 'g_vaso', items: [
    { k: 'epinephrine', fixed: 1000, step: 100, inf: { unit: 'mcg/kg/min', def: 0.05, step: 0.01, toEngine: (v, b) => v * b.weightKg } },
    { k: 'norepinephrine', fixed: 10, step: 5, inf: { unit: 'mcg/kg/min', def: 0.1, step: 0.01, toEngine: (v, b) => v * b.weightKg } },
    { k: 'phenylephrine', fixed: 100, step: 25, inf: { unit: 'mcg/kg/min', def: 0.5, step: 0.1, toEngine: (v, b) => v * b.weightKg } },
    { k: 'vasopressin', fixed: 40, step: 1, warn: true },
    { k: 'atropine', fixed: 1000, step: 100 },
    { k: 'nitroglycerin', fixed: 400, step: 100, inf: { unit: 'mcg/min', def: 10, step: 5, toEngine: (v) => v } },
  ] },
  { g: 'g_acls', items: [
    { k: 'amiodarone', fixed: 300, step: 150 },
    { k: 'lidocaine', per: 1.0, basis: 'tbw', step: 10 },
    { k: 'adenosine', fixed: 6, step: 6 },
    { k: 'calciumChloride', fixed: 1000, step: 500 },
  ] },
];
const O2 = { room: { fio2: 0.21, seal: 0.5, key: 'aw_room' }, nc: { fio2: 0.36, seal: 0.6, key: 'aw_nc' }, mask: { fio2: 0.55, seal: 0.8, key: 'aw_mask' }, nrb: { fio2: 0.85, seal: 0.9, key: 'aw_nrb' } };

export class UI {
  constructor(root, ctx) {
    this.root = root; this.glCanvas = ctx.glCanvas; this.monCanvas = ctx.monCanvas; this.sim = ctx.sim; this.scene = ctx.scene; this.monitor = ctx.monitor; this.sound = ctx.sound;
    this.tab = 'tab_drugs'; this.logLines = []; this.teach = false; this.toastT = 0; this.scenarios = []; this.inputs = {};
  }

  // ---------------------------------------------------------------- chrome: full-screen 3D stage with a game-style HUD
  async init() {
    this.scenarios = await this.sim.scenarios();
    const r = this.root;
    r.replaceChildren();
    this.dom = {};
    if (this.menuOpen === undefined) this.menuOpen = !this.sim.patient;
    if (this.panelOpen === undefined) this.panelOpen = false;
    if (this.hints === undefined) this.hints = false;   // floating markers are opt-in (settings > Markers); hovering the patient or equipment still names it
    const top = el('header', { class: 'hud-top' },
      this.dom.clock = el('div', { class: 'clock', 'aria-live': 'off' }),
      el('div', { class: 'spacer' }),
      this.dom.speed = this.speedBar(),
      this.dom.btnBrief = el('button', { id: 'btnBrief', class: 'ghost', onclick: () => { this.dom.card.hidden = !this.dom.card.hidden; }, text: t('briefing') }),
      this.dom.btnNew = el('button', { id: 'btnNew', class: 'ghost', onclick: () => this.openMenu(), text: t('new_case') }),
      this.dom.btnFinish = el('button', { id: 'btnFinish', class: 'primary', onclick: () => this.onFinish?.(), text: t('finish') }),
      this.dom.opts = this.buildOpts());
    this.dom.noGl = el('div', { class: 'nogl', hidden: true, text: t('no_webgl') });
    this.dom.pins = el('div', { class: 'pins' });
    this.dom.alarm = el('div', { class: 'alarm', hidden: true, role: 'alert' }, this.dom.alarmText = el('span'));
    this.dom.left = el('aside', { class: 'hud-left' });
    this.dom.right = el('aside', { class: 'hud-right' });
    this.dom.tip = el('div', { class: 'tip', hidden: true });
    this.dom.toast = el('div', { class: 'toast', hidden: true, role: 'status' });
    this._alarmMode = null;
    this.buildLeft(); this.buildRight();
    r.append(el('div', { class: 'stage' }, this.glCanvas, this.dom.pins, this.dom.alarm), top, this.dom.left, this.dom.right, this.buildDock(),
      this.dom.hint = el('div', { class: 'hint', text: t('shortcuts') }), el('footer', { class: 'foot', text: t('disclaimer') }), this.buildMenu(), this.dom.noGl, this.dom.tip, this.dom.toast);
    if (this.sim.patient) { this.refreshCard(); this.buildTabs(); this.syncSetupFromSession(); }
    this.syncPins(); this.syncChrome();
  }
  /** Settings pop-over: sound, markers, teaching overlay, language. */
  buildOpts() {
    const box = el('div', { class: 'optsbox' },
      el('label', { class: 'chk' }, el('input', { type: 'checkbox', id: 'chkSound', onchange: e => { this.sound.enable(e.target.checked); } }), ' ', t('sound')),
      el('label', { class: 'chk' }, el('input', { type: 'checkbox', id: 'chkHints', checked: this.hints, onchange: e => { this.hints = e.target.checked; } }), ' ', t('hints')),
      el('label', { class: 'chk' }, el('input', { type: 'checkbox', id: 'chkTeach', checked: this.teach, onchange: e => { this.teach = e.target.checked; this.dom.teach.hidden = !this.teach; } }), ' ', t('teaching')),
      el('label', { class: 'f' }, el('span', { text: t('language') }), el('select', { id: 'selLang', onchange: e => { setLang(e.target.value); this.init(); this.onLang?.(); } },
        el('option', { value: 'en', text: 'English', selected: getLang() === 'en' }), el('option', { value: 'fr', text: 'Français', selected: getLang() === 'fr' }))));
    const d = el('details', { class: 'opts' }, el('summary', { title: t('settings'), 'aria-label': t('settings'), text: '⚙' }), box);
    if (!this._outside) { this._outside = true; document.addEventListener('pointerdown', e => { const o = this.dom?.opts; if (o && o.open && !o.contains(e.target)) o.open = false; }); }
    return d;
  }
  /** What is visible when: the case menu hides the in-game HUD, the bare start screen has no clock or controls. */
  syncChrome() {
    const d = this.dom, play = !!this.sim.patient && !this.menuOpen;
    for (const e of [d.clock, d.speed, d.cam, d.btnNew, d.btnFinish, d.left, d.right, d.dock, d.hint]) if (e) e.hidden = !play;
    d.btnBrief.hidden = !play || !this.scenarios.find(x => x.id === this.sim.scenarioId);
    if (!play && d.alarm) d.alarm.hidden = true; else this._alarmMode = null;
  }
  speedBar() {
    const w = el('div', { class: 'seg', role: 'group', 'aria-label': t('speed') });
    this.dom.speedBtns = SPEEDS.map(s => { const b = el('button', { dataset: { speed: s }, onclick: () => this.sim.setSpeed(s), text: s === 0 ? '❚❚' : s + '×', title: s === 0 ? t('paused') : s + '×' }); w.append(b); return b; });
    return w;
  }
  camBar() {
    const w = el('div', { class: 'seg', role: 'group' });
    for (const [k, key] of [['default', 'cam_reset'], ['head', 'cam_head'], ['chest', 'cam_chest'], ['arm', 'cam_arm'], ['side', 'cam_side'], ['top', 'cam_top'], ['foot', 'cam_foot']]) w.append(el('button', { onclick: () => this.scene.setCamera(k), text: t(key) }));
    return w;
  }
  buildDock() {
    const items = [['tab_guide', 'guide'], ['tab_drugs', 'drugs'], ['tab_fluids', 'fluids'], ['tab_airway', 'airway'], ['tab_circ', 'cpr'], ['tab_proc', 'proc'], ['tab_orders', 'orders']];
    this.dom.dockBtns = items.map(([k, ic]) => {
      const b = el('button', { class: 'dockbtn', id: 'dock-' + k, dataset: { tab: k }, 'aria-pressed': 'false', title: t(k), onclick: () => this.toggleTab(k) });
      b.insertAdjacentHTML('afterbegin', ICON[ic]); b.append(el('span', { text: t(k) })); return b;
    });
    return (this.dom.dock = el('nav', { class: 'hud-dock', 'aria-label': t('dock_label'), hidden: !this.sim.patient }, ...this.dom.dockBtns));
  }

  // ---------------------------------------------------------------- case menu (over the live 3D preview of the patient being built)
  buildMenu() {
    const m = this.dom.menu = el('div', { class: 'menu', hidden: !this.menuOpen, role: 'dialog', 'aria-label': t('menu_title') });
    this.dom.cards = el('div', { class: 'cards' });
    this.dom.setup = el('section', { class: 'card setup' });
    this.dom.resume = el('button', { id: 'btnResume', class: 'ghost wide', hidden: !this.sim.patient, onclick: () => this.closeMenu(true), text: t('back_to_patient') });
    this.dom.menuBody = el('div', { class: 'menuBody' });
    this.dom.menuR = el('div', { class: 'menuR' }, el('h3', { text: t('patient_builder') }), this.dom.setup, el('div', { class: 'muted small previewnote', text: t('preview_note') }), this.dom.resume);
    m.append(el('div', { class: 'menuL' }, el('h1', { text: t('app') }), el('p', { class: 'muted', text: t('menu_sub') }), this.dom.menuBody), this.dom.menuR);
    this.buildSetup(); this.menuView(this._view || 'home');
    return m;
  }
  /** Start screen: home (three sections), physiology lab, skills training, resuscitation and clinical challenges. */
  menuView(view) {
    this._view = view; const B = this.dom.menuBody; B.replaceChildren(); this.dom.menuR.hidden = view === 'home';
    if (view !== 'skills') this.pendingSkill = null;
    const back = () => el('button', { class: 'ghost menu-back', onclick: () => this.menuView('home') }, el('span', { class: 'ic' }), t('menu_back'));
    const sec = (id, ic, col, title, sub) => { const b = el('button', { class: 'sect', style: `--sc:${col}`, onclick: () => this.menuView(id) }); b.innerHTML = `<span class="sect-ic">${icon(ic, 26)}</span>`; b.append(el('span', { class: 'sect-t' }, el('b', { text: title }), el('span', { text: sub })), el('span', { class: 'sect-go' })); b.lastChild.innerHTML = icon('chevron', 18); return b; };
    if (view === 'home') {
      B.append(el('h3', { text: t('home_q') }), el('div', { class: 'sects' },
        sec('lab', 'flask', '#4cc3ff', t('sec_lab'), t('sec_lab_sub')),
        sec('skills', 'hand', '#3ee08f', t('sec_skills'), t('sec_skills_sub')),
        sec('scen', 'heart', '#ff5d6c', t('sec_resus'), t('sec_resus_sub'))));
      return;
    }
    if (view === 'lab') {
      this.inputs.scenario.value = ''; this.inputs.scenario.dispatchEvent(new Event('change'));
      B.append(back(), el('h3', { text: t('sec_lab') }), el('div', { class: 'card lab-note' }, el('p', { text: t('lab_text') }), el('ul', { class: 'muted small' }, [t('lab_1'), t('lab_2'), t('lab_3')].map(x => el('li', { text: x })))));
    } else if (view === 'scen') {
      B.append(back(), this.dom.cards); this.buildCards(true);
      if (!this.inputs.scenario.value) { const first = this.scenarios[0]; if (first) { this.inputs.scenario.value = first.id; this.inputs.scenario.dispatchEvent(new Event('change')); } }
    } else if (view === 'skills') {
      const list = el('div', { class: 'cards' });
      for (const pr of PROCEDURES) {
        const tools = [...new Set(pr.steps.filter(s => s.hand).map(s => s.hand.tool))];
        const b = el('button', { class: 'scard skill', dataset: { kind: 'skill', id: pr.id }, onclick: () => {
          this.pendingSkill = pr.id; this.inputs.scenario.value = SKILL_CASE[pr.id] ?? ''; this.inputs.scenario.dispatchEvent(new Event('change'));
          for (const c of list.children) c.classList.toggle('on', c === b);
        } });
        const ic = el('span', { class: 'skill-ic' }); ic.innerHTML = icon(tools[0] || 'check', 24);
        b.append(el('div', { class: 'skill-row' }, ic, el('b', { text: L(pr) })), el('div', { class: 'badges' }, el('span', { class: 'badge kind', text: t('gd_nsteps', { n: pr.steps.length }) }), tools.length ? el('span', { class: 'badge', text: `✋ ${tools.length} ${t('pw_instr')}` }) : null));
        list.append(b);
      }
      B.append(back(), el('h3', { text: t('sec_skills') }), el('p', { class: 'muted small', text: t('skills_text') }), list);
      list.firstChild?.click();
    }
  }
  openMenu() {
    if (this.sim.patient && !this.sim.finished) { this._speedBefore = this.sim.speed; this.sim.setSpeed(0); }
    this.menuOpen = true; this.dom.menu.hidden = false; this.dom.resume.hidden = !this.sim.patient; this.dom.pins.hidden = true; this.syncChrome();
    this.scene.auto = true; this.queuePreview(true);
  }
  closeMenu(resume = false) {
    this.menuOpen = false; this.dom.menu.hidden = true; this.scene.auto = false; this.syncChrome();
    if (resume) { this.onResume?.(); if (this._speedBefore) this.sim.setSpeed(this._speedBefore); }
  }
  queuePreview(now = false) {
    if (!this.menuOpen) return;
    clearTimeout(this._pv); this._pv = setTimeout(() => this.onPreview?.(this.readSetup()), now ? 0 : 120);
  }
  buildCards(grouped = false) {
    const cards = this.dom.cards; cards.replaceChildren();
    const lvl = { beginner: 1, intermediate: 2, advanced: 3 };
    const badges = (s) => !s ? el('div', { class: 'badges' }, el('span', { class: 'badge kind', text: t('free_badge') })) : el('div', { class: 'badges' },
      el('span', { class: 'badge kind', text: s.kind }),
      el('span', { class: 'badge', title: s.difficulty }, el('span', { class: 'lvl' }, [1, 2, 3].map(i => el('i', { class: i <= (lvl[s.difficulty] || 1) ? 'on' : '' }))), ' ', s.difficulty),
      el('span', { class: 'badge', text: `${Math.round(s.durationS / 60)} min` }));
    const mk = (id, title, summary, s) => el('button', { class: 'scard', dataset: { id, kind: s ? s.kind : 'free' }, 'aria-pressed': 'false', onclick: () => { this.inputs.scenario.value = id; this.inputs.scenario.dispatchEvent(new Event('change')); } },
      el('b', { text: title }), el('span', { class: 'sum', text: summary }), badges(s));
    if (!grouped) { cards.append(mk('', t('free_play'), t('free_sub'), null)); for (const s of this.scenarios) { const x = scenarioText(s); cards.append(mk(s.id, x.title, x.summary, s)); } }
    else for (const [title, pick] of [[t('grp_resus'), s => s.kind === 'ACLS'], [t('grp_chal'), s => s.kind !== 'ACLS']]) {
      cards.append(el('h3', { class: 'grp', text: title }));
      for (const s of this.scenarios.filter(pick)) { const x = scenarioText(s); cards.append(mk(s.id, x.title, x.summary, s)); }
    }
    this.markCards();
  }
  markCards() { for (const c of this.dom.cards.querySelectorAll('.scard')) { const on = c.dataset.id === (this.inputs.scenario.value || ''); c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); } }

  buildLeft() {
    const L = this.dom.left;
    this.dom.card = el('section', { class: 'card scen', hidden: true });
    this.dom.panelTitle = el('h3');
    this.dom.panel = el('div', { class: 'panel' });
    this.dom.panelWrap = el('section', { class: 'hud-panel', hidden: true }, el('div', { class: 'phead' }, this.dom.panelTitle, el('button', { class: 'x', 'aria-label': t('panel_close'), title: t('panel_close'), onclick: () => this.closePanel(), text: '×' })), this.dom.panel);
    L.append(this.dom.card, this.dom.panelWrap);
  }
  buildSetup() {
    const S = this.dom.setup; S.replaceChildren();
    const sel = el('select', { id: 'selScenario', hidden: true, 'aria-hidden': 'true', onchange: () => { this.syncSpecInputs(); this.showScenarioInfo(); this.markCards(); } },
      el('option', { value: '', text: t('free_play') }), ...this.scenarios.map(s => el('option', { value: s.id, text: scenarioText(s).title })));
    this.inputs.scenario = sel;
    const num = (id, label, min, max, step, val) => { const i = el('input', { type: 'number', id, min, max, step, value: val, oninput: () => { this.updateBmi(); this.queuePreview(); } }); this.inputs[id] = i; return el('label', { class: 'f' }, el('span', { text: label }), i); };
    const sex = el('select', { id: 'selSex' }, el('option', { value: 'M', text: t('male') }), el('option', { value: 'F', text: t('female') })); this.inputs.sex = sex;
    sex.addEventListener('change', () => { this.updateBmi(); this.queuePreview(); });
    const tone = el('select', { id: 'selTone', onchange: () => { this.scene.tone = Number(tone.value); this.queuePreview(); } }, ...SKIN_TONES.map((c, i) => el('option', { value: i, text: String(i + 1), selected: i === 2, style: `background:rgb(${c.map(x => Math.round(x * 255)).join(',')})` }))); this.inputs.tone = tone;
    this.dom.bmi = el('div', { class: 'bmi' });
    this.dom.info = el('div', { class: 'info' });
    S.append(sel,
      el('div', { class: 'row4' }, el('label', { class: 'f' }, el('span', { text: t('sex') }), sex), num('inAge', t('age'), 18, 100, 1, 45), num('inH', t('height'), 140, 210, 1, 175), num('inW', t('weight'), 35, 250, 1, 80)),
      el('div', { class: 'row2' }, el('label', { class: 'f' }, el('span', { text: t('skin') }), tone), this.dom.bmi),
      el('label', { class: 'f wide' }, el('span', { text: t('learner') }), this.inputs.learner = el('input', { type: 'text', id: 'inLearner', maxlength: 64, autocomplete: 'off', value: this._learner || '', oninput: e => { this._learner = e.target.value; } })),
      el('button', { id: 'btnStart', class: 'primary big wide', onclick: () => this.onStart?.(this.readSetup()), text: this.sim.patient ? t('restart') : t('start_case') }), this.dom.info);
    if (this.dom.menuR) this.dom.menuR.hidden = this._view === 'home';
    this.buildCards(); this.syncSpecInputs(); this.showScenarioInfo(); stepify(S);
  }
  syncSpecInputs() {
    const id = this.inputs.scenario.value, sc = this.scenarios.find(s => s.id === id), sp = sc ? sc.spec : { sex: 'M', age: 45, heightCm: 175, weightKg: 80 };
    this.inputs.sex.value = sp.sex; this.inputs.inAge.value = sp.age; this.inputs.inH.value = sp.heightCm; this.inputs.inW.value = sp.weightKg; this.updateBmi(); this.queuePreview();
  }
  updateBmi() {
    const h = Number(this.inputs.inH.value), w = Number(this.inputs.inW.value);
    if (!(h > 0 && w > 0)) return; const b = bmiOf(w, h), ok = b >= 15 && b <= 65;
    this.dom.bmi.textContent = ok ? `${t('bmi')} ${b.toFixed(1)} - ${t('bmi_class')[bmiClass(b)]}` : `${t('bmi')} ${b.toFixed(1)} - ${t('bmi_range')}`;
    this.dom.bmi.classList.toggle('bad', !ok); const sb = document.getElementById('btnStart'); if (sb) sb.disabled = !ok;
  }
  showScenarioInfo() {
    const id = this.inputs.scenario.value, sc = this.scenarios.find(s => s.id === id); this.dom.info.replaceChildren();
    if (!sc) return; const x = scenarioText(sc);
    this.dom.info.append(el('p', { class: 'summary', text: x.summary }), el('div', { class: 'muted small', text: `${sc.kind} · ${sc.difficulty} · ${Math.round(sc.durationS / 60)} min` }));
  }
  readSetup() {
    const id = this.inputs.scenario.value || null;
    return { scenarioId: id, spec: { sex: this.inputs.sex.value, age: Number(this.inputs.inAge.value), heightCm: Number(this.inputs.inH.value), weightKg: Number(this.inputs.inW.value) }, tone: Number(this.inputs.tone.value), learner: this.inputs.learner.value.trim() };
  }

  buildRight() {
    const R = this.dom.right;
    this.dom.monWrap = el('div', { class: 'monWrap' }, this.monCanvas);
    this.dom.teach = el('section', { class: 'card teach', hidden: !this.teach });
    this.dom.trend = el('canvas', { class: 'trend', width: 480, height: 150, 'aria-label': t('tr_title') });
    this.dom.logBox = el('section', { class: 'card log' }, el('h3', { text: t('log') }), this.dom.logList = el('ol', { 'aria-live': 'polite' }));
    R.append(this.dom.monWrap, this.dom.teach, el('section', { class: 'card trends' }, el('h3', { text: t('tr_title') }), this.dom.trend), this.dom.logBox);
    this.logLines.forEach(l => this.dom.logList.prepend(el('li', { text: l })));
  }

  // ---------------------------------------------------------------- floating markers over the 3D scene
  syncPins() {
    if (!this.dom.pins) return;
    this.dom.pins.replaceChildren(); this.pinEls = [];
    for (const pin of this.scene.pins || []) {
      const b = el('button', { class: 'pin', dataset: { id: pin.id }, tabindex: '-1', 'aria-label': t(pin.label), onclick: () => this.hotspot(pin.h), onpointerenter: () => { this.scene.hover = pin.h; }, onpointerleave: () => { this.scene.hover = null; } }, el('i', { class: 'dot' }), el('span', { class: 'lbl', text: t(pin.label) }));
      this.dom.pins.append(b); this.pinEls.push({ b, pin });
    }
  }
  updatePins() {
    if (!this.dom.pins) return;
    const show = this.hints && !this.menuOpen && this.sim.patient && !this.sim.finished;
    this.dom.pins.hidden = !show; if (!show || !this.pinEls) return;
    for (const { b, pin } of this.pinEls) { const s = this.scene.project(pin.pos); if (!s || !s.visible) { b.hidden = true; continue; } b.hidden = false; b.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`; }
  }
  escape() { if (this.menuOpen && this.sim.patient) this.closeMenu(true); else if (this.panelOpen) this.closePanel(); }

  // ---------------------------------------------------------------- patient-dependent panels
  refreshCard() {
    const sc = this.scenarios.find(s => s.id === this.sim.scenarioId);
    this.dom.card.replaceChildren();
    if (!sc) { this.dom.card.hidden = true; return; }
    const x = scenarioText(sc);
    this.dom.card.append(el('div', { class: 'phead' }, el('h3', { text: x.title }), el('button', { class: 'x', 'aria-label': t('collapse'), title: t('collapse'), onclick: () => { this.dom.card.hidden = true; }, text: '×' })), el('p', { class: 'summary', text: x.summary }), el('h4', { text: t('objectives') }), el('ul', {}, x.learning.map(l => el('li', { text: l }))));
  }
  onSessionStart() {
    this.closeMenu(false); this._speedBefore = 0;
    this.logLines = []; this.dom.logList.replaceChildren(); this.guide = null;
    this.refreshCard(); this.dom.card.hidden = !this.scenarios.find(s => s.id === this.sim.scenarioId);
    this.panelOpen = false; this.dom.panelWrap.hidden = true; this._alarmMode = null; this.dom.alarm.hidden = true;
    this.buildTabs();
    this.syncSetupFromSession(); this.syncPins(); this.syncChrome();
    const skill = this.pendingSkill && PROCEDURES.find(pr => pr.id === this.pendingSkill);
    if (skill) setTimeout(() => this.startGuide(skill), 400);
    this.dom.pins.classList.add('learn'); clearTimeout(this._learnT); this._learnT = setTimeout(() => this.dom.pins.classList.remove('learn'), 8000);   // names of the markers show for 8 s, then only on hover
  }
  /** Re-open the case menu with the running case's values (so "restart" and a language change keep what was chosen). */
  syncSetupFromSession() {
    if (!this.sim.session) return;
    this.buildSetup(); this.inputs.scenario.value = this.sim.scenarioId || ''; this.markCards(); this.showScenarioInfo();
    const sp = this.sim.session.spec; this.inputs.sex.value = sp.sex; this.inputs.inAge.value = sp.age; this.inputs.inH.value = sp.heightCm; this.inputs.inW.value = sp.weightKg; this.updateBmi(); this.inputs.tone.value = String(this.liveTone ?? this.scene.tone);
    this.dom.resume.hidden = false;
  }
  toggleTab(k) { if (this.panelOpen && this.tab === k) this.closePanel(); else this.openTab(k); }
  openTab(k) { this.tab = k; this.panelOpen = true; { const f = { tab_airway: 'head', tab_circ: 'chest', tab_drugs: 'arm', tab_fluids: 'arm', tab_proc: 'chest' }[k]; if (f && this.sim.patient && !this.menuOpen) this.scene.setCamera(f); } this.dom.card.hidden = true; if (this.sim.patient) this.buildTabs(); }   // the briefing makes room for the action panel
  closePanel() { this.panelOpen = false; this.buildTabs(); if (this.sim.patient && !this.menuOpen) this.scene.setCamera('default'); }   // back to the overview of the patient
  buildTabs() {
    this.dom.dockBtns.forEach(b => { const on = this.panelOpen && b.dataset.tab === this.tab; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    this.dom.panelWrap.hidden = !this.panelOpen || !this.sim.patient;
    if (this.dom.hint) this.dom.hint.hidden = !this.dom.panelWrap.hidden || !this.sim.patient || this.menuOpen;   // the shortcut hint would sit under the open panel
    if (this.dom.panelWrap.hidden) return;
    this.dom.panelTitle.textContent = t(this.tab);
    const P = this.dom.panel; P.replaceChildren();
    const b = this.sim.patient.body;
    queueMicrotask(() => stepify(P));
    ({ tab_guide: () => this.panelGuide(P), tab_drugs: () => this.panelDrugs(P, b), tab_fluids: () => this.panelFluids(P), tab_airway: () => this.panelAirway(P, b), tab_circ: () => this.panelCirc(P), tab_proc: () => this.panelProc(P), tab_orders: () => this.panelOrders(P) })[this.tab]();
  }

  act(ev, label) {
    const r = this.sim.act(ev);
    if (r && r.ok === false) this.toast(r.error || t('err_generic'), true); else if (label) this.toast(label + (r && r.willTakeS ? ` (${Math.round(r.willTakeS)} s)` : ''));
    return r;
  }
  /** Manual compression: ensures the compressor is in manual mode (fatigue applies), then delivers one compression. */
  manualCompress(depth = Number(document.getElementById('inCprDepth')?.value) || 5.5) {
    const p = this.sim.patient; if (!p || this.sim.finished) return;
    if (p.cpr.mode !== 'manual') this.sim.act({ type: 'cpr.start', mode: 'manual', surface: document.getElementById('selSurf')?.value || p.cpr.surface });
    this.sim.act({ type: 'cpr.compress', depth });
  }
  btn(label, fn, cls = '', attrs = {}) { return el('button', { class: cls, onclick: fn, text: label, ...attrs }); }

  panelDrugs(P, b) {
    const basisW = { lbm: b.lbm, ibw: b.ibw, tbw: b.weightKg };
    for (const grp of DRUG_UI) {
      const sec = el('details', { open: true }, el('summary', { text: t(grp.g) }));
      for (const it of grp.items) {
        const d = DRUGS[it.k]; const def = it.fixed ?? Math.max(it.step, round(it.per * basisW[it.basis], it.step));
        const dose = el('input', { type: 'number', min: 0, step: it.step, value: def, 'aria-label': t('dose') + ' ' + drugName(it.k, d.name) });
        const row = el('div', { class: 'drug', dataset: { drug: it.k } },
          el('div', { class: 'dn' }, el('b', { text: drugName(it.k, d.name) }), el('span', { class: 'muted small', text: it.fixed ? t('basis_fixed') : `${it.per} ${d.unit}/kg · ${t('basis_' + it.basis)}` }), it.warn ? el('span', { class: 'warn small', title: t('not_in_arrest'), text: '⚠ ' + t('not_in_arrest') }) : null),
          el('div', { class: 'dc' }, dose, el('span', { class: 'unit', text: d.unit }), this.btn(t('bolus'), () => this.act({ type: 'drug.bolus', drug: it.k, amount: Number(dose.value) }, `${drugName(it.k, d.name)} ${dose.value} ${d.unit}`), 'act')));
        if (it.inf) {
          const rate = el('input', { type: 'number', min: 0, step: it.inf.step, value: it.inf.def, 'aria-label': t('rate') });
          row.append(el('div', { class: 'dc inf' }, el('span', { class: 'small', text: t('infusion') }), rate, el('span', { class: 'unit', text: it.inf.unit }),
            this.btn('▶', () => this.act({ type: 'drug.infusion', drug: it.k, rate: it.inf.toEngine(Number(rate.value), b) }, `${drugName(it.k, d.name)} ${rate.value} ${it.inf.unit}`), 'act', { title: t('infusion') }), this.btn(t('stop'), () => this.act({ type: 'drug.stop', drug: it.k }, drugName(it.k, d.name) + ' - ' + t('stop')))));
        }
        sec.append(row);
      }
      P.append(sec);
    }
  }
  panelFluids(P) {
    const vol = el('input', { type: 'number', id: 'inFluidVol', value: 500, min: 50, max: 3000, step: 50 }), mins = el('input', { type: 'number', id: 'inFluidMin', value: 15, min: 1, max: 120, step: 1 });
    P.append(el('h4', { text: t('fl_crystalloid') }), el('div', { class: 'row3' }, el('label', { class: 'f' }, el('span', { text: t('fl_volume') }), vol), el('label', { class: 'f' }, el('span', { text: t('fl_minutes') }), mins), this.btn(t('fl_give'), () => this.act({ type: 'fluid.bolus', volumeL: Number(vol.value) / 1000, minutes: Number(mins.value) }, `${vol.value} mL`), 'act')),
      el('div', { class: 'stack' },
        this.btn(t('fl_prbc'), () => this.act({ type: 'blood.transfuse', kind: 'prbc' }, t('fl_prbc')), 'act'), this.btn(t('fl_whole'), () => this.act({ type: 'blood.transfuse', kind: 'whole' }, t('fl_whole')), 'act'), this.btn(t('fl_ffp'), () => this.act({ type: 'blood.transfuse', kind: 'ffp' }, t('fl_ffp')), 'act'),
        this.btn(t('fl_tourniquet'), () => this.act({ type: 'bleed.control' }, t('fl_tourniquet')), 'act danger'), this.btn(t('fl_bicarb'), () => this.act({ type: 'bicarb.bolus', mEq: 50 }, t('fl_bicarb')), 'act')));
  }
  panelAirway(P, b) {
    const sel = (id, opts, val) => el('select', { id }, opts.map(([v, l]) => el('option', { value: v, text: l, selected: v === val })));
    const o2 = sel('selO2', Object.entries(O2).map(([k, v]) => [k, t(v.key)]), 'room'), mode = sel('selMode', [['ctrl', t('aw_ctrl')], ['spont', t('aw_spont')]], 'ctrl');
    const depth = el('input', { type: 'number', id: 'inTubeDepth', value: this.sim.patient?.spec.sex === 'F' ? 21 : 23, min: 12, max: 32, step: 0.5 });   // common practice; the bronchoscope shows whether it suits this patient
    const rate = el('input', { type: 'number', id: 'inVr', value: 12, min: 0, max: 40 }), vt = el('input', { type: 'number', id: 'inVt', value: 6, min: 3, max: 12, step: 0.5 }), fio2 = el('input', { type: 'number', id: 'inVf', value: 1.0, min: 0.21, max: 1, step: 0.05 }), peep = el('input', { type: 'number', id: 'inVp', value: 5, min: 0, max: 20 });
    P.append(
      el('h4', { text: t('aw_position') }), el('div', { class: 'row2' }, this.btn(t('aw_headup'), () => this.act({ type: 'position.set', headUp: true }, t('aw_headup')), 'act'), this.btn(t('aw_flat'), () => this.act({ type: 'position.set', headUp: false }, t('aw_flat')), 'act')),
      el('h4', { text: t('aw_o2') }), el('div', { class: 'row2' }, o2, this.btn(t('apply'), () => { const o = O2[o2.value]; this.act({ type: 'o2.mask', fio2: o.fio2, seal: o.seal }, t(o.key)); }, 'act')),
      el('div', { class: 'row2' }, this.btn(t('aw_apox'), () => this.act({ type: 'apox.set', on: true, fio2: 1, eff: 0.5 }, t('aw_apox')), 'act')),
      el('h4', { text: t('aw_device') }), el('div', { class: 'stack' }, this.btn(t('aw_chin'), () => this.act({ type: 'airway.set', device: 'chin_lift' }, t('aw_chin')), 'act'), this.btn(t('aw_jaw'), () => this.act({ type: 'airway.set', device: 'jaw_thrust' }, t('aw_jaw')), 'act'), this.btn(t('aw_opa'), () => this.act({ type: 'airway.set', device: 'opa' }, t('aw_opa')), 'act'), this.btn(t('aw_sga'), () => this.act({ type: 'airway.set', device: 'sga' }, t('aw_sga')), 'act'), this.btn(t('aw_intubate'), () => this.act({ type: 'airway.intubate', depthCm: Number(depth.value) }, `${t('aw_intubate')} ${depth.value} cm`), 'act'), this.btn(t('aw_none'), () => this.act({ type: 'airway.set', device: 'none' }, t('aw_none')), 'act')),
      el('div', { class: 'row2' }, el('label', { class: 'f' }, el('span', { text: t('aw_depth') }), depth), this.btn(t('aw_bronch'), () => this.bronch?.start(), 'act', { id: 'btnBronch' })),
      el('h4', { text: t('aw_vent') }),
      el('div', { class: 'row2' }, this.btn(t('aw_bvm_start'), () => this.act({ type: 'vent.set', settings: { mode: 'ctrl', rate: 10, vt: Math.round(7 * b.pbw), fio2: 1, peep: 0, seal: this.sim.patient.airway.intubated || this.sim.patient.airway.device === 'sga' ? 0.97 : 0.85 } }, t('aw_bvm_start')), 'act primary', { id: 'btnBvm' }), this.btn(t('aw_vent_stop'), () => this.act({ type: 'vent.set', settings: { mode: 'spont' } }, t('aw_vent_stop')), 'act')), el('div', { class: 'row4' }, el('label', { class: 'f' }, el('span', { text: t('aw_mode') }), mode), el('label', { class: 'f' }, el('span', { text: t('aw_rate') }), rate), el('label', { class: 'f' }, el('span', { text: t('aw_vt') }), vt), el('label', { class: 'f' }, el('span', { text: t('aw_fio2') }), fio2)),
      el('div', { class: 'row2' }, el('label', { class: 'f' }, el('span', { text: t('aw_peep') }), peep), this.btn(t('aw_set'), () => this.act({ type: 'vent.set', settings: { mode: mode.value, rate: Number(rate.value), vt: Number(vt.value) * b.pbw, fio2: Number(fio2.value), peep: Number(peep.value), seal: this.sim.patient.airway.intubated ? 0.97 : 0.85 } }, t('aw_set')), 'act primary')));
  }
  panelCirc(P) {
    const rate = el('input', { type: 'number', id: 'inCprRate', value: 110, min: 60, max: 180 }), depth = el('input', { type: 'number', id: 'inCprDepth', value: 5.5, min: 2, max: 8, step: 0.5 }), en = el('input', { type: 'number', id: 'inEnergy', value: 200, min: 50, max: 360, step: 10 });
    const surf = el('select', { id: 'selSurf', onchange: () => this.act({ type: 'cpr.surface', surface: surf.value }) }, el('option', { value: 'hard', text: t('cp_hard') }), el('option', { value: 'soft', text: t('cp_soft') }));
    this.dom.cprFb = el('div', { class: 'fb' }); this.dom.defStatus = el('div', { class: 'fb' });
    P.append(el('h4', { text: t('cp_cpr') }),
      el('div', { class: 'row2' }, el('label', { class: 'f' }, el('span', { text: t('cp_cprrate') }), rate), el('label', { class: 'f' }, el('span', { text: t('cp_cprdepth') }), depth)),
      el('div', { class: 'stack' }, this.btn(t('cp_auto'), () => this.act({ type: 'cpr.start', mode: 'auto', opts: { rate: Number(rate.value), depth: Number(depth.value), ratio: '30:2' }, surface: surf.value }, t('cp_auto')), 'act primary', { id: 'btnCpr' }),
        this.btn(t('cp_cont'), () => this.act({ type: 'cpr.start', mode: 'auto', opts: { rate: Number(rate.value), depth: Number(depth.value), ratio: 'continuous' }, surface: surf.value }, t('cp_cont')), 'act'),
        this.btn(t('cp_manual') + '  [C]', () => this.manualCompress(Number(depth.value)), 'act', { id: 'btnManual' }),
        this.btn(t('cp_switch'), () => this.act({ type: 'cpr.switch' }, t('cp_switch')), 'act'), this.btn(t('cp_stopcpr'), () => this.act({ type: 'cpr.stop' }, t('cp_stopcpr')), 'act danger')),
      el('label', { class: 'f' }, el('span', { text: t('cp_surface') }), surf), this.dom.cprFb,
      el('h4', { text: t('cp_defib') }),
      el('div', { class: 'row2' }, this.btn(t('cp_pads'), () => this.act({ type: 'defib.pads' }, t('cp_pads')), 'act', { id: 'btnPads' }),
        el('label', { class: 'f' }, el('span', { text: t('cp_energy') }), en)),
      el('div', { class: 'row3' }, this.btn(t('cp_charge'), () => { this.act({ type: 'defib.setEnergy', energy: Number(en.value) }); this.act({ type: 'defib.charge' }, t('cp_charge')); }, 'act', { id: 'btnCharge' }), this.btn('⚡ ' + t('cp_shock'), () => this.act({ type: 'defib.shock' }, t('ev_shock')), 'act danger big', { id: 'btnShock' }),
        el('select', { id: 'selDefMode', onchange: e => this.act({ type: 'defib.mode', mode: e.target.value }) }, el('option', { value: 'async', text: t('cp_async') }), el('option', { value: 'sync', text: t('cp_sync') }))), this.dom.defStatus);
  }
  panelProc(P) {
    const sel = (id, opts, def) => el('select', { id }, opts.map(([v, l]) => el('option', { value: v, text: l, ...(v === def ? { selected: true } : {}) })));
    const p = this.sim.patient, startSide = p?.chest?.side || 'R';
    const side = sel('selSgSide', [['R', t('sg_R')], ['L', t('sg_L')]], startSide), site = sel('selSgSite', ['mcl2', 'mal5', 'aal5'].map(k => [k, t('site_' + k)]), 'mal5');
    const len = sel('selSgLen', [[50, '50 mm (14G)'], [70, '70 mm'], [80, '80 mm'], [100, '100 mm']], 50);
    const fr = sel('selSgFr', [[14, '14 Fr'], [20, '20 Fr'], [28, '28 Fr'], [32, '32 Fr'], [36, '36 Fr']], 28);
    const tech = sel('selSgTech', [['scalpel_bougie', t('tech_scalpel_bougie')], ['cannula', t('tech_cannula')]], 'scalpel_bougie'), appr = sel('selSgAppr', [['palpate', t('appr_palpate')], ['vertical', t('appr_vertical')]], 'palpate');
    const out = this.dom.sgOut = el('div', { class: 'sgout muted small', id: 'sgOut', role: 'status', 'aria-live': 'polite' });
    const f = (lab, ctl) => el('label', { class: 'f' }, el('span', { text: lab }), ctl);
    const show = (lines) => { out.replaceChildren(...lines.filter(Boolean).map(l => el('div', { text: l }))); out.classList.remove('muted'); if (lines[0]) this.toast(lines[0]); };
    const needle = () => {
      const r = this.act({ type: 'procedure.needle_decompression', side: side.value, site: site.value, needleMm: Number(len.value) }, `${t('sg_needle_h')} ${side.value} - ${len.value} mm`);
      if (!r || r.ok === false) return;
      show([r.hiss ? t('nd_hiss') : r.relieved ? t('nd_relieved') : r.reached ? (r.wrongSide ? t('nd_wrong') : t('nd_noair')) : t('nd_short'), r.risk === 'cardiac' ? t('nd_cardiac') : null, r.reached && r.wrongSide ? t('nd_wrong') : null].filter((x, i, a) => x && a.indexOf(x) === i));
    };
    const examChest = () => { const r = this.act({ type: 'exam.chest' }); if (r?.ok) show(r.findings.map(c => t('f_' + c))); };
    const pocus = () => {
      const r = this.act({ type: 'exam.pocus' }); if (!r?.ok) return;
      const sl = x => `${t('pocus_sliding')} ${x}: ${r.sliding[x] ? t('pocus_present') : t('pocus_absent')}`, w = r.cwtMm;
      show([sl('L'), sl('R'), r.lungPoint ? t('pocus_point') : null, `${t('pocus_cwt')}: ${t('site_mcl2').split(',')[0]} ${w.mcl2} ${t('mm')} · ${t('site_mal5').split(',')[0]} (mal) ${w.mal5} ${t('mm')} · (aal) ${w.aal5} ${t('mm')}`]);
    };
    const neck = (method) => {
      const r = this.act({ type: 'exam.neck', method }, method === 'ultrasound' ? t('sg_neck_us') : null); if (!r?.ok) return;
      show([method === 'ultrasound' ? t('neck_marked', { d: r.depthMm }) : (r.ctm === 'palpable' ? t('neck_palpable') : t('neck_impalpable'))]);
    };
    const items = [['pr_pericardio', 'procedure.pericardiocentesis'], ['pr_pci', 'procedure.pci'], ['pr_lysis', 'procedure.thrombolysis'], ['pr_hyperk', 'procedure.treat_hyperkalemia']];
    P.append(
      el('h4', { text: t('sg_title') }),
      el('div', { class: 'sg-block' }, el('b', { class: 'small', text: t('sg_exam') }), el('div', { class: 'stack' }, this.btn(t('sg_chest_exam'), examChest, 'act', { id: 'btnExamChest' }), this.btn(t('sg_pocus'), pocus, 'act', { id: 'btnPocus' }), this.btn(t('sg_neck_palp'), () => neck('palpation'), 'act', { id: 'btnNeckPalp' }), this.btn(t('sg_neck_us'), () => neck('ultrasound'), 'act', { id: 'btnNeckUs' }))),
      el('div', { class: 'sg-block' }, el('b', { class: 'small', text: t('sg_needle_h') }), el('div', { class: 'row2' }, f(t('sg_side'), side), f(t('sg_len'), len)), f(t('sg_site'), site), this.btn(t('sg_do_needle'), needle, 'act danger', { id: 'btnNeedle' })),
      el('div', { class: 'sg-block' }, el('b', { class: 'small', text: t('sg_tube_h') }), el('div', { class: 'row2' }, f(t('sg_side'), side.cloneNode(true)), f(t('sg_fr'), fr)),
        this.btn(t('sg_do_tube'), (e) => { const sd = e.currentTarget.parentNode.querySelector('select').value; const r = this.act({ type: 'procedure.chest_tube', side: sd, fr: Number(fr.value) }, t('sg_tube_h') + ' ' + sd); if (r?.ok) show([t('tube_started') + (r.willTakeS ? ` (${Math.round(r.willTakeS)} s)` : '')]); }, 'act danger', { id: 'btnTube' })),
      el('div', { class: 'sg-block' }, el('b', { class: 'small', text: t('sg_fona_h') }), f(t('sg_tech'), tech), f(t('sg_appr'), appr), this.btn(t('sg_do_fona'), () => this.act({ type: 'procedure.cricothyroidotomy', technique: tech.value, approach: appr.value }, t('sg_fona_h')), 'act danger', { id: 'btnFona' })),
      out,
      el('h4', { text: t('pr_other') }), el('div', { class: 'stack' }, items.map(([k, ty]) => this.btn(t(k), () => this.act({ type: ty }, t(k)), 'act'))));
  }
  panelOrders(P) {
    const att = (k, key) => this.btn(t(key), () => this.act({ type: 'monitor.attach', items: { [k]: true } }, t(key)), 'act', { dataset: { att: k } });
    const amb = el('input', { type: 'number', id: 'inAmb', value: 22, min: 5, max: 40, step: 1 });
    P.append(el('h4', { text: t('od_monitor') }), el('div', { class: 'stack' }, att('ecgLeads', 'od_ecg'), att('spo2Probe', 'od_spo2'), this.btn(t('od_nibp'), () => { this.act({ type: 'monitor.attach', items: { nibp: true } }); this.act({ type: 'nibp.cycle' }, t('od_nibp')); }, 'act'), att('aline', 'od_aline'), att('capnography', 'od_capno'), att('tempProbe', 'od_temp'), this.btn(t('od_iv'), () => this.act({ type: 'iv.access' }, t('od_iv')), 'act')),
      el('h4', { text: t('od_orders') }), el('div', { class: 'stack' }, this.btn(t('od_ecg12'), () => { const r = this.act({ type: 'order', what: 'ecg12' }, t('od_ecg12')); if (r?.result) this.showResult(r.result); }, 'act'), this.btn(t('od_trop'), () => { const r = this.act({ type: 'order', what: 'troponin' }, t('od_trop')); if (r?.result) this.showResult(r.result); }, 'act'),
        this.btn(t('od_aspirin'), () => this.act({ type: 'order', what: 'aspirin', mg: 324 }, t('od_aspirin')), 'act'), this.btn(t('od_cath'), () => this.act({ type: 'order', what: 'cath_lab' }, t('od_cath')), 'act'), this.btn(t('od_call_help'), () => this.act({ type: 'order', what: 'call_help' }, t('od_call_help')), 'act'), this.btn(t('od_declare_cico'), () => this.act({ type: 'order', what: 'declare_cico' }, t('od_declare_cico')), 'act'), this.btn(t('od_ttm'), () => { this.act({ type: 'order', what: 'temperature_control' }); this.act({ type: 'thermal.device', target: 36 }, t('od_ttm')); }, 'act')),
      el('h4', { text: t('od_env') }), el('div', { class: 'row2' }, el('label', { class: 'f' }, el('span', { text: t('od_ambient') }), amb), this.btn(t('od_set'), () => this.act({ type: 'thermal.ambient', c: Number(amb.value) }, t('od_set')), 'act')),
      el('div', { class: 'stack' }, this.btn(t('od_cover'), () => this.act({ type: 'thermal.cover', factor: 0.5 }, t('od_cover')), 'act'), this.btn(t('od_warmer'), () => this.act({ type: 'thermal.device', target: 38 }, t('od_warmer')), 'act'), this.btn(t('od_cool'), () => this.act({ type: 'thermal.device', target: null }, t('od_cool')), 'act')));
  }
  showResult(res) { if (res.findings) this.toast(res.findings); else if (res.note) this.toast(res.note); }

  // ---------------------------------------------------------------- guided procedures (step-by-step démarche)
  /** Procedure workspace: progress, the step coach, the instrument table (drag a tool onto the patient) and the step timeline. */
  panelGuide(P) {
    const g = this.guide, p = this.sim.patient;
    if (!g) {
      P.append(el('p', { class: 'muted small', text: t('gd_intro') }),
        el('div', { class: 'pw-pick' }, PROCEDURES.map(pr => {
          const tools = [...new Set(pr.steps.filter(s => s.hand).map(s => s.hand.tool))];
          const b = el('button', { class: 'pw-proc', onclick: () => this.startGuide(pr) });
          b.innerHTML = `<span class="pw-proc-ic">${icon(tools[0] || 'check', 24)}</span>`;
          b.append(el('span', { class: 'pw-proc-t' }, el('b', { text: L(pr) }), el('span', { class: 'small muted', text: t('gd_nsteps', { n: pr.steps.length }) + (tools.length ? ` · ${tools.length} ${t('pw_instr')}` : '') })));
          return b;
        })));
      return;
    }
    const steps = g.proc.steps, cur = g.step, done = g.status.filter(x => x !== 'todo').length, hands = !!this.handsOn?.available;
    const ctx = { p, b: p.body, prm: g.prm }, evs = (st) => { try { return st.run ? st.run(ctx) : []; } catch { return []; } };
    // header: title, progress
    P.append(el('div', { class: 'pw-head' }, el('div', {}, el('b', { text: L(g.proc) }), el('div', { class: 'pw-bar' }, el('i', { style: `width:${(100 * done / steps.length).toFixed(0)}%` })), el('span', { class: 'small muted', text: t('pw_progress', { d: done, n: steps.length }) })),
      this.btn(t('gd_back'), () => { this.handsOn?.end(); this.guide = null; this.scene.setCamera('default'); this.buildTabs(); }, 'ghost small')));
    if (g.proc.params && !g.finished) P.append(el('div', { class: 'row2 gd-prm' }, g.proc.params.map(k => {
      const d = PARAMS[k], sel = el('select', { onchange: e => { g.prm[k] = d.num ? Number(e.target.value) : e.target.value; this.prefocusStep(); } }, d.opts.map(([v, lab]) => el('option', { value: v, text: L(lab), selected: v === g.prm[k] })));
      return el('label', { class: 'f' }, el('span', { text: L(d) }), sel);
    })));
    // the step coach
    if (cur) {
      const handStep = cur.hand && hands, last = g.i > 0 ? g.notes[g.i - 1] : null, lastSt = g.i > 0 ? g.status[g.i - 1] : null;
      this.dom.gdWait = el('div', { class: 'gd-wait small' });
      const coach = el('div', { class: 'pw-coach' + (handStep ? ' hands' : '') },
        el('div', { class: 'pw-coach-top' }, el('span', { class: 'pw-n', text: String(g.i + 1) }), el('span', { class: 'small muted', text: t('gd_step', { i: g.i + 1, n: steps.length }) })),
        el('b', { class: 'pw-title', text: L(cur) }), cur.why ? el('p', { text: L(cur.why) }) : null, this.dom.gdWait,
        handStep ? el('div', { class: 'pw-do' }, el('span', { class: 'pw-hand' }), el('span', { text: t('pw_take') })) : null,
        el('div', { class: 'pw-actions' },
          handStep ? this.btn(t('ho_auto'), () => this.guideDo(), 'act', { id: 'btnGuideDo' }) : this.btn(t('pw_perform'), () => this.guideDo(), 'act primary', { id: 'btnGuideDo' }),
          this.btn(t('gd_skip'), () => this.guideSkip(), 'ghost')));
      if (last) coach.prepend(el('div', { class: 'pw-last ' + (lastSt === 'done' ? 'ok' : 'bad'), text: last }));
      P.append(coach);
      this.updateGuideWait();
    } else {
      const sm = g.summary();
      P.append(el('div', { class: 'pw-coach finished' }, el('b', { class: 'pw-title', text: t('gd_done_title') }), el('p', { text: t('gd_summary', sm) }),
        el('div', { class: 'pw-actions' }, this.btn(t('gd_again'), () => this.startGuide(g.proc), 'act'), this.btn(t('gd_back'), () => { this.guide = null; this.scene.setCamera('default'); this.buildTabs(); }, 'act primary'))));
    }
    // the instrument table
    const need = [...new Set(steps.filter(s => s.hand).map(s => s.hand.tool))];
    if (need.length) {
      const tools = [...need, ...DISTRACTORS.filter(x => !need.includes(x)).slice(0, Math.max(2, 6 - need.length))].sort((a, b) => L(TOOLS[a]).localeCompare(L(TOOLS[b])));
      const usedUpTo = new Set(steps.slice(0, g.i).filter(s => s.hand).map(s => s.hand.tool)), live = cur?.hand && hands;
      const table = el('div', { class: 'pw-table' + (live ? ' live' : '') });
      for (const k of tools) {
        const tile = el('button', { class: 'pw-tool' + (usedUpTo.has(k) ? ' used' : ''), dataset: { tool: k }, title: L(TOOLS[k]), 'aria-label': L(TOOLS[k]), disabled: !live });
        tile.innerHTML = icon(k, 30); tile.append(el('span', { text: L(TOOLS[k]) }));
        if (live) tile.addEventListener('pointerdown', (e) => { e.preventDefault(); this.handsOn.grab(k, e, cur, g.prm, (r) => { if (r) this.guideDo(r); }); });
        table.append(tile);
      }
      P.append(el('h4', { text: t('pw_table') + (hands ? '' : ' · ' + t('pw_loading')) }), table);
    }
    // the step timeline
    const glyph = { done: icon('check', 14), early: icon('clock', 14), warn: '!', skipped: '–' };
    P.append(el('h4', { text: t('pw_steps') }), el('ol', { class: 'pw-steps' }, steps.map((st, i) => {
      const li = el('li', { class: `pw-step ${g.status[i]}${i === g.i ? ' cur' : ''}` });
      const ic = el('span', { class: 'pw-sic' }); ic.innerHTML = g.status[i] !== 'todo' && glyph[g.status[i]] ? glyph[g.status[i]] : icon(stepIcon(st, evs(st)), 16);
      li.append(ic, el('span', { class: 'pw-st' }, el('span', { text: L(st) }), g.notes[i] ? el('span', { class: 'pw-sn', text: g.notes[i] }) : null));
      return li;
    })));
  }
  /** Begin a procedure: log it, open the workspace and frame its first site. */
  startGuide(pr) {
    const p = this.sim.patient; if (!p) return;
    this.handsOn?.end(); this.guide = new Guide(pr, p); this.sim.act({ type: 'note', text: `guide ${pr.id}: start` });
    this.tab = 'tab_guide'; this.panelOpen = true; this.dom.card.hidden = true; this.buildTabs(); this.prefocusStep(0);
  }
  /** The game moves the camera in advance: to the current step's site (its skin normal) or to the step's preset view. */
  prefocusStep(delayMs = 0) {
    clearTimeout(this._pf);
    this._pf = setTimeout(() => {
      const g = this.guide, st = g?.step; if (!st || this.menuOpen) return;
      const h = st.hand, key = h ? (h.target === 'chestSite' ? `${g.prm.side || 'R'}_${h.site || g.prm.site || 'mal5'}` : h.target) : null;
      if (!(key && this.scene.frameStepSite?.(key, h.gesture === 'stroke' || h.gesture === 'push' ? 0.5 : 0.62))) this.scene.setCamera(st.cam || 'default');
    }, delayMs);
  }
  updateGuideWait() {
    const w = this.dom.gdWait, g = this.guide, p = this.sim.patient; if (!w || !w.isConnected || !g || !g.step || !p) return;
    const rem = g.remaining(p), nr = g.step.ready?.({ p, b: p.body, prm: g.prm });
    w.textContent = rem > 0 ? `${L(g.step.wait)} - ${t('gd_wait', { s: Math.ceil(rem) })}` : nr ? L(nr) : ''; w.hidden = !(rem > 0 || nr);
  }
  guideSkip() {
    const g = this.guide; if (!g || !g.step) return;
    g.status[g.i] = 'skipped'; this.sim.act({ type: 'note', text: `guide ${g.proc.id}: ${g.step.id} (skipped)` }); this._guideNext();
  }
  guideDo(hand = null) {
    const g = this.guide, s = g?.step, p = this.sim.patient; if (!s || !p || this.sim.finished) return;
    if (hand?.prm) Object.assign(g.prm, hand.prm);                               // the drop point chose the side / site / approach
    const ctx = { p, b: p.body, prm: g.prm }, rem = g.remaining(p), nr = s.ready?.(ctx), warn = s.check?.(ctx), lines = [];
    let status = rem > 0 || nr ? 'early' : warn ? 'warn' : 'done', engineGesture = false;
    if (hand) { lines.push(`${hand.res.ok ? '✓' : '✗'} ${hand.note}`); if (!hand.res.ok && status === 'done') status = 'warn'; }
    if (rem > 0) lines.push(`${L(s.wait)} (${t('gd_wait', { s: Math.ceil(rem) })})`);
    if (nr) lines.push(L(nr));
    if (warn) lines.push(L(warn));
    for (const ev of (s.run ? s.run(ctx) : [])) {
      const r = this.sim.act(ev);
      if (GESTURE_TYPES.has(ev.type)) engineGesture = true;
      if (r && r.ok === false) { status = 'warn'; lines.push(r.error || t('err_generic')); } else { lines.push(...this.resultLines(ev, r)); if (r && (r.wrongSide || r.reached === false) && status === 'done') status = 'warn'; }   // a needle on the wrong side or too short is a problem, not a success
    }
    if (s.msg) lines.push(L(s.msg(ctx)));
    this.sim.act({ type: 'note', text: `guide ${g.proc.id}: ${s.id}${status !== 'done' ? ` (${status})` : ''}${hand ? ` [hands-on: ${hand.note}]` : ''}`.slice(0, 300) });
    if (hand) this.scene.focus(s.cam || 'default', 1.6);                         // the learner's own instrument already showed the gesture
    else if (s.g) this.scene.stepGesture(s.g, s.cam, this.scene.siteOf(s.at, g.prm)); else if (!engineGesture) this.scene.focus(s.cam || 'default', 2.2);
    g.status[g.i] = status; g.done[s.id] = p.t; g.notes[g.i] = lines.filter(Boolean).join(' · ') || null;
    if (lines.length) this.toast(lines[0], status !== 'done');
    this._guideNext();
  }
  _guideNext() {
    const g = this.guide; g.i++; this.prefocusStep(g.finished ? 0 : 2400);
    if (g.finished) setTimeout(() => this.scene.setCamera('default'), 2400);
    if (g.finished) { const s = g.summary(); this.sim.act({ type: 'note', text: `guide ${g.proc.id}: end ${s.done}/${s.n} in order, ${s.early} early, ${s.warn} with a problem, ${s.skipped} skipped` }); }
    this.buildTabs();
  }
  /** Human-readable outcome of an engine event fired by a guided step (examination findings, needle, drain, airway). */
  resultLines(ev, r) {
    if (!r) return [];
    switch (ev.type) {
      case 'exam.chest': return r.findings ? [r.findings.map(c => t('f_' + c)).join(', ')] : [];
      case 'exam.pocus': return r.sliding ? [`${t('pocus_sliding')} L: ${r.sliding.L ? t('pocus_present') : t('pocus_absent')} · R: ${r.sliding.R ? t('pocus_present') : t('pocus_absent')}`] : [];
      case 'exam.neck': return [r.ctm === 'palpable' ? t('neck_palpable') : t('neck_impalpable')];
      case 'procedure.needle_decompression': return [r.hiss ? t('nd_hiss') : r.relieved ? t('nd_relieved') : r.reached ? (r.wrongSide ? t('nd_wrong') : t('nd_noair')) : t('nd_short')];
      case 'procedure.chest_tube': return [t('tube_started') + (r.willTakeS ? ` (${Math.round(r.willTakeS)} s)` : '')];
      case 'airway.intubate': case 'procedure.cricothyroidotomy': return r.willTakeS ? [t('gd_takes', { s: Math.round(r.willTakeS) })] : [];
      default: return [];
    }
  }

  // ---------------------------------------------------------------- feedback
  toast(msg, bad = false) { const e = this.dom.toast; e.textContent = msg; e.hidden = false; e.classList.toggle('bad', bad); clearTimeout(this._tt); this._tt = setTimeout(() => { e.hidden = true; }, 3200); }
  log(line) { const p = this.sim.patient; const s = `[${mmss(p ? p.t : 0)}] ${line}`; this.logLines.push(s); if (this.logLines.length > 300) this.logLines.shift(); this.dom.logList?.prepend(el('li', { text: s })); while (this.dom.logList && this.dom.logList.children.length > 300) this.dom.logList.lastChild.remove(); }
  describe(ev) {
    const d = ev.drug && DRUGS[ev.drug] ? drugName(ev.drug, DRUGS[ev.drug].name) : '';
    switch (ev.type) {
      case 'drug.bolus': return `${d} ${ev.amount} ${DRUGS[ev.drug]?.unit ?? ''}`;
      case 'drug.infusion': return `${d} ${t('infusion').toLowerCase()} ${fmt(ev.rate, 3)} /min`;
      case 'drug.stop': return `${d} - ${t('stop')}`;
      case 'fluid.bolus': return `${t('fl_crystalloid')} ${Math.round(ev.volumeL * 1000)} mL / ${ev.minutes} min`;
      case 'blood.transfuse': return t('fl_' + ev.kind);
      case 'airway.set': return `${t('aw_device')}: ${t({ none: 'aw_none', chin_lift: 'aw_chin', jaw_thrust: 'aw_jaw', opa: 'aw_opa', sga: 'aw_sga', ett: 'aw_intubate' }[ev.device] || ev.device)}`;
      case 'airway.intubate': return t('aw_intubate') + (ev.depthCm ? ` ${ev.depthCm} cm` : '');
      case 'airway.tube_adjust': return `${t('br_tube_depth')} ${ev.cm > 0 ? '+' : ''}${ev.cm} cm`;
      case 'bronch.insert': return t('br_title');
      case 'bronch.suction': return `${t('br_suction')} (${ev.where})`;
      case 'bronch.remove': return t('br_removed');
      case 'vent.set': { const v = ev.settings || {}; return `${t('aw_vent')}: ` + [v.mode, v.rate != null ? `${v.rate}/min` : '', v.vt != null ? `Vt ${Math.round(v.vt)} mL` : '', v.fio2 != null ? `FiO2 ${v.fio2}` : '', v.peep != null ? `PEEP ${v.peep}` : ''].filter(Boolean).join(' '); }   // only what was changed
      case 'o2.mask': return `${t('aw_o2')} FiO2 ${ev.fio2}`;
      case 'cpr.start': { if (ev.mode === 'manual') return t('cp_manual'); const o = ev.opts || {}, bits = [o.ratio, o.rate ? `${o.rate}/min` : '', o.depth ? `${o.depth} cm` : ''].filter(Boolean).join(' · '); return t('cp_cpr') + (bits ? ` (${bits})` : ''); }
      case 'cpr.compress': case 'note': return null;   // notes reach the log through the engine's note stream
      case 'defib.shock': return t('ev_shock');
      case 'order': return ev.what;
      case 'monitor.attach': return Object.keys(ev.items).map(k => t({ ecgLeads: 'od_ecg', spo2Probe: 'od_spo2', nibp: 'od_nibp', aline: 'od_aline', capnography: 'od_capno', tempProbe: 'od_temp' }[k] || k)).join(', ');
      case 'iv.access': return t('od_iv');
      case 'nibp.cycle': return t('od_nibp');
      case 'cpr.stop': return t('cp_stopcpr');
      case 'cpr.switch': return t('cp_switch');
      case 'defib.pads': return t('cp_pads');
      case 'defib.charge': return t('cp_charge');
      case 'defib.setEnergy': return `${t('cp_energy')} ${ev.energy}`;
      case 'bleed.control': return t('fl_tourniquet');
      case 'bicarb.bolus': return t('fl_bicarb');
      case 'position.set': return ev.headUp ? t('aw_headup') : t('aw_flat');
      case 'apox.set': return t('aw_apox');
      case 'thermal.device': return ev.target == null ? t('od_cool') : `${t('od_ttm')} ${ev.target} °C`;
      case 'thermal.cover': return t('od_cover');
      case 'thermal.ambient': return `${t('od_ambient')} ${ev.c}`;
      case 'procedure.needle_decompression': return ev.side ? `${t('sg_needle_h')} ${ev.side} ${t('site_' + (ev.site || 'mcl2')).split(',')[0]} ${ev.needleMm} mm` : t('pr_needle');
      case 'procedure.chest_tube': return `${t('sg_tube_h')} ${ev.side} ${ev.fr ?? 28} Fr`;
      case 'procedure.cricothyroidotomy': return `${t('sg_fona_h')}: ${t('tech_' + (ev.technique || 'scalpel_bougie'))}`;
      case 'exam.chest': return t('sg_chest_exam');
      case 'exam.pocus': return t('sg_pocus');
      case 'exam.neck': return ev.method === 'ultrasound' ? t('sg_neck_us') : t('sg_neck_palp');
      case 'cpr.surface': case 'defib.mode': return ev.type;
      default: return ev.type.startsWith('procedure.') ? t({ needle_decompression: 'pr_needle', pericardiocentesis: 'pr_pericardio', pci: 'pr_pci', thrombolysis: 'pr_lysis', treat_hyperkalemia: 'pr_hyperk' }[ev.type.slice(10)] || ev.type) : ev.type;
    }
  }

  // ---------------------------------------------------------------- per-frame
  refresh() {
    const p = this.sim.patient; if (!p) return;
    const sc = p.scenario, T = p.t;
    this.dom.clock.textContent = `${t('time')} ${mmss(T)}${sc ? ' / ' + mmss(sc.durationS) : ''}${this.sim.speed === 0 ? ' · ' + t('paused') : ''}`;
    this.dom.speedBtns.forEach(b => b.classList.toggle('on', Number(b.dataset.speed) === this.sim.speed));
    // alarm state: red pulse on cardiac arrest, amber on low saturation (when the probe is on)
    const mode = p.arrest.arrested ? 'arrest' : (p.flags.spo2Probe && p.monitor.spo2 !== null && p.monitor.spo2 < 88 ? 'hypox' : ''), sig = mode + (mode === 'arrest' ? p.arrest.key : '');
    if (sig !== this._alarmMode) { this._alarmMode = sig; this.dom.alarm.hidden = !mode; this.dom.alarm.dataset.mode = mode; this.dom.alarmText.textContent = mode === 'arrest' ? `${t('alarm_arrest')} · ${p.arrest.key}` : mode === 'hypox' ? t('alarm_hypox') : ''; }
    // CPR + defib feedback
    if (this.dom.cprFb && this.dom.cprFb.isConnected) {
      const s = p.cpr.stats, going = s.lastAge < 1.5 && s.rate > 0, ok = (v, lo, hi) => (v >= lo && v <= hi ? 'good' : 'bad');
      this.dom.cprFb.replaceChildren(going ? el('span', { class: ok(s.rate, 100, 120), text: `${Math.round(s.rate)}/min ` }) : el('span', { class: 'muted', text: '-' }), going ? el('span', { class: ok(s.depth, 5, 6), text: ` ${fmt(s.depth)} cm ` }) : '', el('span', { class: ok(p.cpr.ccf, 0.6, 1), text: ` CCF ${Math.round(p.cpr.ccf * 100)}%` }));
      const d = p.defib; this.dom.defStatus.textContent = d.charged ? t('cp_charged') : (d.chargeAt !== null && d.chargeAt > T ? t('cp_charging') : t('cp_notcharged')); this.dom.defStatus.className = 'fb ' + (d.charged ? 'good' : '');
    }
    // teaching overlay
    if (this.teach) {
      const s = p.snapshot(), rows = [['SaO2', fmt(s.spo2True) + ' %'], ['PaO2', fmt(s.pao2, 0) + ' mmHg'], ['PaCO2', fmt(s.paco2, 0) + ' mmHg'], ['pH', fmt(s.ph, 2)], ['HCO3', fmt(s.hco3, 0)], [t('mon_hr'), fmt(s.hr, 0)], ['CO', fmt(s.co, 1) + ' L/min'], ['MAP', fmt(s.map, 0)], ['SVR', fmt(s.svr, 0)], ['CPP', fmt(s.cpp, 0)],
        ['Lactate', fmt(s.lactate, 1)], ['Hb', fmt(s.hb, 1)], ['Blood lost', fmt(s.fractionLost * 100, 0) + ' %'], [t('mon_temp') + ' core', fmt(s.core, 1)], ['BIS', fmt(p.drugs.effects({ inArrest: p.arrest.arrested }).bis, 0)], ['NMB', fmt(p.drugs.effects({ inArrest: p.arrest.arrested }).nmb * 100, 0) + ' %'],
        ...Object.keys(p.drugs.pk).filter(k => p.drugs.ce(k) > 0.001).map(k => ['Ce ' + k, fmt(p.drugs.ce(k), 2)])];
      this.dom.teach.replaceChildren(el('h3', { text: t('teach_title') }), el('dl', {}, rows.map(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]).flat()));
    }
    this.drawTrend();
    this.updateGuideWait();
    // hover tooltip
    const h = this.scene.hover;
    if (h && this._mouse) { this.dom.tip.hidden = false; this.dom.tip.textContent = t(h.label); this.dom.tip.style.left = this._mouse.x + 14 + 'px'; this.dom.tip.style.top = this._mouse.y + 10 + 'px'; } else this.dom.tip.hidden = true;
  }
  drawTrend() {
    const c = this.dom.trend, g = c.getContext('2d'), W = c.width, H = c.height, data = this.sim.trend;
    g.fillStyle = '#05080b'; g.fillRect(0, 0, W, H);
    const L = 30, R = 30, T = 18, B = 16, font = '600 10px "Segoe UI", system-ui, sans-serif';
    g.font = font; g.textBaseline = 'middle';
    for (let y = 0; y <= 200; y += 50) {                                     // left axis: HR / MAP (0-200), right axis: SpO2 / EtCO2 (0-100)
      const py = H - B - (y / 200) * (H - T - B);
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(L, Math.round(py), W - L - R, 1);
      g.fillStyle = '#6f7d8a'; g.textAlign = 'right'; g.fillText(String(y), L - 6, py); g.textAlign = 'left'; g.fillText(String(y / 2), W - R + 6, py);
    }
    const series = [['hr', '#3ee08f', 200, 'HR'], ['map', '#ff5d6c', 200, 'MAP'], ['spo2', '#4cd7ff', 100, 'SpO2'], ['etco2', '#ffd23d', 100, 'EtCO2']];
    let lx = L; g.textAlign = 'left';
    for (const [, col, , name] of series) { g.fillStyle = col; g.fillRect(lx, 6, 8, 3); g.fillStyle = '#a3b0bd'; g.fillText(name, lx + 12, 8); lx += g.measureText(name).width + 28; }
    if (data.length < 2) return;
    const t1 = data[data.length - 1].t, span = Math.min(600, Math.max(60, t1)), t0 = t1 - span;
    for (const [k, col, mx] of series) {
      g.strokeStyle = col; g.lineWidth = 1.8; g.lineJoin = 'round'; g.beginPath(); let started = false;
      for (const d of data) {
        if (d.t < t0 || !Number.isFinite(d[k])) continue;
        const x = L + ((d.t - t0) / span) * (W - L - R), y = H - B - (Math.max(0, Math.min(mx, d[k])) / mx) * (H - T - B);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.fillStyle = '#6f7d8a'; g.textAlign = 'left'; g.fillText(mmss(Math.max(0, t0)), L, H - 6); g.textAlign = 'right'; g.fillText(mmss(t1), W - R, H - 6); g.textAlign = 'left';
  }

  // ---------------------------------------------------------------- debrief
  showDebrief(out) {
    const x = this.sim.scenarioId ? scenarioText(this.scenarios.find(s => s.id === this.sim.scenarioId)) : null;
    const sc = (out.server && out.server.score) || out.local;
    const ov = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('score_title') });
    const box = el('div', { class: 'box' }, el('div', { class: 'phead' }, el('h2', { text: t('score_title') + (x ? ' · ' + x.title : '') }), el('button', { class: 'x', 'aria-label': t('close'), onclick: () => ov.remove(), text: '×' })));
    const v = out.server ? (out.server.verified ? t('verified') : t('unverified')) : t('offline');
    if (sc) {
      const pct = Math.max(0, Math.min(100, sc.pct)), C = 2 * Math.PI * 54, col = pct >= 80 ? 'var(--good)' : pct >= 60 ? 'var(--warn)' : 'var(--bad)';
      const ring = el('div', { class: 'ring', style: `--ring:${col}` });
      ring.innerHTML = `<svg viewBox="0 0 132 132" aria-hidden="true"><circle class="trk" cx="66" cy="66" r="54"/><circle class="val" cx="66" cy="66" r="54" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${C.toFixed(1)}"/></svg>`;
      ring.append(el('div', { class: 'lbl' }, el('b', { text: `${pct.toFixed(0)}%` }), el('span', { text: t('score_total') })));
      requestAnimationFrame(() => requestAnimationFrame(() => ring.querySelector('.val')?.setAttribute('stroke-dashoffset', (C * (1 - pct / 100)).toFixed(1))));
      box.append(el('div', { class: 'db-head' }, ring, el('div', { class: 'db-meta' }, el('span', { class: 'grade', text: `${t('grade')} ${sc.grade}` }), el('span', { class: 'muted', text: `${sc.total} / ${sc.max} ${t('points')}` }), el('span', { class: out.server?.verified ? 'good small' : 'muted small', text: `${t('score_server')}: ${v}` }))));
      box.append(el('div', {}, sc.items.map(i => { const f = i.weight ? i.points / i.weight : 0; return el('div', { class: 'crit' },
        el('span', { class: 'cl', text: getLang() === 'fr' && CRITERION_FR[i.id] ? CRITERION_FR[i.id] : i.label }), el('span', { class: 'cp', text: `${i.points.toFixed(1)} / ${i.weight}` }),
        el('span', { class: 'bar' }, el('i', { class: f >= 0.8 ? '' : f >= 0.4 ? 'mid' : 'low', style: `width:${(f * 100).toFixed(0)}%` })), el('span', { class: 'cd', text: i.detail })); })));
      if (x) box.append(el('h4', { text: t('learning') }), el('ul', { class: 'muted' }, x.learning.map(l => el('li', { text: l }))));
    } else box.append(el('p', { class: 'muted', text: `${t('score_server')}: ${v}` }));
    box.append(el('div', { class: 'db-actions' }, el('button', { class: 'primary', onclick: () => ov.remove(), text: t('close') })));
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    ov.append(box); document.body.append(ov);
  }
  hotspot(h) {
    if (!this.sim.patient || this.sim.finished || this.menuOpen) return;
    switch (h.id) {
      case 'chest': this.openTab('tab_circ'); this.manualCompress(); break;
      case 'head': case 'o2': case 'vent': this.openTab('tab_airway'); break;
      case 'neck': case 'flank': this.openTab('tab_proc'); break;
      case 'rarm': this.act({ type: 'iv.access' }, t('od_iv')); break;
      case 'larm': this.act({ type: 'monitor.attach', items: { nibp: true } }); this.act({ type: 'nibp.cycle' }, t('od_nibp')); break;
      case 'groin': case 'ivpole': this.openTab('tab_fluids'); break;
      case 'defib': this.openTab('tab_circ'); break;
      case 'meds': this.openTab('tab_drugs'); break;
      default: this.openTab('tab_orders');
    }
  }
  /** Tell the scene how much of the window the panels cover, so the 3D view centres the patient in the free space. */
  updateInsets() {
    if (!this.dom || !this.scene) return;
    const Wd = window.innerWidth, Hd = window.innerHeight, vis = (e) => e && !e.hidden && e.getClientRects().length > 0;
    let l = 0, r = 0;
    for (const e of [this.dom.panelWrap, this.dom.card, this.menuOpen ? this.dom.menu?.querySelector('.menuL') : null]) if (vis(e)) { const b = e.getBoundingClientRect(); if (b.left < Wd * 0.3 && b.height > Hd * 0.15) l = Math.max(l, b.right); }
    for (const e of [this.menuOpen ? null : this.dom.right, this.menuOpen ? this.dom.menuR : null]) if (vis(e)) { const b = e.getBoundingClientRect(); if (b.right > Wd * 0.7 && b.height > Hd * 0.15) r = Math.max(r, Wd - b.left); }
    if (Wd <= 600) { l = 0; r = 0; }                                             // phones: panels are bottom sheets
    this.scene.inset = { l, r };
  }
  trackMouse(e) { this._mouse = { x: e.clientX, y: e.clientY }; }
}
