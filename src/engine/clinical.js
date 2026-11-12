// Bedside diagnostics computed from the patient: the 12-lead ECG, cardiac and renal blood tests, and the clinical scores
// (NEWS2, qSOFA, GCS, shock index). Read-only: nothing here changes the physiology.
import { clamp } from './util.js';

const LEADS = Object.freeze(['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6']);
/** Leads facing each coronary territory, and their reciprocal leads (REF thygesen2018: ST elevation >= 1 mm in two contiguous
 *  leads, >= 2 mm in V2-V3 in men). */
export const TERRITORY = Object.freeze({
  anterior: { up: ['V1', 'V2', 'V3', 'V4'], down: ['III', 'aVF'] },
  inferior: { up: ['II', 'III', 'aVF'], down: ['I', 'aVL'] },
  lateral: { up: ['I', 'aVL', 'V5', 'V6'], down: ['III', 'aVF'] },
});

/** 12-lead ECG: per-lead ST shift (mm), QRS and T amplitudes, and the findings a reader should name. */
export function ecg12(p) {
  const key = p.arrest.key, m = { ...p.lytes.ecg() }, terr = TERRITORY[p.stTerritory || 'anterior'];
  const st = Object.fromEntries(LEADS.map(l => [l, 0]));
  if (p.stElevation && !p.arrest.arrested) { for (const l of terr.up) st[l] = l === 'V2' || l === 'V3' ? 3.5 : 2.5; for (const l of terr.down) st[l] = -1.0; }
  if (key === 'AV_BLOCK1') m.prS = (m.prS || 0) + 0.14;   // PR ~300 ms (> 200 ms)
  const qtc = Math.round(400 * (m.qt - 1) + (p.crises ? p.crises.riskQtc(p.lytes) : 400));   // calcium (ST length) + drugs / congenital + hypokalaemia (QT-U)
  const findings = [];
  if (p.stElevation && !p.arrest.arrested) findings.push('stemi_' + (p.stTerritory || 'anterior'));
  if (m.tAmp > 1.4) findings.push('peaked_t'); if (m.qrsWide > 0.3) findings.push('wide_qrs'); if (m.sine > 0.3) findings.push('sine_wave');
  if (m.u > 0.3) findings.push('u_waves'); if (qtc > 470) findings.push('long_qt');
  if (key !== 'NSR') findings.push('rhythm_' + key.toLowerCase());
  if (p.crises?.captured) findings.push('paced');
  // QRS duration: ~90 ms, widened by hyperkalaemia; a bundle branch block gives >= 120 ms (REF surawicz2009)
  const supra = !['VT_PULSE', 'VT_PULSELESS', 'VF', 'TORSADES', 'PEA', 'ASYSTOLE'].includes(key);
  const bbb = supra && !p.crises?.captured ? p.bbb : null;
  let qrs = Math.round(90 * (1 + 0.45 * (m.qrsWide || 0)));
  if (bbb) { qrs = Math.max(qrs, 140); findings.push(bbb === 'L' ? 'lbbb' : 'rbbb'); if (bbb === 'L') for (const l of ['V1', 'V2', 'V3']) st[l] += 1.0; }   // LBBB: discordant ST elevation in V1-V3 (REF sgarbossa1996)
  return { rhythm: key, rate: Math.round(p.monitor.hr ?? p.circ.hr), qtc, qrs, bbb, morph: m, st, findings };
}

/** Cardiac and renal laboratory values (REF design dynamics; reference limits cited in labs.js; NT-proBNP rises with age (roughly doubling
 *  per decade in healthy adults) and with ventricular dysfunction, REF esc_hf2021). */
export function cardiacValues(p) {
  const s = p.snapshot(), lv = clamp(p.lv, 0.05, 1.3);
  // high-sensitivity troponin T rises from ~1 h after the infarct onset and climbs over hours (REF thygesen2018); shocks
  // and CPR add myocardial injury (REF design)
  const ageH = p.stElevation ? (p.t + (p.infarctAgeS ?? 2400)) / 3600 : 0;
  const mi = p.stElevation ? 3000 * (1 - Math.exp(-Math.max(0, ageH - 1) / 6)) : 0;
  const cpr = (p.cpr.totalCompressions || 0) / 110 * 2 + (p.shockLog?.length || 0) * 15;   // ~2 ng/L per minute of compressions (at ~110/min), not per minute of the case
  const tnt = Math.round(6 + mi + cpr);
  const ntprobnp = Math.round(40 * Math.pow(2, Math.max(0, p.spec.age - 50) / 10) + 2500 * Math.pow(Math.max(0, 1 - lv), 1.3) + 2000 * (p.rvLoad || 0));
  const ddimer = +(0.3 + 4 * (p.rvLoad || 0) + 2.5 * clamp(s.fractionLost * 3, 0, 1) + 4 * (p.crises?.lysis || 0)).toFixed(2);
  return { tnt, ntprobnp, ddimer };
}
export function renalValues(p) {
  const base = p.spec.sex === 'F' ? 68 : 85, ageAdj = 1 + 0.004 * Math.max(0, p.spec.age - 40);
  const aki = (p.timers?.lowMapRenal || 0) / 60 * 0.6;                // creatinine creeps up with time below MAP 65 (REF design: KDIGO staging needs hours)
  return { creat: Math.round(base * ageAdj + aki), urea: +(5.0 + aki / 20).toFixed(1) };
}

