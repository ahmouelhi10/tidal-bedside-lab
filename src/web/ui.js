// DOM user interface: scenario/patient setup, intervention panels, event log, trends, teaching overlay, debrief. No framework.
import { t, getLang, setLang, drugName, scenarioText, CRITERION_FR } from './i18n.js';
import { SPEEDS } from './sim.js';
import { DRUGS, CALCIUM } from '/engine/drugs.js';
import { FORCED_AIR_W } from '/engine/thermal.js';
import { fluidVolumeMl } from '/engine/infection.js';
import { Coach, levelPicker, loadLevel, helpUsed } from './coach.js';
import { bmiOf, bmiClass } from '/engine/anthropometrics.js';
import { SKIN_TONES } from './gl/body.js';
import { CAMERAS } from './scene.js';
import { PROCEDURES, PARAMS, Guide } from './procedures.js';
import { icon, stepIcon } from './icons.js';
import { TOOLS } from './handson.js';
import { WardView, wardClock, abxName } from './ward.js';
import { EffectWatcher } from './effects.js';
import { monitorOnset } from './onset.js';
import { REFERENCES } from '/engine/references.js';
import { mechanics, waveAt } from '/engine/mechanics.js';
import { LAB_KINDS, RANGES as LAB_RANGES } from '/engine/labs.js';
import { SCENARIOS } from '/engine/scenarios.js';
import { buildTimeline, keyActionTimes } from '/engine/timeline.js';
import { makeResizable } from './resize.js';
import { prebrief, pearls, reflect, calibrationCard, momentsList } from './debrief-ui.js';
import { ANTS_CATEGORIES } from '/engine/debrief.js';
import { LiveConsole } from './live.js';
import { procExtra, pacingExtra, ordersExtra, scoresTick, fluidsExtra, showEcg12, vaporizerExtra, volTick, nivExtra, signsTick } from './panels2.js';
import { TEAM_ACTS } from '/engine/team.js';
import { SBAR } from '/engine/debrief.js';
import { AREAS, loadProgress, recordProgress, clearProgress, levelOf, profileOf, achievementsOf } from './progress.js';

/** Skills training: the case each procedure is practised on (the condition that makes the procedure meaningful). */
const SKILL_CASE = { iv: '', rsi: 'obese_rsi', defib: 'witnessed_vf', needle: 'tension_ptx', drain: 'tension_ptx', fona: 'cico' };
/** Instruments on the table besides the ones the procedure needs: choosing the right one is part of the skill. */
const DISTRACTORS = ['scalpel', 'syringe', 'tourniquet', 'bougie', 'forcepsGauze'];
/** Start-screen views that start a case, so the patient chooser is shown beside them. */
const PLAYABLE = new Set(['lab', 'skills', 'resus', 'chal', 'echo', 'infect', 'instructor']);
/** Body-shape presets: a BMI inside each WHO class (WHO_BMI_CLASSES in /engine/anthropometrics.js); weight = BMI x height^2. */
const SHAPES = [['shape_under', 17.5], ['shape_normal', 22], ['shape_over', 27.5], ['shape_obese', 33], ['shape_morbid', 45]];

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
    { k: 'flumazenil', fixed: 200, step: 100 },
  ] },
  { g: 'g_nmb', items: [
    { k: 'rocuronium', per: 1.2, basis: 'ibw', step: 5 },
    { k: 'succinylcholine', per: 1.5, basis: 'tbw', step: 10 },
    { k: 'sugammadex', per: 4, basis: 'tbw', step: 10 },
    { k: 'neostigmine', per: 50, basis: 'tbw', step: 500 },
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
    { k: 'calciumChloride', fixed: CALCIUM.calciumChloride.presetMmol, step: CALCIUM.calciumChloride.stepMmol, ca: CALCIUM.calciumChloride },     // mmol of elemental calcium; values set in drugs.js
    { k: 'calciumGluconate', fixed: CALCIUM.calciumGluconate.presetMmol, step: CALCIUM.calciumGluconate.stepMmol, ca: CALCIUM.calciumGluconate },
  ] },
  { g: 'g_crisis', items: [
    { k: 'epinephrine', route: 'im', fixed: 500, step: 100, label: 'IM' },
    { k: 'ephedrine', fixed: 10, step: 5 },
    { k: 'dobutamine', fixed: 250, step: 50, inf: { unit: 'mcg/kg/min', def: 5, step: 0.5, toEngine: (v, b) => v * b.weightKg } },
    { k: 'salbutamol', fixed: 5, step: 2.5 },
    { k: 'magnesium', fixed: 2, step: 0.5 },
    { k: 'dantrolene', per: 2.5, basis: 'tbw', step: 20 },
    { k: 'lipid', per: 1.5, basis: 'tbw', step: 10, inf: { unit: 'mL/kg/min', def: 0.25, step: 0.05, toEngine: (v, b) => v * b.weightKg } },
    { k: 'hydrocortisone', fixed: 200, step: 50 },
    { k: 'terlipressin', fixed: 2, step: 1 },
    { k: 'ceftriaxone', fixed: 1000, step: 1000 },
    { k: 'ipratropium', fixed: 0.5, step: 0.25 },
    { k: 'prednisolone', fixed: 40, step: 10 },
  ] },
  { g: 'g_pacu', items: [
    { k: 'ondansetron', fixed: 4, step: 1 },
    { k: 'droperidol', fixed: 1.25, step: 0.625 },
    { k: 'dexamethasone', fixed: 8, step: 4 },
    { k: 'pethidine', fixed: 25, step: 12.5 },
  ] },
  { g: 'g_neuro', items: [
    { k: 'midazolam', route: 'im', fixed: 10, step: 2.5, label: 'IM' },
    { k: 'lorazepam', fixed: 4, step: 1 },
    { k: 'diazepam', fixed: 10, step: 2.5 },
    { k: 'levetiracetam', per: 60, basis: 'tbw', step: 250 },
  ] },
  { g: 'g_cardio', items: [
    { k: 'isoprenaline', fixed: 20, step: 10, inf: { unit: 'mcg/min', def: 5, step: 1, toEngine: (v) => v } },
    { k: 'esmolol', per: 0.5, basis: 'tbw', step: 5 },
    { k: 'metoprolol', fixed: 5, step: 2.5 },
    { k: 'labetalol', fixed: 20, step: 5 },
    { k: 'urapidil', fixed: 25, step: 5 },
    { k: 'aspirin', fixed: 250, step: 50 },
    { k: 'heparin', per: 70, basis: 'tbw', step: 500 },
    { k: 'morphine', fixed: 5, step: 1 },
  ] },
  { g: 'g_metab', items: [
    { k: 'glucose', fixed: 20, step: 5, inf: { unit: 'mL/h G10 %', def: 125, step: 25, toEngine: (v) => v * 0.1 / 60 } },
    { k: 'insulin', fixed: 10, step: 2, inf: { unit: 'U/kg/h', def: 0.1, step: 0.05, toEngine: (v, b) => v * b.weightKg / 60 } },
    { k: 'potassiumChloride', fixed: 10, step: 10 },
    { k: 'glucagon', route: 'im', fixed: 1, step: 0.5, label: 'IM' },
    { k: 'furosemide', fixed: 40, step: 10 },
    { k: 'tranexamicAcid', fixed: 1000, step: 500 },
  ] },
  { g: 'g_regional', items: [
    { k: 'bupivacaine', route: 'regional', per: 1.5, basis: 'tbw', step: 10, label: 'block' },
  ] },
];
const O2 = { room: { fio2: 0.21, seal: 0.5, key: 'aw_room' }, nc: { fio2: 0.36, seal: 0.6, key: 'aw_nc' }, mask: { fio2: 0.55, seal: 0.8, key: 'aw_mask' }, nrb: { fio2: 0.85, seal: 0.9, key: 'aw_nrb' }, v24: { fio2: 0.24, seal: 1, key: 'aw_v24' }, v28: { fio2: 0.28, seal: 1, key: 'aw_v28' } };

export class UI {
  constructor(root, ctx) {
    this.root = root; this.glCanvas = ctx.glCanvas; this.monCanvas = ctx.monCanvas; this.sim = ctx.sim; this.scene = ctx.scene; this.monitor = ctx.monitor; this.sound = ctx.sound;
    this.tab = 'tab_drugs'; this.logLines = []; this.teach = false; this.toastT = 0; this.scenarios = []; this.inputs = {};
    this.effects = new EffectWatcher((r) => this.effectReport(r)); this.effLines = [];
    // every action, wherever it comes from (panels, guided steps, instruments), is watched for its measured effect
    this.sim.addEventListener('action', (e) => this.effects.watch(e.detail.event, e.detail.result, this.sim.patient, this.describe(e.detail.event) || e.detail.event.type));
    // drug countdown: each bolus starts a timer to its visible effect and to its peak (simulated time, see onset.js)
    this.drugClock = {};
    this.sim.addEventListener('action', (e) => {
      const ev = e.detail.event, p = this.sim.patient;
      if (ev.type !== 'drug.bolus' || (e.detail.result && e.detail.result.ok === false) || !p) return;
      let r = null; try { r = monitorOnset(p.spec, ev.drug, ev.amount); } catch { /* timing unavailable */ }
      if (r) this.drugClock[ev.drug] = { t0: p.t, onsetS: r.onsetS, peakS: r.peakS, sign: r.sign };
    });
  }

