// Which dock button holds the next thing to do, by learner level. Pure (no DOM), so it runs under node --test.
//   beginner     - the dock button of the coach's next step pulses, with the step written above it, at every step;
//   intermediate - only when the senior has just given a hint, for that one step and for HINT_S of patient time;
//   expert       - never.
// The step comes from the case's own scoring criteria (coach-eval.js), so the pointer always matches what is assessed.
// It only points: it never presses anything or changes the patient. Once that button's section is open, it points at the
// control inside it (controlOf / criterionControl).
// During a guided procedure (guideTarget) it shows, step by step, the dock button where that action is found in a real case,
// with the same levels: every step for a beginner, a few for an intermediate, none for an expert.

import { wardStep } from './ward-plan.js';

export const DOCK_TABS = Object.freeze(['tab_guide', 'tab_drugs', 'tab_fluids', 'tab_airway', 'tab_circ', 'tab_proc', 'tab_orders', 'tab_ward']);
export const HINT_S = 60;              // intermediate: how long (patient seconds) the pointer stays after a senior hint

const G = 'tab_guide', D = 'tab_drugs', F = 'tab_fluids', A = 'tab_airway', C = 'tab_circ', P = 'tab_proc', O = 'tab_orders';
/** Criterion id -> the dock button where it is done. null: a result or a "do not" rule, nothing to press (no pointer). */
export const DOCK_OF = Object.freeze({
  // monitoring, orders, laboratory, temperature
  monitor_iv: O, iv_access: O, ecg_10min: O, ecg12: O, aspirin: O, cath_lab: O, declare_cico: O, keep_warm: O, mh_cool: O, pacu_warm: O,
  dka_tests: O, se_glucose: O, copd_gas: O, hk_recheck: O, hy_cbg: O, hy_recheck: O, na_measure: O, na_recheck: O,
  // drugs
  epi_timing: D, naloxone: D, induction: D, ana_adrenaline: D, mh_dantrolene: D, last_lipid: D, hb_analgesia: D, tdp_mg: D, tdp_rate: D,
  dka_insulin: D, dka_potassium: D, dka_glucose10: D, se_benzo: D, se_second: D, copd_bronchodilator: D, copd_steroid: D, svt_adenosine: D,
  hk_calcium: D, hk_insulin: D, hk_salbutamol: D, hy_treat: D, hy_sustain: D, mb_atropine: D, mb_support: D, mb_analgesia: D,
  po_nitrate: D, po_diuretic: D, ht_drug: D, vb_terlipressin: D, vb_antibiotic: D, sp_vaso: D, hs_vaso: D, hs_brady: D, hs_sedation: D, pacu_rescue: D,
  // fluids and blood
  bleed_control: F, blood_vs_crystalloid: F, resus_target: F, ana_fluids: F, dka_fluid: F, na_hypertonic: F, sp_fluid: F, vb_transfusion: F,
  // airway, oxygen, ventilation, position
  airway_vent: A, early_vent: A, cause_hypoxia: A, preox: A, intubation: A, fio2_first: A, last_airway: A, mh_trigger_off: A, mh_vent: A,
  se_oxygen: A, copd_target: A, copd_niv: A, po_upright: A, po_cpap: A, hs_vent: A, hs_airway: A, pacu_o2: A, post_rosc: A,
  bronch_look: G, tube_reposition: G, tube_depth_final: G, secretions: G,   // done in the scope window: the guided bronchoscopy leads there
  // CPR, defibrillator, pacing
  t_first_compression: C, t_first_shock: C, shock_energy: C, cpr_quality: C, hb_pads: C, hb_capture: C, mb_pads: C,
  // examination and procedures
  chest_exam: P, tension_relief: P, needle_technique: P, chest_drain: P, fona_timing: P, fona_technique: P, fona_achieved: P,
  ht_aline: P, vb_endoscopy: P, sp_level: P, svt_vagal: P,
  // results and "do not" rules: nothing to press
  outcome: null, spo2_nadir: null, spo2_nadir_live: null, map_nadir_live: null, hemodynamics: null, ana_map: null, mh_temp: null,
  tdp_quiet: null, tdp_no_amio: null, dka_ketones: null, se_two_benzo: null, se_stopped: null, copd_no_high_o2: null, copd_ph: null,
  svt_converted: null, svt_no_early_shock: null, hk_no_hypo: null, na_rise: F, na_limit: null, na_no_hypotonic: null,
  po_no_fluid: null, po_spo2: null, ht_target: D, ht_no_crash: null, vb_no_txa: null, vb_controlled: null, sp_nadir: D,
  sp_nausea: null, pacu_settled: null, pacu_temp: null, avoid_class3: null, last_no_vaso: null, nitro_safe: null,
  no_routine_o2: null, limit_attempts: null,
});

/** The dock button for a criterion id (undefined: not classified). Démarche criteria are done from the guided panel,
 *  infectiology criteria from the ward workspace, echocardiography from the procedures tab (it opens the echo window). */
export function dockOf(id) {
  if (typeof id !== 'string') return undefined;
  if (id.startsWith('demarche_')) return G;
  if (id.startsWith('inf_')) return 'tab_ward';
  if (id.startsWith('echo_')) return P;
  return Object.prototype.hasOwnProperty.call(DOCK_OF, id) ? DOCK_OF[id] : undefined;
}

/** Engine event type -> the dock button whose panel offers it in a case (where a guided step is found outside the guide). */
export const TAB_OF_EVENT = Object.freeze({
  'drug.bolus': D, 'drug.infusion': D, 'drug.stop': D,
  'fluid.bolus': F, 'blood.transfuse': F, 'bicarb.bolus': F, 'bleed.control': F,
  'o2.mask': A, 'apox.set': A, 'vent.set': A, 'airway.set': A, 'airway.intubate': A, 'airway.tube_adjust': A, 'position.set': A, 'niv.set': A,
  'vaporizer.set': A, 'bronch.insert': A, 'bronch.suction': A, 'bronch.remove': A,
  'cpr.start': C, 'cpr.stop': C, 'cpr.switch': C, 'cpr.compress': C, 'defib.pads': C, 'defib.charge': C, 'defib.shock': C, 'defib.setEnergy': C, 'pacing.set': C,
  'exam.chest': P, 'exam.pocus': P, 'exam.neck': P, 'procedure.needle_decompression': P, 'procedure.chest_tube': P, 'procedure.cricothyroidotomy': P,
  'procedure.arterial_line': P, 'procedure.central_line': P, 'procedure.ng_tube': P, 'procedure.urinary_catheter': P, 'procedure.vagal': P,
  'neuraxial.spinal': P, 'neuraxial.assess': P, 'neuraxial.epidural': P, 'procedure.endoscopy': P, 'io.access': P,
  guide: G,                                                   // not an engine event: "start this guided procedure"
  'monitor.attach': O, 'nibp.cycle': O, 'iv.access': O, 'order': O, 'lab.order': O, 'exam.ecg12': O, 'thermal.cover': O, 'thermal.device': O, 'thermal.ambient': O,
});
/** The dock button of a guided step from the events it dispatches: the first event that has one (null: a check or a
 *  preparation step with no button of its own, such as the checklist before an intubation). */
