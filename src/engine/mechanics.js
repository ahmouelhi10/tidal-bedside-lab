// Respiratory mechanics during controlled ventilation: the single-compartment equation of motion
//   Paw = PEEP + PEEPi + V / Crs + Rrs * flow
// applied to volume-controlled, constant-flow breaths. It is computed from the current patient state and NEVER feeds back
// into gas exchange, so it changes no trajectory and no replay hash: the ventilator simply reads the mechanics it would
// measure. All constants not taken from a paper are tagged REF design and listed in docs/VALIDATION.md.
import { clamp } from './util.js';

/** Anaesthetised, paralysed adults: total respiratory elastance ~23.5-25.5 cmH2O/L (compliance ~40 mL/cmH2O) and tissue/airway
 *  resistance ~2 cmH2O.s/L (REF anesth_impedance1990). Scaled to lung size with predicted body weight (REF design, REF ardsnet2000). */
const CRS_REF = 42, PBW_REF = 70;                     // mL/cmH2O at 70 kg PBW
const R_LUNG = 2.0;                                    // cmH2O.s/L (REF anesth_impedance1990)
const ETT_K1 = 1.0, ETT_K2 = 5.0;                      // tracheal tube, Rohrer form R = K1 + K2 * flow; flow-dependent tube resistance is large under anaesthesia (REF design, to be sourced per tube size)
const MASK_R = 1.5;                                    // face mask / supraglottic device resistance (REF design)
const IE = 0.5;                                        // I:E 1:2 (REF design, usual default)

/** Compliance factors from conditions the engine already models. */
function complianceOf(p) {
  const b = p.body;
  let c = CRS_REF * (b.pbw / PBW_REF);
  c *= 1 - 0.45 * clamp((b.bmi - 25) / 25, 0, 1);      // morbid obesity roughly halves lung compliance (55 vs 107 mL/cmH2O; REF pelosi1996); total Crs scaled ~-45% at BMI 50 (REF design)
  c *= 1 - 0.30 * clamp(p.resp.atel, 0, 1);            // atelectasis removes recruitable units (REF design)
  c *= clamp(0.4 + 0.6 * p.chest.vaMult, 0.2, 1);      // pneumothorax: collapsed lung and raised pleural pressure (REF design)
  if (p.tube?.mainstem) c *= 0.55;                     // endobronchial (one-lung) intubation (REF design)
  return Math.max(5, c);
}

function resistanceOf(p, flowLs) {
  let r = R_LUNG;
  if (p.airway.intubated || p.airway.device === 'ett') {
    r += ETT_K1 + ETT_K2 * Math.abs(flowLs);
    const s = p.tube?.secr ? Math.max(p.tube.secr.trachea, p.tube.secr.R, p.tube.secr.L) : 0;
    r += 8 * s;                                        // secretions narrow the lumen (REF design)
    if (p.tube?.scopeIn) r += 4;                       // a bronchoscope in the tube occupies much of its lumen (REF design)
  } else r += MASK_R;
  return r;
}

/** Mechanics of the current controlled breath, or null when the patient is not on controlled ventilation. */
export function mechanics(p) {
  const v = p.vent;
  if (!v || v.mode !== 'ctrl' || !(v.rate > 0) || !(v.vt > 0)) return null;
  const rr = v.rate, vtL = v.vt / 1000, peep = v.peep ?? 0;
  const tTot = 60 / rr, ti = tTot * IE / (1 + IE), te = tTot - ti;
  const flow = vtL / ti;                                // L/s, constant inspiratory flow
  const crs = complianceOf(p), cL = crs / 1000;         // mL/cmH2O and L/cmH2O
  const rrs = resistanceOf(p, flow);
  // expiratory time constant: passive expiration through the tube, whose resistance depends on the flow it carries;
  // solved as a fixed point on the early expiratory flow (VT / tau), plus the expiratory limb and valve (REF design)
  let tau = 0.3;
  for (let i = 0; i < 12; i++) { const fe = vtL / tau; tau = 0.5 * tau + 0.5 * (resistanceOf(p, fe * 0.5) + 1.5) * cL; }
  const k = Math.exp(-te / tau);
  const trapped = vtL * k / (1 - k);                    // end-expiratory volume above the relaxed volume (dynamic hyperinflation)
  const peepi = trapped / cL;                           // intrinsic PEEP (cmH2O)
  const dp = vtL / cL;                                  // driving pressure
  const pplat = peep + peepi + dp, ppeak = pplat + rrs * flow;
  const mpaw = peep + peepi + 0.5 * (ppeak - peep - peepi) * (ti / tTot);   // constant-flow approximation of the mean airway pressure (REF textbook)
  return { rr, vt: v.vt, peep, crs: +crs.toFixed(1), rrs: +rrs.toFixed(1), flow: +(flow * 60).toFixed(1), ti: +ti.toFixed(2), te: +te.toFixed(2), tau: +tau.toFixed(2),
    peepi: +peepi.toFixed(1), dp: +dp.toFixed(1), pplat: +pplat.toFixed(1), ppeak: +ppeak.toFixed(1), mpaw: +mpaw.toFixed(1) };
}

/** Pressure (cmH2O), flow (L/min, + inspiration) and volume (mL) at time s into the breath, for the ventilator curves. */
export function waveAt(m, s) {
  const tTot = m.ti + m.te, x = ((s % tTot) + tTot) % tTot, flowLs = m.flow / 60, cL = m.crs / 1000;
  if (x < m.ti) { const vol = flowLs * x; return { p: m.peep + m.peepi + vol / cL + m.rrs * flowLs, f: m.flow, v: vol * 1000 }; }
  const e = x - m.ti, vol = (m.vt / 1000) * Math.exp(-e / m.tau);
  return { p: m.peep + m.peepi * Math.exp(-e / m.tau), f: -(vol / m.tau) * 60, v: vol * 1000 };
}
