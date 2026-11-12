// Inhaled anaesthetics: sevoflurane, isoflurane, desflurane (one vaporiser, one agent at a time) and nitrous oxide (its own
// flowmeter). Dial -> inspired fraction -> alveolar (end-tidal) -> blood -> tissue groups, and back out through the lungs.
// Partial pressures are in % of one atmosphere (vol %). Pure, deterministic, no random draws.
//
// Uptake model (perfusion-limited compartments, REF eger1974):
//   FRC . dFA/dt = VA . (FI - FA) - Q . lambda_bg . (FA - Fv)
//   V_i . lambda_ti . dP_i/dt = q_i . Q . (FA - P_i)          (tissue/blood partition lambda_ti, blood flow fraction q_i)
// The vessel-rich group (brain, heart, viscera) stands for the effect site (time constant ~3 min for sevoflurane).
// High fresh-gas flow: the inspired fraction equals the dial (no rebreathing), times the share that reaches the patient.
import { clamp } from './util.js';

/** Agent constants. MAC at 40 years (REF label_sevoflurane 2.05 %, label_isoflurane 1.15 % at ~44, label_desflurane 6.0 % at
 *  ~45, mapleson1996 nitrous oxide 104 %), falling ~6 % per decade (REF mapleson1996). Blood/gas and tissue/blood partition
 *  coefficients (vessel-rich, muscle, fat) are textbook values (REF eger1974). Desflurane and isoflurane are pungent:
 *  airway irritation with a face mask (REF label_desflurane). Volatile agents trigger malignant hyperthermia, nitrous oxide
 *  does not (REF hopkins2021). */
export const AGENTS = Object.freeze({
  sevoflurane: Object.freeze({ mac40: 2.05, lbg: 0.65, ltb: [1.7, 3.1, 48], maxDial: 8, volatile: true, pungent: false }),
  isoflurane: Object.freeze({ mac40: 1.17, lbg: 1.4, ltb: [1.6, 2.9, 45], maxDial: 5, volatile: true, pungent: true }),
  desflurane: Object.freeze({ mac40: 6.2, lbg: 0.42, ltb: [1.3, 2.0, 27], maxDial: 18, volatile: true, pungent: true }),
  n2o: Object.freeze({ mac40: 104, lbg: 0.47, ltb: [1.1, 1.2, 2.3], maxDial: 70, volatile: false, pungent: false }),
});
export const VAPOURS = Object.freeze(['sevoflurane', 'isoflurane', 'desflurane']);
/** Tissue groups for a 70-kg adult: volume (L) and share of cardiac output (REF eger1974). */
export const GROUPS = Object.freeze([{ id: 'vrg', v: 6.0, qf: 0.75 }, { id: 'mus', v: 33.0, qf: 0.18 }, { id: 'fat', v: 14.5, qf: 0.055 }]);
/** Kept for callers that only know sevoflurane. */
export const SEVO = Object.freeze({ mac40: AGENTS.sevoflurane.mac40, lambdaBG: AGENTS.sevoflurane.lbg, maxDial: AGENTS.sevoflurane.maxDial });
export const macOf = (agent, age) => AGENTS[agent].mac40 * Math.pow(10, -0.00269 * ((age ?? 40) - 40));
export const macSevo = (age) => macOf('sevoflurane', age);