export const tabOfEvents = (evs) => { for (const e of evs || []) { const k = TAB_OF_EVENT[e?.type]; if (k) return k; } return null; };

/** During a guided procedure, what to point at for the current step. g: { level, tabs (the dock button of every step, from
 *  tabOfEvents), hands (true for a step done with an instrument from the guide's tray), i (current step), open (the tab whose
 *  panel is open, or null), finished }. The step is done where it would be in a real case:
 *   - an action that has a dock button: that button, then, once its section is open, the control inside it (inside: 'control');
 *   - an instrument step: the instrument on the guide's tray (inside: 'tool');
 *   - a check or a preparation with neither: the guide's "do this step" button (inside: 'do');
 *   - anywhere else open: the guide's button, to come back to the step (why: 'back').
 *  Beginner: every step. Intermediate: only the first step that uses each dock button (a few, then it lets go). Expert: never.
 *  Returns { tab (dock button to pulse, or null), why: 'where' | 'back' | null, inside: 'control' | 'tool' | 'do' | null } or null. */
export function guideTarget(g) {
  if (!g || g.finished || !(g.level === 'beginner' || g.level === 'intermediate') || !(g.i >= 0 && g.i < (g.tabs?.length ?? 0))) return null;
  const T = g.hands?.[g.i] ? null : g.tabs[g.i], H = !!g.hands?.[g.i];
  if (g.level === 'intermediate' && !(T && g.tabs.findIndex((k, j) => k === T && !g.hands?.[j]) === g.i)) return null;   // already shown earlier
  if (T) return g.open === T ? { tab: null, why: null, inside: 'control' } : { tab: T, why: 'where', inside: null };
  if (g.open && g.open !== G) return { tab: G, why: 'back', inside: null };
  return { tab: null, why: null, inside: H ? 'tool' : 'do' };
}

/** The control inside a section that performs an event: { sel } (a CSS selector in the open panel), { label } (an i18n key: the
 *  button whose text contains it) or null (the section itself is the best we can do). */
export function controlOf(ev) {
  if (!ev || typeof ev.type !== 'string') return null;
  const lab = (label) => ({ label }), sel = (q) => ({ sel: q });
  switch (ev.type) {
    case 'guide': return sel(`[data-proc="${ev.proc}"]`);
    case 'drug.bolus': return ev.drug ? { ...sel(`.drug[data-drug="${ev.drug}"]${ev.route ? `[data-route="${ev.route}"]` : ':not([data-route])'} button.dgive`), alt: `.drug[data-drug="${ev.drug}"] button.dgive` } : null;   // IM adrenaline is its own row; a drug given only by one route falls back to it
    case 'drug.infusion': return ev.drug ? sel(`.drug[data-drug="${ev.drug}"] .dbtns button.act`) : null;
    case 'fluid.bolus': return lab('fl_give');
    case 'blood.transfuse': return ['prbc', 'ffp', 'cryo'].includes(ev.kind) ? lab('fl_' + ev.kind) : null;
    case 'bleed.control': return lab('fl_tourniquet');
    case 'o2.mask': return sel('#selO2 + button');
    case 'apox.set': return lab('aw_apox');
    case 'vent.set': return lab(ev.settings?.mode === 'spont' ? 'aw_vent_stop' : ev.adjust ? 'aw_set' : 'aw_bvm_start');   // adjust: the settings row (FiO2, rate)
    case 'airway.set': return { chin_lift: lab('aw_chin'), jaw_thrust: lab('aw_jaw'), opa: lab('aw_opa'), sga: lab('aw_sga'), none: lab('aw_none') }[ev.device] || null;
    case 'airway.intubate': return lab('aw_intubate');
    case 'position.set': return lab(ev.headUp === false ? 'aw_flat' : 'aw_headup');
    case 'niv.set': return lab(ev.mode === 'off' ? 'niv_off' : 'niv_start');
    case 'vaporizer.set': return lab(ev.percent === 0 ? 'va_off' : 'va_set');
    case 'bronch.insert': case 'bronch.suction': case 'bronch.remove': case 'airway.tube_adjust': return sel('#btnBronch');
    case 'cpr.start': return sel('#btnCpr');
    case 'cpr.stop': return lab('cp_stopcpr');
    case 'cpr.switch': return lab('cp_switch');
    case 'defib.pads': return sel('#btnPads');
    case 'defib.charge': case 'defib.setEnergy': return sel('#btnCharge');
    case 'defib.mode': return sel('#selDefMode');
    case 'ward.sample': return sel(`[data-ws="${ev.kind}"]`);
    case 'ward.order': return sel(`[data-wo="${ev.what}"]`);
    case 'ward.advance': return sel(`[data-adv="${ev.hours}"]`);
    case 'ward.rx.start': return sel('#wdRx');
    case 'ward.rx.stop': return sel(`[data-stop="${ev.drug}"]`);
    case 'ward.finish': return sel('#wdEnd');
    case 'defib.shock': return lab('cp_shock');
    case 'pacing.set': return lab(ev.on === false ? 'pc_off' : 'pc_start');
    case 'exam.chest': return sel('#btnExamChest');
    case 'exam.pocus': return sel('#btnPocus');
    case 'exam.neck': return ev.method === 'ultrasound' ? sel('#btnNeckUs') : lab('sg_neck_palp');
    case 'procedure.needle_decompression': return sel('#btnNeedle');
    case 'procedure.chest_tube': return lab('sg_do_tube');
    case 'procedure.cricothyroidotomy': return lab('sg_do_fona');
    case 'procedure.arterial_line': return lab('px_aline');
    case 'procedure.central_line': return lab('px_cvc');
    case 'procedure.ng_tube': return lab('px_ng');
    case 'procedure.urinary_catheter': return lab('px_uc');
    case 'procedure.vagal': return lab('px_vagal_mod');
    case 'procedure.endoscopy': return lab('px_endoscopy');
    case 'neuraxial.spinal': return lab('px_spinal');
    case 'neuraxial.assess': return lab('px_assess');
    case 'io.access': return lab('px_io');
    case 'monitor.attach': { const k = Object.keys(ev.items || {})[0]; return k === 'nibp' ? lab('od_nibp') : k ? sel(`[data-att="${k}"]`) : null; }
    case 'nibp.cycle': return lab('od_nibp');
    case 'iv.access': return lab('od_iv');
    case 'order': return { ecg12: lab('od_ecg12'), aspirin: lab('od_aspirin'), cath_lab: lab('od_cath'), call_help: lab('od_call_help'), declare_cico: lab('od_declare_cico'), temperature_control: lab('od_ttm'), troponin: lab('od_trop') }[ev.what] || null;
    case 'exam.ecg12': return lab('od_ecg12');
    case 'lab.order': return ev.kind ? sel(`[data-lab="${ev.kind}"]`) : null;
    case 'thermal.cover': return lab('od_cover');
    case 'thermal.device': return lab(ev.target == null ? 'od_cool' : 'od_warmer');
    case 'thermal.ambient': return lab('od_set');
    default: return null;
  }
}