  // ---------------------------------------------------------------- chrome: full-screen 3D stage with a game-style HUD
  async init() {
    this.scenarios = await this.sim.scenarios();
    const r = this.root;
    r.replaceChildren();
    this.dom = {};
    if (this.menuOpen === undefined) this.menuOpen = !this.sim.patient;
    if (this.panelOpen === undefined) this.panelOpen = false;
    if (this.level === undefined) this.level = loadLevel();   // learner level: beginner (coach), intermediate (senior on request), expert (no help)
    if (this.hints === undefined) this.hints = false;   // floating markers are opt-in (settings > Markers); hovering the patient or equipment still names it
    const top = el('header', { class: 'hud-top' },
      this.dom.clock = el('div', { class: 'clock', 'aria-live': 'off' }),
      el('div', { class: 'spacer' }),
      this.dom.speed = this.speedBar(),
      this.dom.btnLog = el('button', { id: 'btnLog', class: 'ghost', 'aria-expanded': 'false', title: t('log'), onclick: () => this.toggleLog() }, t('log_btn'), this.dom.logBadge = el('span', { class: 'cnt', hidden: true })),
      this.dom.btnBrief = el('button', { id: 'btnBrief', class: 'ghost', onclick: () => { this.dom.card.hidden = !this.dom.card.hidden; }, text: t('briefing') }),
      this.dom.liveChip = el('button', { class: 'ghost live-chip', hidden: true, onclick: () => { const c = this.liveLink?.code; if (!c) return; navigator.clipboard?.writeText(c).catch(() => {}); this.toast(t('lv_copied', { code: c })); } }),
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
      this.dom.hint = el('div', { class: 'hint', text: t('shortcuts') }), this.dom.logBox, el('footer', { class: 'foot', text: t('disclaimer') }), this.buildMenu(), this.dom.noGl, this.dom.tip, this.dom.toast);
    if (this.sim.patient) { this.refreshCard(); this.buildTabs(); this.syncSetupFromSession(); }
    this.syncPins(); this.syncChrome();
  }
  /** Settings pop-over: sound, markers, teaching overlay, language. */
  buildOpts() {
    const box = el('div', { class: 'optsbox' },
      el('label', { class: 'chk' }, el('input', { type: 'checkbox', id: 'chkSound', onchange: e => { this.sound.enable(e.target.checked); } }), ' ', t('sound')),
      el('label', { class: 'chk' }, el('input', { type: 'checkbox', id: 'chkHints', checked: this.hints, onchange: e => { this.hints = e.target.checked; } }), ' ', t('hints')),
      el('label', { class: 'chk', title: t('tm_mode_t') }, el('input', { type: 'checkbox', id: 'chkTeam', checked: !!this.teamMode, onchange: e => { this.teamMode = e.target.checked; } }), ' ', t('tm_mode')),
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
    for (const e of [d.clock, d.speed, d.cam, d.btnNew, d.btnFinish, d.btnLog, d.left, d.right, d.dock, d.hint]) if (e) e.hidden = !play;
    if (!play && d.logBox) this.toggleLog(false);
    d.btnBrief.hidden = !play || !this.scenarios.find(x => x.id === this.sim.scenarioId);
    if (d.liveChip) d.liveChip.hidden = !play || !this.liveLink?.code;
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
    const items = [['tab_guide', 'guide'], ['tab_drugs', 'drugs'], ['tab_fluids', 'fluids'], ['tab_airway', 'airway'], ['tab_circ', 'cpr'], ['tab_proc', 'proc'], ['tab_orders', 'orders'], ['tab_ward', 'microbe']];
    this.dom.dockBtns = items.map(([k, ic]) => {
      const b = el('button', { class: 'dockbtn', id: 'dock-' + k, dataset: { tab: k }, 'aria-pressed': 'false', title: t(k), onclick: () => this.toggleTab(k) });
      b.insertAdjacentHTML('afterbegin', ICON[ic] ?? icon(ic, 22)); b.append(el('span', { text: t(k) })); return b;
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
  /** Start screen: home (eight sections); every playable mode shows the patient chooser on the right. */
  menuView(view) {
    if (view === 'scen') view = 'resus';
    this._view = view; const B = this.dom.menuBody; B.replaceChildren();
    this.dom.menuR.hidden = !PLAYABLE.has(view);
    if (view !== 'skills') this.pendingSkill = null;
    const back = () => el('button', { class: 'ghost menu-back', onclick: () => this.menuView('home') }, el('span', { class: 'ic' }), t('menu_back'));
    const sec = (id, ic, col, title, sub, soon) => { const b = el('button', { class: 'sect' + (soon ? ' soon' : ''), style: `--sc:${col}`, dataset: { view: id }, onclick: () => this.menuView(id) }); b.innerHTML = `<span class="sect-ic">${icon(ic, 24)}</span>`; b.append(el('span', { class: 'sect-t' }, el('b', { text: title }), el('span', { text: sub })), el('span', { class: 'sect-go' })); b.lastChild.innerHTML = soon ? `<span class="badge">${t('soon')}</span>` : icon('chevron', 18); return b; };
    const pickScenario = (id) => { this.inputs.scenario.value = id; this.inputs.scenario.dispatchEvent(new Event('change')); };
    if (view === 'home') {
      B.append(el('h3', { text: t('home_q') }), el('div', { class: 'sects' },
        sec('lab', 'flask', '#4cc3ff', t('sec_lab'), t('sec_lab_sub')),
        sec('skills', 'target', '#ffb23d', t('sec_skills'), t('sec_skills_sub')),
        sec('resus', 'heart', '#ff5d6c', t('sec_resus'), t('sec_resus_sub')),
        sec('chal', 'clipboard', '#3ee08f', t('sec_chal'), t('sec_chal_sub')),
        sec('infect', 'microbe', '#ffc23d', t('sec_inf'), t('sec_inf_sub')),
        sec('echo', 'probe', '#2fd3c4', t('sec_echo'), t('sec_echo_sub')),
        sec('progress', 'chart', '#b07cff', t('sec_prog'), t('sec_prog_sub')),
        sec('instructor', 'board', '#3d9bff', t('sec_inst'), t('sec_inst_sub'))));
      return;
    }
    if (view === 'lab') {
      pickScenario('');
      B.append(back(), el('h3', { text: t('sec_lab') }), el('div', { class: 'card lab-note' }, el('p', { text: t('lab_text') }), el('ul', { class: 'muted small' }, [t('lab_1'), t('lab_2'), t('lab_3')].map(x => el('li', { text: x })))));
    } else if (view === 'resus' || view === 'chal' || view === 'echo' || view === 'infect') {
      const pick = view === 'resus' ? (s => s.kind === 'ACLS') : view === 'echo' ? (s => s.kind === 'Echo') : view === 'infect' ? (s => s.kind === 'Infectiology') : (s => s.kind !== 'ACLS' && s.kind !== 'Echo' && s.kind !== 'Infectiology');
      B.append(back(), el('h3', { text: t({ resus: 'sec_resus', chal: 'sec_chal', echo: 'sec_echo', infect: 'sec_inf' }[view]) }), levelPicker(this), el('p', { class: 'muted small', text: t({ resus: 'resus_text', chal: 'chal_text', echo: 'echo_text', infect: 'inf_text' }[view]) }), this.dom.cards);
      if (view === 'echo') B.append(el('details', { class: 'card lab-note small' }, el('summary', { text: t('soon_sources_echo') }), el('ul', { class: 'muted' }, t('echo_sources').map(x => el('li', { text: x })))));
      if (view === 'infect') B.append(el('details', { class: 'card lab-note small' }, el('summary', { text: t('soon_sources') }), el('ul', { class: 'muted' }, t('inf_sources').map(x => el('li', { text: x })))));
      this.buildCards(false, pick);
      const cur = this.scenarios.find(s => s.id === this.inputs.scenario.value);
      if (!cur || !pick(cur)) { const first = this.scenarios.find(pick); if (first) pickScenario(first.id); }
    } else if (view === 'infect' || view === 'echo') {
      const k = view === 'infect' ? 'inf' : 'echo';
      B.append(back(), el('h3', { text: t('sec_' + k) }), el('div', { class: 'card lab-note' }, el('p', { class: 'badge', text: t('soon') }), el('p', { text: t(k + '_plan') }),
        el('ul', { class: 'muted small' }, t(k + '_items').map(x => el('li', { text: x }))), el('h4', { text: t('soon_sources') }), el('ul', { class: 'muted small' }, t(k + '_sources').map(x => el('li', { text: x })))));
    } else if (view === 'progress') {
      B.append(back(), el('h3', { text: t('sec_prog') }), this.progressView());
    } else if (view === 'instructor') {
      pickScenario('');
      B.append(back(), el('h3', { text: t('sec_inst') }), this.instructorView(), this.dom.cards);
      this.buildCards(false);
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
      B.append(back(), el('h3', { text: t('sec_skills') }), levelPicker(this), el('p', { class: 'muted small', text: t('skills_text') }), list);
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
  buildCards(grouped = false, only = null) {
    const cards = this.dom.cards; cards.replaceChildren();
    if (only) { for (const s of this.scenarios.filter(only)) { const x = scenarioText(s); cards.append(el('button', { class: 'scard', dataset: { id: s.id, kind: s.kind }, 'aria-pressed': 'false', onclick: () => { this.inputs.scenario.value = s.id; this.inputs.scenario.dispatchEvent(new Event('change')); } }, el('b', { text: x.title }), el('span', { class: 'sum', text: x.summary }), this._badges(s))); } this.markCards(); return; }
    const lvl = { beginner: 1, intermediate: 2, advanced: 3 };
    const badges = (s) => !s ? el('div', { class: 'badges' }, el('span', { class: 'badge kind', text: t('free_badge') })) : el('div', { class: 'badges' },
      el('span', { class: 'badge kind', text: s.kind }),
      el('span', { class: 'badge', title: s.difficulty }, el('span', { class: 'lvl' }, [1, 2, 3].map(i => el('i', { class: i <= (lvl[s.difficulty] || 1) ? 'on' : '' }))), ' ', s.difficulty),
      el('span', { class: 'badge', text: `${Math.round(s.durationS / 60)} min` }));
    const mk = (id, title, summary, s) => el('button', { class: 'scard', dataset: { id, kind: s ? s.kind : 'free' }, 'aria-pressed': 'false', onclick: () => { this.inputs.scenario.value = id; this.inputs.scenario.dispatchEvent(new Event('change')); } },
      el('b', { text: title }), el('span', { class: 'sum', text: summary }), badges(s));
    if (!grouped) { cards.append(mk('', t('free_play'), t('free_sub'), null)); for (const s of this.scenarios) { const x = scenarioText(s); cards.append(mk(s.id, x.title, x.summary, s)); } }
    else for (const [title, pick] of [[t('grp_resus'), s => s.kind === 'ACLS'], [t('grp_chal'), s => s.kind !== 'ACLS' && s.kind !== 'Infectiology']]) {
      cards.append(el('h3', { class: 'grp', text: title }));
      for (const s of this.scenarios.filter(pick)) { const x = scenarioText(s); cards.append(mk(s.id, x.title, x.summary, s)); }
    }
    this.markCards();
  }
  _badges(s) {
    const lvl = { beginner: 1, intermediate: 2, advanced: 3 };
    return el('div', { class: 'badges' }, el('span', { class: 'badge kind', text: s.kind }),
      el('span', { class: 'badge', title: s.difficulty }, el('span', { class: 'lvl' }, [1, 2, 3].map(i => el('i', { class: i <= (lvl[s.difficulty] || 1) ? 'on' : '' }))), ' ', s.difficulty),
      el('span', { class: 'badge', text: `${Math.round(s.durationS / 60)} min` }));
  }
  /** My progress: level, skill profile, achievements and history (this browser only). */
  progressView() {
    const list = loadProgress(), lv = levelOf(list), prof = profileOf(list);
    const ach = achievementsOf(list, { skillIds: PROCEDURES.map(p => p.id), challengeIds: this.scenarios.filter(s => s.kind !== 'ACLS' && s.kind !== 'Echo' && s.kind !== 'Infectiology').map(s => s.id) });
    const pct = (x) => (x == null ? '-' : `${Math.round(x)}%`);
    const box = el('div', { class: 'prog' });
    box.append(el('div', { class: 'card prog-level' }, el('div', { class: 'prog-lv', text: t('prog_level', { n: lv.level }) }),
      el('div', { class: 'pw-bar' }, el('i', { style: `width:${(100 * lv.into / lv.need).toFixed(0)}%` })), el('span', { class: 'small muted', text: t('prog_xp', { xp: lv.xp, next: lv.need - lv.into }) })));
    box.append(el('h4', { text: t('prog_profile') }), el('div', { class: 'card prog-prof' }, AREAS.map(a => el('div', { class: 'crit' },
      el('span', { class: 'cl', text: t('area_' + a) }), el('span', { class: 'cp', text: t('prog_cases', { n: prof[a].n }) }),
      el('span', { class: 'bar' }, el('i', { class: (prof[a].mean ?? 0) >= 80 ? '' : (prof[a].mean ?? 0) >= 60 ? 'mid' : 'low', style: `width:${(prof[a].mean ?? 0).toFixed(0)}%` })),
      el('span', { class: 'cd', text: t('prog_meanbest', { m: pct(prof[a].mean), b: pct(prof[a].best) }) })))));
    box.append(el('h4', { text: t('prog_ach') }), el('div', { class: 'achs' }, ach.map(a => el('div', { class: 'ach' + (a.ok ? ' ok' : ''), title: t('ach_' + a.id + '_d') }, el('b', { text: (a.ok ? '★ ' : '☆ ') + t('ach_' + a.id) }), el('span', { class: 'small muted', text: t('ach_' + a.id + '_d') })))));
    const hist = list.slice(-25).reverse();
    box.append(el('h4', { text: t('prog_hist') }), hist.length ? el('ol', { class: 'hist' }, hist.map(r => el('li', {},
      el('span', { class: 'small muted', text: new Date(r.at).toLocaleString(getLang() === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }) }),
      el('span', { class: 'badge', text: t('area_' + r.area) }), el('b', { text: r.title || r.id || '' }), el('span', { text: pct(r.pct) + (r.grade ? ` · ${r.grade}` : '') })))) : el('p', { class: 'muted small', text: t('prog_empty') }));
    box.append(el('p', { class: 'muted small', text: t('prog_local') }), el('div', { class: 'row2' },
      el('button', { class: 'ghost', onclick: () => { const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(loadProgress(), null, 1)], { type: 'application/json' })), download: 'tidal-progress.json' }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }, text: t('prog_export') }),
      el('button', { class: 'ghost danger', onclick: () => { if (confirm(t('prog_clear_q'))) { clearProgress(); this.menuView('progress'); } }, text: t('prog_clear') })));
    return box;
  }
  /** Instructor mode: free play or any case, with the teaching overlay and markers on, plus the server's session list. */
  /** Team mode: send the order, show the member's read-back, and carry out only what the leader confirms. */
  teamOrder(ev, label) {
    this._teamId = (this._teamId || 0) + 1;
    const id = this._teamId, r = this.sim.act({ type: 'team.order', id, act: ev });
    if (!r || r.ok === false) { this.toast(r?.error || t('err_generic'), true); return r; }
    if (!this.dom.teamBox) { this.dom.teamBox = el('div', { class: 'team-box', 'aria-live': 'polite' }); document.body.append(this.dom.teamBox); }
    const text = el('p', { class: 'tm-rb' }), card = el('div', { class: 'tm-card' });
    const say = (act) => { text.textContent = t('tm_rb_' + r.role, { what: this.describe(act) || act.type }); };
    say(r.readback);
    const done = () => { card.remove(); };
    card.append(el('div', { class: 'tm-who' }, el('b', { text: t('tm_role_' + r.role) }), el('span', { class: 'small muted', text: t('tm_you_said', { what: this.describe(ev) || ev.type }) })), text,
      el('div', { class: 'tm-act' },
        el('button', { class: 'ghost', type: 'button', onclick: () => { const c = this.sim.act({ type: 'team.correct', id }); if (c?.ok) { say(c.readback); this.toast(t('tm_corrected')); } }, text: t('tm_correct') }),
        el('button', { class: 'primary', type: 'button', onclick: () => { const c = this.sim.act({ type: 'team.confirm', id }); done(); if (c?.ok) this.actNow(c.act, label); }, text: t('tm_confirm') })));
    this.dom.teamBox.append(card);
    return { ok: true, pending: true };
  }
  /** title, summary and objectives of a scenario in the current language */
  caseTextOf(sc) { return scenarioText(sc); }
  instructorView() {
    const box = el('div', { class: 'card lab-note inst' });
    const code = el('input', { type: 'text', maxlength: 6, autocomplete: 'off', placeholder: 'K7P2QX', 'aria-label': t('lv_code'), class: 'lv-code' });
    const join = () => { if (code.value.trim()) (this.liveConsole ??= new LiveConsole(this)).open(code.value); };
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    box.append(el('div', { class: 'lv-join' }, el('h4', { text: t('lv_join_title') }), el('p', { class: 'muted small', text: t('lv_join_t') }), el('div', { class: 'row2' }, code, el('button', { class: 'primary', onclick: join, text: t('lv_join') }))));
    const chk = (key, label, get, set) => el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: get(), onchange: e => set(e.target.checked) }), ' ', t(label));
    if (!this.instructor) { this.instructor = true; this.teach = true; if (this.dom.teach) this.dom.teach.hidden = false; }   // instructor mode shows the hidden physiology by default
    box.append(el('p', { text: t('inst_text') }),
      chk('teach', 'teaching', () => this.teach, v => { this.teach = v; if (this.dom.teach) this.dom.teach.hidden = !v; }),
      chk('hints', 'hints', () => this.hints, v => { this.hints = v; }),
      el('p', { class: 'muted small', text: t('inst_pick') }));
    const tok = el('input', { type: 'password', autocomplete: 'off', placeholder: 'API_TOKEN', value: this._apiToken || '', oninput: e => { this._apiToken = e.target.value; } });
    const out = el('div', { class: 'small' });
    const load = async () => {
      out.replaceChildren(el('span', { class: 'muted', text: '…' }));
      try {
        const r = await fetch('/api/sessions', { headers: tok.value ? { Authorization: 'Bearer ' + tok.value } : {} });
        if (!r.ok) { out.replaceChildren(el('span', { class: 'bad', text: r.status === 403 ? t('inst_disabled') : r.status === 401 ? t('inst_badtoken') : `HTTP ${r.status}` })); return; }
        const rows = await r.json();
        out.replaceChildren(rows.length ? el('ol', { class: 'hist' }, rows.slice(0, 50).map(s => el('li', {},
          el('span', { class: 'small muted', text: (s.createdAt || '').replace('T', ' ').slice(0, 16) }), el('b', { text: s.learner || '-' }),
          el('span', { text: s.scenario ? (this.scenarios.find(x => x.id === s.scenario) ? scenarioText(this.scenarios.find(x => x.id === s.scenario)).title : s.scenario) : t('free_play') }),
          el('span', { class: 'badge', text: s.result?.score ? `${Math.round(s.result.score.pct)}% ${s.result.score.grade}` : s.status })))) : el('span', { class: 'muted', text: t('inst_none') }));
      } catch { out.replaceChildren(el('span', { class: 'bad', text: t('offline') })); }
    };
    box.append(el('details', { class: 'inst-srv' }, el('summary', { text: t('inst_sessions') }), el('p', { class: 'muted small', text: t('inst_token') }),
      el('div', { class: 'row2' }, tok, el('button', { class: 'ghost', onclick: load, text: t('inst_load') })), out));
    return box;
  }
  markCards() { for (const c of this.dom.cards.querySelectorAll('.scard')) { const on = c.dataset.id === (this.inputs.scenario.value || ''); c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); } }

  buildLeft() {
    const L = this.dom.left;
    this.dom.card = el('section', { class: 'card scen', hidden: true });
    this.dom.panelTitle = el('h3');
    this.dom.panel = el('div', { class: 'panel' });
    this.dom.panelWrap = el('section', { class: 'hud-panel', hidden: true }, el('div', { class: 'phead' }, this.dom.panelTitle, el('button', { class: 'x', 'aria-label': t('panel_close'), title: t('panel_close'), onclick: () => this.closePanel(), text: '×' })), this.dom.panel);
    L.append(this.dom.card, this.dom.panelWrap);
    this.rzLeft = makeResizable(L, { edge: 'right', key: 'tbl.panelWidth', min: 280, max: () => Math.min(760, window.innerWidth * 0.6), label: t('rz_label'), host: this.dom.panelWrap, minViewport: 860 });   // the action panel can be widened from its right edge
  }
  /** title and summary of the running case, for windows that show it (the echo window) */
  caseText() { const sc = this.scenarios.find(s => s.id === this.sim.scenarioId); return sc ? scenarioText(sc) : null; }
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
    // who is the patient: sex buttons and body-shape presets first, exact values below
    sex.hidden = true;
    this.dom.sexBtns = [['M', 'male', '♂'], ['F', 'female', '♀']].map(([v, k, g]) => el('button', { type: 'button', dataset: { sex: v }, onclick: () => { sex.value = v; sex.dispatchEvent(new Event('change')); } }, el('span', { class: 'g', text: g }), t(k)));
    this.dom.shapeBtns = SHAPES.map(([k, b]) => el('button', { type: 'button', dataset: { bmi: b }, title: `${t('bmi')} ${b}`, onclick: () => {
      const h = Number(this.inputs.inH.value) || 175, w = Math.round(b * (h / 100) ** 2);
      this.inputs.inW.value = Math.max(35, Math.min(250, w)); this.updateBmi(); this.queuePreview();
    } }, el('i', { class: 'shape', style: `--fat:${((b - 17.5) / 27.5).toFixed(2)}` }), t(k)));
    S.append(sel,
      el('div', { class: 'f wide' }, el('span', { text: t('who_patient') }), el('div', { class: 'seg sexseg', role: 'group', 'aria-label': t('sex') }, ...this.dom.sexBtns)),
      el('div', { class: 'f wide' }, el('span', { text: t('body_shape') }), el('div', { class: 'shapes', role: 'group', 'aria-label': t('body_shape') }, ...this.dom.shapeBtns)),
      el('div', { class: 'row4' }, sex, num('inAge', t('age'), 18, 100, 1, 45), num('inH', t('height'), 140, 210, 1, 175), num('inW', t('weight'), 35, 250, 1, 80)),
      el('div', { class: 'row2' }, el('label', { class: 'f' }, el('span', { text: t('skin') }), tone), this.dom.bmi),
      el('label', { class: 'f wide' }, el('span', { text: t('learner') }), this.inputs.learner = el('input', { type: 'text', id: 'inLearner', maxlength: 64, autocomplete: 'off', value: this._learner || '', oninput: e => { this._learner = e.target.value; } })),
      el('button', { id: 'btnStart', class: 'primary big wide', onclick: () => { this._mode = this._view; this.onStart?.(this.readSetup()); }, text: this.sim.patient ? t('restart') : t('start_case') }), this.dom.info);
    if (this.dom.menuR) this.dom.menuR.hidden = this._view === 'home';
    this.buildCards(); this.syncSpecInputs(); this.showScenarioInfo(); stepify(S);
  }
  syncSpecInputs() {
    const id = this.inputs.scenario.value, sc = this.scenarios.find(s => s.id === id), sp = sc ? sc.spec : { sex: 'M', age: 45, heightCm: 175, weightKg: 80 };
    this.inputs.sex.value = sp.sex; this.inputs.inAge.value = sp.age; this.inputs.inH.value = sp.heightCm; this.inputs.inW.value = sp.weightKg; this.updateBmi(); this.queuePreview();
  }
  updateBmi() {
    const h = Number(this.inputs.inH.value), w = Number(this.inputs.inW.value);
    for (const x of this.dom.sexBtns || []) x.classList.toggle('on', x.dataset.sex === this.inputs.sex.value);
    if (!(h > 0 && w > 0)) return; const b = bmiOf(w, h), ok = b >= 15 && b <= 65;
    const near = SHAPES.reduce((best, [, v], i) => (Math.abs(v - b) < Math.abs(SHAPES[best][1] - b) ? i : best), 0);
    (this.dom.shapeBtns || []).forEach((x, i) => x.classList.toggle('on', i === near && Math.abs(SHAPES[i][1] - b) < 4));
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
    // one click connects the standard monitoring while nothing is plugged in (attaching it stays the learner's action)
    this.dom.monAttach = el('button', { class: 'mon-attach', hidden: true, onclick: () => { this.act({ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, nibp: true, capnography: true } }, t('mon_attached')); this.act({ type: 'nibp.cycle' }); } }, el('b', { text: t('mon_attach') }), el('span', { class: 'small', text: t('mon_attach_sub') }));
    this.dom.monWrap = el('div', { class: 'monWrap' }, this.monCanvas, this.dom.monAttach);
    this.dom.effList = el('ol', { class: 'eff-list', 'aria-live': 'polite' });
    this.dom.effBox = el('section', { class: 'card effects' }, el('h3', { text: t('eff_title') }), this.dom.effList, el('p', { class: 'muted small eff-empty', text: t('eff_empty') }));
    this.effLines.forEach(x => this.dom.effList.append(x));
    this.dom.teach = el('section', { class: 'card teach', hidden: !this.teach });
    this.dom.trend = el('canvas', { class: 'trend', width: 480, height: 150, 'aria-label': t('tr_title') });
    // the action log lives behind the "Log" button of the top bar (pop-over), leaving the right column to monitor, effects and trends
    this.dom.logBox = el('section', { class: 'card log logpop', hidden: true, role: 'dialog', 'aria-label': t('log') },
      el('div', { class: 'phead' }, el('h3', { text: t('log') }), el('button', { class: 'x', 'aria-label': t('close'), title: t('close'), onclick: () => this.toggleLog(false), text: '×' })),
      this.dom.logList = el('ol', { 'aria-live': 'polite' }));
    this.coach ??= new Coach(this); this.coach.render(true);
    R.append(this.dom.monWrap, this.coach.box, this.dom.effBox, this.dom.teach, el('section', { class: 'card trends' }, el('h3', { text: t('tr_title') }), this.dom.trend));
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
  escape() { if (this.dom.logBox && !this.dom.logBox.hidden) this.toggleLog(false); else if (this.menuOpen && this.sim.patient) this.closeMenu(true); else if (this.panelOpen) this.closePanel(); }

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
    this.logLines = []; this.dom.logList.replaceChildren(); this.guide = null; this._unseen = 0; this._logBadge(); this.toggleLog(false);
    this.effects.reset(); this.effLines = []; this.dom.effList.replaceChildren(); this.drugClock = {}; this._labsSeen = 0;
    // free play (physiology lab, instructor): standard monitoring connected from the start; in scored cases it is the learner's job
    if (!this.sim.scenarioId && ['lab', 'instructor', undefined].includes(this._mode)) { this.sim.act({ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, nibp: true, capnography: true } }); this.sim.act({ type: 'nibp.cycle' }); }
    this.refreshCard(); this.dom.card.hidden = !this.scenarios.find(s => s.id === this.sim.scenarioId);
    this.panelOpen = false; this.dom.panelWrap.hidden = true; this._alarmMode = null; this.dom.alarm.hidden = true;
    this.buildTabs();
    this.syncSetupFromSession(); this.syncPins(); this.syncChrome();
    const skill = this.pendingSkill && PROCEDURES.find(pr => pr.id === this.pendingSkill);
    if (skill) setTimeout(() => this.startGuide(skill), 400);
    this.liveLink?.start();                                         // live instructor channel (online sessions only)
    this.dom.teamBox?.replaceChildren(); this._teamId = 0;
    this.coach?.start(); if (this.coach && this.pendingSkill) this.coach.box.hidden = true;   // skills training: the guided panel is the help
    const sc0 = this.scenarios.find(s => s.id === this.sim.scenarioId);
    if (sc0 && !this.pendingSkill) { const sp = this.sim.speed; this.sim.setSpeed(0); prebrief(scenarioText(sc0), !!this.teamMode).then((r) => { this.teamMode = !!r?.team; const c = this.dom.opts?.querySelector('#chkTeam'); if (c) c.checked = this.teamMode; if (this.sim.patient && !this.sim.finished && this.sim.speed === 0) this.sim.setSpeed(sp || 1); }); }   // scored case: pre-brief first, the clock waits
    if (this.sim.patient?.ward) { this.wardView = new WardView(this); this.tab = 'tab_ward'; this.panelOpen = true; this.dom.card.hidden = true; this.buildTabs(); }   // infectiology cases open the ward workspace
    if (this.scenarios.find(s => s.id === this.sim.scenarioId)?.kind === 'Echo') setTimeout(() => this.echoLab?.start(), 400);   // focused echo cases open the echo window
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
    const wardCase = !!this.sim.patient?.ward;                    // infectiology: only the ward workspace is relevant
    this.dom.dockBtns.forEach(b => { b.hidden = wardCase !== (b.dataset.tab === 'tab_ward'); });
    this.dom.left?.classList.toggle('ward-mode', wardCase && this.panelOpen && this.tab === 'tab_ward');
    this.dom.dockBtns.forEach(b => { const on = this.panelOpen && b.dataset.tab === this.tab; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    this.dom.panelWrap.hidden = !this.panelOpen || !this.sim.patient;
    if (this.dom.hint) this.dom.hint.hidden = !this.dom.panelWrap.hidden || !this.sim.patient || this.menuOpen;   // the shortcut hint would sit under the open panel
    if (this.dom.panelWrap.hidden) return;
    this.dom.panelTitle.textContent = t(this.tab);
    const P = this.dom.panel; P.replaceChildren(); P.className = 'panel';   // a workspace (the infectiology ward) may have restyled the panel: start clean for every tab
    const b = this.sim.patient.body;
    queueMicrotask(() => stepify(P));
    ({ tab_guide: () => this.panelGuide(P), tab_drugs: () => this.panelDrugs(P, b), tab_fluids: () => { this.panelFluids(P); fluidsExtra(this, P); }, tab_airway: () => this.panelAirway(P, b), tab_circ: () => { this.panelCirc(P); pacingExtra(this, P); }, tab_proc: () => { this.panelProc(P); procExtra(this, P); }, tab_orders: () => { this.panelOrders(P); ordersExtra(this, P); }, tab_ward: () => (this.wardView ??= new WardView(this)).render(P) })[this.tab]();
  }

  act(ev, label) {
    if (this.teamMode && !this.guide && ev.type in TEAM_ACTS && this.sim.patient && !this.sim.finished) return this.teamOrder(ev, label);   // team mode: the order goes to a team member first
    return this.actNow(ev, label);
  }
  actNow(ev, label) {
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

  /** Guided-step help by level: beginner sees why, what to do and what the step will do to the patient; intermediate sees the
   *  reason on request; expert sees the step title only. */
  _stepHelp(cur, ctx, evs, handStep) {
    const lv = this.level, why = cur.why ? L(cur.why) : '';
    if (lv === 'expert') return [];
    if (lv === 'intermediate') return why ? [el('details', { class: 'pw-why' }, el('summary', { text: t('pw_why') }), el('p', { text: why }))] : [];
    const effects = evs(cur).filter(e => e.type !== 'note').map(e => this.describe(e)).filter(Boolean);
    return [why ? el('p', { text: why }) : null,
      el('p', { class: 'pw-howto' }, el('b', { text: t('pw_howto') + ' ' }), handStep ? t('pw_drag', { tool: L(TOOLS[cur.hand.tool]) || cur.hand.tool }) : t('pw_press')),
      effects.length ? el('p', { class: 'small muted pw-effects' }, el('b', { text: t('pw_effects') + ' ' }), effects.join(' · ')) : null].filter(Boolean);
  }
  /** Live countdown in each drug card after a bolus: to the first sign on the monitor, then to the peak. */
  _drugCountdowns(p) {
    const mm = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    for (const box of this.dom.panel.querySelectorAll('.dcount[data-drug]')) {
      const c = this.drugClock?.[box.dataset.drug];
      const el_ = (sel) => box.querySelector(sel);
      if (!c) { box.hidden = true; continue; }
      const e = p.t - c.t0, peak = c.peakS ?? 0, end = Math.max(peak, c.onsetS ?? 0) + 60;
      if (e > end) { box.hidden = true; delete this.drugClock[box.dataset.drug]; continue; }
      box.hidden = false;
      let txt, frac, phase;
      if (c.onsetS != null && e < c.onsetS) { phase = 'wait'; txt = `⏳ ${t('cd_onset')} ${mm(c.onsetS - e)}`; frac = e / c.onsetS; }
      else if (e < peak) { phase = 'on'; txt = `${c.onsetS != null ? '✔ ' + t('cd_visible') : t('cd_novisible')} · ${t('cd_peak')} ${mm(peak - e)}`; frac = e / peak; }
      else { phase = 'peak'; txt = '◎ ' + t('cd_peak_now'); frac = 1; }
      box.dataset.phase = phase; el_('.dc-txt').textContent = txt; el_('.dc-bar i').style.width = `${Math.min(100, frac * 100).toFixed(0)}%`;
    }
  }
  /** Time to a visible effect on the monitor and to the peak at the site of action, for this patient, drug by drug in the
   *  background (see onset.js). The source of each drug model is shown; simplified "design" models are flagged. */
  _fillTimings(P) {
    const spec = this.sim.patient?.spec; if (!spec) return;
    const rows = [...P.querySelectorAll('.dtime[data-drug]')], token = (this._timingToken = {});
    const fmtS = (x) => (x == null ? '-' : x < 90 ? `${x} s` : `${(x / 60).toFixed(1).replace('.', getLang() === 'fr' ? ',' : '.')} min`);
    const next = () => {
      if (token !== this._timingToken || !rows.length) return;
      const row = rows.shift(); if (!row.isConnected) return next();
      const k = row.dataset.drug, ref = REFERENCES[DRUGS[k]?.ref], design = !ref || ref.status === 'UNVERIFIED' || DRUGS[k]?.ref === 'design' || DRUGS[k]?.tHalf != null;   // one-compartment drugs: the reference backs the dose, the timing is a simplified model
      let r; try { r = monitorOnset(spec, k, Number(row.dataset.dose)); } catch { r = null; }
      if (r) {
        const sign = r.sign ? (r.sign.k === 'apnoea' ? t('eff_apnoea', { from: r.sign.from }) : r.sign.k === 'rhythm' ? t('eff_rhythm') : `${t('vl_' + r.sign.k)} ${r.sign.dir > 0 ? '↑' : '↓'}`) : null;
        row.replaceChildren(...[
          el('span', { class: 'dt-mon' }, el('b', { text: '⏱ ' + t('dt_monitor') }), ' ', r.onsetS != null ? el('span', {}, `≈ ${fmtS(r.onsetS)} · `, el('i', { text: sign })) : el('span', { class: 'muted', text: t('dt_none') })),
          r.peakS != null ? el('span', { class: 'dt-peak small' }, `${t('dt_peak')} ≈ ${fmtS(r.peakS)}`) : null,
          el('span', { class: 'dt-src small ' + (design ? 'warn' : 'muted'), title: ref?.cite || '', text: design ? t('dt_design') : `${t('dt_model')} ${(ref.cite || '').split(/[.(]/)[0].trim()}` })].filter(Boolean));
      }
      setTimeout(next, 0);
    };
    setTimeout(next, 30);
  }
  panelDrugs(P, b) {
    const basisW = { lbm: b.lbm, ibw: b.ibw, tbw: b.weightKg };
    for (const grp of DRUG_UI) {
      const sec = el('details', { open: true }, el('summary', { text: t(grp.g) }));
      for (const it of grp.items) {
        const d = DRUGS[it.k]; const def = it.fixed ?? Math.max(it.step, round(it.per * basisW[it.basis], it.step));
        const dose = el('input', { type: 'number', min: 0, step: it.step, value: def, 'aria-label': t('dose') + ' ' + drugName(it.k, d.name) });
        const name = drugName(it.k, d.name) + (it.label ? ' (' + t('route_' + it.route) + ')' : '');
        // one card per drug: name and dosing rule, a bolus line, and for infusions a rate line with start / stop below
        const row = el('div', { class: 'drug', dataset: { drug: it.k } },
          el('div', { class: 'dn' }, el('b', { text: name }), el('span', { class: 'drun', text: t('dr_running') }),
            el('span', { class: 'muted small rule', text: it.ca ? t('ca_rule', { ml: Math.round(it.fixed / it.ca.mmolPerMl), c: it.ca.mmolPerMl }) : it.fixed ? t('basis_fixed') : `${it.per} ${d.unit}/kg · ${t('basis_' + it.basis)}` }), it.warn ? el('span', { class: 'warn small', title: t('not_in_arrest'), text: '⚠ ' + t('not_in_arrest') }) : null),
          el('div', { class: 'dcount', hidden: true, dataset: { drug: it.k } }, el('span', { class: 'dc-txt' }), el('span', { class: 'dc-bar' }, el('i'))),
          el('div', { class: 'dtime', dataset: { drug: it.k, dose: def } }, el('span', { class: 'muted small', text: '⏱ ' + t('dt_computing') })),
          el('div', { class: 'dline' }, el('span', { class: 'dl', text: t('bolus') }), dose, el('span', { class: 'unit', text: d.unit }),
            this.btn(it.route && it.route !== 'iv' ? t('route_' + it.route) : t('bolus'), () => this.act({ type: 'drug.bolus', drug: it.k, amount: Number(dose.value), ...(it.route ? { route: it.route } : {}) }, `${name} ${dose.value} ${d.unit}`), 'act')));
        if (it.inf) {
          const rate = el('input', { type: 'number', min: 0, step: it.inf.step, value: it.inf.def, 'aria-label': t('rate') + ' ' + name });
          row.append(el('div', { class: 'dline' }, el('span', { class: 'dl', text: t('infusion') }), rate, el('span', { class: 'unit', text: it.inf.unit })),
            el('div', { class: 'dbtns' },
              this.btn('▶ ' + t('dr_start'), () => this.act({ type: 'drug.infusion', drug: it.k, rate: it.inf.toEngine(Number(rate.value), b) }, `${name} ${rate.value} ${it.inf.unit}`), 'act', { title: t('infusion') }),
              this.btn('■ ' + t('stop'), () => this.act({ type: 'drug.stop', drug: it.k }, name + ' - ' + t('stop')), 'ghost')));
        }
        sec.append(row);
      }
      P.append(sec);
    }
    this._fillTimings(P);
  }
  panelFluids(P) {
    const vol = el('input', { type: 'number', id: 'inFluidVol', value: 500, min: 50, max: 3000, step: 50 }), mins = el('input', { type: 'number', id: 'inFluidMin', value: 15, min: 1, max: 120, step: 1 });
    const kind = el('select', { id: 'selFluid', 'aria-label': t('fl_kind') }, el('option', { value: 'balanced', text: t('fl_balanced') }), el('option', { value: 'saline', text: t('fl_saline') }), el('option', { value: 'saline3', text: t('fl_saline3') }), el('option', { value: 'glucose5', text: t('fl_glucose5') }));
    P.append(el('h4', { text: t('fl_crystalloid') }), el('div', { class: 'row3' }, el('label', { class: 'f' }, el('span', { text: t('fl_volume') }), vol), el('label', { class: 'f' }, el('span', { text: t('fl_minutes') }), mins), this.btn(t('fl_give'), () => this.act({ type: 'fluid.bolus', volumeL: Number(vol.value) / 1000, minutes: Number(mins.value), fluid: kind.value }, `${vol.value} mL ${t('fl_' + kind.value)}`), 'act')), el('label', { class: 'f' }, el('span', { text: t('fl_kind') }), kind),
      el('div', { class: 'stack grid2' },
        this.btn(t('fl_prbc'), () => this.act({ type: 'blood.transfuse', kind: 'prbc' }, t('fl_prbc')), 'act'), this.btn(t('fl_whole'), () => this.act({ type: 'blood.transfuse', kind: 'whole' }, t('fl_whole')), 'act'), this.btn(t('fl_ffp'), () => this.act({ type: 'blood.transfuse', kind: 'ffp' }, t('fl_ffp')), 'act'), this.btn(t('fl_plt'), () => this.act({ type: 'blood.transfuse', kind: 'platelets' }, t('fl_plt')), 'act'), this.btn(t('fl_cryo'), () => this.act({ type: 'blood.transfuse', kind: 'cryo' }, t('fl_cryo')), 'act'),
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
      el('div', { class: 'row2' }, el('label', { class: 'f' }, el('span', { text: t('aw_peep') }), peep), this.btn(t('aw_set'), () => this.act({ type: 'vent.set', settings: { mode: mode.value, rate: Number(rate.value), vt: Number(vt.value) * b.pbw, fio2: Number(fio2.value), peep: Number(peep.value), seal: this.sim.patient.airway.intubated ? 0.97 : 0.85 } }, t('aw_set')), 'act primary')),
      this.mechBlock());
    nivExtra(this, P);
    vaporizerExtra(this, P);
  }
  /** Ventilator mechanics read-out and pressure / flow / volume curves (engine mechanics.js, display only). */
  mechBlock() {
    const vals = el('div', { class: 'mech-vals' });
    const cv = el('canvas', { class: 'mech-curves', width: 600, height: 300, 'aria-label': t('mech_curves') });
    this.dom.mech = { vals, cv, box: el('div', { class: 'mech' }, el('h4', { text: t('mech_title') }), el('p', { class: 'muted small mech-off', text: t('mech_off') }), vals, cv) };
    return this.dom.mech.box;
  }
  _mechTick(p) {
    const d = this.dom.mech; if (!d || !d.box.isConnected) return;
    const m = mechanics(p); d.box.classList.toggle('on', !!m); if (!m) return;
    const warn = (k, v) => (k === 'pplat' && v > 30) || (k === 'dp' && v > 15) || (k === 'peepi' && v > 2) || (k === 'ppeak' && v > 40);
    const rows = [['ppeak', 'Ppeak', m.ppeak, 'cmH₂O'], ['pplat', 'Pplat', m.pplat, 'cmH₂O'], ['dp', 'ΔP', m.dp, 'cmH₂O'], ['peep', 'PEEP', m.peep, 'cmH₂O'], ['peepi', t('mech_peepi'), m.peepi, 'cmH₂O'],
      ['mpaw', t('mech_mpaw'), m.mpaw, 'cmH₂O'], ['crs', 'Crs', m.crs, 'mL/cmH₂O'], ['rrs', 'Rrs', m.rrs, 'cmH₂O/L/s'], ['flow', t('mech_flow'), m.flow, 'L/min']];
    const sig = rows.map(r => r[2]).join('|');
    if (sig !== d.sig) { d.sig = sig; d.vals.replaceChildren(...rows.map(([k, lab, v, u]) => el('div', { class: 'mv' + (warn(k, v) ? ' warn' : ''), title: t('mech_tip_' + k) }, el('span', { text: lab }), el('b', { text: String(v) }), el('i', { text: u })))); }
    // curves over two breaths; the sweep follows simulated time
    const c = d.cv, g = c.getContext('2d'), W = c.width, H = c.height, tTot = m.ti + m.te, span = 2 * tTot, now = p.t % span;
    g.clearRect(0, 0, W, H);
    const lanes = [['p', '#ffc23d', Math.max(20, m.ppeak * 1.2), 0, 'Paw'], ['f', '#4cc3ff', Math.max(30, Math.abs(m.flow) * 1.6), -1, t('mech_flow')], ['v', '#3ee08f', Math.max(300, m.vt * 1.2), 0, 'V']];
    lanes.forEach(([k, col, max, sym, lab], i) => {
      const y0 = i * H / 3, h = H / 3 - 6, base = sym < 0 ? y0 + h / 2 : y0 + h, sc = sym < 0 ? h / 2 / max : h / max;
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.beginPath(); g.moveTo(0, base); g.lineTo(W, base); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '13px system-ui'; g.fillText(lab, 4, y0 + 13);
      g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
      for (let x = 0; x <= W; x += 2) { const ss = (x / W) * span; if (ss > now) break; const w = waveAt(m, ss)[k]; const y = base - w * sc; if (x) g.lineTo(x, y); else g.moveTo(x, y); }
      g.stroke();
    });
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
    if (this.echoLab) P.append(el('div', { class: 'row2' }, this.btn(t('ec_open'), () => this.echoLab.start(), 'act primary')));
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
      el('h4', { text: t('od_orders') }), el('div', { class: 'stack' }, this.btn(t('od_ecg12'), () => { const r = this.act({ type: 'order', what: 'ecg12' }, t('od_ecg12')); showEcg12(this); if (r?.result) this.showResult(r.result); }, 'act'),   // the tracing itself (panels2.js), plus the case's written result if it has one this.btn(t('od_trop'), () => { const r = this.act({ type: 'order', what: 'troponin' }, t('od_trop')); if (r?.result) this.showResult(r.result); }, 'act'),
        this.btn(t('od_aspirin'), () => this.act({ type: 'order', what: 'aspirin', mg: 324 }, t('od_aspirin')), 'act'), this.btn(t('od_cath'), () => this.act({ type: 'order', what: 'cath_lab' }, t('od_cath')), 'act'), this.btn(t('od_call_help'), () => this.act({ type: 'order', what: 'call_help' }, t('od_call_help')), 'act'), this.btn(t('od_declare_cico'), () => this.act({ type: 'order', what: 'declare_cico' }, t('od_declare_cico')), 'act'), this.btn(t('od_ttm'), () => { this.act({ type: 'order', what: 'temperature_control' }); this.act({ type: 'thermal.device', target: 36 }, t('od_ttm')); }, 'act')),
      el('h4', { text: t('lab_title') }), el('div', { class: 'stack' }, ...LAB_KINDS.map(k => this.btn(t('lab_' + k), () => this.act({ type: 'lab.order', kind: k }, t('lab_' + k)), 'act', { dataset: { lab: k } }))),
      this.dom.labBox = el('div', { class: 'labs' }),
      el('h4', { text: t('od_env') }), el('div', { class: 'row2' }, el('label', { class: 'f' }, el('span', { text: t('od_ambient') }), amb), this.btn(t('od_set'), () => this.act({ type: 'thermal.ambient', c: Number(amb.value) }, t('od_set')), 'act')),
      el('div', { class: 'stack' }, this.btn(t('od_cover'), () => this.act({ type: 'thermal.cover', factor: 0.5 }, t('od_cover')), 'act'), this.btn(t('od_warmer'), () => this.act({ type: 'thermal.device', target: 38, maxWatts: FORCED_AIR_W }, t('od_warmer')), 'act'), this.btn(t('od_cool'), () => this.act({ type: 'thermal.device', target: null }, t('od_cool')), 'act')));
  }
  /** Laboratory: pending samples with a countdown, then the results table (each sample a column, so trends read left to right). */
  _labsTick(p) {
    const box = this.dom.labBox; if (!box || !box.isConnected) return;
    const mm = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
    const pending = p.labs.filter(l => l.readyAt > p.t), done = p.labResults();
    const sig = `${p.labs.length}|${done.length}|${pending.map(l => Math.ceil(l.readyAt - p.t)).join(',')}`;
    if (sig === box.dataset.sig) return; box.dataset.sig = sig;
    const kids = pending.map(l => el('div', { class: 'lab-pend' }, el('span', { text: `⏳ ${t('lab_' + l.kind)} · ${t('lab_sampled')} ${mm(l.t)}` }), el('b', { text: mm(l.readyAt - p.t) })));
    const rowsOf = { abg: ['ph', 'paco2', 'pao2', 'hco3', 'be', 'sao2', 'lactate', 'na', 'k', 'cl', 'ag', 'ica', 'glucose', 'fio2'], lactate: ['lactate'], chem: ['na', 'k', 'mg', 'glucose', 'osm'], ketones: ['ketones'], cbg: ['glucose'], cbc: ['hb', 'hct', 'plt'], coag: ['inr', 'aptt', 'fib', 'plt'], cardiac: ['tnt', 'ntprobnp', 'ddimer'], renal: ['creat', 'urea'] };
    const unit = { ph: '', paco2: 'mmHg', pao2: 'mmHg', hco3: 'mmol/L', be: 'mmol/L', sao2: '%', lactate: 'mmol/L', na: 'mmol/L', k: 'mmol/L', cl: 'mmol/L', ag: 'mmol/L', mg: 'mmol/L', osm: 'mOsm/kg', ketones: 'mmol/L', ica: 'mmol/L', glucose: 'mmol/L', plt: '×10⁹/L', inr: '', aptt: 's', fib: 'g/L', tnt: 'ng/L', ntprobnp: 'pg/mL', ddimer: 'mg/L', creat: 'µmol/L', urea: 'mmol/L', fio2: '', hb: 'g/dL', hct: '' };
    const label = { ph: 'pH', paco2: 'PaCO₂', pao2: 'PaO₂', hco3: 'HCO₃⁻', be: t('lab_be'), sao2: 'SaO₂', lactate: t('lab_lact'), na: 'Na⁺', k: 'K⁺', cl: 'Cl⁻', ag: t('lab_ag'), mg: 'Mg²⁺', osm: t('lab_osm'), ketones: t('lab_ket'), ica: 'Ca²⁺ ' + t('lab_ion'), glucose: t('lab_glu'), plt: t('lab_plt'), inr: 'INR', aptt: t('lab_aptt'), fib: t('lab_fib'), tnt: 'hs-TnT', ntprobnp: 'NT-proBNP', ddimer: t('lab_dd'), creat: t('lab_creat'), urea: t('lab_urea'), fio2: 'FiO₂', hb: 'Hb', hct: 'Hct' };
    for (const kind of LAB_KINDS) {
      const cols = done.filter(l => l.kind === kind); if (!cols.length) continue;
      const sex = p.spec.sex === 'F' ? 'F' : 'M', rng = (k) => LAB_RANGES[k] || LAB_RANGES[`${k}_${sex}`];
      const head = el('tr', {}, el('th', { text: t('lab_' + kind) }), ...cols.map(l => el('th', { text: mm(l.t) })), el('th', { class: 'muted', text: t('lab_ref') }));
      const body = rowsOf[kind].map(k => el('tr', {}, el('td', { text: `${label[k]} ${unit[k] ? '(' + unit[k] + ')' : ''}` }),
        ...cols.map(l => el('td', { class: l.flags[k] === 'H' ? 'hi' : l.flags[k] === 'L' ? 'lo' : '', text: `${l.values[k]}${l.flags[k] ? ' ' + (l.flags[k] === 'H' ? '↑' : '↓') : ''}` })),
        el('td', { class: 'muted', text: rng(k) ? `${rng(k)[0]} – ${rng(k)[1]}` : '' })));
      kids.push(el('table', { class: 'lab-tab' }, el('thead', {}, head), el('tbody', {}, ...body)));
    }
    if (!kids.length) kids.push(el('p', { class: 'muted small', text: t('lab_none') }));
    box.replaceChildren(...kids);
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
        el('b', { class: 'pw-title', text: L(cur) }), ...this._stepHelp(cur, ctx, evs, handStep), this.dom.gdWait,
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
    if (g.finished) {
      const s = g.summary(); this.sim.act({ type: 'note', text: `guide ${g.proc.id}: end ${s.done}/${s.n} in order, ${s.early} early, ${s.warn} with a problem, ${s.skipped} skipped` });
      // progress: steps done in order count fully, early or problematic ones half, skipped ones nothing
      recordProgress({ area: 'skills', id: g.proc.id, title: L(g.proc), pct: 100 * (s.done + 0.5 * (s.early + s.warn)) / Math.max(1, s.n), spec: this.sim.session?.spec });
    }
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
  /** One line of measured effect: "+1 min · Propofol 150 mg: apnoea (RR 12 → 0), EtCO₂ 38 → 0 ↓". */
  effectReport(r) {
    const when = r.at < 60 ? `+${r.at} s` : `+${r.at / 60} min`;
    const name = (k) => t('vl_' + k);
    let text, cls = 'eff';
    if (r.unmonitored) { text = t('eff_unmon'); cls += ' warn'; }
    else if (!r.changes.length) { text = t('eff_none'); cls += ' none'; }
    else text = r.changes.map(c => c.k === 'apnoea' ? t('eff_apnoea', { from: c.from }) : c.k === 'rhythm' ? `${t('eff_rhythm')} ${c.from} → ${c.to}` : `${name(c.k)} ${c.from} → ${c.to} ${c.dir > 0 ? '↑' : '↓'}`).join(' · ');
    const li = el('li', { class: cls }, el('span', { class: 'eff-t', text: when }), el('b', { text: r.label }), el('span', { class: 'eff-c', text }));
    this.effLines.unshift(li); if (this.effLines.length > 8) this.effLines.pop();
    this.dom.effList?.replaceChildren(...this.effLines);
    this.log(`${t('eff_title')} ${when} · ${r.label}: ${text}`);
    if (r.changes?.length) this.toast(`${r.label} ${when}: ${text}`);
  }
  log(line) {
    const p = this.sim.patient; const s = `[${mmss(p ? p.t : 0)}] ${line}`; this.logLines.push(s); if (this.logLines.length > 300) this.logLines.shift();
    this.dom.logList?.prepend(el('li', { text: s })); while (this.dom.logList && this.dom.logList.children.length > 300) this.dom.logList.lastChild.remove();
    if (this.dom.logBox?.hidden) { this._unseen = (this._unseen || 0) + 1; this._logBadge(); }
  }
  /** Open / close the action log pop-over; opening clears the count of new entries. */
  toggleLog(open = this.dom.logBox?.hidden) {
    const b = this.dom.logBox; if (!b) return;
    b.hidden = !open; this.dom.btnLog?.setAttribute('aria-expanded', String(!!open)); this.dom.btnLog?.classList.toggle('on', !!open);
    if (open) { this._unseen = 0; this._logBadge(); }
  }
  _logBadge() { const c = this.dom.logBadge; if (!c) return; c.hidden = !this._unseen; c.textContent = this._unseen > 99 ? '99+' : String(this._unseen || ''); }
  describe(ev) {
    const d = ev.drug && DRUGS[ev.drug] ? drugName(ev.drug, DRUGS[ev.drug].name) : '';
    switch (ev.type) {
      case 'drug.bolus': return `${d} ${ev.amount} ${DRUGS[ev.drug]?.unit ?? ''}${ev.route && ev.route !== 'iv' ? ' ' + t('route_' + ev.route) : ''}`;
      case 'instructor.inject': return `${t('lv_by')}: ${ev.what === 'marker' ? ev.text : t('lv_w_' + ev.what)}`;
      case 'team.order': return `${t('tm_order')} → ${t('tm_role_' + (TEAM_ACTS[ev.act?.type] || 'nurse'))}: ${this.describe(ev.act) || ev.act?.type}`;
      case 'team.correct': return t('tm_corrected');
      case 'io.access': return t('px_io');
      case 'vaporizer.set': return `${t('va_' + (ev.agent || 'sevoflurane'))} ${ev.percent} %`;
      case 'n2o.set': return `N₂O ${ev.percent} %`;
      case 'procedure.vagal': return t(ev.technique === 'standard' ? 'px_vagal_std' : 'px_vagal_mod');
      case 'niv.set': return ev.mode === 'off' ? t('niv_off') : `${t('niv_' + ev.mode)} ${ev.mode === 'hfno' ? (ev.flow ?? '') + ' L/min' : ev.mode === 'bipap' ? (ev.ipap ?? '') + '/' + (ev.epap ?? '') : (ev.epap ?? '')} FiO2 ${ev.fio2 ?? ''}`;
      case 'pacing.set': return ev.on ? `${t('pc_title')} ${ev.rate ?? ''}/min ${ev.mA ?? ''} mA` : `${t('pc_title')} - ${t('stop')}`;
      case 'procedure.arterial_line': return t('px_aline') + (ev.us ? ' (US)' : '');
      case 'procedure.central_line': return `${t('px_cvc')} ${t('px_site_' + ev.site)}` + (ev.us ? ' (US)' : '');
      case 'procedure.ng_tube': return t('px_ng');
      case 'procedure.urinary_catheter': return t('px_uc');
      case 'exam.ecg12': return t('od_ecg12');
      case 'team.confirm': return '';                                  // the action itself follows in the journal
      case 'drug.infusion': return `${d} ${t('infusion').toLowerCase()} ${fmt(ev.rate, 3)} /min`;
      case 'drug.stop': return `${d} - ${t('stop')}`;
      case 'fluid.bolus': return `${t('fl_' + (['saline', 'saline3', 'glucose5'].includes(ev.fluid) ? ev.fluid : 'balanced'))} ${Math.round(ev.volumeL * 1000)} mL / ${ev.minutes} min`;
      case 'procedure.endoscopy': return t('px_endoscopy');
      case 'neuraxial.spinal': return `${t('px_spinal')} ${ev.amount} mg`;
      case 'neuraxial.epidural': return ev.action === 'test' ? t('px_epi_test') : `${t('px_epi_topup')} ${ev.volumeMl} mL`;
      case 'neuraxial.assess': return t('px_assess');
      case 'blood.transfuse': return t('fl_' + ev.kind);
      case 'airway.set': return `${t('aw_device')}: ${t({ none: 'aw_none', chin_lift: 'aw_chin', jaw_thrust: 'aw_jaw', opa: 'aw_opa', sga: 'aw_sga', ett: 'aw_intubate' }[ev.device] || ev.device)}`;
      case 'airway.intubate': return t('aw_intubate') + (ev.depthCm ? ` ${ev.depthCm} cm` : '');
      case 'airway.tube_adjust': return `${t('br_tube_depth')} ${ev.cm > 0 ? '+' : ''}${ev.cm} cm`;
      case 'bronch.insert': return t('br_title');
      case 'ward.advance': return t('wd_log_adv', { h: ev.hours, when: this.sim.patient?.ward ? wardClock(this.sim.patient.ward.h) : '' });
      case 'ward.sample': return t('wd_log_sample', { k: t('wd_s_' + ev.kind) });
      case 'ward.rx.start': return t('wd_log_rx', { d: abxName(ev.drug), r: t('wd_' + ev.route) + (ev.dose === 'high' ? ' · ' + t('wd_high') : '') });
      case 'ward.rx.stop': return t('wd_log_stop', { d: abxName(ev.drug) });
      case 'ward.order': { const pt = this.sim.patient; return t('wd_o_' + ev.what, { ml: pt ? fluidVolumeMl(pt.body) : '', w: '' }); }
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
    this.effects.tick(p);
    signsTick(this);
    this.coach?.tick();
    if (this.panelOpen && this.tab === 'tab_airway') { this._mechTick(p); volTick(this); }
    if (this.panelOpen && this.tab === 'tab_orders') { this._labsTick(p); scoresTick(this); }
    if (this.panelOpen && this.tab === 'tab_circ') this._paceStatus?.();
    if (p.labs) { const n = p.labResults().length; if (n > (this._labsSeen ?? 0)) { this._labsSeen = n; const l = p.labResults()[n - 1]; this.toast(`${t('lab_back')}: ${t('lab_' + l.kind)}`); this.log(`${t('lab_back')}: ${t('lab_' + l.kind)} (${Object.entries(l.values).map(([k, v]) => k + ' ' + v).join(', ')})`); } }
    // the cuff re-inflates every 2.5 min once connected, like a monitor set to automatic
    if (p.flags.nibp && !this.sim.finished && this.sim.speed > 0 && p.t - (p.nibp?.t ?? -1e9) >= 150) this.sim.act({ type: 'nibp.cycle' });
    if (this.dom.monAttach) this.dom.monAttach.hidden = !!(p.flags.ecgLeads || p.flags.spo2Probe || p.flags.capnography);
    if (this.panelOpen && this.tab === 'tab_drugs') { for (const r of this.dom.panel.querySelectorAll('.drug[data-drug]')) r.classList.toggle('running', (p.drugs?.pk?.[r.dataset.drug]?.rate ?? 0) > 0); this._drugCountdowns(p); }   // running infusions stand out
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
  showDebrief(out, self = null) {
    const x = this.sim.scenarioId ? scenarioText(this.scenarios.find(s => s.id === this.sim.scenarioId)) : null;
    const sc = (out.server && out.server.score) || out.local;
    const ov = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('score_title') });
    const box = el('div', { class: 'box db-box' }, el('div', { class: 'phead' }, el('h2', { text: t('score_title') + (x ? ' · ' + x.title : '') }), el('button', { class: 'x', 'aria-label': t('close'), onclick: () => ov.remove(), text: '×' })));
    const v = out.server ? (out.server.verified ? t('verified') : t('unverified')) : t('offline');
    const help = helpUsed(this.sim.patient?.log || []);
    const scen = this.scenarios.find(s => s.id === this.sim.scenarioId);
    recordProgress({ area: scen ? (scen.kind === 'ACLS' ? 'resus' : scen.kind === 'Echo' ? 'echo' : scen.kind === 'Infectiology' ? 'inf' : 'chal') : 'lab', id: scen ? scen.id : 'free', title: x ? x.title : t('free_play'),
      pct: sc ? sc.pct : null, grade: sc?.grade, verified: !!out.server?.verified, spec: this.sim.session?.spec, selfPct: self?.pct ?? null });
    const notes = {}, rec = { scen: x, sc, out, self, notes };
    // 1. reactions: the learner speaks first
    const reactions = el('div', {}, el('p', { class: 'muted', text: t('db_react_lead') }), reflect(notes, 'reactions', t('db_react_q')));
    // 2. description: what happened, in time order
    const keyBox = el('div', { class: 'db-keys' }, el('p', { class: 'muted small', text: t('tl_building') }));
    const description = el('div', {}, x ? el('p', { class: 'summary', text: x.summary }) : null, el('h4', { text: t('rec_times') }), keyBox, reflect(notes, 'description', t('db_desc_q')));
    // 3. analysis: score, self-assessment calibration, moments to discuss, criteria, replay timeline
    const analysis = el('div', {});
    if (sc) {
      const pct = Math.max(0, Math.min(100, sc.pct)), C = 2 * Math.PI * 54, col = pct >= 80 ? 'var(--good)' : pct >= 60 ? 'var(--warn)' : 'var(--bad)';
      const ring = el('div', { class: 'ring', style: `--ring:${col}` });
      ring.innerHTML = `<svg viewBox="0 0 132 132" aria-hidden="true"><circle class="trk" cx="66" cy="66" r="54"/><circle class="val" cx="66" cy="66" r="54" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${C.toFixed(1)}"/></svg>`;
      ring.append(el('div', { class: 'lbl' }, el('b', { text: `${pct.toFixed(0)}%` }), el('span', { text: t('score_total') })));
      requestAnimationFrame(() => requestAnimationFrame(() => ring.querySelector('.val')?.setAttribute('stroke-dashoffset', (C * (1 - pct / 100)).toFixed(1))));
      analysis.append(el('div', { class: 'db-head' }, ring, el('div', { class: 'db-meta' }, el('span', { class: 'grade', text: `${t('grade')} ${sc.grade}` }), el('span', { class: 'muted', text: `${sc.total} / ${sc.max} ${t('points')}` }), el('span', { class: out.server?.verified ? 'good small' : 'muted small', text: `${t('score_server')}: ${v}` }))));
    } else analysis.append(el('p', { class: 'muted', text: `${t('score_server')}: ${v}` }));
    if (help.level) analysis.append(el('p', { class: 'db-level' }, el('span', { class: 'badge', text: t('lvl_' + help.level) }), ' ', help.level === 'intermediate' ? t('db_hints', { n: help.hints }) : help.level === 'beginner' ? t('db_coached') : t('db_nohelp')));
    const cal = calibrationCard(self, sc); if (cal) analysis.append(cal);
    const momBox = el('div', { class: 'db-moments' }, el('h4', { text: t('db_moments') }), el('p', { class: 'muted small', text: t('tl_building') }));
    analysis.append(momBox);
    if (sc) analysis.append(el('h4', { text: t('db_criteria') }), el('div', {}, sc.items.map(i => { const f = i.weight ? i.points / i.weight : 0; return el('div', { class: 'crit' },
      el('span', { class: 'cl', text: getLang() === 'fr' && CRITERION_FR[i.id] ? CRITERION_FR[i.id] : i.label }), el('span', { class: 'cp', text: `${i.points.toFixed(1)} / ${i.weight}` }),
      el('span', { class: 'bar' }, el('i', { class: f >= 0.8 ? '' : f >= 0.4 ? 'mid' : 'low', style: `width:${(f * 100).toFixed(0)}%` })), el('span', { class: 'cd', text: i.detail })); })));
    // replay timeline: rebuilt from the event log by the engine itself, so the curves are exactly what happened
    const tlBox = el('div', { class: 'db-tl' }, el('h4', { text: t('tl_title') }), el('p', { class: 'muted small', text: t('tl_building') }));
    analysis.append(tlBox);
    // 4. summary: objectives and take-aways, then the record
    const summary = el('div', {}, x ? [el('h4', { text: t('learning') }), el('ul', { class: 'muted' }, x.learning.map(l => el('li', { text: l })))] : null, reflect(notes, 'takeaways', t('db_sum_q')),
      el('h4', { text: t('sbar_title') }), el('p', { class: 'muted small', text: t('sbar_t') }), el('div', { class: 'sbar' }, ...SBAR.map(k => reflect(notes, 'sbar_' + k, t('sbar_' + k)))),
      el('div', { class: 'db-actions' },
        el('button', { class: 'ghost', onclick: () => this.printRecord(rec), text: '🖨 ' + t('rec_print') }),
        el('button', { class: 'ghost', onclick: () => this.exportRecord(rec), text: t('rec_export') }),
        el('button', { class: 'primary', onclick: () => ov.remove(), text: t('close') })));
    const P = pearls({ reactions, description, analysis, summary });
    box.append(P.root);
    setTimeout(() => {
      const p = this.sim.patient, ss = this.sim.session; if (!p || !ss) return;
      try { rec.tl = buildTimeline({ spec: ss.spec, seed: ss.seed, scenario: this.sim.scenarioId, log: p.log, until: p.t }, SCENARIOS, 5); }
      catch (e) { tlBox.lastChild.textContent = String(e.message || e); return; }
      const mark = this.drawTimeline(tlBox, rec.tl), k = keyActionTimes(rec.tl.events);
      keyBox.replaceChildren(el('table', { class: 'rec-crit' }, ...Object.entries(k).map(([n, s]) => el('tr', {}, el('td', { text: t('rec_k_' + n) }), el('td', { text: s == null ? '—' : mmss(s) })))));
      momBox.lastChild.replaceWith(momentsList(rec.tl, k, (ev) => this.describe(ev), (s) => { P.show('analysis'); mark(s); }));
    }, 30);
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    ov.append(box); document.body.append(ov);
  }
  /** Debrief timeline: true HR/MAP, SpO2, EtCO2/RR lanes with every learner action marked; hover reads the values. */
  drawTimeline(box, tl) {
    const W = 920, H = 260, PADL = 44, PADR = 10, T = tl.end || 1, X = (s) => PADL + (s / T) * (W - PADL - PADR);
    const cv = el('canvas', { class: 'tl-canvas', width: W, height: H }), read = el('div', { class: 'tl-read small' }, t('tl_hover'));
    const lanes = [{ keys: [['hr', '#3ee08f', t('vl_hr')], ['map', '#ff5d6c', t('vl_map')]], max: 200 }, { keys: [['spo2', '#4cc3ff', 'SpO₂']], max: 100 }, { keys: [['etco2', '#ffc23d', 'EtCO₂'], ['rr', '#e6e6e6', t('vl_rr')]], max: 60 }];
    const g = cv.getContext('2d'), lh = (H - 24) / lanes.length;
    let markT = null;                                                    // a moment chosen in the debrief list
    const draw = (hx) => {
      g.clearRect(0, 0, W, H); g.font = '11px system-ui';
      lanes.forEach((ln, i) => {
        const y0 = i * lh + 4, y1 = y0 + lh - 8, Y = (v) => y1 - (Math.max(0, Math.min(ln.max, v)) / ln.max) * (y1 - y0);
        g.strokeStyle = 'rgba(255,255,255,.1)'; g.strokeRect(PADL, y0, W - PADL - PADR, y1 - y0);
        g.fillStyle = 'rgba(255,255,255,.5)'; g.fillText(String(ln.max), 4, y0 + 9); g.fillText('0', 4, y1);
        ln.keys.forEach(([k, col, lab], j) => {
          g.strokeStyle = col; g.lineWidth = 1.8; g.beginPath();
          tl.t.forEach((tt, n) => { const xx = X(tt), yy = Y(tl[k][n]); if (n) g.lineTo(xx, yy); else g.moveTo(xx, yy); });
          g.stroke(); g.fillStyle = col; g.fillText(lab, PADL + 6 + j * 60, y0 + 11);
        });
      });
      g.fillStyle = 'rgba(255,255,255,.5)';
      for (let m = 0; m <= T / 60; m += Math.max(1, Math.round(T / 60 / 8))) g.fillText(`${m}′`, X(m * 60) - 4, H - 4);
      for (const e of tl.events) { g.strokeStyle = e.type === 'instructor.inject' ? 'rgba(255,160,60,.95)' : e.ok ? 'rgba(176,124,255,.75)' : 'rgba(255,93,108,.6)'; g.lineWidth = 1; g.beginPath(); g.moveTo(X(e.t), 2); g.lineTo(X(e.t), H - 16); g.stroke(); }
      if (markT != null) { g.fillStyle = 'rgba(255,211,77,.18)'; g.fillRect(X(markT) - 3, 2, 6, H - 18); g.strokeStyle = '#ffd34d'; g.lineWidth = 2; g.beginPath(); g.moveTo(X(markT), 2); g.lineTo(X(markT), H - 16); g.stroke(); }
      if (hx != null) { g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.moveTo(hx, 2); g.lineTo(hx, H - 16); g.stroke(); }
    };
    draw(null);
    cv.addEventListener('pointermove', (ev) => {
      const r = cv.getBoundingClientRect(), hx = (ev.clientX - r.left) * (W / r.width), s = Math.max(0, Math.min(T, ((hx - PADL) / (W - PADL - PADR)) * T));
      let n = 0; while (n < tl.t.length - 1 && tl.t[n + 1] <= s) n++;
      const near = tl.events.filter(e => Math.abs(e.t - s) < T / 60).map(e => this.describe(e.ev) || e.type);
      read.textContent = `${mmss(s)} · ${t('vl_hr')} ${Math.round(tl.hr[n])} · ${t('vl_map')} ${Math.round(tl.map[n])} · SpO₂ ${Math.round(tl.spo2[n])} · EtCO₂ ${Math.round(tl.etco2[n])} · ${t('vl_rr')} ${Math.round(tl.rr[n])}${near.length ? ' — ' + near.join(', ') : ''}`;
      draw(hx);
    });
    cv.addEventListener('pointerleave', () => { draw(null); read.textContent = t('tl_hover'); });
    box.replaceChildren(el('h4', { text: t('tl_title') }), el('p', { class: 'muted small', text: t('tl_note') }), cv, read);
    return (s) => { markT = s; draw(null); cv.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
  }
  /** Competency record of the finished session (learner pseudonym, case, body, verified score, criteria, key action times). */
  _recordData(rec) {
    const ss = this.sim.session, p = this.sim.patient, sc = rec.sc, k = rec.tl ? keyActionTimes(rec.tl.events) : null;
    return { app: 'Tidal Bedside Lab', learner: this._learner || '', case: rec.scen?.title || t('free_play'), scenarioId: this.sim.scenarioId, date: new Date().toISOString(),
      patient: ss?.spec, durationS: p ? Math.round(p.t) : null, score: sc ? { pct: Math.round(sc.pct), grade: sc.grade, points: sc.total, max: sc.max } : null,
      verified: !!rec.out.server?.verified, sessionId: ss?.id || null,
      criteria: sc ? sc.items.map(i => ({ label: getLang() === 'fr' && CRITERION_FR[i.id] ? CRITERION_FR[i.id] : i.label, points: +i.points.toFixed(1), weight: i.weight, detail: i.detail })) : [],
      keyActionsS: k, selfAssessment: rec.self || null, reflection: rec.notes || {} };
  }
  exportRecord(rec) {
    const d = this._recordData(rec), a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(d, null, 1)], { type: 'application/json' })), download: `tidal-record-${(d.learner || 'learner').replace(/[^\w-]+/g, '_')}-${d.date.slice(0, 10)}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  printRecord(rec) {
    const d = this._recordData(rec), fmtT = (x) => (x == null ? '—' : mmss(x));
    const sp = d.patient ? `${d.patient.sex === 'F' ? t('female') : t('male')}, ${d.patient.age} ${t('rec_years')}, ${d.patient.heightCm} cm, ${d.patient.weightKg} kg` : '';
    const page = el('div', { class: 'printable' },
      el('h1', { text: t('rec_title') }),
      el('table', { class: 'rec-meta' }, ...[[t('rec_learner'), d.learner || '—'], [t('rec_case'), d.case], [t('rec_patient'), sp], [t('rec_date'), new Date(d.date).toLocaleString(getLang() === 'fr' ? 'fr-FR' : 'en-GB')], [t('rec_duration'), fmtT(d.durationS)],
        [t('rec_score'), d.score ? `${d.score.pct} % · ${t('grade')} ${d.score.grade} (${d.score.points} / ${d.score.max})` : '—'], [t('rec_verified'), d.verified ? t('verified') : t('rec_not_verified')], [t('rec_session'), d.sessionId || '—']].map(([a, b]) => el('tr', {}, el('th', { text: a }), el('td', { text: b })))),
      el('h2', { text: t('rec_criteria') }),
      el('table', { class: 'rec-crit' }, el('tr', {}, el('th', { text: t('rec_criterion') }), el('th', { text: t('points') }), el('th', { text: t('rec_detail') })), ...d.criteria.map(c => el('tr', {}, el('td', { text: c.label }), el('td', { text: `${c.points} / ${c.weight}` }), el('td', { text: c.detail || '' })))),
      el('h2', { text: t('rec_times') }),
      el('table', { class: 'rec-crit' }, ...Object.entries(d.keyActionsS || {}).map(([k, v]) => el('tr', {}, el('td', { text: t('rec_k_' + k) }), el('td', { text: fmtT(v) })))),
      d.selfAssessment ? el('h2', { text: t('db_self_title') }) : null,
      d.selfAssessment ? el('p', { text: `${t('db_self_pct')}: ${d.selfAssessment.pct} % · ` + ANTS_CATEGORIES.map(k => `${t('db_a_' + k)} ${d.selfAssessment.ants?.[k] ?? '—'}/4`).join(' · ') }) : null,
      ...['reactions', 'description', 'takeaways'].filter(k => d.reflection?.[k]).map(k => el('p', {}, el('b', { text: t('db_rec_' + k) + ': ' }), d.reflection[k])),
      SBAR.some(k => d.reflection?.['sbar_' + k]) ? el('h2', { text: t('sbar_title') }) : null,
      ...SBAR.filter(k => d.reflection?.['sbar_' + k]).map(k => el('p', {}, el('b', { text: t('sbar_' + k) + ': ' }), d.reflection['sbar_' + k])),
      el('p', { class: 'rec-foot', text: t('disclaimer') }));
    document.body.append(page);
    const done = () => { page.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done); window.print(); setTimeout(done, 60000);
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
    for (const e of [this.menuOpen ? null : this.dom.right, this.menuOpen ? this.dom.menuR : null, this.menuOpen ? null : this.echoLab?.dom?.root]) if (vis(e)) { const b = e.getBoundingClientRect(); if (b.right > Wd * 0.7 && b.height > Hd * 0.15) r = Math.max(r, Wd - b.left); }
    if (Wd <= 600) { l = 0; r = 0; }                                             // phones: panels are bottom sheets
    this.scene.inset = { l, r };
  }
  trackMouse(e) { this._mouse = { x: e.clientX, y: e.clientY }; }
}
