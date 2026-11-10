// Plasma electrolytes and glucose: potassium, sodium, ionised calcium and glucose. These are reported values that
// interventions move; they do not yet feed back into the rhythm or the circulation (the hyperkalaemic arrest stays
// driven by the arrest cause in cpr.js). Deterministic: no random draws, so adding them never shifts the main stream.
import { clamp } from './util.js';

/** Healthy adult baseline (mmol/L), mid reference interval. REF textbook */
export const BASELINE = Object.freeze({ k: 4.2, na: 140, ica: 1.20, glucose: 5.5 });

/** Plasma potassium of a hyperkalaemic arrest scenario (above the 6.5 mmol/L emergency threshold). REF ers2021_special */
export const K_ARREST = 7.4;

/** Transcellular shift: plasma K rises as the metabolic pH falls. Mineral acidosis averages ~0.6 mmol/L per 0.1 pH and
 *  organic (lactic) acidosis much less (REF adrogue1981); 0.4 per 0.1 is applied to the metabolic pH component only. REF design */
export const K_PER_01_PH = 0.4;

/** Succinylcholine raises plasma K by ~0.5 mmol/L at 1 mg/kg in a normal patient, peak within ~5 min. REF label_succ_k */
export const SUX_K_RISE = 0.5;
const SUX_ABS_MIN = 1, SUX_OFF_MIN = 10;                             // rise and clearance time constants, min (REF design)
const SUX_PEAK_FRACTION = 0.774;                                     // peak of the two-compartment curve for these constants, so the peak equals SUX_K_RISE

/** Insulin 10 U IV (with 25 g glucose) lowers plasma K by ~0.6-1.0 mmol/L, starting in 10-20 min, peak 30-60 min, lasting
 *  4-6 h; hypoglycaemia is its main harm. REF harel2016 */
export const INSULIN_K_DROP = 0.95;                                 // target of the shift; with the decay below the drop at 60 min is ~0.8 mmol/L
const INSULIN_TAU_MIN = 15, INSULIN_OFF_MIN = 300;                       // onset and decay time constants, min. REF harel2016, design

/** Calcium chloride: 1 g = 6.8 mmol Ca2+ (MW 147, dihydrate); about half of plasma calcium is ionised. REF textbook */
const CA_MG_PER_MMOL = 147, IONISED_FRACTION = 0.5;

/** Citrate of each blood product unit chelates ionised Ca2+; the liver clears it in minutes, slower when cold.
 *  Hypocalcaemia is near universal in massive transfusion (REF giancarelli2016); drop per unit and clearance REF design */
const CITRATE_ICA_DROP = 0.07, CITRATE_TAU_MIN = 6;

/** 25 g of glucose (139 mmol) distributes in extracellular water (~0.2 L/kg); insulin clears it over tens of minutes. REF design */
const DEX_MMOL = 139, ECF_L_PER_KG = 0.2, DEX_TAU_MIN = 25, INSULIN_GLU_DROP = 2.0;

export class Electrolytes {
  constructor(spec, body) {
    const hk = (spec.causes || []).includes('hyperkalemia');
    this.kBase = spec.potassium ?? (hk ? K_ARREST : BASELINE.k);
    this.na = spec.sodium ?? BASELINE.na;
    this.icaBase = spec.ionisedCalcium ?? BASELINE.ica;
    this.gluBase = spec.glucose ?? BASELINE.glucose;
    this.weightKg = body.weightKg;
    this.suxGut = 0; this.sux = 0;               // succinylcholine K load: absorbing compartment and plasma excess (mmol/L)
    this.insTarget = 0; this.ins = 0;            // insulin-driven K shift: target and current (mmol/L lowered)
    this.dex = 0;                                // glucose excess from a dextrose bolus (mmol/L)
    this.citrate = 0;                            // ionised calcium bound by citrate (mmol/L)
    this.k = this.kBase; this.ica = this.icaBase; this.glucose = this.gluBase;
  }
  /** succinylcholine bolus, mg/kg of actual weight */
  succinylcholine(mgPerKg) { this.suxGut += SUX_K_RISE / SUX_PEAK_FRACTION * clamp(mgPerKg, 0, 2); }
  /** insulin 10 U with glucose 25 g (the procedure "treat hyperkalaemia") */
  insulinGlucose() { this.insTarget += INSULIN_K_DROP; this.dex += DEX_MMOL / (ECF_L_PER_KG * this.weightKg); }
  /** one unit of a citrated blood product */
  transfuse() { this.citrate += CITRATE_ICA_DROP; }

  /** ctx: {hco3, cacl2 (plasma calcium chloride, mg/L), coreC} */
  step(dt, ctx) {
    const m = dt / 60;
    const toPlasma = this.suxGut * (1 - Math.exp(-m / SUX_ABS_MIN));    // peak at ~2.5 min (REF label_succ_k, design)
    this.suxGut -= toPlasma; this.sux += toPlasma - this.sux * (1 - Math.exp(-m / SUX_OFF_MIN));
    this.ins += (this.insTarget - this.ins) * (1 - Math.exp(-m / INSULIN_TAU_MIN));
    this.insTarget *= Math.exp(-m / INSULIN_OFF_MIN);
    this.dex *= Math.exp(-m / DEX_TAU_MIN);
    this.citrate *= Math.exp(-m / (CITRATE_TAU_MIN * (ctx.coreC < 35 ? 2 : 1)));   // hypothermia slows hepatic citrate clearance (REF design)
    const pHmet = 6.1 + Math.log10(ctx.hco3 / (0.0307 * 40));            // metabolic pH: Henderson-Hasselbalch at PaCO2 40 (REF textbook)
    const shift = -K_PER_01_PH * (pHmet - 7.40) / 0.1;
    this.k = clamp(this.kBase + shift + this.sux - this.ins, 1.5, 9.5);
    this.ica = clamp(this.icaBase + IONISED_FRACTION * (ctx.cacl2 || 0) / CA_MG_PER_MMOL - this.citrate, 0.4, 2.0);
    const insGlu = INSULIN_GLU_DROP * this.ins / INSULIN_K_DROP;          // insulin lowers glucose in step with its potassium effect (REF design)
    this.glucose = clamp(this.gluBase + this.dex - insGlu, 1.0, 40);
  }
  hashVec() { return [this.suxGut, this.sux, this.insTarget, this.ins, this.dex, this.citrate]; }
}