/** A case's scored step -> the action that does it (what the button in its section dispatches), for the in-section pointer.
 *  Démarche criteria point at their guided procedure in the guide panel; ward and result criteria have none. */
const DB = (drug) => ({ type: 'drug.bolus', drug }), DI = (drug) => ({ type: 'drug.infusion', drug });
/** set: [selector, value, unit?] fields the beginner pointer fills in before pointing at the button (and names in the bubble). */
const FB = (kind, ml, min) => ({ type: 'fluid.bolus', fluid: kind, set: [['#selFluid', kind], ['#inFluidVol', ml, 'mL'], ['#inFluidMin', min, 'min']] });
const O2F = { nc: 0.36, nrb: 0.85, fm100: 1, v28: 0.28, v24: 0.24 };                 // FiO2 of the airway panel's devices (ui.js O2), so a different device is not taken as done
const O2 = (k) => ({ type: 'o2.mask', fio2: O2F[k], set: [['#selO2', k]] });
export const CRITERION_EVENT = Object.freeze({
  monitor_iv: { type: 'monitor.attach', items: { ecgLeads: true } }, iv_access: { type: 'iv.access' },
  ecg_10min: { type: 'order', what: 'ecg12' }, ecg12: { type: 'order', what: 'ecg12' }, aspirin: { type: 'order', what: 'aspirin' }, cath_lab: { type: 'order', what: 'cath_lab' },
  declare_cico: { type: 'order', what: 'declare_cico' }, keep_warm: { type: 'thermal.cover' }, mh_cool: { type: 'order', what: 'temperature_control' }, pacu_warm: { type: 'thermal.device', target: 38 },
  dka_tests: { type: 'lab.order', kind: 'ketones' }, se_glucose: { type: 'lab.order', kind: 'cbg' }, hy_cbg: { type: 'lab.order', kind: 'cbg' }, hy_recheck: { type: 'lab.order', kind: 'cbg' },
  copd_gas: { type: 'lab.order', kind: 'abg' }, hk_recheck: { type: 'lab.order', kind: 'abg' }, na_measure: { type: 'lab.order', kind: 'abg' }, na_recheck: { type: 'lab.order', kind: 'abg' },   // the blood gas gives Na and K in 3 min (the chemistry panel takes 45)
  epi_timing: DB('epinephrine'), naloxone: DB('naloxone'), induction: DB('propofol'), ana_adrenaline: { ...DB('epinephrine'), route: 'im' }, mh_dantrolene: DB('dantrolene'), last_lipid: DB('lipid'),
  hb_analgesia: DB('fentanyl'), tdp_mg: DB('magnesium'), tdp_rate: DI('isoprenaline'), dka_insulin: DI('insulin'), dka_potassium: DB('potassiumChloride'), dka_glucose10: DI('glucose'),
  se_benzo: { ...DB('lorazepam'), set: [['.drug[data-drug="lorazepam"] .dline input', 4, 'mg']] }, se_second: DB('levetiracetam'), copd_bronchodilator: DB('salbutamol'), copd_steroid: DB('prednisolone'), svt_adenosine: DB('adenosine'),
  hk_calcium: DB('calciumGluconate'), hk_insulin: DB('insulin'), hk_salbutamol: { ...DB('salbutamol'), set: [['.drug[data-drug="salbutamol"] .dline input', 10, 'mg']] }, hy_treat: DB('glucose'), hy_sustain: DI('glucose'), mb_atropine: DB('atropine'),
  mb_support: DI('isoprenaline'), mb_analgesia: DB('fentanyl'), po_nitrate: DI('nitroglycerin'), po_diuretic: DB('furosemide'), ht_drug: DB('labetalol'), ht_target: DB('labetalol'), vb_terlipressin: DB('terlipressin'),
  vb_antibiotic: DB('ceftriaxone'), sp_vaso: DB('phenylephrine'), sp_nadir: DB('phenylephrine'), hs_vaso: DB('phenylephrine'), hs_brady: DB('atropine'), hs_sedation: DB('propofol'), pacu_rescue: DB('ondansetron'),
  bleed_control: { type: 'bleed.control' }, blood_vs_crystalloid: { type: 'blood.transfuse', kind: 'prbc' }, resus_target: { type: 'blood.transfuse', kind: 'prbc' },
  ana_fluids: FB('balanced', 1000, 15), dka_fluid: FB('saline', 1000, 60), na_hypertonic: FB('saline3', 150, 20), na_rise: FB('saline3', 150, 20), sp_fluid: FB('balanced', 500, 15), vb_transfusion: { type: 'blood.transfuse', kind: 'prbc' },
  airway_vent: { type: 'vent.set' }, early_vent: { type: 'vent.set' }, cause_hypoxia: { type: 'vent.set' }, preox: O2('fm100'), intubation: { type: 'airway.intubate' },
  fio2_first: O2('nrb'), last_airway: O2('nrb'), mh_trigger_off: { type: 'vaporizer.set', percent: 0 }, mh_vent: { type: 'vent.set', adjust: true, set: [['#inVr', 20, '/min']] }, se_oxygen: O2('nrb'),
  copd_target: O2('v28'), copd_niv: { type: 'niv.set', set: [['#nivMode', 'bipap'], ['#nivFio2', 0.28]] }, po_upright: { type: 'position.set', headUp: true }, po_cpap: { type: 'niv.set' }, hs_vent: { type: 'vent.set' },
  hs_airway: { type: 'airway.intubate' }, pacu_o2: O2('nc'), post_rosc: { type: 'vent.set' },
  bronch_look: { type: 'guide', proc: 'bronch' }, tube_reposition: { type: 'guide', proc: 'bronch' }, tube_depth_final: { type: 'guide', proc: 'bronch' }, secretions: { type: 'guide', proc: 'bronch' },
  t_first_compression: { type: 'cpr.start' }, t_first_shock: { type: 'defib.shock' }, shock_energy: { type: 'defib.charge' }, cpr_quality: { type: 'cpr.start' },
  hb_pads: { type: 'defib.pads' }, hb_capture: { type: 'pacing.set', on: true }, mb_pads: { type: 'defib.pads' },
  chest_exam: { type: 'exam.chest' }, tension_relief: { type: 'procedure.needle_decompression' }, needle_technique: { type: 'procedure.needle_decompression' },
  chest_drain: { type: 'procedure.chest_tube' }, fona_timing: { type: 'procedure.cricothyroidotomy' }, fona_technique: { type: 'procedure.cricothyroidotomy' },
  fona_achieved: { type: 'procedure.cricothyroidotomy' }, ht_aline: { type: 'procedure.arterial_line' }, vb_endoscopy: { type: 'procedure.endoscopy' },
  sp_level: { type: 'neuraxial.assess' }, svt_vagal: { type: 'procedure.vagal' },
});
const NO_LINE = new Set(['salbutamol']);                     // nebulised: no venous line needed
/** The next action for a case's scored step, read from the patient (pure; criterionAction below adds { type: 'skip' } for a
 *  step already done that now only needs time, and 'wait' for one that must wait): the part still missing comes first, so the learner
 *  is not sent to a button that cannot work yet (pads and charge before the shock, and not the charge again while it charges; a line before an IV drug or a fluid;
 *  ventilation, capnography, then an advanced airway; the monitor leads then the line). null: none known. */
