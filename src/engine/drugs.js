// Drug registry: pharmacokinetic model builders, pharmacodynamic mapping to physiology, and the DrugSystem state container.
// Dose units are PK amount units: mg for drugs reported in ug/mL, mcg for drugs reported in ng/mL (see DRUGS[key].unit / concUnit).
// Evidence: every model builder carries a `REF` id (references.js). ACLS/vasoactive PD values are UNVERIFIED design parameters.
import { PKModel } from './pk.js';
import { lbmJames } from './anthropometrics.js';
import { clamp, hill } from './util.js';

const sig = (x, e50, g) => Math.pow(x, g) / (Math.pow(x, g) + Math.pow(e50, g));
const expDec = (x, a) => Math.exp(a * x);

/** Al-Sallami fat-free mass as printed in the Eleveld 2017 supplement NONMEM code. REF eleveld2017 */
export function ffmAlSallami(sex, age, w, hCm) {
  const ht2 = (hCm / 100) ** 2;
  if (sex === 'F') { const mat = 1.11 - 0.11 / (1 + Math.pow(age / 7.1, -1.1)); return mat * 37.99 * ht2 * w / (35.98 * ht2 + w); }
  const mat = 0.88 + 0.12 / (1 + Math.pow(age / 13.4, -12.7));
  return mat * 42.92 * ht2 * w / (30.93 * ht2 + w);
}
/** James LBM is non-monotonic; devices clamp weight at the LBM maximum (BMI ~43 M / ~36 F). REF james1976, absalom2009 */
export function lbmJamesCapped(sex, w, hCm) {
  const [a, b] = sex === 'F' ? [1.07, 148] : [1.1, 128];
  const wPeak = (a * hCm * hCm) / (2 * b);
  return lbmJames(sex, Math.min(w, wPeak), hCm);
}

// ---------------------------------------------------------------- PK builders (return {V1,k10,k12,k21,k13,k31,ke0})
const fromClear = (V1, V2, V3, CL, Q2, Q3, ke0) => ({ V1, V2, V3, CL, Q2, Q3, k10: CL / V1, k12: Q2 / V1, k13: Q3 / V1, k21: Q2 / V2, k31: V3 > 0 ? Q3 / V3 : 0, ke0 });

export function propofolEleveld(b, { opioid = false } = {}) {                         // REF eleveld2018
  const W = b.weightKg, age = b.age, ffm = ffmAlSallami(b.sex, age, W, b.heightCm), ffmRef = ffmAlSallami('M', 35, 70, 170);
  const pma = age * 52 + 40, pmaRef = 1860;
  const V1 = 6.28 * sig(W, 33.6, 1) / sig(70, 33.6, 1);
  const V2 = 25.5 * (W / 70) * expDec(age - 35, -0.0156);
  const V3 = 273 * (ffm / ffmRef) * (opioid ? expDec(age, -0.0138) : 1);
  const CL = (b.sex === 'F' ? 2.10 : 1.79) * Math.pow(W / 70, 0.75) * (sig(pma, 42.3, 9.06) / sig(pmaRef, 42.3, 9.06)) * (opioid ? expDec(age, -0.00286) : 1);
  const q3mat = sig(pma, 68.3, 1) / sig(pmaRef, 68.3, 1);
  const Q3 = 1.11 * Math.pow(V3 / 273, 0.75) * q3mat;
  const Q2 = 1.75 * Math.pow(V2 / 25.5, 0.75) * (1 + 1.30 * (1 - q3mat));
  return fromClear(V1, V2, V3, CL, Q2, Q3, 0.146 * Math.pow(W / 70, -0.25));
}
export function propofolMarsh(b, ke0 = 0.26) {                                        // REF marsh1991 (k13 0.0419, k31 0.0033); ke0 1.2 = "modified Marsh"
  const W = b.weightKg;
  return { V1: 0.228 * W, k10: 0.119, k12: 0.112, k13: 0.0419, k21: 0.055, k31: 0.0033, ke0 };
}
export function propofolSchnider(b) {                                                 // REF schnider1998
  const { age, weightKg: W, heightCm: H } = b, lbm = lbmJamesCapped(b.sex, W, H);
  const V2 = 18.9 - 0.391 * (age - 53);
  return {
    V1: 4.27, k10: 0.443 + 0.0107 * (W - 77) - 0.0159 * (lbm - 59) + 0.0062 * (H - 177),
    k12: 0.302 - 0.0056 * (age - 53), k13: 0.196, k21: (1.29 - 0.024 * (age - 53)) / V2, k31: 0.0035, ke0: 0.456,
  };
}
export function remifentanilMinto(b) {                                                // REF minto1997 (concentrations ng/mL when dose in mcg)
  const { age } = b, lbm = lbmJamesCapped(b.sex, b.weightKg, b.heightCm);
  const V1 = 5.1 - 0.0201 * (age - 40) + 0.072 * (lbm - 55), V2 = 9.82 - 0.0811 * (age - 40) + 0.108 * (lbm - 55), V3 = 5.42;
  const CL1 = 2.6 - 0.0162 * (age - 40) + 0.0191 * (lbm - 55), CL2 = 2.05 - 0.0301 * (age - 40), CL3 = 0.076 - 0.00113 * (age - 40);
  return fromClear(V1, V2, V3, CL1, CL2, CL3, 0.595 - 0.007 * (age - 40));
}
export function remifentanilEleveld(b) {                                              // REF eleveld2017 (SE50 = 2.88 kg as in both libraries; unresolved ln-scale ambiguity)
  const { age, weightKg: W } = b, ffm = ffmAlSallami(b.sex, age, W, b.heightCm), ffmRef = ffmAlSallami('M', 35, 70, 170), size = ffm / ffmRef;
  const ag = s => Math.exp(s * (age - 35));
  const fsex = b.sex === 'F' ? 1 + 0.470 * sig(age, 12, 6) * (1 - sig(age, 45, 6)) : 1;
  const V1 = 5.81 * size * ag(-0.00554), V2 = 8.82 * size * ag(-0.00327) * fsex, V3 = 5.03 * size * ag(-0.0315) * Math.exp(-0.0260 * (W - 70));
  const fmat = sig(W, 2.88, 2) / sig(70, 2.88, 2);
  const CL = 2.58 * Math.pow(size, 0.75) * fmat * fsex * ag(-0.00327);
  const Q2 = 1.72 * Math.pow(V2 / 8.82, 0.75) * ag(-0.00554) * fsex, Q3 = 0.124 * Math.pow(V3 / 5.03, 0.75) * ag(-0.00554);
  return fromClear(V1, V2, V3, CL, Q2, Q3, 1.09 * Math.exp(-0.0289 * (age - 35)));
}
const fentanylShafer = () => ({ V1: 6.09, k10: 0.0827, k12: 0.471, k13: 0.225, k21: 0.102, k31: 0.006, ke0: 0.12 });   // REF opentiva
const ketamineDomino = b => ({ V1: 0.063 * b.weightKg, k10: 0.4381, k12: 0.5921, k13: 0.5900, k21: 0.2470, k31: 0.0146, ke0: 0.652 }); // REF opentiva
const midazolamAlbrecht = b => b.age < 65
  ? { V1: 7.9, k10: 0.399 / 7.9, k12: 0.19, k13: 0.065, k21: 0.06, k31: 0.0083, ke0: 0.11 }
  : { V1: 8.5, k10: 0.388 / 8.5, k12: 0.10, k13: 0.066, k21: 0.051, k31: 0.0069, ke0: 0.08 };                    // REF opentiva
