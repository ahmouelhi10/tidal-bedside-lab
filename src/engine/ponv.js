// Nausea and vomiting: postoperative (PONV) and from hypotension (spinal anaesthesia).
// Apfel simplified score: female sex, non-smoker, previous PONV or motion sickness, postoperative opioids; 0-4 risk factors give
// a 24-h PONV risk of about 10, 20, 40, 60 and 80 % (REF apfel1999). Each prophylactic antiemetic of a different class cuts the
// relative risk by about a quarter (REF apfel2004); rescue uses a class not already given (REF gan2020).
// Hypotension below about 80 % of baseline makes an awake patient nauseated, and correcting the pressure relieves it (REF
// carpenter1992, textbook). Vomiting is deterministic here: nausea above 0.4 fills an emesis integrator, each crossing is one
// episode (REF design). Vomiting while unconscious without a tracheal tube risks aspiration (REF textbook; size REF design).
import { clamp } from './util.js';

const hill = (c, c50, g = 1.5) => (c > 0 ? 1 / (1 + Math.pow(c50 / c, g)) : 0);
export const APFEL_RISK = Object.freeze([0.10, 0.20, 0.40, 0.60, 0.80]);
export const OPIOIDS = Object.freeze(['morphine', 'fentanyl', 'remifentanil', 'pethidine', 'sufentanil']);

export class Ponv {
  constructor(spec = {}) {
    this.pacu = !!spec.pacu;                            // recovery-room case: the postoperative drive is on
    this.factors = { female: spec.sex === 'F', nonSmoker: spec.smoker !== true, history: !!spec.ponvHistory };
    this.nausea = 0; this.acc = 0; this.vomits = []; this.aspirated = false; this.extra = 0;
  }
  /** Apfel factors, the postoperative-opioid factor counted once any opioid has been given (REF apfel1999). */
  apfel(drugs) {
    const opioid = drugs.log.some(d => OPIOIDS.includes(d.key)) || Object.keys(drugs.pk).some(k => OPIOIDS.includes(k) && drugs.ce(k) > 0);
    const f = this.factors, n = (f.female ? 1 : 0) + (f.nonSmoker ? 1 : 0) + (f.history ? 1 : 0) + (opioid ? 1 : 0);
    return { score: n, risk: APFEL_RISK[n], opioid };
  }
  /** Antiemetic protection 0..1 per class, from the effect-site concentrations (classes add, REF apfel2004; sizes REF design). */
  protection(drugs) {
    const ce = (k) => (drugs.pk[k] ? drugs.ce(k) : 0);
    return { ond: hill(ce('ondansetron'), 0.010), drop: hill(ce('droperidol'), 0.004), dex: hill(ce('dexamethasone'), 0.03) };
  }
  step(dt, ctx) {
    const m = dt / 60, { drugs, mapRatio = 1, suppressed = false, loc = false, protectedAirway = false, t = 0 } = ctx;   // suppressed: paralysed or under general anaesthesia
    this.extra *= Math.exp(-m / 30);
    const pr = this.protection(drugs), block = (1 - 0.65 * pr.ond) * (1 - 0.65 * pr.drop) * (1 - 0.4 * pr.dex);
    const post = this.pacu ? this.apfel(drugs).risk : 0;
    const hypo = clamp((0.8 - mapRatio) / 0.2, 0, 1);
    const target = !suppressed ? clamp((post + this.extra) * block + hypo * (1 - 0.3 * pr.ond), 0, 1) : 0;
    this.nausea += (target - this.nausea) * (1 - Math.exp(-m / 2));
    if (this.nausea > 0.4) this.acc += (this.nausea - 0.4) * m / 2.2; else this.acc = Math.max(0, this.acc - m / 20);
    let vomited = false;
    if (this.acc >= 1) { this.acc = 0; this.vomits.push(t); vomited = true; if (!protectedAirway && loc) this.aspirated = true; }
    return { vomited };
  }
  hashVec() { return [this.nausea, this.acc, this.vomits.length, this.aspirated ? 1 : 0, this.extra]; }
}