/** Clinical scores from what is observable (monitor values; null when the variable is not measured). */
export function scores(p) {
  const m = p.monitor, eff = p.drugs.effects({ inArrest: p.arrest.arrested });
  const H = eff.hyp ?? 0;
  // sedation lowers the GCS to ~9 before loss of consciousness; unconscious (hypnosis index > 0.3) is GCS <= 7 (REF design mapping)
  let gcs = p.arrest.arrested ? 3 : eff.loc ? (H > 0.6 ? 3 : H > 0.45 ? 5 : 7) : clamp(15 - Math.round(6 * H / 0.3), 9, 15);
  if (p.crises?.seizure) gcs = Math.min(gcs, 6);
  if (p.lytes.glucose < 2.2) gcs = Math.min(gcs, 8); else if (p.lytes.glucose < 3) gcs = Math.min(gcs, 13);
  const assessable = !eff.paralyzed;
  const alert = assessable && gcs === 15;
  // NEWS2 (REF rcp2017)
  const band = (v, rows) => { if (v == null) return null; for (const [lo, hi, pts] of rows) if (v >= lo && v <= hi) return pts; return null; };
  const parts = {
    rr: band(m.rr, [[-1, 8, 3], [9, 11, 1], [12, 20, 0], [21, 24, 2], [25, 999, 3]]),
    spo2: band(m.spo2, [[0, 91, 3], [92, 93, 2], [94, 95, 1], [96, 100, 0]]),
    o2: p.o2 || p.vent.mode === 'ctrl' || p.apOx ? 2 : 0,
    sbp: band(m.sbp, [[0, 90, 3], [91, 100, 2], [101, 110, 1], [111, 219, 0], [220, 999, 3]]),
    hr: band(m.hr, [[0, 40, 3], [41, 50, 1], [51, 90, 0], [91, 110, 1], [111, 130, 2], [131, 999, 3]]),
    cons: assessable ? (alert ? 0 : 3) : null,
    temp: band(m.temp, [[0, 35.0, 3], [35.05, 36.0, 1], [36.05, 38.0, 0], [38.05, 39.0, 1], [39.05, 50, 2]]),
  };
  const known = Object.values(parts).filter(v => v != null);
  const news2 = Object.values(parts).every(v => v != null) ? known.reduce((a, b) => a + b, 0) : null;
  // qSOFA (REF singer2016): RR >= 22, SBP <= 100, altered mentation
  const qsofa = m.rr == null || m.sbp == null ? null : (m.rr >= 22 ? 1 : 0) + (m.sbp <= 100 ? 1 : 0) + (assessable && gcs < 15 ? 1 : 0);
  const shockIndex = m.hr != null && m.sbp ? +(m.hr / m.sbp).toFixed(2) : null;
  return { gcs: assessable ? gcs : null, news2, news2Parts: parts, qsofa, shockIndex };
}

/** History items a case can carry (scenario.history); they are told to the learner in the case summary. */
export const HISTORY_KEYS = Object.freeze(['dvtSigns', 'recentSurgery', 'priorVte', 'haemoptysis', 'malignancy', 'hormones', 'chf', 'hypertension', 'diabetes', 'strokeTia', 'vascular']);

/** Bedside risk scores from the case history plus what the monitor shows (null when a needed vital sign is not measured).
 *  - Wells score for pulmonary embolism (REF wells2000): DVT signs 3, PE the most likely diagnosis 3 (the clinician's
 *    judgement: `peLikely`), heart rate > 100 1.5, immobilisation or surgery in the last 4 weeks 1.5, previous DVT/PE 1.5,
 *    haemoptysis 1, cancer 1. Two-level reading: > 4 PE likely (imaging), <= 4 unlikely (D-dimer first).
 *  - PERC rule (REF kline2004): only for a low pretest probability; negative when all 8 items are absent (age >= 50,
 *    HR >= 100, SpO2 < 95 %, unilateral leg swelling, haemoptysis, recent surgery or trauma, previous VTE, hormones).
 *  - CHA2DS2-VA for stroke risk in atrial fibrillation (REF esc_af2024, which drops the sex category; CHA2DS2-VASc,
 *    REF lip2010, is also returned): heart failure 1, hypertension 1, age >= 75 2, diabetes 1, stroke/TIA 2, vascular
 *    disease 1, age 65-74 1 (female sex 1 in CHA2DS2-VASc). Anticoagulation recommended from 2, considered at 1. */