const etomidateKaneda = () => ({ V1: 4.45, k10: 0.1416, k12: 0.7101, k13: 0, k21: 0.0422, k31: 0, ke0: 0.447 });  // REF opentiva
const rocuroniumWierda = b => ({ V1: 0.044 * b.weightKg, k10: 0.1, k12: 0.21, k13: 0.028, k21: 0.13, k31: 0.01, ke0: 0.107 }); // REF opentiva (library ke0; with c50 1.2 / gamma 3.5 gives 90% twitch depression at ~60 s for 1.2 mg/kg)
const succinylcholineEmpirical = (b, act = 1) => ({ V1: 0.065 * b.weightKg, k10: 1.0 * act, k12: 0, k13: 0, k21: 0.1, k31: 0, ke0: 0.3 }); // REF label_succ (hydrolysis reproduces "<2 ug/mL by 2.5 min"); design otherwise
const dexmedetomidineHannivoort = b => { const w = b.weightKg / 70, s = Math.pow(w, 0.75), V1 = 1.78 * w, V2 = 30.3 * w, V3 = 52 * w; return fromClear(V1, V2, V3, 0.686 * s, 2.98 * s, 0.602 * s, 0.0428); }; // REF opentiva
// single-compartment ACLS / vasoactive drugs (design values; REF design). Concentration in ng/mL when dose in mcg.
/** flumazenil: concentration (ng/mL) that halves the effective midazolam concentration (REF design: 0.5 mg reverses a sedating dose for ~45 min) */
const FLU_K = 3;
/** neostigmine: half-maximal effect (ng/mL) and the rocuronium C50 shift at full effect (REF design, calibrated: 50 mcg/kg takes a TOF count of 2 to a ratio >= 0.9 in 10-20 min (~15), not a deep block) */
const NEO_C50 = 15, NEO_SHIFT = 3;
/** sevoflurane hypnosis: potency in MAC multiples on the additive hypnotic scale (REF design, see effects()) */
const SEVO_HYP_C50 = 0.72, SEVO_HYP_G = 1.3;
const oneComp = (V1, tHalfMin, ke0 = 5) => ({ V1, k10: Math.LN2 / tHalfMin, k12: 0, k13: 0, k21: 0.1, k31: 0, ke0 });
/**
 * Peripheral IV bolus to central circulation transit (s). A drug that acts on first pass with a < 10 s half-life (adenosine)
 * blocks the AV node 17.5 +/- 1.0 s (mean +/- SEM, n = 10) after antecubital injection and 21.9 s after a hand vein (REF ng1999);
 * in healthy volunteers its heart-rate fall appears about 20 s after injection (REF watt1986). 15 s is the injection-to-central
 * plasma dead time, the rest being the response itself. Applied only to the single-compartment (design) drugs below: the published
 * PK-PD models (propofol, opioids, relaxants...) fitted their ke0 to the effect after a bolus, so their lag already contains it.
 */
export const IV_TRANSIT_S = 15;

/**
 * DRUGS: unit = dose unit; pk(b, ctx) -> params; pd = pharmacodynamic parameters (c50 in the concentration unit of the model).
 * `kind` drives the effect mapping in DrugSystem.effects().
 */
