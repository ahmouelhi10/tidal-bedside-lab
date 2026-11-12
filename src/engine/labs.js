// Point-of-care and laboratory tests: a sample freezes the patient's values at the moment it is drawn, and the result is
// released after a turnaround time. Only quantities the engine actually models are reported (electrolytes and glucose come
// from electrolytes.js; a blood gas analyser reports them with the gas, as point-of-care analysers do).
import { coagStatus } from './coag.js';
import { cardiacValues, renalValues } from './clinical.js';
// Reading only: ordering a test never changes the physiology, so it cannot shift a trajectory or a replay hash.

export const LAB_KINDS = Object.freeze(['abg', 'lactate', 'chem', 'cbc', 'coag', 'cardiac', 'renal', 'ketones', 'cbg']);

/** Turnaround from sampling to result, seconds. Point-of-care blood gas analysers report in about 1-2 min of analysis plus
 *  handling (REF design); a stat blood count or chemistry panel from the central laboratory within an hour (REF design; stat targets <= 60 min). */
export const TURNAROUND_S = Object.freeze({ abg: 180, lactate: 180, chem: 2700, cbc: 2700, coag: 2700, cardiac: 3600, renal: 2700, ketones: 60, cbg: 60 });   // capillary glucose: bedside meter   // capillary ketones: bedside meter   // hs-troponin on the 0/1 h pathway: ~1 h (REF esc_acs2023)   // standard coagulation tests ~45 min (viscoelastic point-of-care tests are not modelled)

/** Adult reference intervals used to flag results (REF textbook). */
export const RANGES = Object.freeze({
  ph: [7.35, 7.45], paco2: [35, 45], pao2: [80, 100], hco3: [22, 26], be: [-2, 2], sao2: [95, 100], lactate: [0.5, 2.0],
  na: [135, 145], osm: [275, 295], ketones: [0, 0.6], mg: [0.7, 1.0], cl: [98, 106], ag: [8, 16], k: [3.5, 5.0], ica: [1.15, 1.33], glucose: [3.9, 7.8],
  plt: [150, 400], inr: [0.8, 1.2], aptt: [25, 35], fib: [2.0, 4.0],
  tnt: [0, 14], ntprobnp: [0, 125], ddimer: [0, 0.5], creat_M: [60, 110], creat_F: [45, 90], urea: [2.5, 7.8],   // hs-cTnT 99th percentile 14 ng/L (REF thygesen2018); NT-proBNP < 125 pg/mL rules out heart failure (REF esc_hf2021); others REF textbook
  hb_M: [13.0, 17.0], hb_F: [12.0, 15.5], hct_M: [0.40, 0.50], hct_F: [0.36, 0.46],
});

/** Anion gap Na - (Cl + HCO3), ~12 mmol/L without potassium; lactate adds to it mmol for mmol (REF kraut2007). Chloride is
 *  derived from it: the model has no separate chloride balance, so a hyperchloraemic (normal-gap) acidosis is not represented. */
export const AG_BASE = 12;
/** Lower limit of a normal PaO2 on room air falls with age (REF sorbini1968: mean 104.2 - 0.27 x age; limit ~10 mmHg below) */
export const pao2Lower = (age) => Math.max(60, Math.round(94.2 - 0.27 * (age ?? 40)));

/** Standard base excess (Van Slyke form, REF textbook) from HCO3- (mmol/L) and pH. */
export const baseExcess = (hco3, ph) => 0.93 * (hco3 - 24.4 + 14.83 * (ph - 7.40));

/** Values of a sample drawn now from the patient p. */
export function sampleValues(kind, p) {
  const r = p.resp, v = p.vol, e = p.lytes;
  // measured sodium falls ~0.3 mmol/L per mmol/L of glucose as water leaves the cells (REF katz1973); osmolality 2 Na + glucose + urea
  const naMeas = e.na - 0.29 * Math.max(0, e.glucose - 5.5);
  const lytes = () => ({ na: +naMeas.toFixed(0), k: +e.k.toFixed(1), glucose: +e.glucose.toFixed(1) });
  if (kind === 'abg') {
    const ph = +r.pH.toFixed(2), hco3 = +r.hco3.toFixed(1);
    const ag = AG_BASE + Math.max(0, r.lactate - 1.0) + (p.keto ? p.keto.hco3Loss : 0), cl = Math.round(naMeas - r.hco3 - ag);
    return { ph, paco2: +r.paco2.toFixed(0), pao2: +r.pao2.toFixed(0), hco3, be: +baseExcess(r.hco3, r.pH).toFixed(1), sao2: +(r.sao2 * 100).toFixed(0), lactate: +r.lactate.toFixed(1), ...lytes(), cl, ag: Math.round(+naMeas.toFixed(0) - cl - hco3), ica: +e.ica.toFixed(2), fio2: +(r.fio2Eff ?? 0.21).toFixed(2) };
  }
  if (kind === 'lactate') return { lactate: +r.lactate.toFixed(1) };
  if (kind === 'chem') return { ...lytes(), mg: +e.mg.toFixed(2), osm: Math.round(2 * naMeas + e.glucose + renalValues(p).urea) };
  if (kind === 'cbg') return { glucose: +e.glucose.toFixed(1) };
  if (kind === 'ketones') return { ketones: +(p.keto ? p.keto.ketones : 0.1).toFixed(1) };                     // central laboratory: Na+, K+, glucose
  if (kind === 'cbc') return { hb: +v.hb.toFixed(1), hct: +v.hct.toFixed(2), plt: Math.round(v.pltAmt / v.bloodVolume) };
  if (kind === 'cardiac') return cardiacValues(p);
  if (kind === 'renal') return renalValues(p);
  if (kind === 'coag') { const c = coagStatus(v); return { inr: +c.inr.toFixed(1), aptt: Math.round(c.aptt * p.crises.heparinEffect(p.drugs).apttMult), fib: +c.fib.toFixed(1), plt: Math.round(c.plt) }; }   // measured at 37 C: cold and acidosis do not show
  return null;
}

/** Flag each value against its reference interval: 'L', 'H' or ''. */
export function flags(values, sex, age) {
  const out = {};
  for (const [k, x] of Object.entries(values)) {
    const rk = RANGES[k] ? k : RANGES[`${k}_${sex === 'F' ? 'F' : 'M'}`] ? `${k}_${sex === 'F' ? 'F' : 'M'}` : null;
    if (!rk || k === 'fio2') { out[k] = ''; continue; }
    const [lo0, hi] = RANGES[rk], lo = k === 'pao2' ? pao2Lower(age) : lo0;
    out[k] = x < lo ? 'L' : x > hi ? 'H' : '';
  }
  return out;
}