/** The defibrillator from where it stands: pads, charge, wait while it charges (a shock before is refused), shock. */
function shockStep(p) {
  const d = p.defib || {};
  if (!(p.flags?.padsOn || d.padsOn)) return { type: 'defib.pads' };
  if (d.charged) return { type: 'defib.shock' };
  if (d.chargeAt != null && d.chargeAt > p.t) return { type: 'wait', why: 'charge', left: Math.ceil(d.chargeAt - p.t) };
  return { type: 'defib.charge' };
}
const SHOCKABLE = new Set(['VF', 'VT_PULSELESS', 'TORSADES']), CYCLE_S = 120;   // a rhythm check every 2 min of CPR (REF erc2025 in the engine)
function resolveAction(id, p) {
  const ev = CRITERION_EVENT[id]; if (!ev) return null; if (!p) return ev;   // no patient: the action itself
  const f = p?.flags || {}, line = f.ivAccess || f.ioAccess;
  if (id === 't_first_shock' || id === 'shock_energy') return shockStep(p);
  if (id === 'ht_target') {                                 // lower the MAP by 20-25 % over the first hour: a labetalol bolus every 10 min while it is down less than 15 %, never chasing beyond
    const map0 = p.map0 ?? p.circ?.mapArt, fall = 1 - (p.circ?.mapArt ?? map0) / map0, given = (p.log || []).filter(e => e.type === 'drug.bolus' && e.drug === 'labetalol');
    if (!given.length || fall >= 0.15 || given.length >= 8) return { type: 'skip' };
    const last = given[given.length - 1]; if (p.t - last.t < 600) return { type: 'wait', why: 'bp', soft: true, left: Math.ceil(600 - (p.t - last.t)), on: ev };
    return { ...ev, again: true };
  }
  if (id === 'sp_nadir') {                                 // after a spinal: phenylephrine again whenever the MAP is more than 20 % below its baseline, a minute apart
    const base = p.mapRef, now = p.circ?.mapArt; if (!base || now == null || now >= 0.8 * base) return { type: 'skip' };
    const last = [...(p.log || [])].reverse().find(e => e.type === 'drug.bolus' && ['phenylephrine', 'ephedrine', 'norepinephrine'].includes(e.drug));
    if (!last) return { type: 'skip' };                      // the first dose is sp_vaso
    return p.t - last.t < 60 ? { type: 'wait', why: 'map', soft: true, left: Math.ceil(60 - (p.t - last.t)), on: DB('phenylephrine') } : { ...DB('phenylephrine'), again: true };
  }
  if (id === 'resus_target') {                             // bleeding: blood and plasma 1:1 while the shock index stays above 1, one unit every 5 min
    const si = (p.monitor?.hr ?? p.circ?.hr ?? 80) / Math.max(1, p.monitor?.sbp ?? p.circ?.sbp ?? 120), tx = (p.log || []).filter(e => e.type === 'blood.transfuse');
    if (si <= 1 || tx.length >= 10) return { type: 'skip' };
    const last = tx[tx.length - 1]; if (last && p.t - last.t < 300) return { type: 'wait', why: 'blood', soft: true, left: Math.ceil(300 - (p.t - last.t)), on: ev };
    const prbc = tx.filter(e => e.kind === 'prbc' || e.kind === 'whole').length, ffp = tx.filter(e => e.kind === 'ffp').length;
    return { type: 'blood.transfuse', kind: prbc > ffp ? 'ffp' : 'prbc', again: true };
  }
  if (id === 'na_recheck') {                                // the sodium again once each 3 % bolus has run, not before and not over and over
    const b = (p.log || []).filter(e => e.type === 'fluid.bolus' && e.fluid === 'saline3').pop(); if (!b) return { type: 'skip' };
    const end = b.t + (b.minutes || 20) * 60, after = (p.log || []).some(e => e.type === 'lab.order' && ['abg', 'chem'].includes(e.kind) && e.t >= end - 60);
    if (after) return { type: 'skip' };
    if (p.t < end - 60) return { type: 'wait', why: 'bolus', soft: true, left: Math.ceil(end - 60 - p.t), on: { type: 'fluid.bolus' } };
    return { ...ev, again: true };
  }
  if (id === 'na_rise') {                                    // severe symptoms: 150 mL of 3 % again (up to three in all) until the measured Na is up 5 mmol/L
    const boluses = (p.log || []).filter(e => e.type === 'fluid.bolus' && e.fluid === 'saline3'), last = boluses[boluses.length - 1];
    const na = (p.labResults?.() || []).filter(l => l.values?.na != null), first = na[0]?.values.na, now = na[na.length - 1];
    if (!last || first == null || boluses.length >= 3) return { type: 'skip' };
    if (now.values.na - first >= 5) return { type: 'skip' };
    if (p.t - last.t < (last.minutes || 20) * 60) return { type: 'wait', why: 'bolus', soft: true, left: Math.ceil((last.minutes || 20) * 60 - (p.t - last.t)), on: ev };
    if (now.t < last.t + (last.minutes || 20) * 60 - 60) return { type: 'skip' };   // measure after this bolus first (na_recheck)
    return { ...ev, again: true };
  }
  if (id === 'copd_target') {                                // controlled oxygen: SpO2 88-92 %, one step at a time (on NIV its FiO2, else the Venturi mask)
    const sat = (p.resp?.sao2 ?? 0.9) * 100, niv = p.niv && p.niv.mode !== 'off';
    if (sat >= 88 && sat <= 92.5 && (niv || p.o2?.fio2 != null)) return { type: 'skip' };
    const ch = [...(p.log || [])].reverse().find(e => e.type === 'niv.set' || e.type === 'o2.mask');   // give the SpO2 a minute to follow each change
    if (ch && p.t - ch.t < 60) return { type: 'wait', why: 'o2', soft: true, left: Math.ceil(60 - (p.t - ch.t)), on: niv ? { type: 'niv.set' } : { type: 'o2.mask' } };
    if (niv) { const f0 = p.niv.fio2 ?? 0.4, f1 = Math.round(Math.min(0.6, Math.max(0.21, f0 + (sat > 92.5 ? -0.05 : 0.05))) * 100) / 100;
      return f1 === f0 ? { type: 'skip' } : { type: 'niv.set', again: true, set: [['#nivFio2', f1]] }; }
    if (sat > 92.5 && (p.o2?.fio2 ?? 0.21) > 0.25) return { ...O2('v24'), again: true };
    if (sat < 88) return { ...O2('v28'), again: (p.o2?.fio2 ?? 0) >= 0.28 ? undefined : true };
    return ev;
  }
  if (id === 'hb_capture' && !f.padsOn) return { type: 'defib.pads' };
  if (id === 'preox') {                                      // head-up, the 100 % mask, then wait for the end-tidal O2 before induction
    if (p.airway?.intubated || p.airway?.device === 'sga' || p.arrest?.arrested) return { type: 'skip' };
    if (!p.headUp) return { type: 'position.set', headUp: true };
    if (!(p.o2?.fio2 >= 0.9)) return { ...ev, again: true };
    const on = [...(p.log || [])].reverse().find(e => e.type === 'o2.mask' && e.fio2 >= 0.9);
    return (p.preoxEtO2Max ?? 0) < 0.9 && on && p.t - on.t < 180 ? { type: 'wait', why: 'preox', pct: Math.round((p.resp?.etO2 ?? 0) * 100), left: Math.ceil(180 - (p.t - on.t)) } : ev;   // 3 min at most, then on to the induction
  }
  if (ev.type === 'o2.mask' && (p?.airway?.intubated || p?.airway?.device === 'sga')) return { type: 'vent.set', adjust: true, set: [['#inVf', 1]] };   // on a ventilator: its FiO2
  if (id === 'hk_insulin') { const ins = (p?.drugs?.log || []).some(d => d.key === 'insulin' && d.amount >= 8);
    if (!ins) return !line ? { type: 'iv.access' } : { ...DB('insulin'), set: [['.drug[data-drug="insulin"] .dline input', 10, 'U']] };
    return { ...DB('glucose'), set: [['.drug[data-drug="glucose"] .dline input', 25, 'g']] }; }
  if (id === 'dka_tests') return (p?.log || []).some(e => e.type === 'lab.order' && e.kind === 'ketones') ? { type: 'lab.order', kind: 'abg' } : ev;
  if (id === 'tension_relief' || id === 'needle_technique') return { ...ev, set: [['#selSgSide', p?.chest?.side || 'R'], ['#selSgSite', 'mal5'], ['#selSgLen', 80, 'mm']] };
  if (ev.type === 'airway.intubate' && p && !p.arrest?.arrested) {                // not relaxed: the tube is refused; a hypnotic and the relaxant first
    const given = (k) => (p.drugs?.log || []).some(d => k.includes(d.key)), nmb = (() => { try { return p.drugs.effects({ inArrest: false }).nmb; } catch { return 1; } })();
    if (nmb < 0.9) { if (!line) return { type: 'iv.access' }; return !given(['propofol', 'ketamine', 'etomidate', 'midazolam']) ? DB('ketamine') : !given(['rocuronium', 'succinylcholine']) ? DB('rocuronium') : { type: 'wait', why: 'nmb', pct: Math.floor(Math.max(0, nmb) * 100) }; }
    const asleep = (() => { try { return p.drugs.effects({ inArrest: false }).loc; } catch { return true; } })();
    if (!asleep) {                                           // paralysed but not asleep: the tube would be refused, and the patient is aware; a top-up of the hypnotic first,
      const HYP = ['propofol', 'ketamine', 'etomidate', 'midazolam'], doses = (p.log || []).filter(e => e.type === 'drug.bolus' && HYP.includes(e.drug)), last = doses[doses.length - 1];
      if (last && p.t - last.t < 90) return { type: 'wait', why: 'hypnotic', left: Math.ceil(90 - (p.t - last.t)), on: DB(last.drug) };   // one at a time: each needs about a minute to act
      if (doses.length >= 4) return { type: 'skip' };          // the induction and three top-ups: past that the pointer stops suggesting more
      const lbm = p.body?.lbm || 60, shock = (p.circ?.mapArt ?? 80) < 65;   // in shock ketamine, which keeps the pressure up, rather than propofol
      return shock ? { ...DB('ketamine'), again: true, set: [['.drug[data-drug="ketamine"] .dline input', Math.max(20, Math.round(0.5 * lbm / 5) * 5), 'mg']] }
        : { ...DB('propofol'), again: true, set: [['.drug[data-drug="propofol"] .dline input', Math.max(30, Math.round(0.7 * lbm / 10) * 10), 'mg']] };
    }
  }
  if (id === 'induction' && p) return { ...ev, set: [['.drug[data-drug="propofol"] .dline input', Math.round(2.5 * (p.body?.lbm || 60) / 10) * 10, 'mg']] };   // 2.5 mg/kg lean body mass (the panel default, 2, can leave an obese patient awake)
  if (id === 'post_rosc' && p?.arrest?.roscCount) {          // the bundle, part by part: 12-lead, temperature, then the targets
    const ordered = (w) => (p.log || []).some(e => e.type === 'order' && e.what === w), sat = (p.resp?.sao2 ?? 1) * 100, co2 = p.resp?.paco2 ?? 40;
    if (!ordered('ecg12')) return { type: 'order', what: 'ecg12' };
    if (!ordered('temperature_control') && p.therm?.device == null) return { type: 'order', what: 'temperature_control' };
    if ((p.circ?.mapArt ?? 80) < 65) {                       // noradrenaline: start it, give it a minute, then turn it up (not the same start again)
      const NE = { type: 'drug.infusion', drug: 'norepinephrine' }, rate = p.drugs?.pk?.norepinephrine?.rate ?? 0, w = p.body?.weightKg || 70;
      if (!(rate > 0)) return NE;
      const on = [...(p.log || [])].reverse().find(e => e.type === 'drug.infusion' && e.drug === 'norepinephrine');
      if (on && p.t - on.t < 60) return { type: 'wait', why: 'map', soft: true, left: Math.ceil(60 - (p.t - on.t)), on: NE };
      return { ...NE, again: true, set: [['.drug[data-drug="norepinephrine"] .ddet > .dline:nth-child(4) input', Math.min(1, Math.round((rate / w + 0.05) * 100) / 100), 'mcg/kg/min']] };
    }
    if (sat < 90 || sat > 98.5 || co2 < 35 || co2 > 45) {
      const set = []; if (sat > 98.5) set.push(['#inVf', Math.max(0.3, Math.round(((p.vent?.fio2 ?? 1) - 0.2) * 10) / 10)]); else if (sat < 90) set.push(['#inVf', 1]);
      const rr = p.vent?.rate ?? 12; if (co2 > 45) set.push(['#inVr', Math.min(30, rr + 4), '/min']); else if (co2 < 35) set.push(['#inVr', Math.max(8, rr - 2), '/min']);
      return { type: 'vent.set', settings: { mode: 'ctrl' }, adjust: true, set };
    }
    return ev;
  }
  if (id === 'airway_vent' || id === 'post_rosc') { const vented = p?.vent?.mode === 'ctrl' && p.vent.fio2 >= 0.6; const adv = p?.airway?.intubated || p?.airway?.device === 'sga';
    return !vented ? { type: 'vent.set' } : !f.capnography ? { type: 'monitor.attach', items: { capnography: true } } : !adv && id === 'airway_vent' ? { type: 'airway.set', device: 'sga' } : ev; }   // then an advanced airway (a supraglottic device is enough in arrest)
  if (id === 'monitor_iv') return !f.ecgLeads ? ev : !f.spo2Probe ? { type: 'monitor.attach', items: { spo2Probe: true } } : !line ? { type: 'iv.access' } : ev;
  if (['drug.bolus', 'drug.infusion', 'fluid.bolus', 'blood.transfuse'].includes(ev.type) && !line && !NO_LINE.has(ev.drug) && p) return { type: 'iv.access' };
  return ev;
}
/** Steps whose action is legitimately done again (a repeat dose, a recheck after treatment, another ventilator adjustment). */
const REPEAT = new Set(['epi_timing', 'hy_recheck', 'na_recheck', 'hk_recheck', 'mh_vent', 'post_rosc']);
const sameAct = (e, a) => e.type === a.type && ['drug', 'kind', 'what', 'fluid', 'device'].every(k => a[k] == null || e[k] === a[k]) && (a.fio2 == null || Math.abs((e.fio2 ?? 0) - a.fio2) < 0.01)
  && Object.keys(a.items || {}).every(k => e.items?.[k]);   // attaching the ECG is not attaching the SpO2 probe