export const DRUGS = {
  propofol:       { name: 'Propofol', unit: 'mg', concUnit: 'ug/mL', ref: 'eleveld2018', kind: 'hypnotic', c50: 3.08, gamma: 2.5, ventC50: 1.16, ventGamma: 3, ventEmax: 0.97, hemoC50: 2.0, hemoGamma: 3 },   // ventC50 fitted to REF nieuwenhuijs2003: Ce 1 ug/mL depresses ventilation at a fixed PetCO2 of 55 mmHg by 44.3 +/- 3.9 % (gamma / Emax stay design)
  etomidate:      { name: 'Etomidate', unit: 'mg', concUnit: 'ug/mL', ref: 'opentiva', kind: 'hypnotic', c50: 0.40, gamma: 2.5, ventC50: 0.5, ventGamma: 3, ventEmax: 0.3, hemoC50: 0.5, hemoGamma: 2, hemoSvr: 0.05, hemoInot: 0.0 },
  ketamine:       { name: 'Ketamine', unit: 'mg', concUnit: 'ug/mL', ref: 'opentiva', kind: 'hypnotic', c50: 1.5, gamma: 3, ventC50: 3.0, ventGamma: 2, ventEmax: 0.15, symp: true },
  midazolam:      { name: 'Midazolam', unit: 'mg', concUnit: 'ug/mL', ref: 'opentiva', kind: 'hypnotic', c50: 0.58, gamma: 2.5, ventC50: 0.35, ventGamma: 2, ventEmax: 0.8, hemoC50: 0.4, hemoGamma: 2, hemoSvr: 0.10, hemoInot: 0.0, emax: 0.8 },   // hypnotic c50 REF design, calibrated with the age term in effects() to REF label_midazolam (IV induction in 2-2.5 min without premedication); ventEmax fitted to REF forster1980 / REF gross1991 (0.13-0.15 mg/kg lowers the CO2-response slope 29-33 %)
  dexmedetomidine:{ name: 'Dexmedetomidine', unit: 'mcg', concUnit: 'ng/mL', ref: 'opentiva', kind: 'hypnotic', c50: 3.0, gamma: 2, emax: 0.45, ventC50: 3, ventGamma: 2, ventEmax: 0.1, brady: 0.25, bradyC50: 0.6 },
  remifentanil:   { name: 'Remifentanil', unit: 'mcg', concUnit: 'ng/mL', ref: 'minto1997', kind: 'opioid', c50: 2.0, gamma: 2, ventC50: 0.92, ventGamma: 2, ventEmax: 0.98, brady: 0.25, svrDrop: 0.10 },
  fentanyl:       { name: 'Fentanyl', unit: 'mcg', concUnit: 'ng/mL', ref: 'opentiva', kind: 'opioid', c50: 2.0, gamma: 2, ventC50: 1.3, ventGamma: 2, ventEmax: 0.98, brady: 0.15, svrDrop: 0.05 },
  rocuronium:     { name: 'Rocuronium', unit: 'mg', concUnit: 'ug/mL', ref: 'opentiva', kind: 'nmb', c50: 1.2, gamma: 3.5 },
  succinylcholine:{ name: 'Succinylcholine', unit: 'mg', concUnit: 'ug/mL', ref: 'label_succ', kind: 'nmb', c50: 1.2, gamma: 3.0, fasc: true },
  sugammadex:     { name: 'Sugammadex', unit: 'mg', concUnit: 'ug/mL', ref: 'label_sugammadex', kind: 'reversal' },
  naloxone:       { name: 'Naloxone', transit: true, unit: 'mcg', concUnit: 'ng/mL', ref: 'design', kind: 'antagonist', kn: 1.0 },
  epinephrine:    { name: 'Epinephrine', transit: true, unit: 'mcg', concUnit: 'ng/mL', ref: 'aha2025_part9', kind: 'pressor', tHalf: 2.5, vPerKg: 0.15, a1C50: 6, b1C50: 1.5, chronoC50: 1.0, hrAdd: 60, svrEmax: 0.70, inotEmax: 0.9, venEmax: 0.15, escape: 20 },
  norepinephrine: { name: 'Norepinephrine', transit: true, unit: 'mcg', concUnit: 'ng/mL', ref: 'design', kind: 'pressor', tHalf: 2.5, vPerKg: 0.15, a1C50: 3, b1C50: 6, chronoC50: 8, hrAdd: 8, svrEmax: 1.2, inotEmax: 0.35, venEmax: 0.2 },
  phenylephrine:  { name: 'Phenylephrine', transit: true, unit: 'mcg', concUnit: 'ng/mL', ref: 'design', kind: 'pressor', tHalf: 5, vPerKg: 0.15, a1C50: 3.5, b1C50: 1e9, chronoC50: 1e9, hrAdd: 0, svrEmax: 0.9, inotEmax: 0, venEmax: 0.1 },
  vasopressin:    { name: 'Vasopressin', transit: true, unit: 'units', concUnit: 'units/L', ref: 'aha2025_part9', kind: 'pressor', tHalf: 14, vPerKg: 0.14, a1C50: 0.10, b1C50: 1e9, chronoC50: 1e9, hrAdd: 0, svrEmax: 0.7, inotEmax: 0, venEmax: 0, ineffectiveInArrest: true },
  atropine:       { name: 'Atropine', transit: true, unit: 'mcg', concUnit: 'ng/mL', ref: 'design', kind: 'vagolytic', tHalf: 150, vPerKg: 1.0, c50: 8.0, gamma: 2, hrAdd: 65, ke0: 0.65 },   // ke0 REF label_atropine: maximum heart rate 7-8 min after IV dosing (t_peak of Ce 7.7 min); dose-response REF design: 0.5 mg ~ +25, 1 mg ~ +45, 3 mg (full vagal block) ~ +55/min
  nitroglycerin:  { name: 'Nitroglycerin', transit: true, unit: 'mcg', concUnit: 'ng/mL', ref: 'design', kind: 'vasodilator', tHalf: 3, vPerKg: 0.5, c50: 2.0, venEmax: 0.35, svrEmax: 0.30 },
  amiodarone:     { name: 'Amiodarone', transit: true, unit: 'mg', concUnit: 'ug/mL', ref: 'aha2025_part9', kind: 'antiarrhythmic', tHalf: 600, vPerKg: 1.0, c50: 2.0, hypoSvr: 0.12 },
  lidocaine:      { name: 'Lidocaine', transit: true, unit: 'mg', concUnit: 'ug/mL', ref: 'aha2025_part9', kind: 'antiarrhythmic', tHalf: 100, vPerKg: 1.0, c50: 2.5, hypoSvr: 0 },
  adenosine:      { name: 'Adenosine', transit: true, unit: 'mg', concUnit: 'ug/mL', ref: 'label_adenosine', kind: 'av_block', tHalf: 0.17, vPerKg: 0.2 },   // t1/2 < 10 s in whole blood (REF label_adenosine); rhythm effect in Patient._adenosine
  calciumChloride:{ name: 'Calcium chloride', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'aha2025_part9', kind: 'inotrope', tHalf: 6, vPerKg: 0.2, c50: 25, inotEmax: 0.3, svrEmax: 0.15 },
  // ---- crisis, emergency and anaesthesia drugs (crises.js reads their concentrations). Single compartment with the
  //      half-life and volume of distribution of the label or a standard pharmacology text; potencies (c50) are design values
  //      calibrated to the clinical effect sizes tested in tests/crises.test.js (REF design, textbook unless another id is given).
  calciumGluconate:{ name: 'Calcium gluconate 10 %', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'ers2021_special', kind: 'inotrope', tHalf: 6, vPerKg: 0.2, c50: 77, inotEmax: 0.3, svrEmax: 0.15 },   // 1 g = 2.2 mmol Ca2+, a third of 1 g calcium chloride (6.8 mmol): 30 mL of 10 % ~ 10 mL of calcium chloride 10 % (REF ers2021_special, textbook)
  lorazepam:      { name: 'Lorazepam', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'label_lorazepam', kind: 'hypnotic', tHalf: 840, vPerKg: 1.3, ke0: 0.25, c50: 0.06, gamma: 2, emax: 0.6, ventC50: 0.08, ventGamma: 2, ventEmax: 0.5 },   // 4 mg IV (0.1 mg/kg); long anticonvulsant action; potencies REF design
  diazepam:       { name: 'Diazepam', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'label_diazepam', kind: 'hypnotic', tHalf: 60, vPerKg: 1.1, ke0: 1.0, c50: 0.25, gamma: 2, emax: 0.6, ventC50: 0.3, ventGamma: 2, ventEmax: 0.5 },   // fast onset, the anticonvulsant effect fades with redistribution (~20-30 min); tHalf is the redistribution phase (REF design)
  levetiracetam:  { name: 'Levetiracetam', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'esett2019', kind: 'none', tHalf: 420, vPerKg: 0.6, ke0: 0.1 },   // 60 mg/kg (max 4500 mg) over 10 min, second line (REF esett2019)
  ipratropium:    { name: 'Ipratropium (nebulised)', unit: 'mg', concUnit: 'mg', ref: 'gold2024', kind: 'bronchodilator', tHalf: 120, vPerKg: 1 / 80, c50: 0.25, hrAdd: 0, ke0: 0.4 },   // airway compartment like salbutamol; slower onset (REF textbook)
  prednisolone:   { name: 'Prednisolone', unit: 'mg', concUnit: 'n/a', ref: 'gold2024', kind: 'direct' },   // 30-40 mg for 5 days in a COPD exacerbation; no effect within the time of a case
  flumazenil:     { name: 'Flumazenil', transit: true, unit: 'mcg', concUnit: 'ng/mL', ref: 'label_flumazenil', kind: 'none', tHalf: 50, vPerKg: 1.0, ke0: 1.0 },   // benzodiazepine antagonist; half-life ~1 h, shorter than midazolam: re-sedation (REF label_flumazenil)
  neostigmine:    { name: 'Neostigmine', transit: true, unit: 'mcg', concUnit: 'ng/mL', ref: 'label_neostigmine', kind: 'none', tHalf: 77, vPerKg: 0.7, ke0: 0.15 },   // cholinesterase inhibitor; peak reversal ~10 min; cannot reverse a deep block (ceiling); muscarinic bradycardia unless an anticholinergic is given (REF label_neostigmine)
  potassiumChloride:{ name: 'Potassium chloride (over 1 h)', unit: 'mmol', concUnit: 'n/a', ref: 'textbook', kind: 'direct' },   // never a bolus: each dose runs over 60 min (peripheral maximum ~10-20 mmol/h)
  glucagon:       { name: 'Glucagon', unit: 'mg', concUnit: 'n/a', ref: 'textbook', kind: 'direct', routes: ['iv', 'im'] },   // 1 mg IM/IV raises glucose within 10-15 min when liver glycogen is present
  ephedrine:      { name: 'Ephedrine', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'label_ephedrine', kind: 'pressor', tHalf: 60, vPerKg: 3.0, a1C50: 0.03, b1C50: 0.025, chronoC50: 0.04, hrAdd: 14, svrEmax: 0.45, inotEmax: 0.55, venEmax: 0.25 },
  isoprenaline:   { name: 'Isoprenaline', transit: true, unit: 'mcg', concUnit: 'ng/mL', ref: 'erc2025', kind: 'pressor', tHalf: 2.5, vPerKg: 0.15, a1C50: 1e9, b1C50: 1.2, chronoC50: 1.2, hrAdd: 45, svrEmax: 0, inotEmax: 0.6, venEmax: 0, b2C50: 1.5, b2Svr: 0.30, escape: 30 },   // pure beta agonist; 5 mcg/min (REF erc2025 bradycardia algorithm) gives Css ~1.7 ng/mL; potencies REF design
  dobutamine:     { name: 'Dobutamine', transit: true, unit: 'mcg', concUnit: 'ng/mL', ref: 'label_dobutamine', kind: 'pressor', tHalf: 2, vPerKg: 0.2, a1C50: 1e9, b1C50: 70, chronoC50: 160, hrAdd: 25, svrEmax: 0, inotEmax: 0.9, venEmax: 0, b2C50: 120, b2Svr: 0.18 },
  salbutamol:     { name: 'Salbutamol (nebulised)', unit: 'mg', concUnit: 'mg', ref: 'gina2024', kind: 'bronchodilator', tHalf: 120, vPerKg: 1 / 80, c50: 1.2, hrAdd: 14, ke0: 1.0 },   // airway compartment of 1 L: the dose stands for the local amount; ~10 % reaches the circulation (heart rate, potassium)
  magnesium:      { name: 'Magnesium sulfate', transit: true, unit: 'g', concUnit: 'g/L', ref: 'gina2024', kind: 'bronchodilator', tHalf: 240, vPerKg: 0.3, c50: 0.08, hrAdd: 0, svrDrop: 0.10 },
  dantrolene:     { name: 'Dantrolene', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'hopkins2021', kind: 'none', tHalf: 600, vPerKg: 0.5, ke0: 0.5 },
  lipid:          { name: 'Lipid emulsion 20 %', transit: true, unit: 'mL', concUnit: 'mL/L', ref: 'neal2018', kind: 'none', tHalf: 40, vPerKg: 0.05 },
  bupivacaine:    { name: 'Bupivacaine', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'neal2018', kind: 'la', tHalf: 160, vPerKg: 1.0, routes: ['iv', 'regional'] },
  morphine:       { name: 'Morphine', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'textbook', kind: 'opioid', tHalf: 150, vPerKg: 3.5, ke0: 0.03, c50: 0.025, gamma: 2, ventC50: 0.03, ventGamma: 2, ventEmax: 0.9, brady: 0.10, svrDrop: 0.12 },   // 10 mg IV raises PaCO2 ~4 mmHg (REF textbook; size REF design)
  esmolol:        { name: 'Esmolol', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'label_esmolol', kind: 'betablocker', tHalf: 9, vPerKg: 3.4, c50: 0.15, chronoMax: 0.45, inotMax: 0.20, avMax: 0.45 },
  metoprolol:     { name: 'Metoprolol', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'esc_af2024', kind: 'betablocker', tHalf: 210, vPerKg: 4.0, c50: 0.015, chronoMax: 0.45, inotMax: 0.15, avMax: 0.45 },
  labetalol:      { name: 'Labetalol', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'textbook', kind: 'betablocker', tHalf: 330, vPerKg: 9.0, c50: 0.015, chronoMax: 0.15, inotMax: 0.05, avMax: 0.2, svrDrop: 0.25 },
  urapidil:       { name: 'Urapidil', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'textbook', kind: 'vasodilator', tHalf: 180, vPerKg: 0.8, c50: 0.3, venEmax: 0.10, svrEmax: 0.30, baroHrDrop: 0.9 },   // central 5-HT1A action blunts the reflex tachycardia (REF textbook)
  furosemide:     { name: 'Furosemide', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'textbook', kind: 'none', tHalf: 90, vPerKg: 0.15, ke0: 0.1 },
  tranexamicAcid: { name: 'Tranexamic acid', transit: true, unit: 'mg', concUnit: 'mg/L', ref: 'crash2_2010', kind: 'none', tHalf: 120, vPerKg: 0.18 },
  heparin:        { name: 'Heparin (unfractionated)', transit: true, unit: 'units', concUnit: 'units/L', ref: 'textbook', kind: 'none', tHalf: 90, vPerKg: 0.07 },
  hydrocortisone: { name: 'Hydrocortisone', unit: 'mg', concUnit: 'n/a', ref: 'rcuk2021_anaph', kind: 'direct' },   // no effect within the time of a case: given, logged, scored (REF rcuk2021_anaph: no longer routine in the emergency treatment)
  aspirin:        { name: 'Aspirin', unit: 'mg', concUnit: 'n/a', ref: 'esc_acs2023', kind: 'direct' },
  glucose:        { name: 'Glucose (dextrose)', unit: 'g', concUnit: 'n/a', ref: 'textbook', kind: 'direct' },       // crises.js / electrolytes.js: distributes in extracellular water
  insulin:        { name: 'Insulin (regular, IV)', unit: 'units', concUnit: 'n/a', ref: 'harel2016', kind: 'direct' },
};
DRUGS.midazolam.routes = ['iv', 'im']; DRUGS.midazolam.ka = { im: 0.25 };   // IM midazolam 10 mg stops seizures within minutes (REF silbergleit2012)
DRUGS.epinephrine.routes = ['iv', 'im']; DRUGS.lidocaine.routes = ['iv', 'regional'];
/** First-order absorption from an intramuscular or regional depot (per min): intramuscular epinephrine in the thigh peaks
 *  at ~8 min (REF simons2001); local anaesthetic after a nerve block peaks at ~30 min (REF textbook). */
