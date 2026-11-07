// Procedure démarche: was each procedure done in the right order, with its preparation and its confirmation?
// Scored ONLY from the replay log (plus the flags a scenario set before t = 0), like every other criterion, so the
// server's replay gives the same result. Most checks are real engine events (monitoring, oxygen, drugs, devices).
// A few safety steps leave no physical trace (skin antisepsis, "stand clear", the pre-induction check-list): the
// learner declares them from the guided panel, which logs a `note` "guide <proc>: <step>". Those checks are
// flagged `declared` and carry a smaller share of the score.
//
// Weights and time thresholds are design values (REF design) built on the cited guideline sequences:
// RSI REF weingart2012, das2015; bronchoscopy REF design; defibrillation REF aha2025_part9; chest decompression and drain REF atls; front of neck REF das2015.

const evs = (p, type, pred = () => true) => p.log.filter(e => e.type === type && pred(e));
const firstT = (arr) => (arr.length ? arr[0].t : null);
const before = (p, type, t, pred) => evs(p, type, e => e.t <= t && (!pred || pred(e))).length > 0;
const declared = (p, proc, step, tMax = Infinity) => p.log.some(e => e.type === 'note' && e.t <= tMax && typeof e.text === 'string' && e.text.startsWith(`guide ${proc}: ${step}`) && !e.text.includes('(skipped)'));
const ramp = (x, full) => Math.max(0, Math.min(1, x / full));
/** a monitoring item was on before t: set by the scenario before the case started, or attached by the learner */
const monitoredBy = (p, item, t) => !!p.flags0?.[item] || before(p, 'monitor.attach', t, e => e.items?.[item]);
const INDUCTION = new Set(['propofol', 'etomidate', 'ketamine', 'midazolam']);
const NMB = new Set(['rocuronium', 'succinylcholine']);
const ANALGESIA = new Set(['fentanyl', 'remifentanil', 'ketamine']);

