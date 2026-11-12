// Scripted "expert" and "idle" learners for each scenario. They are used by the scenario tests to prove that
// (a) the scoring rewards guideline-concordant care, (b) doing nothing is scored poorly, and (c) the physiology
// responds to the interventions the scoring rewards (i.e. scoring is not decorative).
import { aclsTeam, runScript } from './bots.js';
import { wardExpert } from './ward.js';
import { ECHO_VIEWS, echoState, measureTruth, reportTruth } from '../../src/engine/echo.js';

const MON = { type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, capnography: true } };

/** Run `p` as a competent clinician would for its scenario. Deterministic. */
export function expertRun(p, id) {
  switch (id) {
    case 'witnessed_vf':
      return aclsTeam(p, { endT: 900, reaction: 5 });
    case 'stemi_vf':
      runScript(p, [[20, MON], [30, { type: 'iv.access' }], [60, { type: 'order', what: 'ecg12' }], [100, { type: 'order', what: 'aspirin', mg: 324 }],
        [160, { type: 'order', what: 'cath_lab' }], [200, { type: 'defib.pads' }]], 590);
      return aclsTeam(p, { endT: 1500, reaction: 5 });
    case 'opioid_pea':
      runScript(p, [[5, MON], [10, { type: 'iv.access' }], [15, { type: 'airway.set', device: 'bvm' }],
        [20, { type: 'vent.set', settings: { mode: 'ctrl', rate: 10, vt: 450, fio2: 1.0, peep: 5, seal: 0.9 } }],
        [60, { type: 'drug.bolus', drug: 'naloxone', amount: 400 }]], 120);
      return p.arrest.arrested ? aclsTeam(p, { endT: 900, reaction: 5 }) : p.run(900 - p.t);
    case 'obese_rsi': {
      runScript(p, [[0, { type: 'note', text: 'guide rsi: prep' }], [0, { type: 'position.set', headUp: true }], [1, { type: 'o2.mask', fio2: 1.0, seal: 0.95 }], [2, MON]], 300);
      const vent = q => q.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: 6 * q.body.pbw, fio2: 1.0, peep: 8, seal: 0.97 } });
      p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 200 });          // ~2.6 mg/kg lean body mass
      p.dispatch({ type: 'drug.bolus', drug: 'rocuronium', amount: 100 });        // ~1.5 mg/kg ideal body weight
      for (let k = 0; k < 20 && !(p.drugs.effects({ inArrest: false }).nmb > 0.9); k++) p.run(10);   // wait for relaxation (train-of-four equivalent)
      for (let a = 0; a < 3 && !p.airway.intubated; a++) {
        const r = p.dispatch({ type: 'airway.intubate' });
        p.run((r.willTakeS || 30) + 2);                                           // an operator re-attempts after a failed pass
      }
      if (p.airway.intubated) vent(p);
      return p.run(p.scenario.durationS - p.t);
    }
    case 'hemorrhage':
      runScript(p, [[5, { type: 'iv.access' }], [20, { type: 'thermal.cover', factor: 0.5 }], [45, { type: 'bleed.control' }],
        [60, { type: 'blood.transfuse', kind: 'prbc' }], [75, { type: 'blood.transfuse', kind: 'prbc' }], [90, { type: 'blood.transfuse', kind: 'prbc' }], [105, { type: 'blood.transfuse', kind: 'ffp' }]], 600);
      return p.run(p.scenario.durationS - p.t);
    case 'tension_ptx':
      runScript(p, [[40, { type: 'exam.chest' }], [50, { type: 'exam.pocus' }], [60, { type: 'note', text: 'guide needle: site' }],
        [70, { type: 'procedure.needle_decompression', side: 'R', site: 'aal5', needleMm: 80 }],        // 8 cm at the 5th ICS AAL on the right (ATLS; REF ahmad2025)
        [85, { type: 'exam.chest' }], [90, { type: 'drug.bolus', drug: 'fentanyl', amount: 100 }],       // reassess, then analgesia before the drain
        [100, { type: 'procedure.chest_tube', side: 'R', fr: 28 }]], 600);
      return p.run(p.scenario.durationS - p.t);
    case 'cico': {
      runScript(p, [[3, { type: 'order', what: 'call_help' }], [8, { type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: 450, fio2: 1.0, peep: 5, seal: 0.95 } }]], 40);
      for (let k = 0; k < 20 && !(p.drugs.effects({ inArrest: false }).nmb > 0.9); k++) p.run(5);
      const r = p.dispatch({ type: 'airway.intubate' }); p.run((r.willTakeS || 30) + 1);             // one laryngoscopy attempt (fails: grade 4 view)
      p.dispatch({ type: 'airway.set', device: 'sga' }); p.run(8);                                    // one supraglottic attempt (does not ventilate)
      p.dispatch({ type: 'order', what: 'declare_cico' });
      p.dispatch({ type: 'exam.neck', method: 'palpation' });                                        // laryngeal handshake before the incision
      const f = p.dispatch({ type: 'procedure.cricothyroidotomy', technique: 'scalpel_bougie', approach: p.neck.palpable ? 'palpate' : 'vertical' });
      p.run(f.willTakeS + 1);
      if (!p.airway.intubated) {                                                                      // failed pass: second attempt through a vertical incision
        const g = p.dispatch({ type: 'procedure.cricothyroidotomy', technique: 'scalpel_bougie', approach: 'vertical' }); p.run(g.willTakeS + 1);
      }
      p.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: 450, fio2: 1.0, peep: 5, seal: 0.95 } });
      return p.run(p.scenario.durationS - p.t);
    }
    case 'tube_desat':                                                                                 // DOPE: FiO2 1.0, look, pull the tube back while looking, aspirate, scope out, wean FiO2
      runScript(p, [[10, { type: 'vent.set', settings: { fio2: 1.0 } }], [30, { type: 'bronch.insert' }], [45, { type: 'airway.tube_adjust', cm: -3 }],
        [60, { type: 'bronch.suction', where: 'R' }], [70, { type: 'bronch.suction', where: 'trachea' }], [80, { type: 'bronch.remove' }], [300, { type: 'vent.set', settings: { fio2: 0.5 } }]], 900);
      return p;
    case 'echo_hypovolaemia': case 'echo_lv_failure': case 'echo_tamponade': case 'echo_rv': return echoExpert(p);
    case 'inf_pyelo': case 'inf_cap': case 'inf_sab': case 'inf_esbl': return wardExpert(p, id);
    case 'anaphylaxis':                                                                               // adrenaline IV 50 mcg titrated, IM 0.5 mg, fluids
      runScript(p, [[90, { type: 'drug.bolus', drug: 'epinephrine', amount: 50 }], [100, { type: 'fluid.bolus', volumeL: 1, minutes: 10 }], [110, { type: 'drug.bolus', drug: 'epinephrine', amount: 500, route: 'im' }],
        [150, { type: 'drug.bolus', drug: 'epinephrine', amount: 50 }], [200, { type: 'drug.bolus', drug: 'epinephrine', amount: 50 }], [400, { type: 'fluid.bolus', volumeL: 0.5, minutes: 10 }]], 1200);
      return p;
    case 'mh_crisis': {                                                                               // hyperventilate, dantrolene as soon as EtCO2 climbs, cool
      while (p.resp.etco2 <= 55 && p.t < 1500) p.run(5);
      const w = p.body.weightKg;
      runScript(p, [[p.t + 2, { type: 'vaporizer.set', percent: 0 }], [p.t + 3, { type: 'drug.infusion', drug: 'propofol', rate: 6 }], [p.t + 5, { type: 'vent.set', settings: { rate: 24, fio2: 1.0 } }], [p.t + 30, { type: 'drug.bolus', drug: 'dantrolene', amount: Math.round(2.5 * w) }],
        [p.t + 60, { type: 'thermal.device', target: 35 }], [p.t + 600, { type: 'drug.bolus', drug: 'dantrolene', amount: Math.round(2.5 * w) }]], 1800);
      return p;
    }
    case 'last_block': {                                                                              // oxygen, lipid 1.5 mL/kg then infusion as soon as signs appear
      while (p.lastSignT == null && p.t < 600) p.run(2);
      const w = p.body.weightKg;
      runScript(p, [[p.t + 10, { type: 'o2.mask', fio2: 0.8 }], [p.t + 20, { type: 'drug.bolus', drug: 'lipid', amount: Math.round(1.5 * w) }], [p.t + 25, { type: 'drug.infusion', drug: 'lipid', rate: 0.25 * w }]], 1200);
      if (p.arrest.arrested) { p.dispatch({ type: 'cpr.start' }); p.run(10); }
      return p;
    }
    case 'heart_block':                                                                               // pads, atropine, analgesia, pace
      runScript(p, [[20, { type: 'defib.pads' }], [30, { type: 'iv.access' }], [40, { type: 'drug.bolus', drug: 'atropine', amount: 500 }], [60, { type: 'drug.bolus', drug: 'fentanyl', amount: 50 }],
        [90, { type: 'pacing.set', on: true, rate: 70, mA: 120 }]], 1200);
      return p;
    case 'dka': {                                                                                    // JBDS: tests, saline, fixed-rate insulin, potassium, glucose 10 %
      const w = p.body.weightKg;
      runScript(p, [[30, { type: 'iv.access' }], [60, { type: 'lab.order', kind: 'ketones' }], [90, { type: 'lab.order', kind: 'abg' }], [120, { type: 'fluid.bolus', volumeL: 1, minutes: 60, fluid: 'saline' }],
        [300, { type: 'drug.infusion', drug: 'insulin', rate: 0.1 * w / 60 }], [3720, { type: 'fluid.bolus', volumeL: 1, minutes: 120, fluid: 'saline' }], [10920, { type: 'fluid.bolus', volumeL: 1, minutes: 240, fluid: 'saline' }]], 600);
      let lastK = -1e9, g10 = false;
      while (p.t < 14400) { p.run(60); if (p.lytes.k < 5.5 && p.t - lastK >= 3600) { p.dispatch({ type: 'drug.bolus', drug: 'potassiumChloride', amount: 20 }); lastK = p.t; } if (!g10 && p.lytes.glucose < 14) { p.dispatch({ type: 'drug.infusion', drug: 'glucose', rate: 125 * 0.1 / 60 }); g10 = true; } if (Math.round(p.t) % 3600 === 0) p.dispatch({ type: 'lab.order', kind: 'ketones' }); }
      return p;
    }
    case 'status_epilepticus': {                                                                     // O2, IM midazolam, IV line, glucose, lorazepam at 6 min, levetiracetam at 11 min, propofol at 25 min
      runScript(p, [[10, { type: 'o2.mask', fio2: 0.85, seal: 0.9 }], [30, { type: 'drug.bolus', drug: 'midazolam', amount: 10, route: 'im' }], [60, { type: 'iv.access' }], [90, { type: 'lab.order', kind: 'abg' }]], 360);
      if (p.crises.se.active) p.dispatch({ type: 'drug.bolus', drug: 'lorazepam', amount: 4 });
      p.run(300); if (p.crises.se.active) p.dispatch({ type: 'drug.bolus', drug: 'levetiracetam', amount: 4500 });
      p.run(840); if (p.crises.se.active) { p.dispatch({ type: 'drug.bolus', drug: 'propofol', amount: 150 }); p.dispatch({ type: 'drug.infusion', drug: 'propofol', rate: 8 }); p.dispatch({ type: 'airway.set', device: 'jaw_thrust' }); }
      p.run(2700 - p.t); return p;
    }
    case 'copd_exacerbation':                                                                        // Venturi 28 %, salbutamol + ipratropium, steroid, gas, BiPAP
    {
      runScript(p, [[30, { type: 'o2.mask', fio2: 0.28, seal: 1 }], [60, { type: 'drug.bolus', drug: 'salbutamol', amount: 5 }], [70, { type: 'drug.bolus', drug: 'ipratropium', amount: 0.5 }], [90, { type: 'iv.access' }],
        [120, { type: 'drug.bolus', drug: 'hydrocortisone', amount: 200 }], [180, { type: 'lab.order', kind: 'abg' }]], 240);
      let fio2 = 0.28, niv = false, sal2 = false;
      while (p.t < 5400) {                                                // titrate oxygen to SpO2 88-92 % every minute; BiPAP at 20 min; second nebuliser at 40 min
        p.run(60);
        const s = p.resp.spo2, next = s > 92 ? Math.max(0.21, fio2 - 0.02) : s < 88 ? Math.min(0.40, fio2 + 0.02) : fio2;
        if (!niv && p.t >= 1200) { niv = true; fio2 = next; p.dispatch({ type: 'niv.set', mode: 'bipap', ipap: 18, epap: 5, fio2 }); continue; }
        if (!sal2 && p.t >= 2400) { sal2 = true; p.dispatch({ type: 'drug.bolus', drug: 'salbutamol', amount: 5 }); }
        if (next !== fio2) { fio2 = next; p.dispatch(niv ? { type: 'niv.set', mode: 'bipap', ipap: 18, epap: 5, fio2 } : { type: 'o2.mask', fio2, seal: 1 }); }
      }
      return p;
    }
    case 'svt': {                                                                                    // 12-lead, modified Valsalva, adenosine 6 / 12 / 18 mg, cardioversion only as a last resort
      runScript(p, [[20, { type: 'iv.access' }], [40, { type: 'order', what: 'ecg12' }], [60, { type: 'procedure.vagal', technique: 'modified' }]], 90);
      for (const [t, mg] of [[90, 6], [150, 12], [210, 18]]) { if (p.arrest.key !== 'SVT') break; p.run(t - p.t); p.dispatch({ type: 'drug.bolus', drug: 'adenosine', amount: mg }); p.run(30); }
      if (p.arrest.key === 'SVT') runScript(p, [[p.t + 10, { type: 'drug.bolus', drug: 'midazolam', amount: 2 }], [p.t + 20, { type: 'defib.pads' }], [p.t + 25, { type: 'defib.mode', mode: 'sync' }], [p.t + 26, { type: 'defib.setEnergy', energy: 100 }], [p.t + 27, { type: 'defib.charge' }], [p.t + 32, { type: 'defib.shock' }]], p.t + 40);
      p.run(1200 - p.t); return p;
    }
    case 'hyperkalaemia':                                                                            // ECG, calcium, insulin-glucose, salbutamol, recheck, glucose infusion against hypoglycaemia
      runScript(p, [[20, { type: 'iv.access' }], [40, { type: 'order', what: 'ecg12' }], [60, { type: 'drug.bolus', drug: 'calciumGluconate', amount: 3000 }], [120, { type: 'drug.bolus', drug: 'insulin', amount: 10 }],
        [125, { type: 'drug.bolus', drug: 'glucose', amount: 25 }], [150, { type: 'drug.bolus', drug: 'salbutamol', amount: 10 }], [600, { type: 'drug.infusion', drug: 'glucose', rate: 50 * 0.1 / 60 }], [1800, { type: 'lab.order', kind: 'abg' }]], 3600);
      return p;
    case 'hypoglycaemia':                                                                            // check, IV glucose 20 g, recheck, glucose 10 % infusion
      runScript(p, [[20, { type: 'lab.order', kind: 'cbg' }], [60, { type: 'iv.access' }], [90, { type: 'drug.bolus', drug: 'glucose', amount: 20 }], [600, { type: 'lab.order', kind: 'cbg' }],
        [660, { type: 'drug.infusion', drug: 'glucose', rate: 150 * 0.1 / 60 }], [1800, { type: 'lab.order', kind: 'cbg' }]], 2700);
      return p;
    case 'mobitz_brady':                                                                             // ECG, pads, atropine, then pacing with analgesia
      runScript(p, [[20, { type: 'defib.pads' }], [30, { type: 'iv.access' }], [45, { type: 'order', what: 'ecg12' }], [60, { type: 'drug.bolus', drug: 'atropine', amount: 500 }],
        [300, { type: 'drug.bolus', drug: 'fentanyl', amount: 50 }], [330, { type: 'pacing.set', on: true, rate: 70, mA: 100 }]], 1500);
      return p;
    case 'torsades':                                                                                 // pads, magnesium on the long QT, isoprenaline, then ALS for any run
      runScript(p, [[15, { type: 'defib.pads' }], [25, { type: 'order', what: 'ecg12' }], [40, { type: 'drug.bolus', drug: 'magnesium', amount: 2 }], [55, { type: 'drug.infusion', drug: 'isoprenaline', rate: 5 }]], 60);
      return aclsTeam(p, { endT: 1500, reaction: 5 });
    default: throw new Error('no expert for ' + id);
  }
}

/** A learner who does nothing for the whole scenario. */
export function idleRun(p, id, endT) {
  return p.run((endT ?? p.scenario.durationS) - p.t);
}

/** A competent sonographer: the five views in order, the measurements as the image shows them, then the report. */
export function echoExpert(p, endT) {
  for (const view of ECHO_VIEWS) {
    p.run(25);
    p.dispatch({ type: 'echo.view', view, quality: 0.9 });
    const s = echoState(p), what = { a4c: ['tapse'], plax: ['lvef'], ivc: ['ivc_max', 'ivc_min'], subcostal: s.effusionMm > 1 ? ['effusion'] : [] }[view] || [];
    for (const w of what) p.dispatch({ type: 'echo.measure', what: w, value: Math.round(measureTruth(s, w)) });
  }
  p.run(20);
  p.dispatch({ type: 'echo.report', ...reportTruth(echoState(p)) });
  return p.run((endT ?? p.scenario.durationS) - p.t);
}