export function riskScores(p, { peLikely = false } = {}) {
  const h = p.scenario?.history || {}, m = p.monitor, age = p.spec.age, has = (k) => !!h[k];
  const hr = m.hr, spo2 = m.spo2;
  const wellsParts = { dvtSigns: has('dvtSigns') ? 3 : 0, peLikely: peLikely ? 3 : 0, hr: hr == null ? null : hr > 100 ? 1.5 : 0,
    immobile: has('recentSurgery') ? 1.5 : 0, priorVte: has('priorVte') ? 1.5 : 0, haemoptysis: has('haemoptysis') ? 1 : 0, malignancy: has('malignancy') ? 1 : 0 };
  const wells = wellsParts.hr == null ? null : Object.values(wellsParts).reduce((a, b) => a + b, 0);
  const percItems = { age: age >= 50, hr: hr == null ? null : hr >= 100, spo2: spo2 == null ? null : spo2 < 95, legSwelling: has('dvtSigns'),
    haemoptysis: has('haemoptysis'), surgery: has('recentSurgery'), priorVte: has('priorVte'), hormones: has('hormones') };
  const percUnknown = Object.values(percItems).some(v => v == null);
  const percPositive = Object.entries(percItems).filter(([, v]) => v).map(([k]) => k);
  const va = (has('chf') ? 1 : 0) + (has('hypertension') ? 1 : 0) + (age >= 75 ? 2 : age >= 65 ? 1 : 0) + (has('diabetes') ? 1 : 0) + (has('strokeTia') ? 2 : 0) + (has('vascular') ? 1 : 0);
  return {
    wells, wellsParts, wellsLikely: wells == null ? null : wells > 4,
    perc: percUnknown ? null : percPositive.length, percNegative: percUnknown ? null : percPositive.length === 0, percPositive,
    cha2ds2va: va, cha2ds2vasc: va + (p.spec.sex === 'F' ? 1 : 0),
  };
}

/** Train-of-four from the neuromuscular block (T1 depression d). The fourth twitch disappears at ~75 % T1 depression, the third
 *  at ~80 %, the second at ~90 % and the first at ~100 % (REF lee1975); a non-depolarising block fades (TOF ratio < 1), a
 *  depolarising (succinylcholine) block does not. Extubate at a TOF ratio >= 0.9 (REF naguib2018). The fade
 *  curve (1 - d)^6 is REF design. */
export function trainOfFour(p) {
  const d = p.drugs.effects({ inArrest: p.arrest.arrested }).nmb;
  const count = d >= 0.99 ? 0 : d >= 0.9 ? 1 : d >= 0.8 ? 2 : d >= 0.75 ? 3 : 4;
  const sux = p.drugs.ce('succinylcholine'), roc = p.drugs.ce('rocuronium');
  const depol = sux / 1.2 > roc / 1.2;
  const ratio = count < 4 ? null : depol ? 1 : +Math.pow(1 - d, 6).toFixed(2);
  return { count, ratio, depolarising: depol && d > 0.05, extubationReady: count === 4 && ratio >= 0.9 };
}

/** CRB-65 / CURB-65 for community-acquired pneumonia (REF lim2003): confusion, urea > 7 mmol/L (only once a renal result is
 *  back), respiratory rate >= 30, systolic < 90 or diastolic <= 60 mmHg, age >= 65. 0-1 home, 2 admit, >= 3 severe. */
export function curb65(p) {
  const m = p.monitor, s = scores(p);
  if (m.rr == null || m.sbp == null || s.gcs == null) return { crb65: null, curb65: null };
  const crb = (s.gcs < 15 ? 1 : 0) + (m.rr >= 30 ? 1 : 0) + (m.sbp < 90 || m.dbp <= 60 ? 1 : 0) + (p.spec.age >= 65 ? 1 : 0);
  const renal = p.labResults().filter(l => l.kind === 'renal').at(-1);
  return { crb65: crb, curb65: renal ? crb + (renal.values.urea > 7 ? 1 : 0) : null };
}
