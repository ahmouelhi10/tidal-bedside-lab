// Plasma electrolytes and glucose: potassium, sodium, ionised calcium and glucose. These are reported values that
// interventions move; they do not yet feed back into the rhythm or the circulation (the hyperkalaemic arrest stays
// driven by the arrest cause in cpr.js). Deterministic: no random draws, so adding them never shifts the main stream.
import { clamp } from './util.js';

/** Healthy adult baseline (mmol/L), mid reference interval. REF textbook */
export const BASELINE = Object.freeze({ k: 4.2, na: 140, ica: 1.20, glucose: 5.5, mg: 0.85 });

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

/** About half of plasma calcium is ionised (REF textbook). Calcium doses and concentrations are mmol of elemental calcium;
 *  CA_FULL_SHIELD_MMOL is the dose that gives full membrane protection (6.8 mmol = 10 mL of calcium chloride 10 %; REF design). */
const IONISED_FRACTION = 0.5;
export const CA_FULL_SHIELD_MMOL = 6.8;

/** Citrate of each blood product unit chelates ionised Ca2+; the liver clears it in minutes, slower when cold.
 *  Hypocalcaemia is near universal in massive transfusion (REF giancarelli2016); drop per unit and clearance REF design */
const CITRATE_ICA_DROP = 0.07, CITRATE_TAU_MIN = 6;

/** 25 g of glucose (139 mmol) distributes in extracellular water (~0.2 L/kg); insulin clears it over tens of minutes. REF design */
/** Potassium chloride runs over 60 min; ~0.1 mmol/L rise per 10 mmol in a 70-kg adult (REF textbook). Glucagon 1 mg: glucose
 *  +3-4 mmol/L at 15-30 min (REF textbook); time constants REF design */
/** Magnesium sulfate 2 g raises serum Mg by ~0.5 mmol/L at first, back towards baseline over hours (REF textbook; time constant REF design) */
const MG_MMOL_PER_G = 4.06, MG_TAU_MIN = 180;
const KCL_RUN_MIN = 60, KCL_RISE_PER_MMOL = 0.01, GCG_ONSET_MIN = 8, GCG_OFF_MIN = 25, GCG_GLU = 6.0;
const DEX_MMOL = 139, ECF_L_PER_KG = 0.2, DEX_TAU_MIN = 40, INSULIN_GLU_DROP = 4.0;   // 10 U alone takes a normal glucose to ~2 mmol/L within an hour (hypoglycaemia is the main harm, REF harel2016); size REF design

/** Calcium protects the heart against hyperkalaemia within minutes and for 30-60 min without lowering the K (REF ers2021_special):
 *  1 g of calcium chloride (or the treatment bundle) gives full protection, worth CA_SHIELD_K mmol/L on the membrane (REF design). */
export const CA_SHIELD_K = 1.5, CA_SHIELD_TAU_MIN = 40;
/** Arrest hazard of severe hyperkalaemia, per minute, from the membrane-effective K (REF design: rare below 7, minutes above 8). */
export const hyperkHazard = (kEff) => (kEff < 7.0 ? 0 : 0.05 * Math.exp(1.6 * (kEff - 7.0)));
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };

export class Electrolytes {
  constructor(spec, body) {
    const hk = (spec.causes || []).includes('hyperkalemia');
    this.kBase = spec.potassium ?? (hk ? K_ARREST : BASELINE.k);
    this.na = spec.sodium ?? BASELINE.na;
    // total body water: 60 % of weight in men, 50 % in women, 5 % less over 65 (REF adrogue2000)
    this.tbw = body.weightKg * ((spec.sex === 'F' ? 0.5 : 0.6) - (spec.age > 65 ? 0.05 : 0));
    this.na0 = this.na; this.naLow = this.na;   // starting value and the lowest value since, to judge the correction rate
    this.icaBase = spec.ionisedCalcium ?? BASELINE.ica;
    this.gluBase = spec.glucose ?? BASELINE.glucose;
    this.mgBase = spec.magnesium ?? BASELINE.mg; this.mgExtra = 0;   // serum magnesium (mmol/L) and the excess from magnesium sulfate
    this.weightKg = body.weightKg;
    this.suxGut = 0; this.sux = 0;               // succinylcholine K load: absorbing compartment and plasma excess (mmol/L)
    this.insTarget = 0; this.ins = 0;            // insulin-driven K shift: target and current (mmol/L lowered)
    this.dex = 0;                                // glucose excess from a dextrose bolus (mmol/L)
    this.citrate = 0;                            // ionised calcium bound by citrate (mmol/L)
    this.shield = 0;                             // calcium membrane protection 0..1
    this.kQueue = 0; this.kRate = 0;             // potassium chloride still to run (mmol) and its rate (mmol/min)
    this.gcg = 0; this.gcgEff = 0;               // glucagon given (mg, decaying) and its glycaemic effect
    this.k = this.kBase; this.ica = this.icaBase; this.glucose = this.gluBase;
  }
  /** succinylcholine bolus, mg/kg of actual weight */
  succinylcholine(mgPerKg) { this.suxGut += SUX_K_RISE / SUX_PEAK_FRACTION * clamp(mgPerKg, 0, 2); }
  /** insulin 10 U with glucose 25 g (the procedure "treat hyperkalaemia") */
  insulinGlucose() { this.insTarget += INSULIN_K_DROP; this.dex += DEX_MMOL / (ECF_L_PER_KG * this.weightKg); }
  /** one unit of a citrated blood product */
  transfuse() { this.citrate += CITRATE_ICA_DROP; }
  /** glucose bolus (g): 5.55 mmol/g in extracellular water (REF textbook) */
  glucoseGrams(g) { this.dex += g * 5.55 / (ECF_L_PER_KG * this.weightKg); }
  /** IV regular insulin (units), scaled from the 10 U effect (REF harel2016) */
  insulinUnits(u) { this.insTarget += INSULIN_K_DROP * clamp(u, 0, 50) / 10; }
  /** potassium chloride (mmol), run over 60 min: ~0.1 mmol/L per 10 mmol in a 70-kg adult (REF textbook) */
  potassiumMmol(mmol) { this.kQueue += clamp(mmol, 0, 40); this.kRate = this.kQueue / KCL_RUN_MIN; }
  /** magnesium sulfate (g): 4.06 mmol Mg2+ per g, spread in extracellular water, then into cells and the urine (REF textbook) */
  magnesiumGrams(g) { this.mgExtra += clamp(g, 0, 10) * MG_MMOL_PER_G / (ECF_L_PER_KG * this.weightKg); }
  get mg() { return this.mgBase + this.mgExtra; }
  /** an infused fluid mixes into total body water: the Adrogue-Madias change, applied as it runs (REF adrogue2000) */
  fluid(naMmolL, litres) { if (litres <= 0) return; this.na = (this.na * this.tbw + naMmolL * litres) / (this.tbw + litres); this.tbw += litres; }
  /** rise since the lowest value: the osmotic demyelination limit is 10 mmol/L in 24 h (REF spasovski2014) */
  get naRise() { return this.na - this.naLow; }
  /** glucagon (mg) */
  glucagonMg(mg) { this.gcg += clamp(mg, 0, 2); }
  /** calcium chloride bolus (mg) */
  /** IV calcium, mmol of elemental calcium (any salt). */
  calcium(mmol) { this.shield = Math.min(1, this.shield + clamp(mmol, 0, 3 * CA_FULL_SHIELD_MMOL) / CA_FULL_SHIELD_MMOL); }
  /** K as the heart feels it: calcium offsets part of the excess (it does not lower the plasma value) */
  get kEff() { return this.k - (this.k > 5.0 ? CA_SHIELD_K * this.shield : 0); }
  arrestHazard() { return hyperkHazard(this.kEff); }
  /** ECG shape from the effective K and ionised Ca: peaked T from 5.5, flat P and long PR from 6.5, wide QRS from 7, sine wave
   *  from 8.5; low K gives small T and U waves; low ionised Ca a long QT. Thresholds are the textbook sequence; the ECG
   *  correlates loosely with the measured K in real patients (REF montague2008), here it follows it smoothly (REF design). */
  ecg() {
    const k = this.kEff, lo = smooth(3.2, 2.2, k);
    return { tAmp: 1 + 1.6 * smooth(5.5, 7.0, k) - 0.6 * lo, tNarrow: smooth(5.5, 7.0, k), pAmp: 1 - smooth(6.5, 8.0, k), prS: 0.07 * smooth(6.5, 8.0, k),
      qrsWide: 1.8 * smooth(7.0, 8.5, k), sine: smooth(8.5, 9.4, k), u: lo, qt: 1 + 0.35 * smooth(1.05, 0.7, this.ica) };
  }