/** Démarche criteria whose act is already done another way: starting the guided procedure then would repeat it (a second induction, a second drain). */
const DEMARCHE_DONE = { demarche_rsi: (p) => p.airway?.intubated || p.airway?.device === 'ett', demarche_fona: (p) => p.airway?.device === 'fona', demarche_chest: (p) => !!(p.chest?.tube || p.chest?.tubeBusy) };
export function criterionAction(id, p) {
  if (p && DEMARCHE_DONE[id]?.(p)) return { type: 'skip' };
  if (CRITERION_EVENT[id]?.type === 'airway.intubate' && p && !p.airway?.intubated && !p.airway?.intubating && (p.failedAttempts || 0) > 0) {   // a failed attempt: oxygenate (the apnoea rule) and try again, three at most, then a supraglottic airway (DAS plan B)
    if ((p.failedAttempts || 0) >= 3) return p.airway?.device === 'sga' ? { type: 'skip' } : { type: 'airway.set', device: 'sga' };
    const a2 = resolveAction(id, p); return a2?.type === 'airway.intubate' ? { ...a2, again: true } : a2;
  }
  const ev = CRITERION_EVENT[id], a = resolveAction(id, p); if (!a || !p) return a;
  if (id === 'epi_timing') { const last = [...(p.log || [])].reverse().find(e => e.type === 'drug.bolus' && e.drug === 'epinephrine'); if (last && p.t - last.t < 180) return { type: 'skip' }; }   // every 3-5 min
  if (a.type === 'drug.bolus' && a.drug) {                 // safety net: never the same bolus again within a minute (a learner pressing as fast as the pointer moves)
    const same = [...(p.log || [])].reverse().find(e => e.type === 'drug.bolus' && e.drug === a.drug);
    if (same && p.t - same.t < 60) return { type: 'wait', why: 'busy', soft: true, left: Math.ceil(60 - (p.t - same.t)), on: { type: 'drug.bolus', drug: a.drug } };
  }
  if (id === 't_first_shock' || id === 'shock_energy') return (p.arrest?.shocksGiven ?? 0) > 0 ? { type: 'skip' } : a;   // a refused shock (not charged yet) is not a shock: keep pointing
  if (a.type === ev.type && !REPEAT.has(id) && !a.again && (p.log || []).some(e => sameAct(e, a))) return { type: 'skip' };   // already done: the rest is time or outcome
  return a;
}

