// Which dock button holds the next thing to do, by learner level. Pure (no DOM), so it runs under node --test.
//   beginner     - the dock button of the coach's next step pulses, with the step written above it, at every step;
//   intermediate - only when the senior has just given a hint, for that one step and for HINT_S of patient time;
//   expert       - never.
// The step comes from the case's own scoring criteria (coach-eval.js), so the pointer always matches what is assessed.
// It only points: it never presses anything or changes the patient. It hides while that button's panel is already open.
// During a guided procedure (guideTarget) it shows, step by step, the dock button where that action is found in a real case,
// with the same levels: every step for a beginner, a few for an intermediate, none for an expert.

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
  bronch_look: A, tube_reposition: A, tube_depth_final: A, secretions: A,
  // CPR, defibrillator, pacing
  t_first_compression: C, t_first_shock: C, shock_energy: C, cpr_quality: C, hb_pads: C, hb_capture: C, mb_pads: C,
  // examination and procedures
  chest_exam: P, tension_relief: P, needle_technique: P, chest_drain: P, fona_timing: P, fona_technique: P, fona_achieved: P,
  ht_aline: P, vb_endoscopy: P, sp_level: P, svt_vagal: P,
  // results and "do not" rules: nothing to press
  outcome: null, spo2_nadir: null, spo2_nadir_live: null, map_nadir_live: null, hemodynamics: null, ana_map: null, mh_temp: null,
  tdp_quiet: null, tdp_no_amio: null, dka_ketones: null, se_two_benzo: null, se_stopped: null, copd_no_high_o2: null, copd_ph: null,
  svt_converted: null, svt_no_early_shock: null, hk_no_hypo: null, na_rise: null, na_limit: null, na_no_hypotonic: null,
  po_no_fluid: null, po_spo2: null, ht_target: null, ht_no_crash: null, vb_no_txa: null, vb_controlled: null, sp_nadir: null,
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
  'neuraxial.spinal': P, 'neuraxial.assess': P, 'io.access': P,
  'monitor.attach': O, 'nibp.cycle': O, 'iv.access': O, 'order': O, 'lab.order': O, 'exam.ecg12': O, 'thermal.cover': O, 'thermal.device': O, 'thermal.ambient': O,
});
/** The dock button of a guided step from the events it dispatches: the first event that has one (null: a check or a
 *  preparation step with no button of its own, such as the checklist before an intubation). */
export const tabOfEvents = (evs) => { for (const e of evs || []) { const k = TAB_OF_EVENT[e?.type]; if (k) return k; } return null; };

/** During a guided procedure: the dock button where the current step is found in a real case, so the learner learns
 *  where each action lives. g: { level, tabs (the dock button of every step, from tabOfEvents), i (current step),
 *  open (the tab whose panel is open), finished }. Beginner: every step that has a button; intermediate: only the
 *  first step that uses each button (a few, then it lets go); expert: never. When another panel than the guide is
 *  open, the guide's button is pointed at instead, to come back to the step. Returns { tab, why: 'where' | 'back' } or null. */
export function guideTarget(g) {
  if (!g || g.finished || g.level === 'expert' || !(g.i >= 0 && g.i < (g.tabs?.length ?? 0))) return null;
  if (g.open && g.open !== G) return { tab: G, why: 'back' };
  const tab = g.tabs[g.i]; if (!tab) return null;
  if (g.level === 'intermediate' && g.tabs.indexOf(tab) !== g.i) return null;   // already shown earlier in this procedure
  return g.level === 'beginner' || g.level === 'intermediate' ? { tab, why: 'where' } : null;
}

/** What the dock should point at now, or null.
 *  s: { level, next (the coach's next item {id, text, state} or null), items (the live checklist), said (the last senior
 *  hint {id, t} or null), t (patient time), open (the tab whose panel is open, or null), guiding (a guided procedure runs),
 *  finished }. Returns { tab, text, why: 'next' | 'senior' }. */
export function dockTarget(s) {
  if (!s || s.finished || s.guiding || s.level === 'expert') return null;
  let item = null, why = null;
  if (s.level === 'beginner') { item = s.next; why = 'next'; }
  else if (s.level === 'intermediate' && s.said?.id != null && s.t - s.said.t <= HINT_S) {
    item = (s.items || []).find(i => i.id === s.said.id) || null; why = 'senior';
    if (item && item.state !== 'todo' && item.state !== 'part') item = null;   // done since the hint: stop pointing
  }
  const tab = item ? dockOf(item.id) : null;
  if (!tab || tab === s.open) return null;                                   // nothing to press, or its panel is already open
  return { tab, text: item.text, why };
}
