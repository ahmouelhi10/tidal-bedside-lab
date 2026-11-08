// Focused cardiac ultrasound (FoCUS): what a transthoracic echo would show on this patient, derived from the live engine state,
// plus the guideline cut-offs used to interpret it. Pure functions of the Patient, so they run in the browser, in tests and in replay.
//
// Sources (values checked against the primary PDFs; see docs/REFERENCES.md):
//   via2014    Via G et al. International evidence-based recommendations for focused cardiac ultrasound. J Am Soc Echocardiogr 2014;27:683.e1
//              (five standard views, qualitative LV grading, tamponade = RA systolic / RV diastolic collapse, small IVC < 10 mm with hypovolaemia)
//   lang2015   Lang RM et al. ASE/EACVI chamber quantification. J Am Soc Echocardiogr 2015;28:1 (LVEF ranges and grading, LVEDD, RV size, TAPSE < 17 mm)
//   rudski2010 Rudski LG et al. Echocardiographic assessment of the right heart. J Am Soc Echocardiogr 2010;23:685 (RA pressure from the IVC, Table 3)
// What is not in those documents (how a given contractility, preload or effusion volume maps to an image) is a design model,
// tagged REF design and listed in docs/VALIDATION.md.
import { clamp } from './util.js';

/** The five FoCUS views in the order of the ICU protocol. REF via2014 (Figure 1: SLAX, SIVC, PLAX, PSAX, A4CH); the order is a teaching choice (REF design). */
export const ECHO_VIEWS = Object.freeze(['plax', 'psax', 'a4c', 'subcostal', 'ivc']);
/** Measurements the learner can record (echo.measure). */
export const ECHO_MEASURES = Object.freeze(['lvef', 'lvedd', 'tapse', 'rv_basal', 'ivc_max', 'ivc_min', 'effusion']);
/** Qualitative answers of the report (echo.report). */
export const ECHO_REPORT = Object.freeze({
  lv: ['hyperkinetic', 'normokinetic', 'hypokinetic', 'severely_hypokinetic'],   // REF via2014 (wording of the FoCUS semiquantitative LV grading)
  rv: ['normal', 'dilated'],
  rap: [3, 8, 15],                                                                // REF rudski2010 (Table 3 midrange values)
  peri: ['none', 'effusion', 'tamponade'],
  dx: ['normal', 'hypovolaemia', 'lv_failure', 'tamponade', 'rv_failure'],
});

/** Guideline cut-offs. Each is quoted in the cited document. */
export const ECHO_CUTOFFS = Object.freeze({
  lvef: { M: { normal: [52, 72], mild: [41, 51], moderate: [30, 40], severeBelow: 30 }, F: { normal: [54, 74], mild: [41, 53], moderate: [30, 40], severeBelow: 30 } },   // REF lang2015 (Table 4, 2D biplane)
  lveddMm: { M: [42.0, 58.4], F: [37.8, 52.2] },                                // REF lang2015 (Table 2 normal ranges)
  tapseAbnormalBelowMm: 17,                                                     // REF lang2015 (TAPSE < 17 mm highly suggestive of RV systolic dysfunction; Rudski 2010 used < 16 mm)
  rvBasalUpperMm: 41, rvMidUpperMm: 35,                                         // REF lang2015 (RV basal 25-41 mm, mid 19-35 mm; Rudski 2010: > 42 mm basal)
  ivcUpperMm: 21, sniffCollapsePct: 50, quietCollapsePct: 20,                   // REF rudski2010 (Table 3; < 20 % collapse with quiet inspiration suggests elevated RA pressure)
  ivcVentSmallMm: 12,                                                           // REF rudski2010 (ventilated: IVC <= 12 mm identifies RA pressure < 10 mmHg)
  ivcHypovolaemiaMm: 10,                                                        // REF via2014 (spontaneous breathing: end-expiratory IVC < 10 mm with hypovolaemia)
});

/** Normal means used as the operating point of the image model. REF lang2015 (Table 2: LVEDD 50.2 / 45.0 mm, LVEF 62 / 64 %; TAPSE 24 mm; RV basal 33 mm; RV mid 27 mm). */
const NORM = { lvedd: { M: 50.2, F: 45.0 }, ef: { M: 62, F: 64 }, tapse: 24, rvBasal: 33, rvMid: 27 };