  /** ctx: {hco3, caMmolL (plasma rise in total calcium from IV calcium, mmol/L), coreC} */
  step(dt, ctx) {
    const m = dt / 60;
    const toPlasma = this.suxGut * (1 - Math.exp(-m / SUX_ABS_MIN));    // peak at ~2.5 min (REF label_succ_k, design)
    this.suxGut -= toPlasma; this.sux += toPlasma - this.sux * (1 - Math.exp(-m / SUX_OFF_MIN));
    this.ins += (this.insTarget - this.ins) * (1 - Math.exp(-m / INSULIN_TAU_MIN));
    this.insTarget *= Math.exp(-m / INSULIN_OFF_MIN);
    this.dex *= Math.exp(-m / DEX_TAU_MIN);
    this.naLow = Math.min(this.naLow, this.na);
    this.mgExtra *= Math.exp(-m / MG_TAU_MIN);
    if (this.kQueue > 0) { const d = Math.min(this.kQueue, this.kRate * m); this.kQueue -= d; this.kBase = Math.min(8.5, this.kBase + d * KCL_RISE_PER_MMOL * 70 / this.weightKg); }
    this.gcgEff += (this.gcg - this.gcgEff) * (1 - Math.exp(-m / GCG_ONSET_MIN)); this.gcg *= Math.exp(-m / GCG_OFF_MIN);
    this.shield *= Math.exp(-m / CA_SHIELD_TAU_MIN);
    this.citrate *= Math.exp(-m / (CITRATE_TAU_MIN * (ctx.coreC < 35 ? 2 : 1)));   // hypothermia slows hepatic citrate clearance (REF design)
    const pHmet = 6.1 + Math.log10(ctx.hco3 / (0.0307 * 40));            // metabolic pH: Henderson-Hasselbalch at PaCO2 40 (REF textbook)
    const shift = -K_PER_01_PH * (pHmet - 7.40) / 0.1;
    const beta2 = 0.6 * (ctx.salbutamol > 0 ? 1 / (1 + Math.pow(1.2 / ctx.salbutamol, 1.5)) : 0);   // nebulised salbutamol shifts K into cells, ~0.6 mmol/L (REF allon1989)
    this.k = clamp(this.kBase + shift + this.sux - this.ins - beta2, 1.5, 9.5);
    this.ica = clamp(this.icaBase + IONISED_FRACTION * (ctx.caMmolL || 0) - this.citrate, 0.4, 2.0);
    const insGlu = INSULIN_GLU_DROP * this.ins / INSULIN_K_DROP;          // insulin lowers glucose in step with its potassium effect (REF design)
    this.glucose = clamp(this.gluBase + this.dex + GCG_GLU * Math.min(1, this.gcgEff) - insGlu, 1.0, 40);
  }
  hashVec() { return [this.kBase, this.suxGut, this.sux, this.insTarget, this.ins, this.dex, this.citrate, this.shield, this.kQueue, this.kRate, this.gcg, this.gcgEff, this.mgBase, this.mgExtra, this.na, this.tbw, this.naLow]; }
}