export const ABSORPTION_KA = Object.freeze({ im: 0.05, regional: 0.03 });

const PD = (c, c50, g = 1) => hill(c, c50, g);

export class DrugSystem {
  constructor(body, { dtSec = 0.1, propofolModel = 'eleveld', remiModel = 'minto', pseudocholinesterase = 1 } = {}) {
    this.body = body; this.dtSec = dtSec;
    this.propofolModel = propofolModel; this.remiModel = remiModel; this.pchE = pseudocholinesterase;
    this.pk = {}; this.hemo = {}; this.sug = { capacity: 0 };
    this.transit = [];                                      // IV boluses still on their way from the arm vein: { key, amount, steps left }
    this.depots = [];                                       // intramuscular / regional depots: { key, amount, ka (/min) }
    this.log = [];
  }
  _opioidOn() { return ['remifentanil', 'fentanyl'].some(k => this.pk[k] && this.pk[k].c1 > 0.2); }
  _params(key) {
    const b = this.body, d = DRUGS[key];
    switch (key) {
      case 'propofol': return this.propofolModel === 'marsh' ? propofolMarsh(b) : this.propofolModel === 'marsh-mod' ? propofolMarsh(b, 1.2) : this.propofolModel === 'schnider' ? propofolSchnider(b) : propofolEleveld(b, { opioid: this._opioidOn() });
      case 'remifentanil': return this.remiModel === 'eleveld' ? remifentanilEleveld(b) : remifentanilMinto(b);
      case 'fentanyl': return fentanylShafer();
      case 'ketamine': return ketamineDomino(b);
      case 'midazolam': return midazolamAlbrecht(b);
      case 'etomidate': return etomidateKaneda();
      case 'dexmedetomidine': return dexmedetomidineHannivoort(b);
      case 'rocuronium': return rocuroniumWierda(b);
      case 'succinylcholine': return succinylcholineEmpirical(b, this.pchE);
      case 'naloxone': return { ...oneComp(0.5 * b.weightKg, 64), ke0: 0.35 };
      case 'bupivacaine': { const W = b.weightKg, V1 = 0.2 * W, V2 = 0.8 * W, CL = 0.0056 * W, Q = 1.5; return { V1, k10: CL / V1, k12: Q / V1, k13: 0, k21: Q / V2, k31: 0, ke0: 2 }; }   // central 0.2 L/kg, Vss 1 L/kg, CL 5.6 mL/kg/min (REF textbook): an accidental IV bolus peaks far higher than a block
      default: return d && d.tHalf && d.vPerKg ? { ...oneComp(d.vPerKg * b.weightKg, d.tHalf), ke0: d.ke0 ?? 4 } : null;   // single-compartment drugs; ke0 4/min (t1/2 10 s) vascular / myocardial response lag (REF design)
    }
  }
  model(key) {
    if (!this.pk[key]) { const p = this._params(key); if (!p) return null; this.pk[key] = new PKModel(p, this.dtSec); this.hemo[key] = 0; }
    return this.pk[key];
  }
  bolus(key, amount, t = 0, route = 'iv') {
    if (DRUGS[key]?.kind === 'direct') { this.log.push({ t, key, amount, route }); return; }   // effect handled by the patient (crises.js / electrolytes.js)
    if (route !== 'iv') { this.model(key); this.depots.push({ key, amount, ka: DRUGS[key].ka?.[route] ?? ABSORPTION_KA[route] }); this.log.push({ t, key, amount, route }); return; }
    if (key === 'sugammadex') { this.sug.capacity += amount * 0.28; this.log.push({ t, key, amount }); return; } // 1 mg sugammadex (MW 2178) binds 0.28 mg rocuronium (MW 609), 1:1 molar
    const m = this.model(key); if (!m) throw new Error('unknown drug ' + key);
    if (DRUGS[key].transit) this.transit.push({ key, amount, n: Math.round(IV_TRANSIT_S / this.dtSec) });
    else m.bolus(amount);
    this.log.push({ t, key, amount });
  }
  /** amount (dose units) of `key` injected but not yet in the central circulation */
  inTransit(key) { return this.transit.reduce((s, x) => s + (x.key === key ? x.amount : 0), 0); }
  /** quantised state of the transit queue for Patient.stateHash() */
  hashVec() { return [...this.transit.flatMap(x => [Object.keys(DRUGS).indexOf(x.key), x.amount, x.n]), ...this.depots.flatMap(x => [Object.keys(DRUGS).indexOf(x.key), x.amount])]; }
  infusion(key, ratePerMin) { const m = this.model(key); if (!m) throw new Error('unknown drug ' + key); m.setInfusion(ratePerMin); }
  stop(key) { if (this.pk[key]) this.pk[key].setInfusion(0); }
  /** effect-site (or plasma for single-compartment drugs) concentration used for PD */
  ce(key) { const m = this.pk[key]; if (!m) return 0; return m.ce; }
  cp(key) { const m = this.pk[key]; return m ? m.c1 : 0; }
  step() {
    const dtMin = this.dtSec / 60;
    if (this.transit.length) {                               // arrivals in injection order, before the step integrates them
      for (const x of this.transit) if (--x.n <= 0) this.pk[x.key].bolus(x.amount);
      this.transit = this.transit.filter(x => x.n > 0);
    }
    for (const x of this.depots) { const a = x.amount * (1 - Math.exp(-x.ka * dtMin)); x.amount -= a; this.pk[x.key].bolus(a); }
    if (this.depots.length) this.depots = this.depots.filter(x => x.amount > 1e-6);
    for (const [k, m] of Object.entries(this.pk)) {
      m.step();
      const kh = 0.5;                                        // extra hemodynamic equilibration on top of the effect-site (BP nadir 2-4 min after an induction bolus; REF sahinovic2018)
      this.hemo[k] += (m.ce - this.hemo[k]) * (1 - Math.exp(-kh * dtMin));
    }
    if (this.sug.capacity > 0 && this.pk.rocuronium) {      // encapsulation: first-order complexation (k = 3/min, design) until capacity is used up
      const m = this.pk.rocuronium, f = 1 - Math.exp(-3 * dtMin);
      const tot = m.a[0] + m.a[1] + m.a[2];
      const bind = Math.min(this.sug.capacity, tot * f);
      if (tot > 0) { const s = (tot - bind) / tot; m.a = m.a.map(x => x * s); m.cumulativeOut += bind; }
      this.sug.capacity -= bind;
      m.ce = Math.min(m.ce, m.c1 * 1.0);
    }
  }
  /** Aggregate pharmacodynamics. ctx: {inArrest:boolean} */
  effects(ctx = {}) {
    const age = this.body.age, o = { fx: { chrono: 1, hrAdd: 0, inotropy: 1, svr: 1, ven: 0, baro: 1, baroHr: 1 }, dep: { slope: 1, shift: 0, hypoxic: 1 } };
    // --- naloxone-shifted opioid exposure
    const nal = this.pk.naloxone ? this.pk.naloxone.ce : 0;
    const opShift = 1 / (1 + nal / DRUGS.naloxone.kn);
    let I = 0, analg = 0, opioidMax = 0, slopeRes = 1, hypoxRes = 1, shift = 0;
    let svr = 1, inot = 1, ven = 0, baro = 1, baroHr = 1, chrono = 1, hrAdd = 0, avSlow = 0, escape = 0;
    // --- hypnotics: additive potency with opioid synergy on propofol (up to -40% C50 at ~3 ng/mL fentanyl-equivalent; REF sahinovic2018)
    const opCe = (this.ce('remifentanil') + this.ce('fentanyl')) * opShift;
    const syn = 1 - 0.40 * (opCe / (opCe + 1.5));
    for (const [k, d] of Object.entries(DRUGS)) {
      const m = this.pk[k]; if (!m) continue;
      const c = k === 'midazolam' ? m.ce / (1 + this.ce('flumazenil') / FLU_K) : m.ce;   // competitive antagonism at the benzodiazepine site
      if (d.kind === 'hypnotic') {
        let c50 = d.c50; if (k === 'propofol') c50 = 3.08 * Math.exp(-0.00635 * (age - 35)) * syn;   // REF eleveld2018 Ce50(age)
        else if (k === 'midazolam') c50 = d.c50 * Math.exp(-0.012 * (age - 35));   // age sensitivity, REF design: the Albrecht kinetics alone give an older patient a LOWER effect-site concentration, while the label says older patients need less drug (REF label_midazolam)
        const emax = d.emax ?? 1; I += emax * Math.pow(c / c50, d.gamma);
        const v = d.ventEmax * PD(c, d.ventC50, d.ventGamma);
        slopeRes *= 1 - v; shift += 5 * v; hypoxRes *= 1 - 0.9 * v;
        const h = PD(this.hemo[k], d.hemoC50 ?? 1e9, d.hemoGamma ?? 2);
        if (k === 'propofol') { svr *= 1 - 0.42 * h; inot *= 1 - 0.25 * h; ven -= 0.30 * h; baro *= 1 - 0.60 * h; baroHr *= 1 - 0.85 * h; chrono *= 1 - 0.08 * h; }   // calibrated: Ce 3 ug/mL, normovolemic -> MAP -25..-30% (design; Jeleazcov 2015 shows larger, steady-state volunteer data) (REF jeleazcov2015)
        else if (d.hemoSvr) { svr *= 1 - d.hemoSvr * h; }
        if (d.symp) { const s = PD(c, 1.0, 1.5); svr *= 1 + 0.18 * s; chrono *= 1 + 0.20 * s; inot *= 1 + 0.05 * s; }
        if (d.brady) { const s = PD(this.hemo[k] * 1, d.bradyC50, 1.5); chrono *= 1 - d.brady * s; svr *= 1 + 0.10 * PD(c, 6, 2); }
      } else if (d.kind === 'opioid') {
        const ceEff = c * opShift, d50 = d.c50 ?? 2, dg = d.gamma ?? 2;
        analg += (1 - analg) * PD(ceEff, d50, dg);
        const v = d.ventEmax * PD(ceEff, d.ventC50, d.ventGamma);
        slopeRes *= 1 - v; shift += 8 * v; hypoxRes *= 1 - 0.95 * v;      // massive opioid exposure abolishes the hypoxic drive as well (REF design) opioidMax = Math.max(opioidMax, v);
        const hh = PD(this.hemo[k] * opShift, d50, 1.5);
        chrono *= 1 - d.brady * hh; svr *= 1 - d.svrDrop * hh; baro *= 1 - 0.1 * hh;
      } else if (d.kind === 'pressor') {
        const cc = c;                                  // effect site (ke0 4/min, REF design); the arrest model still reads plasma epinephrine
        const a1 = PD(cc, d.a1C50, 1.3), b1 = PD(cc, d.b1C50, 1.3), ch = PD(cc, d.chronoC50, 1.2);
        if (!(d.ineffectiveInArrest && ctx.inArrest)) svr *= 1 + d.svrEmax * a1;
        inot *= 1 + d.inotEmax * b1; hrAdd += d.hrAdd * ch; ven += d.venEmax * a1;
        if (d.escape) escape += d.escape * ch;                            // beta-1 stimulation speeds a ventricular escape rhythm (complete heart block); atropine does not (REF erc2025; size REF design)
        if (d.b2Svr) svr *= 1 - d.b2Svr * PD(cc, d.b2C50, 1.3);          // beta-2 vasodilation (dobutamine)
      } else if (d.kind === 'betablocker') {
        const e = PD(c, d.c50, 1.3); chrono *= 1 - d.chronoMax * e; inot *= 1 - d.inotMax * e; avSlow = Math.max(avSlow, d.avMax * e); if (d.svrDrop) svr *= 1 - d.svrDrop * e;
      } else if (d.kind === 'bronchodilator') {
        const e = PD(c, d.c50, 1.5); hrAdd += d.hrAdd * e; if (d.svrDrop) svr *= 1 - d.svrDrop * e;
      } else if (d.kind === 'vagolytic') {
        hrAdd += d.hrAdd * PD(c, d.c50, d.gamma ?? 1.5);
      } else if (d.kind === 'vasodilator') {
        const e = PD(c, d.c50, 1.3); ven -= d.venEmax * e; svr *= 1 - d.svrEmax * e; if (d.baroHrDrop) baroHr *= 1 - d.baroHrDrop * e;
      } else if (d.kind === 'antiarrhythmic') {
        svr *= 1 - d.hypoSvr * PD(c, d.c50, 1.5);
      } else if (d.kind === 'inotrope') {
        const e = PD(c, d.c50, 1.3); inot *= 1 + d.inotEmax * e; svr *= 1 + d.svrEmax * e;
      }
    }
    // --- volatile agent (sevoflurane, volatile.js): additive hypnosis on the same scale; potency fitted so loss of consciousness
    //     comes at ~0.35-0.4 MAC (MAC-awake 0.34, REF katoh1993) and BIS ~40 at 1 MAC (REF design); vasodilation, mild myocardial
    //     depression and baroreflex blunting give MAP -15..-30 % at 1 MAC (REF ebert1995); ventilatory depression (REF textbook)
    // nitrous oxide: weaker hypnotic per MAC (MAC-awake ~0.6 MAC), little cardiovascular or ventilatory depression (REF textbook)
    const vol = this.volatile, vmV = vol ? vol.macFrac : 0, n2o = vol ? vol.n2oMac : 0, vm = vmV + 0.55 * n2o;
    if (vm > 0.001) {
      I += Math.pow(vm / SEVO_HYP_C50, SEVO_HYP_G);
      const hv = PD(vmV + 0.1 * n2o, 0.6, 1.5);
      svr *= 1 - 0.55 * hv; inot *= 1 - 0.30 * PD(vm, 1.0, 1.5); ven -= 0.30 * hv; baro *= 1 - 0.75 * hv; baroHr *= 1 - 0.85 * hv;
      const v = 0.8 * PD(vmV + 0.3 * n2o, 1.0, 1.5); slopeRes *= 1 - v; shift += 5 * v; hypoxRes *= 1 - 0.8 * v;
    }
    if (vol && vol.desSurge > 0.01) { hrAdd += 60 * vol.desSurge; svr *= 1 + 1.0 * vol.desSurge; inot *= 1 + 0.2 * vol.desSurge; }   // desflurane: sympathetic surge on a fast rise (REF weiskopf1994)
    // --- hypnosis index: H = I^g/(1+I^g) mapped with g=1 on the already-powered additive potency
    const H = I / (1 + I);
    // --- neuromuscular block (twitch depression), diaphragm needs ~ deeper block
    let nmb = 0;
    const neo = PD(this.ce('neostigmine'), NEO_C50, 1.5);
    for (const k of ['rocuronium', 'succinylcholine']) { const m = this.pk[k]; if (!m) continue; const d = DRUGS[k]; const c50 = k === 'rocuronium' ? d.c50 * (1 + NEO_SHIFT * neo) : d.c50; nmb = 1 - (1 - nmb) * (1 - PD(m.ce, c50, d.gamma)); }   // neostigmine raises acetylcholine: it shifts a non-depolarising block, so a deep block stays (ceiling)
    chrono *= 1 - 0.35 * neo * (1 - PD(this.ce('atropine'), 8, 2));   // muscarinic bradycardia, prevented by an anticholinergic (REF label_neostigmine; size REF design)
    o.fx = { avSlow, escape, chrono: clamp(chrono, 0.4, 2), hrAdd, inotropy: clamp(inot, 0.1, 4), svr: clamp(svr, 0.2, 4), ven: clamp(ven, -0.6, 0.6), baro: clamp(baro, 0.2, 1), baroHr: clamp(baroHr, 0.05, 1) };
    o.dep = { slope: clamp(slopeRes, 0.001, 1), shift, hypoxic: clamp(hypoxRes, 0.02, 1) };
    o.hyp = H; o.loc = H > 0.30; o.bis = 92 - (92 - 5.3) * H;
    o.analgesia = analg; o.nmb = nmb; o.paralyzed = nmb > 0.92;
    o.fasciculation = false;
    return o;
  }
  snapshot() { const s = {}; for (const [k, m] of Object.entries(this.pk)) s[k] = { cp: m.c1, ce: m.ce, a: m.a.slice() }; return s; }
}