/** The guided procedure that scores a démarche criterion (its button in the guide's list). */
export const DEMARCHE_PROC = Object.freeze({ demarche_defib: 'defib', demarche_rsi: 'rsi', demarche_chest: 'needle', demarche_fona: 'fona', demarche_bronch: 'bronch' });
/** The control for a case's scored step inside its section (null: none known). */
export function criterionControl(id) {
  if (CRITERION_EVENT[id]?.type === 'guide') return { sel: `[data-proc="${CRITERION_EVENT[id].proc}"]` };
  if (DEMARCHE_PROC[id]) return { sel: `[data-proc="${DEMARCHE_PROC[id]}"]` };
  if (typeof id === 'string' && id.startsWith('echo_')) return { label: 'ec_open' };
  return controlOf(CRITERION_EVENT[id]);
}

/** What the dock should point at now, or null.
 *  s: { level, next (the coach's next item {id, text, state} or null), items (the live checklist), said (the last senior
 *  hint {id, t} or null), t (patient time), p (the patient, for prerequisites), open (the tab whose panel is open, or null), guiding (a guided procedure runs),
 *  finished }. Returns { tab, id, text, why: 'next' | 'senior', inside (its section is open: point at the control in it) }. */
/** wait: true when the step has nothing to press yet (act.why 'nmb' | 'preox'): the UI shows why, without pointing. */
export function dockTarget(s) {
  if (!s || s.finished || s.guiding || s.level === 'expert') return null;
  if (s.level === 'beginner' && s.p?.ward && s.p.scenario?.id) {   // the infectiology ward: the guideline plan, step by step (ward-plan.js)
    const st = wardStep(s.p.ward, s.p.scenario.id); if (!st) return null;
    const a = st.act, act = a.type === 'ward.rx.start' ? { ...a, set: [['#wdDrug', a.drug], ['#wdRoute', a.route], ['#wdDose', a.dose]] } : a;
    return { tab: 'tab_ward', id: 'ward', text: s.tx ? s.tx(st.why) : st.why, why: 'next', act, inside: s.open === 'tab_ward' };
  }
  if (s.p?.airway?.intubating && s.level === 'beginner') {   // a tube (or a front-of-neck airway) is going in: nothing else to press at the airway until it is done
    const left = Math.max(1, Math.ceil(Math.min(s.p.t + 30, ...(s.p.pendingEvents || []).map(e => e.at).filter(a => a > s.p.t)) - s.p.t));
    return { tab: 'tab_airway', id: 'airway_busy', text: '', why: 'next', act: { type: 'wait', why: 'tube', left }, ctl: { type: 'airway.intubate' }, wait: true, inside: s.open === 'tab_airway' };
  }
  { const q = s.p, aw = q?.airway || {};                    // a tube (or a supraglottic or surgical airway) in, no ventilation and hardly breathing: ventilate, before anything else
    const tubed = aw.intubated || aw.device === 'sga' || aw.device === 'fona';   // without an airway device too: a failed intubation in a paralysed patient is bag-mask, now
    const rsiApnoea = !tubed && !(q?.failedAttempts > 0) && (q?.resp?.sao2 ?? 1) >= 0.92 && (q?.drugs?.log || []).some(d => d.key === 'rocuronium' || d.key === 'succinylcholine');   // the planned apnoea of an RSI: no bagging while the SpO2 holds
    if (s.level === 'beginner' && q && !q.arrest?.arrested && !rsiApnoea && q.vent?.mode !== 'ctrl' && !(q.niv && q.niv.mode !== 'off') && (q.resp?.rr ?? 14) < 6)
      return { tab: 'tab_airway', id: 'ventilate', text: s.tx ? s.tx(tubed ? 'dh_ventilate' : 'dh_bmv') : 'Not breathing: ventilate now', why: 'next', act: { type: 'vent.set', settings: { mode: 'ctrl' } }, inside: s.open === 'tab_airway' };
  }
  { const q = s.p;                                           // the monitor shows SpO2 under 90 % on little or no oxygen: oxygen first, whatever the case (not in COPD, which titrates to 88-92 %)
    if (s.level === 'beginner' && q && q.flags?.spo2Probe && !q.arrest?.arrested && (q.resp?.sao2 ?? 1) < 0.9 && (q.resp?.rr ?? 14) >= 8 && q.vent?.mode !== 'ctrl' && !(q.niv && q.niv.mode !== 'off')
      && (q.o2?.fio2 ?? 0.21) < 0.5 && !q.airway?.intubated && !/copd/.test(q.scenario?.id || ''))
      return { tab: 'tab_airway', id: 'oxygen', text: s.tx ? s.tx('dh_oxygen') : 'SpO2 under 90 %: give oxygen', why: 'next', act: { ...O2('nrb'), again: true }, inside: s.open === 'tab_airway' };
  }
  const p = s.p;                                             // cardiac arrest, whatever the case: CPR, then for VF/VT a shock every 2 min, adrenaline every 3-5 min (REF aha2025 / erc2025 in the engine)
  if (s.level === 'beginner' && p && (p.tdpCount || 0) > 0 && !p.arrest?.arrested) {   // torsades on a long QT: keep K 4.5-5, the heart rate up, magnesium repeated if it comes back (REF drew2010 in the engine)
    const log = p.log || [], ago = (pred) => { const e = [...log].reverse().find(pred); return e ? p.t - e.t : Infinity; };
    const T = (k, en) => (s.tx ? s.tx(k) : en), at = (tab, k, en, act) => ({ tab, id: 'tdp', text: T(k, en), why: 'next', act, inside: tab === s.open });
    const lab = (p.labResults?.() || []).filter(l => l.values?.k != null).pop(), pending = (p.labs || []).some(l => l.readyAt > p.t && ['abg', 'chem'].includes(l.kind));
    if (!lab && !pending && ago(e => e.type === 'lab.order') > 600) return at('tab_orders', 'dh_tdp_k', 'Torsades: check the potassium (aim 4.5-5)', { type: 'lab.order', kind: 'abg' });
    const kcl = ago(e => e.type === 'drug.bolus' && e.drug === 'potassiumChloride');
    if (lab && lab.values.k < 4.5 && kcl > 3600 && lab.t >= p.t - kcl) return at('tab_drugs', 'dh_tdp_k', 'Torsades: potassium up to 4.5-5', { ...DB('potassiumChloride'), again: true, set: [['.drug[data-drug="potassiumChloride"] .dline input', 20, 'mmol']] });
    if (lab && kcl < Infinity && kcl >= 3600 && !pending && ago(e => e.type === 'lab.order') > 3600) return at('tab_orders', 'dh_tdp_k', 'Torsades: check the potassium (aim 4.5-5)', { type: 'lab.order', kind: 'abg', again: true });
    const lastTdp = (p.arrest?.arrestStarts || []).slice(-1)[0] ?? -Infinity, mg = [...log].reverse().find(e => e.type === 'drug.bolus' && e.drug === 'magnesium');
    if (mg && lastTdp > mg.t && p.t - mg.t >= 600 && log.filter(e => e.drug === 'magnesium' && e.type === 'drug.bolus').length < 2) return at('tab_drugs', 'dh_tdp_mg', 'Torsades again: magnesium 2 g once more', { ...DB('magnesium'), again: true });
    const iso = p.drugs?.pk?.isoprenaline?.rate ?? 0, hr = p.monitor?.hr ?? p.circ?.hr ?? 80;
    if (iso > 0 && hr < 90 && iso < 10 && ago(e => e.type === 'drug.infusion' && e.drug === 'isoprenaline') >= 120)
      return at('tab_drugs', 'dh_tdp_rate', 'Torsades: heart rate to 90-110 (isoprenaline up)', { ...DI('isoprenaline'), again: true, set: [['.drug[data-drug="isoprenaline"] .ddet > .dline:nth-child(4) input', Math.min(10, Math.round(iso + 2)), 'mcg/min']] });
  }
  if (s.level === 'beginner' && p && (p.crises?.seizure || p.crises?.se?.active) && !p.arrest?.arrested) {   // refractory status: still fitting 10 min after the second-line drug: anaesthesia, the tube, then an infusion (REF glauser2016 in the engine)
    const drug = (k) => (p.log || []).filter(e => e.type === 'drug.bolus' && e.drug === k), second = ['levetiracetam', 'valproate', 'fosphenytoin', 'phenytoin'].flatMap(drug)[0];
    if (second && p.t - second.t >= 600) {
      const at = (tab, act, extra = {}) => ({ tab, id: 'se_refractory', text: s.tx ? s.tx('dh_se_refr') : 'Still fitting: refractory status, anaesthesia and intubation', why: 'next', act, inside: tab === s.open, ...extra });
      const nmb = (() => { try { return p.drugs.effects({ inArrest: false }).nmb; } catch { return 0; } })();
      if (!drug('propofol').length) return at('tab_drugs', DB('propofol'));
      if (!p.airway?.intubated) {
        if (p.airway?.intubating) return null;
        if (!drug('rocuronium').length && !drug('succinylcholine').length) return at('tab_drugs', DB('rocuronium'));
        if (nmb < 0.9) return at('tab_airway', { type: 'wait', why: 'nmb', pct: Math.floor(Math.max(0, nmb) * 100) }, { wait: true, ctl: { type: 'airway.intubate' } });
        const a2 = resolveAction('intubation', p) || { type: 'airway.intubate' };   // asleep too, or a top-up first (the intubation rules)
        return at(a2.type === 'airway.intubate' ? 'tab_airway' : a2.type === 'wait' ? 'tab_drugs' : TAB_OF_EVENT[a2.type] || 'tab_drugs', a2, a2.type === 'wait' ? { wait: true, ctl: a2.on } : {});
      }
      if (!((p.drugs?.pk?.propofol?.rate ?? 0) > 0)) return at('tab_drugs', DI('propofol'));
    }
  }
  if (s.level === 'beginner' && p?.arrest?.key === 'SVT' && !p.arrest.arrested) {   // re-entrant SVT still running after adenosine: 12 mg, 12 mg again, then a synchronised shock only if unstable (REF aha2025 in the engine)
    const ad = (p.log || []).filter(e => e.type === 'drug.bolus' && e.drug === 'adenosine'), lastA = ad[ad.length - 1];
    if (ad.length && ad.length < 3) return p.t - lastA.t < 120 ? { tab: 'tab_drugs', id: 'svt_more', text: '', why: 'next', act: { type: 'wait', why: 'adeno', soft: true, left: Math.ceil(120 - (p.t - lastA.t)) }, ctl: DB('adenosine'), wait: true, inside: s.open === 'tab_drugs' }
      : { tab: 'tab_drugs', id: 'svt_more', text: s.tx ? s.tx('dh_adeno') : 'Still in SVT: adenosine 12 mg, rapid push and flush', why: 'next', act: { ...DB('adenosine'), again: true, set: [['.drug[data-drug="adenosine"]:not([data-route]) .dline input', 12, 'mg']] }, inside: s.open === 'tab_drugs' };
    if (ad.length >= 3 && (p.monitor?.sbp ?? p.circ?.sbp ?? 120) < 90 && p.t - lastA.t >= 60)
      return { tab: 'tab_circ', id: 'svt_cardiovert', text: s.tx ? s.tx('dh_cardiovert') : 'Unstable: synchronised cardioversion', why: 'next', act: p.defib?.mode !== 'sync' ? { type: 'defib.mode', mode: 'sync' } : shockStep(p), inside: s.open === 'tab_circ' };
  }
  if (s.level === 'beginner' && p?.arrest?.arrested) {
    const T = (k, en) => (s.tx ? s.tx(k) : en), at = (tab, id, text, act, extra = {}) => ({ tab, id, text, why: 'next', act, ...(act.type === 'wait' ? { wait: true } : {}), inside: tab === s.open, ...extra });
    if (!(p.cpr?.mode && p.cpr.mode !== 'off')) return at('tab_circ', 'arrest_cpr', T('dh_cpr', 'Cardiac arrest: start chest compressions'), { type: 'cpr.start', mode: 'auto' });
    const shockable = SHOCKABLE.has(p.arrest.key), shocks = p.shockLog || [], last = shocks[shocks.length - 1];
    const since = (p.arrest.arrestStarts || []).slice(-1)[0] ?? 0;   // a new arrest (a re-arrest) is shocked at once, not at the old cycle's time
    if (shockable && (p.defib?.chargeAt != null || !last || last.t < since || p.t - last.t >= CYCLE_S))
      return at('tab_circ', 'acls_cycle', shocks.length ? T('dh_cycle', 'Rhythm check: still shockable, shock again') : T('dh_shock', 'VF/VT: defibrillate'), shockStep(p), { ctl: { type: 'defib.shock' } });
    const epi = [...(p.log || [])].reverse().find(e => e.type === 'drug.bolus' && e.drug === 'epinephrine'), line = p.flags?.ivAccess || p.flags?.ioAccess;
    const last_ = (p.drugs?.log || []).some(d => d.key === 'bupivacaine' || d.key === 'lidocaine' && d.amount > 300), w = p.body?.weightKg || 70;   // local anaesthetic toxicity
    if (last_ && line) {                                     // LAST in arrest: lipid running, a bolus repeated twice 5 min apart (neal2018 in the engine)
      const lb = (p.log || []).filter(e => e.type === 'drug.bolus' && e.drug === 'lipid'), inf = (p.drugs?.pk?.lipid?.rate ?? 0) > 0;
      if (!inf) return at('tab_drugs', 'last_inf', T('dh_lipid', 'LAST: lipid emulsion running, bolus repeated twice'), DI('lipid'));
      if (lb.length && lb.length < 3 && p.t - lb[lb.length - 1].t >= 300) return at('tab_drugs', 'last_bolus', T('dh_lipid', 'LAST: lipid emulsion running, bolus repeated twice'), { ...DB('lipid'), again: true });
    }
    if ((!shockable || shocks.length >= 2) && (!epi || p.t - epi.t >= 180)) {
      const dose = last_ ? [['.drug[data-drug="epinephrine"]:not([data-route]) .dline input', Math.max(10, Math.min(100, Math.round(w / 10) * 10)), 'mcg']] : [['.drug[data-drug="epinephrine"]:not([data-route]) .dline input', 1000, 'mcg']];   // LAST: at most 1 mcg/kg
      return line ? at('tab_drugs', 'acls_epi', last_ ? T('dh_epi_last', 'LAST: adrenaline at most 1 mcg/kg') : T('dh_epi', 'Adrenaline 1 mg IV, every 3-5 min'), { ...DB('epinephrine'), set: dose }) : at('tab_proc', 'acls_line', T('dh_epi', 'Adrenaline 1 mg IV, every 3-5 min'), { type: 'io.access' });
    }
  }
  let item = null, why = null;
  if (s.level === 'beginner') {                              // the first step still to do that has something to press now
    why = 'next'; item = s.next;
    if (s.p && s.items) {                                    // a soft wait (oxygen or a vasopressor settling) lets the next step go first; a hard one (pre-oxygenation, the relaxant) does not
      const open = s.items.filter(i => (i.state === 'todo' || i.state === 'part') && dockOf(i.id)), act = (i) => criterionAction(i.id, s.p);
      item = open.find(i => { const a = act(i); return a?.type !== 'skip' && !(a?.type === 'wait' && a.soft); }) || open.find(i => act(i)?.type === 'wait') || null;
    }
  }
  else if (s.level === 'intermediate' && s.said?.id != null && s.t - s.said.t <= HINT_S) {
    item = (s.items || []).find(i => i.id === s.said.id) || null; why = 'senior';
    if (item && item.state !== 'todo' && item.state !== 'part') item = null;   // done since the hint: stop pointing
  }
  const dock = item ? dockOf(item.id) : null;
  if (!dock) return null;                                                    // nothing to press
  const act = item ? criterionAction(item.id, s.p) : null; if (act?.type === 'skip') return null;
  if (act?.type === 'wait') { const tab = TAB_OF_EVENT[act.on?.type] || TAB_OF_EVENT[CRITERION_EVENT[item.id]?.type] || dock;   // nothing to press yet: say what it waits for, where it will happen
    return { tab, id: item.id, text: item.text, why, act, wait: true, inside: tab === s.open, ...(act.on ? { ctl: act.on } : {}) }; }
  const tab = (act && TAB_OF_EVENT[act.type]) || dock;   // a missing prerequisite may live elsewhere
  return { tab, id: item.id, text: item.text, why, act, inside: tab === s.open };   // its section open: point at the control inside it
}