export class Volatile {
  constructor(body) {
    this.age = body.age; this.scale = body.weightKg / 70;
    this.agent = 'sevoflurane';                                   // agent in the vaporiser
    this.st = Object.fromEntries(Object.keys(AGENTS).map(k => [k, { dial: 0, fi: 0, fa: 0, p: [0, 0, 0], on: false }]));
    this.slowDes = 0; this.desSurge = 0;                         // desflurane: lagged end-tidal and the sympathetic response to a fast rise
    this.dilution = 0;                                           // alveolar oxygen dilution by nitrous oxide leaving the blood (diffusion hypoxia)
    this.irritation = 0;                                         // airway irritation by a pungent agent through a mask (0..1)
  }
  // ---- the vaporiser agent (compatibility with the single-agent interface)
  get dial() { return this.st[this.agent].dial; }
  get fi() { return this.st[this.agent].fi; }
  get fa() { return this.st[this.agent].fa; }
  set fa(v) { this.st[this.agent].fa = v; }
  get p() { return this.st[this.agent].p; }
  set p(v) { this.st[this.agent].p = v; }
  get mac() { return macOf(this.agent, this.age); }
  get etMac() { return this.fa / this.mac; }
  // ---- totals
  /** brain partial pressure of the volatile agents as a MAC multiple */
  get macFrac() { return VAPOURS.reduce((s, k) => s + this.st[k].p[0] / macOf(k, this.age), 0); }
  get n2oMac() { return this.st.n2o.p[0] / macOf('n2o', this.age); }
  /** end-tidal MAC of everything inhaled (MAC values add, REF textbook) */
  get totalEtMac() { return Object.keys(AGENTS).reduce((s, k) => s + this.st[k].fa / macOf(k, this.age), 0); }
  get n2oFi() { return this.st.n2o.fi; }
  /** vaporiser: one agent at a time; choosing another agent closes the first */
  set(percent, agent = this.agent) {
    if (!VAPOURS.includes(agent)) return false;
    if (agent !== this.agent) { this.st[this.agent].dial = 0; this.agent = agent; }
    const s = this.st[agent]; s.dial = clamp(percent, 0, AGENTS[agent].maxDial); if (s.dial > 0) s.on = true; return true;
  }
  setN2O(percent) { const s = this.st.n2o; s.dial = clamp(percent, 0, AGENTS.n2o.maxDial); if (s.dial > 0) s.on = true; }
  /** ctx: { delivered (0..1 share of the dial reaching the patient), va (L/min alveolar ventilation), q (L/min cardiac output),
   *  frc (L), secured (tube or supraglottic airway) } */
  step(dt, ctx) {
    const m = dt / 60, Q = Math.max(0, ctx.q), frc = Math.max(1.0, ctx.frc), va = Math.max(0, ctx.va), share = clamp(ctx.delivered || 0, 0, 1);
    let n2oOut = 0, irr = 0;
    for (const [k, s] of Object.entries(this.st)) {
      if (!s.on) continue;
      const A = AGENTS[k], L = A.lbg;
      s.fi = s.dial * share;
      let fv = 0, qs = 0;
      for (let i = 0; i < GROUPS.length; i++) { fv += GROUPS[i].qf * s.p[i]; qs += GROUPS[i].qf; }
      fv += (1 - qs) * s.fa;                                      // remaining flow (shunt, other tissue) returns at the arterial value
      const n = 4, h = m / n;                                     // the lung equilibrates within seconds: sub-steps keep the explicit integration stable
      for (let j = 0; j < n; j++) s.fa = Math.max(0, s.fa + h * (va * (s.fi - s.fa) - Q * L * (s.fa - fv)) / frc);
      for (let i = 0; i < GROUPS.length; i++) s.p[i] += m * GROUPS[i].qf * Q * (s.fa - s.p[i]) / (GROUPS[i].v * this.scale * A.ltb[i]);
      if (k === 'n2o') n2oOut = Math.max(0, Q * L * (fv - s.fa) / 100);   // L/min of nitrous oxide entering the alveoli from the blood
      if (A.pungent && !ctx.secured) irr = Math.max(irr, clamp((s.fi / macOf(k, this.age) - 0.8) / 0.7, 0, 1));
    }
    // diffusion hypoxia: when nitrous oxide is stopped it floods out of the blood and dilutes alveolar oxygen for ~5-10 min
    // (REF fink1955; size REF design)
    this.dilution = va > 0.2 ? clamp(n2oOut / va, 0, 0.5) : 0;
    this.irritation = irr;
    const d = this.st.desflurane;
    this.slowDes += (d.fa - this.slowDes) * (1 - Math.exp(-m / 3));
    this.desSurge = clamp((d.fa - this.slowDes) / macOf('desflurane', this.age), 0, 1);   // a fast rise of desflurane above ~1 MAC raises heart rate and BP (REF label_desflurane, weiskopf1994)
  }
  hashVec() { return [Object.keys(AGENTS).indexOf(this.agent), this.slowDes, ...Object.values(this.st).flatMap(s => [s.dial, s.fi, s.fa, ...s.p])]; }
}
