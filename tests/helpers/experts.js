// Scripted "expert" and "idle" learners for each scenario. They are used by the scenario tests to prove that
// (a) the scoring rewards guideline-concordant care, (b) doing nothing is scored poorly, and (c) the physiology
// responds to the interventions the scoring rewards (i.e. scoring is not decorative).
import { aclsTeam, runScript } from './bots.js';

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
    default: throw new Error('no expert for ' + id);
  }
}

/** A learner who does nothing for the whole scenario. */
export function idleRun(p, id, endT) {
  return p.run((endT ?? p.scenario.durationS) - p.t);
}
