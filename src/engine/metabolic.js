// Ketosis and insulin: diabetic ketoacidosis (DKA) and the fixed-rate insulin infusion that treats it. Insulin deficiency makes
// the liver release glucose and ketone bodies; ketoacids use up bicarbonate (a high-anion-gap acidosis); glucose above the
// renal threshold drags water into the urine (osmotic diuresis). A fixed-rate insulin infusion (0.1 U/kg/h) stops ketogenesis,
// lowers glucose and shifts potassium into cells; glucose 10 % is added once glucose falls below 14 mmol/L so the insulin can
// keep clearing the ketones (REF jbds2023). Deterministic, no random draws. Rates are REF design, calibrated to the JBDS
// treatment targets in tests/dka.test.js (ketones down >= 0.5 mmol/L/h, glucose down ~3-6 mmol/L/h).
import { clamp } from './util.js';

/** Measured beta-hydroxybutyrate stands for ~40 % of the ketoacid load (acetoacetate and other anions make up the rest), so each
 *  mmol/L of capillary ketones lowers HCO3- by ~2.5 mmol/L (REF design, calibrated to the JBDS severity bands: ketones > 6 with
 *  HCO3 < 5 is severe). */
export const KETO_HCO3 = 2.5;
const KETO_BASE = 0.2;                 // normal capillary beta-hydroxybutyrate (mmol/L)
const INS_HALF = 0.04;                 // U/kg/h of insulin giving half of the maximal effect (0.1 U/kg/h -> ~0.7)
const INS_TAU_MIN = 30;                // time to reach the effect of a new infusion rate (min)
const KETO_PROD = 0.010, KETO_CLEAR0 = 0.0015, KETO_CLEAR_INS = 0.0025;   // per min
const K_URINE = 0.00012;                                                   // mmol/L/min of plasma K lost per mmol/L of glucose above 10 (REF design)
const HGO = 0.05, UPTAKE = 0.0035, RENAL = 0.0015;                         // glucose: hepatic output, insulin-driven uptake, renal loss (per min)

export class Ketosis {
  constructor(spec, body) {
    this.weightKg = body.weightKg;
    this.drive = spec.dka ? 1 : 0;                     // insulin deficiency (type 1 diabetes, missed insulin, illness)
    this.ketones = spec.ketones ?? (spec.dka ? 5 : KETO_BASE);
    this.rate = 0;                                     // insulin infusion, U/min
    this.eff = 0;                                      // insulin effect 0..1
    this.gluRate = 0;                                  // glucose infusion, g/min
  }
  setInsulin(uPerMin) { this.rate = clamp(uPerMin, 0, 1); }
  setGlucose(gPerMin) { this.gluRate = clamp(gPerMin, 0, 2); }
  /** U/kg/h being infused */
  get uPerKgH() { return this.rate * 60 / this.weightKg; }
  /** bicarbonate used up by the ketoacids (mmol/L) */
  get hco3Loss() { return KETO_HCO3 * Math.max(0, this.ketones - KETO_BASE); }
  /** lytes: Electrolytes (glucose and the insulin potassium shift are kept there) */
  step(dt, lytes) {
    const m = dt / 60, x = this.uPerKgH;
    if (this.rate === 0 && this.eff === 0 && this.drive === 0 && this.gluRate === 0) return;
    this.eff += (x / (x + INS_HALF) - this.eff) * (1 - Math.exp(-m / INS_TAU_MIN));
    const def = this.drive * (1 - this.eff);
    this.ketones = Math.max(0.05, this.ketones + (KETO_PROD * def - (KETO_CLEAR0 + KETO_CLEAR_INS * this.eff) * this.ketones) * m);
    const g = lytes.glucose;
    lytes.gluBase = clamp(lytes.gluBase + (HGO * def - UPTAKE * this.eff * Math.max(0, g - 3) - RENAL * Math.max(0, g - 10)) * m, 1.5, 60);
    if (this.gluRate > 0) lytes.glucoseGrams(this.gluRate * m);
    // insulin moves potassium into the cells: ~0.9 mmol/L at a full effect, held while the infusion runs (REF jbds2023: K falls)
    lytes.insTarget = Math.max(lytes.insTarget, 0.9 * this.eff);
    // the osmotic diuresis carries potassium away: total-body K falls although the acidosis keeps the plasma value up (REF jbds2023)
    lytes.kBase = Math.max(1.8, lytes.kBase - K_URINE * Math.max(0, g - 10) * m * 70 / this.weightKg);
  }
  hashVec() { return [this.drive, this.ketones, this.rate, this.eff, this.gluRate]; }
}