/** id -> { label, ref, anchor(p) -> t | null, checks: [{ id, label, w, declared?, frac(p, t, x) -> 0..1 }] } */
export const DEMARCHE = {
  rsi: {
    label: 'Intubation démarche: monitoring, IV, position, 3-min pre-oxygenation, paralysis time, EtCO2 confirmation, ventilation', ref: 'weingart2012',
    anchor: p => firstT(evs(p, 'airway.intubate')),
    ctx: (p, tA) => ({ tI: firstT(evs(p, 'drug.bolus', e => INDUCTION.has(e.drug) && e.t <= tA)) ?? tA }),
    checks: [
      { id: 'monitor', label: 'ECG and SpO2 on before induction', w: 1, frac: (p, t, x) => (monitoredBy(p, 'ecgLeads', x.tI) && monitoredBy(p, 'spo2Probe', x.tI) ? 1 : 0) },
      { id: 'iv', label: 'IV access before induction', w: 1, frac: (p, t, x) => (p.flags0?.ivAccess || before(p, 'iv.access', x.tI) ? 1 : 0) },
      { id: 'position', label: 'Head-up / ramped before induction', w: 1, frac: (p, t, x) => (before(p, 'position.set', x.tI, e => e.headUp) ? 1 : 0) },
      { id: 'preox', label: 'Pre-oxygenation FiO2 >= 0.9 for 3 min before induction', w: 2, frac: (p, t, x) => { const o = firstT(evs(p, 'o2.mask', e => e.fio2 >= 0.9 && e.t <= x.tI)); return o === null ? 0 : ramp(x.tI - o, 180); } },
      { id: 'nmb', label: 'Neuromuscular blocker given before laryngoscopy', w: 1, frac: (p, t) => (before(p, 'drug.bolus', t, e => NMB.has(e.drug)) ? 1 : 0) },
      { id: 'relaxed', label: 'Laryngoscopy only once fully paralysed (no attempt on a patient still moving)', w: 1,   // the engine notes every attempt refused for lack of relaxation (replayed identically)
        frac: (p) => (p.notes.some(n => n.text.startsWith('intubation attempted on a patient who is not paralysed')) ? 0 : 1) },
      { id: 'capno', label: 'Capnography to confirm the tube', w: 1, frac: (p, t) => (monitoredBy(p, 'capnography', t + 90) ? 1 : 0) },
      { id: 'vent', label: 'Controlled ventilation after the tube', w: 1, frac: (p, t) => (evs(p, 'vent.set', e => e.t >= t && e.settings?.mode === 'ctrl').length ? 1 : 0) },
      { id: 'prep', label: 'Pre-induction check-list (declared)', w: 0.5, declared: true, frac: (p, t, x) => (declared(p, 'rsi', 'prep', x.tI) ? 1 : 0) },
    ],
  },
  defib: {
    label: 'Defibrillation démarche: compress first, pads, charge during CPR, stand clear, resume CPR at once', ref: 'aha2025_part9',
    anchor: p => firstT(evs(p, 'defib.shock')),
    checks: [
      { id: 'cpr_first', label: 'Compressions started before the first shock', w: 1, frac: (p, t) => (before(p, 'cpr.start', t) || before(p, 'cpr.compress', t) ? 1 : 0) },
      { id: 'pads', label: 'Pads on before charging', w: 1, frac: (p) => { const c = firstT(evs(p, 'defib.charge')); return c !== null && (p.flags0?.padsOn || before(p, 'defib.pads', c)) ? 1 : 0; } },
      { id: 'charge_cpr', label: 'Charging while compressions continue', w: 2, frac: (p) => {
        const shocks = evs(p, 'defib.shock'); if (!shocks.length) return 0;
        let ok = 0;
        for (const s of shocks) {                                     // the charge that armed this shock, and was CPR running at that moment?
          const ch = evs(p, 'defib.charge', e => e.t <= s.t).pop(); if (!ch) continue;
          const last = p.log.filter(e => (e.type === 'cpr.start' || e.type === 'cpr.stop') && e.t <= ch.t).pop();
          if (last && last.type === 'cpr.start') ok++;
        }
        return ok / shocks.length;
      } },
      { id: 'clear', label: '"Stand clear, oxygen away" before each shock (declared)', w: 0.5, declared: true, frac: (p) => {
        const shocks = evs(p, 'defib.shock'); return shocks.filter(s => p.log.some(e => e.type === 'note' && e.t <= s.t && e.t >= s.t - 30 && typeof e.text === 'string' && e.text.startsWith('guide defib: clear'))).length / shocks.length;
      } },
      { id: 'resume', label: 'CPR resumed within 10 s of each shock (unless ROSC)', w: 2, frac: (p) => {
        const shocks = evs(p, 'defib.shock'); if (!shocks.length) return 0;
        let ok = 0;
        for (const s of shocks) {
          const rosc = p.arrest.events.some(e => e.type === 'rhythm' && e.t >= s.t && e.t <= s.t + 10 && !['VF', 'VT', 'VT_PULSELESS', 'PEA', 'ASYSTOLE'].includes(e.to));
          if (rosc || evs(p, 'cpr.start', e => e.t >= s.t && e.t <= s.t + 10).length) ok++;
        }
        return ok / shocks.length;
      } },
    ],
  },
  chest: {
    label: 'Chest decompression démarche: examine, prepare, decompress, reassess, analgesia before the drain', ref: 'atls',
    anchor: p => firstT(evs(p, 'procedure.needle_decompression')) ?? firstT(evs(p, 'procedure.chest_tube')),
    ctx: (p) => ({ tD: firstT(evs(p, 'procedure.chest_tube')) }),
    checks: [
      { id: 'exam', label: 'Chest examined (clinical or ultrasound) before acting', w: 2, frac: (p, t) => (before(p, 'exam.chest', t) || before(p, 'exam.pocus', t) ? 1 : 0) },
      { id: 'reassess', label: 'Reassessed within 2 min after decompression', w: 1, frac: (p, t) => (evs(p, 'exam.chest', e => e.t > t && e.t <= t + 120).length || evs(p, 'exam.pocus', e => e.t > t && e.t <= t + 120).length ? 1 : 0) },
      { id: 'analgesia', label: 'Analgesia given before the chest drain', w: 1, frac: (p, t, x) => (x.tD === null ? 0 : before(p, 'drug.bolus', x.tD, e => ANALGESIA.has(e.drug)) ? 1 : 0) },
      { id: 'asepsis', label: 'Site located and skin prepared (declared)', w: 0.5, declared: true, frac: (p, t) => (declared(p, 'needle', 'site', t) || declared(p, 'drain', 'site') ? 1 : 0) },
    ],
  },
  bronch: {
    label: 'Bronchoscopy démarche: FiO2 1.0 before the scope, capnography on, look then act, short look, re-check after moving the tube', ref: 'design',
    anchor: p => firstT(evs(p, 'bronch.insert')),
    checks: [
      { id: 'fio2', label: 'FiO2 >= 0.9 before the scope goes in', w: 2, frac: (p, t) => (before(p, 'vent.set', t, e => (e.settings?.fio2 ?? 0) >= 0.9) ? 1 : 0) },
      { id: 'capno', label: 'Capnography on during bronchoscopy', w: 1, frac: (p, t) => (monitoredBy(p, 'capnography', t) ? 1 : 0) },
      { id: 'look_first', label: 'Tube moved only while looking (scope in)', w: 2, frac: (p) => {
        const adj = evs(p, 'airway.tube_adjust'); if (!adj.length) return 1;
        const inAt = (t) => { const last = p.log.filter(e => (e.type === 'bronch.insert' || e.type === 'bronch.remove') && e.t <= t).pop(); return last && last.type === 'bronch.insert'; };
        return adj.filter(e => inAt(e.t)).length / adj.length;
      } },
      { id: 'short', label: 'Scope out within 3 min each time', w: 1, frac: (p) => {
        const ins = evs(p, 'bronch.insert'); return ins.filter(i => evs(p, 'bronch.remove', e => e.t >= i.t && e.t <= i.t + 180).length).length / ins.length;
      } },
    ],
  },
  fona: {
    label: 'Front-of-neck démarche: declare CICO, extend the neck, identify the membrane, confirm with EtCO2 and ventilate', ref: 'das2015',
    anchor: p => firstT(evs(p, 'procedure.cricothyroidotomy')),
    checks: [
      { id: 'declare', label: 'CICO declared before the incision', w: 1, frac: (p, t) => (before(p, 'order', t, e => e.what === 'declare_cico') ? 1 : 0) },
      { id: 'extend', label: 'Neck extended (patient flat)', w: 1, frac: (p, t) => { const last = evs(p, 'position.set', e => e.t <= t).pop(); return !last || !last.headUp ? 1 : 0; } },
      { id: 'identify', label: 'Membrane identified (palpation or ultrasound) or vertical incision', w: 2, frac: (p, t) => (before(p, 'exam.neck', t) || before(p, 'procedure.cricothyroidotomy', t, e => e.approach === 'vertical') ? 1 : 0) },
      { id: 'confirm', label: 'Capnography and controlled ventilation after access', w: 2, frac: (p, t) => (monitoredBy(p, 'capnography', p.t) ? 0.5 : 0) + (evs(p, 'vent.set', e => e.t >= t && e.settings?.mode === 'ctrl').length ? 0.5 : 0) },
    ],
  },
};

/** Score one procedure's démarche for a patient. null when the procedure was never performed (not applicable). */
export function scoreDemarche(p, id) {
  const d = DEMARCHE[id], t = d?.anchor(p); if (t == null) return null;
  const x = d.ctx ? d.ctx(p, t) : {};
  const steps = d.checks.map(c => ({ id: c.id, label: c.label, declared: !!c.declared, w: c.w, frac: Math.max(0, Math.min(1, c.frac(p, t, x))) }));
  const W = steps.reduce((s, c) => s + c.w, 0), frac = steps.reduce((s, c) => s + c.w * c.frac, 0) / W;
  const missed = steps.filter(s => s.frac < 1).map(s => s.label + (s.frac > 0 ? ` (${Math.round(s.frac * 100)}%)` : ''));
  return { frac, steps, detail: missed.length ? `missed: ${missed.join('; ')}` : 'every step in order' };
}