/** Lang 2015 grade of an LVEF (%): 'normal' | 'mild' | 'moderate' | 'severe' | 'above' (above the normal range). REF lang2015 */
export function lvefGrade(ef, sex = 'M') {
  const c = ECHO_CUTOFFS.lvef[sex === 'F' ? 'F' : 'M'];
  if (ef > c.normal[1]) return 'above';
  if (ef >= c.normal[0]) return 'normal';
  if (ef >= c.mild[0]) return 'mild';
  if (ef >= c.moderate[0]) return 'moderate';
  return 'severe';
}
/** FoCUS semiquantitative grade (Via 2014 wording) mapped onto the Lang 2015 ranges: above the normal range = hyperkinetic,
 *  normal range = normokinetic, mildly/moderately reduced = hypokinetic, < 30 % = severely hypokinetic. The mapping is REF design. */
export function focusLvClass(ef, sex = 'M') {
  return { above: 'hyperkinetic', normal: 'normokinetic', mild: 'hypokinetic', moderate: 'hypokinetic', severe: 'severely_hypokinetic' }[lvefGrade(ef, sex)];
}
/** RA pressure from the IVC (Rudski 2010 Table 3, without secondary indices). Spontaneous breathing only: under positive-pressure
 *  ventilation IVC collapse cannot estimate RA pressure (returns { rap: null, below10 }). REF rudski2010 */
export function rapFromIvc(maxMm, sniffCollapsePct, { ventilated = false } = {}) {
  const c = ECHO_CUTOFFS;
  if (ventilated) return { rap: null, below10: maxMm <= c.ivcVentSmallMm };
  const small = maxMm <= c.ivcUpperMm, collapses = sniffCollapsePct > c.sniffCollapsePct;
  return { rap: small && collapses ? 3 : !small && !collapses ? 15 : 8 };
}

// ------------------------------------------------------------------------------------------------ pericardium
/** Pericardial effusion: volume (mL) and the pressure it exerts on the heart. The pericardial pressure-volume curve is steep
 *  (exponential); its constants are a design fit (REF design) so that ~350 mL accumulated acutely produces tamponade physiology. */
export class Pericardium {
  constructor(volumeMl = 0) { this.volume = Math.max(0, volumeMl); }
  /** mmHg transmitted to the cardiac chambers (added to the intrathoracic pressure the circulation sees) */
  get pressure() { return Math.min(30, 0.5 * (Math.exp(this.volume / 150) - 1)); }   // REF design
  /** end-diastolic echo-free space (mm): a shell around a sphere of radius 45 mm (REF design geometry) */
  get depthMm() { const r = 45, v = this.volume * 1000; return v <= 0 ? 0 : Math.cbrt(v * 3 / (4 * Math.PI) + r ** 3) - r; }
  /** needle pericardiocentesis: drains most of the fluid (REF design: 85 % removed) */
  drain() { const out = this.volume * 0.85; this.volume -= out; return out; }
}

/** IVC from the RA pressure (mmHg): end-expiratory diameter (mm) and collapse (%) with a sniff and with quiet breathing.
 *  The mapping is a design model (REF design) built so that the Rudski 2010 Table 3 category it yields always contains the true
 *  RA pressure: <= 5 mmHg -> 'normal 3', 5-10 -> 'intermediate 8', > 10 -> 'high 15' (tested against REF rudski2010). */
export function ivcModel(rap, ventilated = false) {
  const max = clamp(9 + 1.2 * rap, 4, 28);                                           // 21 mm at RA 10 mmHg
  const sniff = ventilated ? 0 : clamp(50 + 8 * (5 - rap), 3, 92);                   // 50 % at RA 5 mmHg
  const quiet = ventilated ? 0 : sniff * 0.55;
  const distension = ventilated ? clamp(28 - 2.4 * rap, 2, 30) : 0;                  // insufflation distends a compliant IVC (no cut-off is scored)
  return { max, sniff, quiet, distension };
}

// ------------------------------------------------------------------------------------------------ the echo image model
/** Everything the echo shows at this instant (truth). Image model REF design, calibrated in tests to the guideline bands. */
export function echoState(p) {
  const c = p.circ, sex = p.spec.sex === 'F' ? 'F' : 'M', perf = p.arrest.info.perfusing && c.hr > 0;
  const peri = p.peri?.pressure ?? 0, itp = (p.chest?.itp ?? 0) + peri, rap = c.rap, rapTm = rap - itp;
  const contr = c.contr ?? 1, rv = p.rvLoad ?? 0;
  // LV: ejection fraction follows the effective contractility; volumes follow the stroke volume (EDV = SV / EF)
  const ef0 = NORM.ef[sex];
  const ef = perf ? clamp(ef0 * Math.pow(contr, 1.5) * (1 + 0.003 * (c.hr - c.HR0)), 8, 85) : 0;   // REF design (EF rises with contractility and sympathetic drive)
  const edv0 = c.SV0 / (ef0 / 100), edv = perf ? Math.max(20, c.sv / Math.max(0.08, ef / 100)) : edv0 * clamp(c.pms / c.PMS0, 0.6, 1.3);
  const remodel = 1 + 0.25 * clamp(1 - (p.lv ?? 1), 0, 0.8);                         // chronic LV dysfunction dilates the ventricle (REF design)
  const lvedd = NORM.lvedd[sex] * Math.cbrt(edv / edv0) * remodel;                   // REF design (diameter ~ volume^1/3)
  const lvesd = lvedd * Math.cbrt(1 - ef / 100);
  // RV: pressure overload dilates it and reduces longitudinal shortening; high filling distends it a little
  const rvBasal = NORM.rvBasal * (1 + 0.42 * rv) * (1 + 0.012 * clamp(rapTm - 4, -4, 12));   // REF design
  const rvMid = NORM.rvMid * (1 + 0.45 * rv) * (1 + 0.012 * clamp(rapTm - 4, -4, 12));
  const tapse = perf ? clamp(NORM.tapse * (1 - 0.48 * rv) * clamp(0.75 + 0.25 * contr, 0.5, 1.15), 4, 32) : 0;   // REF design
  const rvLv = rvBasal / Math.max(20, lvedd);
  const dShape = rv > 0.35;                                                          // septal flattening (D-shaped LV) with RV pressure overload (REF design threshold)
  const ventilated = p.vent?.mode === 'ctrl' || p.arrest.arrested;
  const { max: ivcMax, sniff, quiet, distension } = ivcModel(rap, ventilated);
  // pericardium: chamber collapse when the pericardial pressure approaches the chamber filling pressure (REF design thresholds;
  // the signs themselves are the FoCUS tamponade criteria, REF via2014)
  const raCollapse = peri > 2 && peri >= 0.45 * Math.max(1, rap);
  const rvCollapse = peri > 5 && peri >= 0.6 * Math.max(1, rap);
  return {
    perfusing: perf, hr: perf ? c.hr : 0, rhythm: p.arrest.key, ef: +ef.toFixed(1), lvedd: +lvedd.toFixed(1), lvesd: +lvesd.toFixed(1),
    tapse: +tapse.toFixed(1), rvBasal: +rvBasal.toFixed(1), rvMid: +rvMid.toFixed(1), rvLv: +rvLv.toFixed(2), dShape,
    ivcMax: +ivcMax.toFixed(1), ivcMinSniff: +(ivcMax * (1 - sniff / 100)).toFixed(1), ivcMinQuiet: +(ivcMax * (1 - quiet / 100)).toFixed(1),
    sniffCollapse: +sniff.toFixed(0), quietCollapse: +quiet.toFixed(0), distension: +distension.toFixed(0), ventilated,
    effusionMm: +(p.peri ? p.peri.depthMm : 0).toFixed(1), periP: +peri.toFixed(1), raCollapse, rvCollapse, rap: +rap.toFixed(1), sex,
  };
}

/** The value a perfect operator would record for a measurement. */
export function measureTruth(s, what) {
  return { lvef: s.ef, lvedd: s.lvedd, tapse: s.tapse, rv_basal: s.rvBasal, ivc_max: s.ivcMax, ivc_min: s.ventilated ? s.ivcMax : s.ivcMinSniff, effusion: s.effusionMm }[what];
}
/** The correct report for a state (the answer key). Uses only the guideline cut-offs above. */
export function reportTruth(s) {
  const lv = s.perfusing ? focusLvClass(s.ef, s.sex) : 'severely_hypokinetic';
  const rv = s.rvBasal > ECHO_CUTOFFS.rvBasalUpperMm || s.tapse < ECHO_CUTOFFS.tapseAbnormalBelowMm ? 'dilated' : 'normal';   // REF via2014 (RV size is part of RV function: a failing RV dilates); cut-offs REF lang2015
  const rap = s.ventilated ? null : rapFromIvc(s.ivcMax, s.sniffCollapse).rap;
  const peri = s.effusionMm < 1 ? 'none' : s.raCollapse || s.rvCollapse ? 'tamponade' : 'effusion';
  // FoCUS pattern recognition (REF via2014): tamponade > RV failure > LV failure > hypovolaemia (small hyperdynamic LV + small IVC)
  const dx = peri === 'tamponade' ? 'tamponade' : rv === 'dilated' ? 'rv_failure' : (lv === 'hypokinetic' || lv === 'severely_hypokinetic') ? 'lv_failure'
    : lv === 'hyperkinetic' && (s.ventilated ? s.ivcMax <= ECHO_CUTOFFS.ivcVentSmallMm : s.ivcMax < ECHO_CUTOFFS.ivcHypovolaemiaMm || rap === 3) ? 'hypovolaemia' : 'normal';
  return { lv, rv, rap, peri, dx };
}
