// Scenario catalogue + guideline-derived scoring.
// A scenario is plain data + pure functions of the Patient (no wall clock, no Math.random), so a session is
// reproducible from (scenario id, patient spec, seed, event log).
//
// Scoring is derived ONLY from the replay log / patient state. Every criterion cites a registry id (references.js);
// criteria whose numeric target is a design choice say so (ref 'design') and are listed in docs/VALIDATION.md.
import { clamp } from './util.js';
import { DEMARCHE, scoreDemarche } from './demarche.js';
import { Ward, ABX, categorize } from './infection.js';
import { ECHO_VIEWS, reportTruth } from './echo.js';

// ----------------------------------------------------------------------------- helpers over the log
const ev = (p, type, pred = () => true) => p.log.filter(e => e.type === type && pred(e));
const first = (arr) => (arr.length ? arr[0] : null);
const arrestT0 = p => (p.arrest.arrestStarts && p.arrest.arrestStarts.length ? p.arrest.arrestStarts[0] : null);
const drugsGiven = (p, key) => p.drugs.log.filter(d => d.key === key);
const orderT = (p, what) => { const o = p.orders.find(x => x.what === what); return o ? o.t : null; };
/** seconds spent in the first arrest (to ROSC, or to now) */
const arrestDur = p => { const t0 = arrestT0(p); if (t0 === null) return 0; return (p.arrest.tRosc !== null && p.arrest.tRosc >= t0 ? p.arrest.tRosc : p.t) - t0; };
const inducted = p => ['propofol', 'etomidate', 'ketamine'].some(k => drugsGiven(p, k).length);
const lerpScore = (x, full, zero) => (x <= full ? 1 : x >= zero ? 0 : 1 - (x - full) / (zero - full));

/** Criterion factory: eval(p) -> { frac:0..1, detail:string } or null when not applicable */
const C = (id, label, weight, ref, evalFn) => ({ id, label, weight, ref, eval: evalFn });

export const criteria = {
  monitorAndAccess: (sMax = 120) => C('monitor_iv', 'Monitor, SpO2, IV access placed early', 6, 'aha2025_algo', p => {
    const t = Math.max(...['ecgLeads', 'spo2Probe'].map(k => ev(p, 'monitor.attach', e => e.items?.[k]).map(e => e.t)[0] ?? Infinity), first(ev(p, 'iv.access'))?.t ?? Infinity);
    return Number.isFinite(t) ? { frac: lerpScore(t, sMax, sMax * 3), detail: `complete at ${t.toFixed(0)} s` } : { frac: 0, detail: 'not completed' };
  }),
  firstCompression: (targetS = 30) => C('t_first_compression', `First compression within ${targetS} s of arrest`, 12, 'aha2025_part7', p => {
    const t0 = arrestT0(p); if (t0 === null) return null;
    const tc = p.cpr.firstCompressionT; if (tc === null || tc < t0) return { frac: tc === null ? 0 : 1, detail: tc === null ? 'no compressions' : 'started before arrest' };
    const d = tc - t0; return { frac: lerpScore(d, targetS, targetS * 4), detail: `${d.toFixed(0)} s` };
  }),
  firstShock: (targetS = 120) => C('t_first_shock', `First shock within ${targetS} s of VF/pVT onset`, 14, 'design', p => {
    const t0 = arrestT0(p); if (t0 === null || !['VF', 'VT_PULSELESS'].includes(p.arrest.events.find(e => e.type === 'rhythm' && e.t >= t0)?.to)) return null;
    const s = first(p.shockLog); if (!s) return { frac: 0, detail: 'no shock delivered' };
    const d = s.t - t0; return { frac: lerpScore(d, targetS, targetS * 3), detail: `${d.toFixed(0)} s` };
  }),
  shockEnergy: () => C('shock_energy', 'Biphasic shock energy >= 120 J, escalating or equal on repeats', 4, 'aha2025_part9', p => {
    if (!p.shockLog.length) return null;
    const ok = p.shockLog.filter((s, i) => s.energy >= 120 && (i === 0 || s.energy >= p.shockLog[i - 1].energy)).length;
    return { frac: ok / p.shockLog.length, detail: `${ok}/${p.shockLog.length} shocks` };
  }),
  cprQuality: () => C('cpr_quality', 'CPR quality: rate 100-120/min, depth 5-6 cm, CCF >= 60%', 14, 'aha2025_part7', p => {
    if (arrestT0(p) === null) return null;
    const c = p.cpr; if (c.goingS < 10) return p.arrest.roscCount ? null : { frac: 0, detail: 'insufficient compressions' };   // ROSC after < 10 s of CPR (e.g. first shock): too little CPR to grade
    const rate = c.goodRateS / c.goingS, depth = c.goodDepthS / c.goingS;
    const ccf = c.ccf;                                   // fraction of arrest time with compressions
    const ccfScore = clamp((ccf - 0.4) / 0.2, 0, 1);
    return { frac: (rate + depth + ccfScore) / 3, detail: `rate-in-range ${(rate * 100).toFixed(0)}%, depth-in-range ${(depth * 100).toFixed(0)}%, CCF ${(ccf * 100).toFixed(0)}%` };
  }),
  epinephrine: (shockable) => C('epi_timing', shockable ? 'Epinephrine 1 mg after initial shocks fail, repeated every 3-5 min' : 'Epinephrine 1 mg as soon as feasible (non-shockable), every 3-5 min', 8, 'aha2025_part9', p => {
    const t0 = arrestT0(p); if (t0 === null) return null;
    const epi = drugsGiven(p, 'epinephrine').filter(d => d.t >= t0);
    if (!epi.length) return shockable && p.shockLog.length <= 1 && p.arrest.roscCount ? null : { frac: 0, detail: 'none given' };   // ROSC after the first shock: epinephrine not yet indicated
    let sc = 0.5;
    if (shockable) {
      const s1 = first(p.shockLog);
      sc = epi[0].t >= (s1?.t ?? 0) && epi[0].t <= (s1?.t ?? 0) + 300 ? 1 : (epi[0].t < (s1?.t ?? 0) ? 0.5 : 0.6);
    } else sc = lerpScore(epi[0].t - t0, 120, 360);
    const gaps = epi.slice(1).map((d, i) => d.t - epi[i].t);
    if (gaps.length) sc *= gaps.filter(g => g >= 150 && g <= 330).length / gaps.length * 0.3 + 0.7;
    const big = epi.filter(d => d.amount > 1500).length; if (big) sc *= 0.5;          // high-dose epinephrine: Class 3 No Benefit
    return { frac: clamp(sc, 0, 1), detail: `${epi.length} dose(s), first at +${(epi[0].t - t0).toFixed(0)} s` };
  }),
  avoidClass3: () => C('avoid_class3', 'No Class 3 (No Benefit) drugs: vasopressin, routine calcium / bicarbonate', 8, 'aha2025_part9', p => {
    const t0 = arrestT0(p); if (t0 === null) return null;
    const hk = p.arrest.causes.hyperkalemia === true || p.arrest.causes.hyperkalemia === false;     // true/false both mean the cause existed
    const bad = [].concat(drugsGiven(p, 'vasopressin'), hk ? [] : drugsGiven(p, 'calciumChloride'), hk ? [] : p.drugs.log.filter(d => d.key === 'sodiumBicarbonate')).filter(d => d.t >= t0);
    return { frac: bad.length ? Math.max(0, 1 - 0.5 * bad.length) : 1, detail: bad.length ? `given: ${bad.map(b => b.key).join(', ')}` : 'none given' };
  }),
  airwayVent: () => C('airway_vent', 'Oxygen + ventilation: advanced airway or BVM; waveform capnography on', 8, 'aha2025_part9', p => {
    if (arrestDur(p) < 90 && p.arrest.roscCount) return null;
    const adv = p.airway.intubated || p.airway.device === 'sga';
    const caps = p.flags.capnography; const vented = p.vent.mode === 'ctrl' && p.vent.fio2 >= 0.6;
    const frac = (adv ? 0.4 : vented ? 0.2 : 0) + (vented ? 0.3 : 0) + (caps ? 0.3 : 0);
    return { frac, detail: `${adv ? p.airway.device : 'no advanced airway'}, ventilation ${vented ? 'on FiO2 ' + p.vent.fio2 : 'not set'}, capnography ${caps ? 'on' : 'off'}` };
  }),
  reversibleCause: (cause, label, fixedBy) => C('cause_' + cause, `Treat reversible cause: ${label}`, 10, 'aha2025_part9', p => {
    const cs = p.arrest.causes; if (cs[cause] === undefined) return null;
    return { frac: cs[cause] === false ? 1 : 0, detail: cs[cause] === false ? 'resolved' : `unresolved (${fixedBy})` };
  }),
  postRosc: (opts = {}) => C('post_rosc', 'Post-ROSC bundle: SpO2 90-98%, PaCO2 35-45, MAP >= 65, 12-lead, temperature control', 14, 'aha2025_part11', p => {
    if (!p.arrest.roscCount) return null;
    const r = p.resp, c = p.circ, hasEcg = orderT(p, 'ecg12') !== null, tm = orderT(p, 'temperature_control') !== null || p.therm.device != null;
    const items = [
      [r.sao2 * 100 >= 90 && r.sao2 * 100 <= 98.5, `SpO2 ${(r.sao2 * 100).toFixed(0)}%`],
      [r.paco2 >= 35 && r.paco2 <= 45, `PaCO2 ${r.paco2.toFixed(0)}`],
      [c.mapArt >= 65, `MAP ${c.mapArt.toFixed(0)}`],
      [hasEcg, '12-lead ' + (hasEcg ? 'done' : 'missing')],
      [tm, 'temperature control ' + (tm ? 'started' : 'not started')],
    ];
    if (opts.cathLab) items.push([orderT(p, 'cath_lab') !== null, 'cath lab activated']);
    return { frac: items.filter(i => i[0]).length / items.length, detail: items.map(i => (i[0] ? '+ ' : '- ') + i[1]).join('; ') };
  }),
  ecgEarly: (s = 600) => C('ecg_10min', '12-lead ECG within 10 min of contact', 12, 'acc_aha_acs', p => {
    const t = orderT(p, 'ecg12'); return t === null ? { frac: 0, detail: 'not obtained' } : { frac: lerpScore(t, s * 0.5, s * 1.5), detail: `at ${t.toFixed(0)} s` };
  }),
  aspirin: () => C('aspirin', 'Aspirin 162-325 mg given', 6, 'acc_aha_acs', p => {
    const o = p.orders.find(x => x.what === 'aspirin'); return o ? { frac: o.mg >= 162 && o.mg <= 325 ? 1 : 0.5, detail: `${o.mg ?? '?'} mg` } : { frac: 0, detail: 'not given' };
  }),
  noRoutineOxygen: () => C('no_routine_o2', 'Oxygen only if SpO2 < 90%', 4, 'acc_aha_acs', p => {
    const t0 = arrestT0(p) ?? Infinity;                // after ROSC oxygen is titrated to 90-98% and is expected
    const o = ev(p, 'o2.mask', e => e.fio2 > 0.21 && e.t < t0); if (!o.length) return { frac: 1, detail: 'no oxygen given' };
    return { frac: o[0].spo2Before != null && o[0].spo2Before < 90 ? 1 : 0.2, detail: 'oxygen given with SpO2 >= 90%' };
  }),
  nitroSafe: () => C('nitro_safe', 'Nitroglycerin only with adequate blood pressure (SBP >= 100)', 4, 'acc_aha_acs', p => {
    const n = drugsGiven(p, 'nitroglycerin'); if (!n.length) return { frac: 1, detail: 'none given' };
    return { frac: p.circ.sbp >= 90 || p.arrest.arrested ? 1 : 0, detail: 'given' };
  }),
  cathLab: () => C('cath_lab', 'Cath-lab activation for STEMI', 8, 'acc_aha_acs', p => (orderT(p, 'cath_lab') !== null ? { frac: 1, detail: `at ${orderT(p, 'cath_lab').toFixed(0)} s` } : { frac: 0, detail: 'not activated' })),
  survival: (label = 'Patient alive and stable at end', { requireIntubated = false } = {}) => C('outcome', label, 10, 'design', p => requireIntubated && !p.airway.intubated ? { frac: 0, detail: 'airway not secured' } : ({ frac: p.arrest.arrested ? 0 : (p.circ.mapArt >= 65 && p.resp.sao2 >= 0.9 ? 1 : 0.4), detail: p.arrest.arrested ? 'still in arrest' : `MAP ${p.circ.mapArt.toFixed(0)}, SpO2 ${(p.resp.sao2 * 100).toFixed(0)}%` })),
  // anaesthesia / RSI
  preoxygenation: () => C('preox', 'Pre-oxygenation: FiO2 ~1.0 until end-tidal O2 >= 0.90, head-up 25-30 deg', 14, 'weingart2012', p => {
    const m = ev(p, 'o2.mask', e => e.fio2 >= 0.9); const up = p.headUp;
    const etO2 = p.preoxEtO2Max ?? 0;
    return { frac: (m.length ? 0.4 : 0) + clamp((etO2 - 0.6) / 0.3, 0, 1) * 0.4 + (up ? 0.2 : 0), detail: `max ETO2 ${(etO2 * 100).toFixed(0)}%, head-up ${up ? 'yes' : 'no'}` };
  }),
  induction: () => C('induction', 'Induction + muscle relaxant before laryngoscopy; propofol 1.2-3.2 mg/kg lean body mass', 12, 'design', p => {
    const prop = drugsGiven(p, 'propofol'), hyp = ['propofol', 'etomidate', 'ketamine'].some(k => drugsGiven(p, k).length), nmb = ['rocuronium', 'succinylcholine'].some(k => drugsGiven(p, k).length);
    const mgPerLbm = prop.length ? prop.reduce((s, d) => s + d.amount, 0) / p.body.lbm : null;
    const doseOk = mgPerLbm === null ? (hyp ? 1 : 0) : (mgPerLbm >= 1.2 && mgPerLbm <= 3.2 ? 1 : 0);
    return { frac: (hyp ? 0.3 : 0) + (hyp && doseOk ? 0.2 : 0) + (nmb ? 0.5 : 0), detail: `hypnotic ${hyp ? 'yes' : 'no'}${mgPerLbm !== null ? ` (${mgPerLbm.toFixed(1)} mg/kg LBM)` : ''}, relaxant ${nmb ? 'yes' : 'no'}` };
  }),
  intubation: () => C('intubation', 'Tracheal intubation first pass, confirmed with capnography', 14, 'design', p => {
    if (!p.airway.intubated) return { frac: 0, detail: 'not intubated' };
    const fails = p.failedAttempts || 0; return { frac: (fails === 0 ? 1 : fails === 1 ? 0.6 : 0.3) * (p.flags.capnography ? 1 : 0.6), detail: `${p.attempts || 1} attempt(s), capnography ${p.flags.capnography ? 'on' : 'off'}` };
  }),
  noHypoxia: () => C('spo2_nadir', 'SpO2 never below 90% (nadir)', 14, 'weingart2012', p => {
    if (!inducted(p)) return { frac: 0, detail: 'induction not performed' };
    const n = p.minSpo2 ?? 100; return { frac: lerpScore(100 - n, 10, 40), detail: `nadir ${n.toFixed(0)}%` };
  }),
  hemodynamics: () => C('hemodynamics', 'MAP >= 65 mmHg throughout (nadir tracked)', 12, 'design', p => {
    if (!inducted(p)) return { frac: 0, detail: 'induction not performed' };
    const n = p.minMap ?? 100; return { frac: clamp((n - 40) / 25, 0, 1), detail: `MAP nadir ${n.toFixed(0)}` };
  }),
  // trauma
  hemorrhageControl: (targetS = 300) => C('bleed_control', `Haemorrhage controlled within ${targetS / 60} min`, 22, 'atls', p => {
    const t = p.bleedControlledAt; return t === null ? { frac: 0, detail: 'never controlled' } : { frac: lerpScore(t, targetS, targetS * 3), detail: `at ${t.toFixed(0)} s` };
  }),
  bloodNotCrystalloid: () => C('blood_vs_crystalloid', 'Blood products preferred to large-volume crystalloid (< 1 L)', 14, 'atls', p => {
    const crys = ev(p, 'fluid.bolus').reduce((s, e) => s + (e.volumeL || 0), 0), blood = ev(p, 'blood.transfuse').length;
    if (!blood && !crys) return { frac: 0, detail: 'no volume resuscitation given' };
    return { frac: (blood > 0 ? 0.6 : 0) + (crys <= 1 ? 0.4 : crys <= 2 ? 0.2 : 0), detail: `${blood} unit(s) blood, ${crys.toFixed(1)} L crystalloid` };
  }),
  warm: () => C('keep_warm', 'Prevent hypothermia (core temperature >= 36 C)', 6, 'design', p => ({ frac: clamp((p.therm.tc - 34) / 2, 0, 1), detail: `core ${p.therm.tc.toFixed(1)} C` })),
  ivAccess: () => C('iv_access', 'IV access established early', 6, 'atls', p => { const e = first(ev(p, 'iv.access')); return e ? { frac: lerpScore(e.t, 60, 240), detail: `at ${e.t.toFixed(0)} s` } : { frac: 0, detail: 'no IV' }; }),
  hemorrhageResus: () => C('resus_target', 'Blood loss limited (peak <= 15-40% of volume, graded) and perfusion restored at end (shock index < 1.0, Hb >= 7 g/dL)', 14, 'atls', p => {
    const peak = p.peakLost ?? p.vol.fractionLost, si = p.circ.hr / Math.max(1, p.circ.sbp);
    const lossScore = lerpScore(peak, 0.15, 0.40), perf = (si < 1.0 ? 0.5 : si < 1.2 ? 0.25 : 0) + (p.vol.hb >= 7 ? 0.5 : 0);
    return { frac: 0.6 * lossScore + 0.4 * perf, detail: `peak loss ${(peak * 100).toFixed(0)}%, shock index ${si.toFixed(2)}, Hb ${p.vol.hb.toFixed(1)}` };
  }),
  // opioid
  naloxone: () => C('naloxone', 'Naloxone 0.4-2 mg IV with ventilation support', 12, 'design', p => {
    const n = drugsGiven(p, 'naloxone'); if (!n.length) return { frac: 0, detail: 'not given' };
    const v = n[0].amount; const dose = v >= 200 && v <= 2000 ? 1 : 0.5;
    return { frac: dose * (p.vent.mode === 'ctrl' || p.airway.device !== 'none' ? 1 : 0.6), detail: `${v} mcg at ${n[0].t.toFixed(0)} s` };
  }),
  // surgical gestures
  examinedChest: () => C('chest_exam', 'Examine the chest (inspection, percussion, auscultation) or scan it (lung sliding) before acting', 10, 'atls', p => {
    const e = p.log.filter(x => x.type === 'exam.chest' || x.type === 'exam.pocus'); if (!e.length) return { frac: 0, detail: 'no chest examination' };
    const d = p.chest.tensionT0 === null ? 0 : e[0].t - p.chest.tensionT0;
    return { frac: lerpScore(d, 60, 240), detail: `first at ${e[0].t.toFixed(0)} s` };
  }),
  tensionRelieved: () => C('tension_relief', 'Tension relieved within 90 s of onset (needle or finger thoracostomy / drain), zero after 7 min', 22, 'ahmad2025', p => {
    const c = p.chest; if (!c.side) return null;
    if (c.tensionT0 === null) return c.venting ? { frac: 1, detail: 'tension never developed (drained early)' } : { frac: 0, detail: 'no decompression' };
    if (c.reliefT === null) return { frac: 0, detail: `tension from ${c.tensionT0.toFixed(0)} s, never relieved` };
    const d = c.reliefT - c.tensionT0; return { frac: lerpScore(d, 90, 420), detail: `relieved ${d.toFixed(0)} s after onset` };
  }),
  needleTechnique: () => C('needle_technique', 'Needle decompression: correct side, catheter long enough for the chest wall, and no cardiac risk on the left', 12, 'ahmad2025', p => {
    const a = p.chest.attempts.filter(x => x.kind === 'needle'); const tubeFirst = p.chest.attempts.find(x => x.kind === 'tube' && x.ok);
    if (!a.length) return tubeFirst ? null : { frac: 0, detail: 'no needle attempt' };
    const f = a[0]; let frac = f.relieved ? 1 : f.wrongSide ? 0 : f.reached ? 0.3 : 0.3;
    if (f.risk) frac *= 0.5;
    const extra = a.length - 1; if (extra > 0) frac *= Math.max(0.5, 1 - 0.2 * extra);
    return { frac, detail: `${a.length} attempt(s); first: ${f.side} ${f.site} ${f.needleMm} mm -> ${f.relieved ? 'released air' : f.reached ? 'pleura reached, no air' : 'too short'}${f.risk ? ', cardiac risk' : ''}` };
  }),
  chestDrain: () => C('chest_drain', 'Definitive intercostal drain placed after the needle (working, correct side)', 14, 'ahmad2025', p => {
    const c = p.chest; if (!c.side) return null;
    const tub = c.tube; if (!tub) return { frac: 0, detail: 'no drain' };
    return { frac: tub.ok ? 1 : tub.malposition ? 0.3 : 0.1, detail: tub.ok ? `${tub.fr} Fr, working` : tub.malposition ? 'malpositioned' : 'wrong side' };
  }),
  spo2Nadir: (ref = 'atls') => C('spo2_nadir_live', 'SpO2 nadir (90% full marks, below 60% none)', 10, ref, p => { const n = p.minSpo2 ?? 100; return { frac: lerpScore(100 - n, 10, 40), detail: `nadir ${n.toFixed(0)}%` }; }),
  mapNadir: () => C('map_nadir_live', 'MAP nadir (>= 65 mmHg full marks, below 40 none)', 10, 'design', p => { const n = p.minMap ?? 100; return { frac: clamp((n - 40) / 25, 0, 1), detail: `MAP nadir ${n.toFixed(0)}` }; }),
  declareCico: () => C('declare_cico', "Declare 'can't intubate, can't oxygenate' and call for help within 2 min of the desaturation", 8, 'das2015', p => {
    const o = orderT(p, 'declare_cico'); if (o === null) return { frac: 0, detail: 'never declared' };
    const d0 = p.cicoDesatT ?? 0; return { frac: lerpScore(o - d0, 120, 300), detail: `at ${o.toFixed(0)} s` };
  }),
  limitAttempts: () => C('limit_attempts', 'Limit laryngoscopy attempts (max 3 incl. one by the most experienced), then move on', 8, 'das2015', p => {
    if (!p.airway.intubated) return { frac: 0, detail: 'airway never secured' };
    const n = p.attempts || 0; return { frac: n <= 2 ? 1 : n === 3 ? 0.6 : 0.2, detail: `${n} laryngoscopy attempt(s)` };
  }),
  fonaTiming: () => C('fona_timing', 'Front-of-neck access started within 60 s of the SpO2 falling below 90% (zero after 4 min)', 20, 'das2015', p => {
    const s = p.fonaStartT;
    if (s == null) return { frac: 0, detail: 'no front-of-neck access' };
    const d = s - (p.cicoDesatT ?? s); return { frac: lerpScore(d, 60, 240), detail: `started ${d.toFixed(0)} s after SpO2 < 90%` };
  }),
  fonaTechnique: () => C('fona_technique', 'Scalpel-bougie-tube (vertical incision when the landmarks are impalpable)', 14, 'das2015', p => {
    const first = p.log.find(x => x.type === 'procedure.cricothyroidotomy'); if (!first) return { frac: 0, detail: 'none performed' };
    const tech = first.technique ?? 'scalpel_bougie', app = first.approach ?? 'palpate', pal = p.neck.palpable || p.neck.marked;
    let frac = tech === 'scalpel_bougie' ? 1 : 0.5;      // REF umek2020, nap4 (cannula fails often); rees2019 shows the opposite in novices, so not a zero
    if (!pal && app !== 'vertical') frac *= 0.6;
    return { frac, detail: `${tech}, ${app}${pal ? '' : ' (landmarks impalpable)'}` };
  }),
  fonaAchieved: () => C('fona_achieved', 'Tracheal access achieved and ventilation restored through it', 14, 'umek2020', p => {
    const f = p.neck.fona; if (!f) return { frac: 0, detail: 'no access' };
    const vent = p.vent.mode === 'ctrl' && p.vent.fio2 >= 0.6;
    return { frac: (f.kind === 'tube' ? 0.6 : f.displaced ? 0.1 : 0.4) + (vent ? 0.4 : 0), detail: `${f.kind}${f.displaced ? ' (displaced)' : ''}, ventilation ${vent ? 'on' : 'not set'}, ${p.neck.attempts.length} attempt(s)` };
  }),
  // tracheal tube problems (DOPE: displacement, obstruction, pneumothorax, equipment)
  fio2First: (s = 60) => C('fio2_first', `FiO2 raised to 1.0 within ${s} s of the desaturation`, 8, 'design', p => {
    const t = first(ev(p, 'vent.set', e => (e.settings?.fio2 ?? 0) >= 0.9))?.t ?? null; return t === null ? { frac: 0, detail: 'FiO2 not increased' } : { frac: lerpScore(t, s, s * 4), detail: `at ${t.toFixed(0)} s` };
  }),
  bronchoscopy: (s = 240) => C('bronch_look', `Tube position checked with the bronchoscope within ${s / 60} min`, 12, 'design', p => {
    const t = first(ev(p, 'bronch.insert'))?.t ?? null; return t === null ? { frac: 0, detail: 'no bronchoscopy' } : { frac: lerpScore(t, s, s * 2.5), detail: `at ${t.toFixed(0)} s` };
  }),
  tubeRepositioned: (s = 300) => C('tube_reposition', `Endobronchial tube pulled back into the trachea within ${s / 60} min`, 16, 'design', p => {
    const t = p.tubeFixedT ?? null; return t === null ? { frac: 0, detail: `still in the right main bronchus (${p.tube.depth} cm)` } : { frac: lerpScore(t, s, s * 2.5), detail: `at ${t.toFixed(0)} s` };
  }),
  tubeDepthFinal: () => C('tube_depth_final', 'Final tube tip 2-6 cm above the carina (neither endobronchial nor at the cords)', 10, 'design', p => {
    const d = p.tube.tipAboveCarina; if (d === null) return { frac: 0, detail: 'no tracheal tube' };
    return { frac: d >= 2 && d <= 6 ? 1 : d > -0.5 && d <= 7 ? 0.5 : 0, detail: `tip ${d} cm above the carina at ${p.tube.depth} cm` };
  }),
  secretionsCleared: () => C('secretions', 'Obstructing secretions aspirated through the scope (right bronchial tree)', 8, 'design', p => {
    const r = ev(p, 'bronch.suction', e => e.where === 'R').length, n = ev(p, 'bronch.suction').length;   // each pass through the scope clears most of the region (ett.js)
    return { frac: r ? 1 : n ? 0.4 : 0, detail: `${r} pass(es) in the right bronchi, ${n} in total` };
  }),
  /** Procedure démarche (order, preparation, confirmation) of a procedure; not applicable until the procedure is performed. */
  demarche: (id, weight = 8) => C('demarche_' + id, DEMARCHE[id].label, weight, DEMARCHE[id].ref, p => scoreDemarche(p, id)),
  earlyVentilation: (s = 90) => C('early_vent', `Assisted ventilation started within ${s} s`, 14, 'aha2025_part9', p => {
    const t = first(ev(p, 'vent.set', e => e.settings?.mode === 'ctrl'))?.t ?? null; return t === null ? { frac: 0, detail: 'not started' } : { frac: lerpScore(t, s, s * 4), detail: `at ${t.toFixed(0)} s` };
  }),
};


// ----------------------------------------------------------------------------- focused echocardiography
/** Tolerance of a recorded measurement against the true value (design: about the spread a trainee should reach). REF design */
const ECHO_TOL = { lvef: 10, lvedd: 5, tapse: 3, rv_basal: 4, ivc_max: 3, ivc_min: 3, effusion: 4 };
const lastOf = (arr, pred) => { for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i]; return null; };
export const echoCriteria = {
  views: () => C('echo_views', 'All five FoCUS views acquired with diagnostic quality (PLAX, PSAX, A4C, subcostal, IVC)', 25, 'via2014', p => {
    const ok = ECHO_VIEWS.filter(v => p.echo.views.some(x => x.view === v && x.quality >= 0.7));
    return { frac: ok.length / ECHO_VIEWS.length, detail: ok.length ? `${ok.length}/5: ${ok.join(', ')}` : 'no view saved' };
  }),
  order: () => C('echo_order', 'Systematic sequence: the views taken in the protocol order', 5, 'design', p => {
    const seq = []; for (const x of p.echo.views) if (x.quality >= 0.7 && !seq.includes(x.view)) seq.push(x.view);
    if (seq.length < 2) return { frac: 0, detail: 'fewer than two views' };
    let inOrder = 0; for (let i = 1; i < seq.length; i++) if (ECHO_VIEWS.indexOf(seq[i]) > ECHO_VIEWS.indexOf(seq[i - 1])) inOrder++;
    return { frac: (inOrder / (seq.length - 1)) * (seq.length / ECHO_VIEWS.length), detail: seq.join(' > ') };
  }),
  measures: (extra = []) => C('echo_measures', 'Measurements within tolerance: LVEF (+-10 points), TAPSE (+-3 mm), IVC maximum and minimum (+-3 mm)' + (extra.includes('effusion') ? ', effusion (+-4 mm)' : ''), 25, 'design', p => {
    const need = ['lvef', 'tapse', 'ivc_max', 'ivc_min', ...extra];
    let sum = 0; const det = [];
    for (const w of need) {
      const m = lastOf(p.echo.measures, x => x.what === w);
      if (!m) { det.push(`${w} -`); continue; }
      const err = Math.abs(m.value - m.truth), tol = ECHO_TOL[w];
      sum += err <= tol ? 1 : err >= 2 * tol ? 0 : 1 - (err - tol) / tol;
      det.push(`${w} ${m.value} (${m.truth})`);
    }
    return { frac: sum / need.length, detail: det.join(', ') };
  }),
  interpretation: () => C('echo_interp', 'Report: LV function, RV size, RA pressure from the IVC and pericardium graded with the guideline cut-offs', 25, 'lang2015', p => {
    const r = lastOf(p.echo.reports, () => true); if (!r) return { frac: 0, detail: 'no report' };
    const key = reportTruth(r.state), f = ['lv', 'rv', 'rap', 'peri'], ok = f.filter(k => r[k] === key[k]);
    return { frac: ok.length / f.length, detail: f.map(k => `${k} ${r[k] ?? '-'}${r[k] === key[k] ? '' : ` (expected ${key[k]})`}`).join(', ') };
  }),
  diagnosis: () => C('echo_dx', 'Mechanism of shock identified from the FoCUS pattern', 20, 'via2014', p => {
    const r = lastOf(p.echo.reports, () => true); if (!r) return { frac: 0, detail: 'no report' };
    const want = reportTruth(r.state).dx; return { frac: r.dx === want ? 1 : 0, detail: r.dx === want ? want : `${r.dx ?? '-'} (expected ${want})` };
  }),
};
const echoScore = (extra) => () => [echoCriteria.views(), echoCriteria.order(), echoCriteria.measures(extra), echoCriteria.interpretation(), echoCriteria.diagnosis()];
const ECHO_LEARN = ['FoCUS is qualitative or semiquantitative: grade the LV as hyperkinetic, normokinetic, hypokinetic or severely hypokinetic, and look at each target in at least two views (Via 2014).',
  'IVC (spontaneous breathing): <= 21 mm collapsing > 50 % with a sniff = RA pressure about 3 mmHg; > 21 mm collapsing < 50 % = about 15 mmHg; otherwise 8 mmHg (Rudski 2010). Under positive-pressure ventilation collapse cannot estimate RA pressure.'];
const echoInit = (p) => { p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = true; p.nibp = { sbp: p.circ.sbp, dbp: p.circ.dbp, t: 0, valid: true }; };

// ----------------------------------------------------------------------------- scenarios
const hardStopAt = (t) => ({ t, run: p => { p.ended = true; } });

export const SCENARIOS = {
  stemi_vf: {
    id: 'stemi_vf', title: 'Chest pain -> STEMI -> ventricular fibrillation', difficulty: 'intermediate', durationS: 1500, kind: 'ACLS',
    summary: 'A 58-year-old man with 40 min of crushing chest pain. Anterior STEMI. Recognise it, treat per ACS guideline, and be ready: he will fibrillate.',
    spec: { sex: 'M', age: 58, heightCm: 178, weightKg: 92, lvFunction: 0.82, causes: [] },
    startMonitored: false, orderResult: (what) => what === 'ecg12' ? { rhythm: 'NSR', findings: 'ST elevation V1-V5, reciprocal inferior depression: anterior STEMI', stemi: true } : what === 'troponin' ? { pending: true, note: 'high-sensitivity troponin pending (design)' } : null,
    init(p) { p.arrest.causes.coronary_thrombosis = true; p.stElevation = true; },
    timeline: [{ t: 600, run: p => { p.notes.push({ t: p.t, text: 'ventricular fibrillation' }); p.arrest.arrest('VF', p.t); } }],
    score: () => [criteria.monitorAndAccess(180), criteria.ecgEarly(), criteria.aspirin(), criteria.noRoutineOxygen(), criteria.nitroSafe(), criteria.cathLab(),
      criteria.firstCompression(30), criteria.firstShock(120), criteria.shockEnergy(), criteria.cprQuality(), criteria.epinephrine(true), criteria.avoidClass3(), criteria.airwayVent(), criteria.postRosc({ cathLab: true }), criteria.demarche('defib')],
    learning: ['Obtain a 12-lead ECG within 10 min of contact.', 'Aspirin 162-325 mg; oxygen only if SpO2 < 90%; nitroglycerin only when blood pressure allows.', 'Pads on before the rhythm degrades; shock VF immediately, then 2-min CPR cycles.', 'Post-ROSC: titrate oxygen to 90-98%, avoid hypotension, activate the cath lab.'],
  },
  witnessed_vf: {
    id: 'witnessed_vf', title: 'Witnessed VF in a monitored bed', difficulty: 'beginner', durationS: 900, kind: 'ACLS',
    summary: 'A 62-year-old man on telemetry collapses. Rhythm: ventricular fibrillation. Early compressions and early defibrillation decide the outcome.',
    spec: { sex: 'M', age: 62, heightCm: 175, weightKg: 85, causes: [] },
    init(p) { p.flags.ecgLeads = true; p.flags.spo2Probe = true; },
    timeline: [{ t: 20, run: p => { p.notes.push({ t: p.t, text: 'collapse - ventricular fibrillation' }); p.arrest.arrest('VF', p.t); } }],
    score: () => [criteria.firstCompression(30), criteria.firstShock(90), criteria.shockEnergy(), criteria.cprQuality(), criteria.epinephrine(true), criteria.avoidClass3(), criteria.airwayVent(), criteria.postRosc(), criteria.demarche('defib')],
    learning: ['Start compressions immediately, attach pads, shock as soon as charged.', 'Epinephrine after initial shocks fail; vasopressin and routine calcium/bicarbonate are not recommended.'],
  },
  opioid_pea: {
    id: 'opioid_pea', title: 'Opioid overdose: respiratory arrest to PEA', difficulty: 'intermediate', durationS: 900, kind: 'ACLS',
    summary: 'A 34-year-old woman found unresponsive, breathing 3/min, SpO2 falling. Oxygenation and ventilation first; naloxone adjunct. If missed, hypoxic PEA follows.',
    spec: { sex: 'F', age: 34, heightCm: 168, weightKg: 62, causes: [] },
    preRunS: 20,
    init(p) { p.drugs.bolus('fentanyl', 400, 0); p.flags.spo2Probe = false; },   // the opioid does not block ROSC once oxygenated: the arrest cause is hypoxia (AHA 2025: standard resuscitation first, naloxone is an adjunct)
    timeline: [],
    score: () => [criteria.monitorAndAccess(120), criteria.earlyVentilation(90), criteria.naloxone(), criteria.firstCompression(30), criteria.cprQuality(), criteria.epinephrine(false), criteria.avoidClass3(), criteria.reversibleCause('hypoxia', 'hypoxia', 'oxygenate and ventilate'), criteria.survival()],
    learning: ['In respiratory arrest from opioids, ventilation takes priority; naloxone does not replace airway care.', 'If pulseless: CPR + epinephrine; hypoxia is the reversible cause.'],
  },
  obese_rsi: {
    id: 'obese_rsi', title: 'Rapid-sequence induction, BMI 45', difficulty: 'advanced', durationS: 900, kind: 'Anaesthesia',
    summary: 'A 41-year-old man (172 cm, 135 kg) needs emergency laparotomy. Pre-oxygenate, induce, secure the airway. Obesity shortens safe apnoea time and doubles the difficulty.',
    spec: { sex: 'M', age: 41, heightCm: 172, weightKg: 135, causes: [] },
    init(p) { p.flags.ecgLeads = true; p.flags.spo2Probe = true; p.flags.nibp = true; p.flags.ivAccess = true; p.nibp = { sbp: p.circ.sbp, dbp: p.circ.dbp, t: 0, valid: true }; },
    timeline: [],
    track(p) {
      p.minSpo2 = Math.min(p.minSpo2 ?? 100, p.resp.sao2 * 100); p.minMap = Math.min(p.minMap ?? 999, p.circ.mapArt);
      if (p.o2 && p.o2.fio2 >= 0.9 && !p.airway.intubating) p.preoxEtO2Max = Math.max(p.preoxEtO2Max ?? 0, p.resp.etO2);
    },
    score: () => [criteria.preoxygenation(), criteria.induction(), criteria.intubation(), criteria.noHypoxia(), criteria.hemodynamics(), criteria.airwayVent(), criteria.survival('Ventilating and haemodynamically stable at end', { requireIntubated: true }), criteria.demarche('rsi')],
    learning: ['Head-up 25-30 deg, FiO2 ~1.0 for 3+ min (or until ETO2 >= 0.9); consider apnoeic oxygenation.', 'Dose hypnotics to lean body mass; expect a shorter time to desaturation as BMI rises.', 'After intubation: ventilate with PEEP to recruit atelectatic lung.'],
  },
  hemorrhage: {
    id: 'hemorrhage', title: 'Haemorrhagic shock (penetrating thigh wound)', difficulty: 'intermediate', durationS: 1200, kind: 'Trauma',
    summary: 'A 28-year-old man with a bleeding femoral wound, pale, tachycardic. Control the bleeding, give blood, keep him warm. Time is blood.',
    spec: { sex: 'M', age: 28, heightCm: 180, weightKg: 82, causes: [] },
    init(p) { p.flags.ecgLeads = true; p.flags.spo2Probe = true; },
    timeline: [{ t: 0, run: p => { p.vol.setBleed(110); p.notes.push({ t: p.t, text: 'active haemorrhage 110 mL/min' }); } }],
    track(p) { p.minMap = Math.min(p.minMap ?? 999, p.circ.mapArt); p.peakLost = Math.max(p.peakLost ?? 0, p.vol.fractionLost); },
    score: () => [criteria.ivAccess(), criteria.hemorrhageControl(300), criteria.bloodNotCrystalloid(), criteria.warm(), criteria.hemorrhageResus(), criteria.survival()],
    learning: ['Direct pressure / tourniquet first; haemorrhage control precedes fluids.', 'Early blood products; limit crystalloid; avoid hypothermia (lethal triad).'],
  },
};

SCENARIOS.tension_ptx = {
  id: 'tension_ptx', title: 'Trauma: collapse after intubation (tension pneumothorax)', difficulty: 'intermediate', durationS: 900, kind: 'Trauma',
  summary: 'A 31-year-old man, motorcycle crash, right chest trauma, intubated at the scene and ventilated. Since arrival the blood pressure is falling, the airway pressure is rising and the SpO2 is slipping. Find the cause and relieve it before he arrests.',
  spec: { sex: 'M', age: 31, heightCm: 183, weightKg: 88, causes: [] },
  startMonitored: true,
  init(p) {
    p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = p.flags.capnography = p.flags.ivAccess = true;
    p.airway = { device: 'ett', patency: 1, intubated: true };
    p.vent = { mode: 'ctrl', rate: 14, vt: Math.round(7 * p.body.pbw), fio2: 0.6, peep: 5, seal: 0.97, efficiency: 1 };
    p.drugs.bolus('ketamine', 100, 0); p.drugs.bolus('rocuronium', 80, 0);
    p.chest.setPneumothorax({ side: 'R', air: 0.45, valve: true, leak: 0.06 });   // a simple right pneumothorax from rib fractures, now ventilated with positive pressure
    p.nibp = { sbp: 120, dbp: 75, t: 0, valid: true };
  },
  timeline: [],
  track(p) { p.minSpo2 = Math.min(p.minSpo2 ?? 100, p.resp.sao2 * 100); p.minMap = Math.min(p.minMap ?? 999, p.circ.mapArt); },
  score: () => [criteria.examinedChest(), criteria.tensionRelieved(), criteria.needleTechnique(), criteria.chestDrain(), criteria.spo2Nadir(), criteria.mapNadir(), criteria.survival('Alive with a circulation at the end'), criteria.demarche('chest')],
  learning: ['Ventilated trauma patient, rising airway pressure, falling BP and SpO2: think tension pneumothorax before anything else; do not wait for an X-ray.',
    'Decompress on the side of the absent breath sounds: a long catheter (7-8 cm) at the 5th intercostal space anterior/mid-axillary line, or the 2nd space mid-clavicular line; chest wall thickness grows with BMI and a 5 cm catheter fails in about a third of adults.',
    'The needle is a bridge: follow it with a large-bore intercostal drain. A blocked catheter lets the tension come back.',
    'Right-sided tension compromises the circulation earlier than left-sided tension.'],
};
SCENARIOS.cico = {
  id: 'cico', title: "Can't intubate, can't oxygenate (BMI 36)", difficulty: 'advanced', durationS: 600, kind: 'Anaesthesia',
  summary: "A 56-year-old woman (165 cm, 98 kg) for emergency laparotomy has just been induced and paralysed. Laryngoscopy will fail, the facemask and the supraglottic airway do not ventilate, and the SpO2 is falling. Declare it and perform emergency front-of-neck access.",
  spec: { sex: 'F', age: 56, heightCm: 165, weightKg: 98, causes: [] },
  preRunS: 150,
  init(p) {
    p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = p.flags.capnography = p.flags.ivAccess = true;
    p.nibp = { sbp: 128, dbp: 78, t: 0, valid: true };
    p.o2 = { fio2: 1, seal: 0.95 };                                                   // pre-oxygenated for ~3 min, supine
    p.hard = { ett: 0.04, cap: 0 };                                                   // grade 4 view, and a mask / supraglottic seal that cannot ventilate through the obstruction
  },
  timeline: [{ t: 0, run: p => { p.drugs.bolus('propofol', 160, p.t); p.drugs.bolus('rocuronium', 100, p.t); p.notes.push({ t: p.t, text: 'induction' }); } }],
  track(p) {
    p.minSpo2 = Math.min(p.minSpo2 ?? 100, p.resp.sao2 * 100); p.minMap = Math.min(p.minMap ?? 999, p.circ.mapArt);
    if (p.cicoDesatT == null && p.resp.sao2 < 0.9) p.cicoDesatT = p.t;
    if (p.fonaStartT == null) { const f = p.log.find(x => x.type === 'procedure.cricothyroidotomy'); if (f) p.fonaStartT = f.t; }
  },
  score: () => [criteria.declareCico(), criteria.limitAttempts(), criteria.fonaTiming(), criteria.fonaTechnique(), criteria.fonaAchieved(), criteria.noHypoxia(), criteria.airwayVent(), criteria.survival('Oxygenating and stable at end (secured airway)', { requireIntubated: true }), criteria.demarche('fona')],
  learning: ["Plan A-B-C-D (DAS 2015): maximum three attempts at laryngoscopy, one supraglottic device, optimise the mask, then declare CICO and go to the neck - do not keep trying the mouth while the SpO2 falls.",
    'Scalpel-bougie-tube: transverse stab through the cricothyroid membrane, rotate the blade, slide the bougie, railroad a 6.0 cuffed tube. If you cannot feel the landmarks: 8-10 cm vertical midline incision, blunt dissection, then the membrane.',
    'Landmark palpation finds the cricothyroid membrane in only about 4 of 10 obese women: mark it with ultrasound before induction when you expect a difficult airway.',
    'A narrow cannula needs a high-pressure source and an expiratory path; with a completely obstructed upper airway it risks barotrauma (tension pneumothorax).'],
};

SCENARIOS.tube_desat = {
  id: 'tube_desat', title: 'Desaturation in an intubated patient (tube too deep)', difficulty: 'intermediate', durationS: 900, kind: 'Anaesthesia',
  summary: 'A 64-year-old woman (160 cm, 70 kg), intubated in the emergency room 20 min ago and moved to the bed. Since the transfer the SpO2 is falling and the left chest barely moves. Find the cause with the bronchoscope and fix it.',
  spec: { sex: 'F', age: 64, heightCm: 160, weightKg: 70, causes: [] },
  startMonitored: true,
  init(p) {
    p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = p.flags.capnography = p.flags.ivAccess = true;
    p.airway = { device: 'ett', patency: 1, intubated: true };
    p.tube.place(p.tube.carinaDepth + 1);                                             // the tube slid 1 cm into the right main bronchus during the transfer
    p.tube.secr.R = 0.85; p.tube.secr.trachea = 0.45;                                  // and thick secretions sit in the right bronchial tree
    p.vent = { mode: 'ctrl', rate: 14, vt: Math.round(6 * p.body.pbw), fio2: 0.4, peep: 5, seal: 0.97, efficiency: 1 };
    p.drugs.bolus('propofol', 100, 0); p.drugs.bolus('rocuronium', 50, 0); p.drugs.infusion('propofol', 6);
    p.nibp = { sbp: 124, dbp: 70, t: 0, valid: true };
  },
  timeline: [],
  track(p) {
    p.minSpo2 = Math.min(p.minSpo2 ?? 100, p.resp.sao2 * 100);
    if (p.tubeFixedT == null && p.tube.placed && !p.tube.mainstem) p.tubeFixedT = p.t;
  },
  score: () => [criteria.fio2First(), criteria.bronchoscopy(), criteria.tubeRepositioned(), criteria.tubeDepthFinal(), criteria.secretionsCleared(), criteria.spo2Nadir('design'), criteria.survival('Oxygenating and stable at the end (tube in the trachea)', { requireIntubated: true }), criteria.demarche('bronch')],
  learning: ['A ventilated patient who desaturates: DOPE - Displacement (oesophagus, too deep, too high), Obstruction (secretions, kinking), Pneumothorax, Equipment. Give FiO2 1.0 first, then look.',
    'A tube that is too deep goes into the right main bronchus: the left chest barely moves and the SpO2 falls. The bronchoscope shows the carina missing or the right upper lobe opening at the tube tip.',
    'Pull the tube back until the tip sits 2-6 cm above the carina (the optimal depth at the teeth is about 0.1 x height + 4 cm), and note the new depth.',
    'Aspirate the secretions through the scope, keep each look short and keep FiO2 high while the scope is in the tube.'],
};


// ----------------------------------------------------------------------------- focused echocardiography cases (kind 'Echo'): a shocked or breathless patient, a probe, five views
SCENARIOS.echo_hypovolaemia = {
  id: 'echo_hypovolaemia', title: 'Focused echo: hypotension after a GI bleed', difficulty: 'beginner', durationS: 900, kind: 'Echo',
  summary: 'A 46-year-old man vomited blood twice this morning. He is pale, tachycardic and breathing spontaneously. Do a focused echo: five views, measure, and say why he is shocked.',
  spec: { sex: 'M', age: 46, heightCm: 178, weightKg: 76, causes: [] },
  preRunS: 560,
  init(p) { echoInit(p); p.vol.setBleed(p.body.bloodVolume * 1000 * 0.27 / (590 / 60)); },   // about 27 % of the blood volume lost before arrival (REF design)
  timeline: [{ t: 0, run: p => { p.vol.setBleed(0); p.nibp = { sbp: p.circ.sbp, dbp: p.circ.dbp, t: 0, valid: true }; } }],
  score: echoScore([]),
  learning: ['Hypovolaemic pattern: small, hyperdynamic ventricles and a small IVC (< 10 mm, collapsing) in a spontaneously breathing patient (Via 2014).', ...ECHO_LEARN],
};
SCENARIOS.echo_lv_failure = {
  id: 'echo_lv_failure', title: 'Focused echo: breathless with cold hands', difficulty: 'intermediate', durationS: 900, kind: 'Echo',
  summary: 'A 68-year-old woman with a previous anterior infarction, breathless and cold. Find the five views, estimate the ejection fraction and decide what limits her circulation.',
  spec: { sex: 'F', age: 68, heightCm: 162, weightKg: 70, lvFunction: 0.3, causes: [] },
  init(p) { echoInit(p); },
  timeline: [],
  score: echoScore([]),
  learning: ['LVEF graded with Lang 2015: normal 54-74 % in women (52-72 % in men), mildly reduced 41-53 (41-51), moderately 30-40, severely < 30 %.', ...ECHO_LEARN],
};
SCENARIOS.echo_tamponade = {
  id: 'echo_tamponade', title: 'Focused echo: tachycardia and distended neck veins', difficulty: 'intermediate', durationS: 900, kind: 'Echo',
  summary: 'A 55-year-old man with lung cancer, increasingly breathless over a week, now tachycardic with distended neck veins. Look at the pericardium and the right heart, measure, and decide.',
  spec: { sex: 'M', age: 55, heightCm: 175, weightKg: 72, effusionMl: 440, causes: [] },
  init(p) { echoInit(p); p.vol.startInfusion(0.015 * p.body.weightKg, 10, 'crystalloid'); },   // 15 mL/kg of fluid given in the ambulance (REF design)
  timeline: [],
  score: echoScore(['effusion']),
  learning: ['Tamponade physiology on 2D: systolic collapse of the right atrium and diastolic collapse of the right ventricle (Via 2014).', 'The treatment is drainage (pericardiocentesis), not more fluid.', ...ECHO_LEARN],
};
SCENARIOS.echo_rv = {
  id: 'echo_rv', title: 'Focused echo: sudden breathlessness after surgery', difficulty: 'advanced', durationS: 900, kind: 'Echo',
  summary: 'A 61-year-old man, 6 days after hip surgery, suddenly breathless and tachycardic. Look at the right ventricle as carefully as the left, measure TAPSE, and decide.',
  spec: { sex: 'M', age: 61, heightCm: 176, weightKg: 88, rvLoad: 0.7, causes: [] },
  init(p) { echoInit(p); },
  timeline: [],
  score: echoScore([]),
  learning: ['Acute RV pressure overload: RV basal diameter > 41 mm (Lang 2015; > 42 mm in Rudski 2010), TAPSE < 17 mm, a flattened septum (D-shaped LV) and an underfilled, hyperdynamic LV.', ...ECHO_LEARN],
};

// ----------------------------------------------------------------------------- infectiology (kind 'Infectiology'): ward patients over several simulated days
/** an antibiotic course is fully active against the case isolate (S, or I at the high dose: REF eucast_sir) */
const fullyActive = (w, r) => { const c = categorize(w.iso, r.drug, r.route).cat; return c === 'S' || (c === 'I' && r.dose === 'high'); };
const regimenAt = (w, h) => w.courses.filter(r => r.startH <= h && (r.stopH === null || r.stopH > h));
const daysTxt = d => `${d.toFixed(1)} days`;
export const infCriteria = {
  cultures: () => C('inf_cultures', 'Blood cultures (2 sets) and a sample of the suspected source before the first antibiotic', 12, 'ssc2021', p => {
    const w = p.ward, pre = w.samples.filter(x => x.preAbx), nb = Math.min(2, pre.filter(x => x.kind === 'blood').length), src = w.def.source ? pre.some(x => x.kind === w.def.source) : null;
    if (!w.samples.length) return { frac: 0, detail: 'no sample taken' };
    const frac = src === null ? nb / 2 : 0.7 * nb / 2 + (src ? 0.3 : 0);
    return { frac, detail: `${nb} blood culture set(s) before antibiotics` + (src === null ? '' : `, ${w.def.source} ${src ? 'sampled first' : 'not sampled before antibiotics'}`) };
  }),
  timing: (targetH) => C('inf_abx_time', `First antibiotic dose within ${targetH} h of recognition`, 12, 'ssc2021', p => {
    const h = p.ward.firstAbxH; if (h === null) return { frac: 0, detail: 'no antibiotic given' };
    return { frac: lerpScore(h, targetH, targetH * 4), detail: `at ${h} h` };
  }),
  empiric: () => C('inf_empiric', 'Empirical regimen active against the pathogen, without cover the risk profile does not call for (MRSA, double Gram-negative)', 14, 'ssc2021', p => {
    const w = p.ward, d = w.def; if (w.firstAbxH === null) return { frac: 0, detail: 'no antibiotic given' };
    const reg = w.courses.filter(r => r.startH <= w.firstAbxH + 2);
    const active = reg.some(r => fullyActive(w, r)), atyp = d.need !== 'atyp' || reg.some(r => ABX[r.drug].atyp);
    const mrsa = !d.mrsaRisk && reg.some(r => ABX[r.drug].mrsa), dbl = !d.mdrRisk && reg.filter(r => ABX[r.drug].gn).length >= 2;
    const broad = !d.mdrRisk && reg.some(r => ABX[r.drug].broad);                                     // broad Gram-negative agents without MDR risk (REF design weight)
    const frac = (active ? 0.6 : 0) + (atyp ? 0.2 : 0) + 0.2 - (mrsa ? 0.3 : 0) - (dbl ? 0.3 : 0) - (broad ? 0.15 : 0);
    const why = [active ? 'active' : 'NOT active on the isolate', d.need === 'atyp' ? (atyp ? 'atypical cover' : 'no atypical cover') : null, mrsa ? 'unneeded MRSA cover' : null, dbl ? 'unneeded double Gram-negative cover' : null, broad ? 'broader than the risk profile needs' : null].filter(Boolean);
    return { frac, detail: `${reg.map(r => r.drug + ' ' + r.route).join(' + ')}: ${why.join(', ')}` };
  }),
  deescalate: () => C('inf_deesc', 'Regimen narrowed to a targeted active agent within 24 h of the antibiogram', 16, 'ssc2021', p => {
    const w = p.ward, ast = w.milestones().ast; if (ast === null) return null;
    for (let h = ast; h <= w.h; h++) {
      const reg = regimenAt(w, h);
      if (reg.length && reg.every(r => w.def.targeted.includes(r.drug) && fullyActive(w, r))) return { frac: lerpScore(h - ast, 24, 72), detail: `${reg.map(r => r.drug).join(' + ')} ${h - ast} h after the antibiogram` };
    }
    return { frac: 0, detail: 'not narrowed to a targeted active agent' };
  }),
  oralSwitch: () => C('inf_oral', 'Switch to an active oral agent once clinically stable (afebrile, haemodynamically stable, eating)', 10, 'barlam2016', p => {
    const w = p.ward; if (!w.def.oral) return null;
    const po = w.courses.find(r => r.route === 'po');
    if (!po) return w.stableH !== null && w.h - w.stableH > 72 ? { frac: 0, detail: 'still intravenous 3 days after stability' } : null;
    if (!fullyActive(w, po)) return { frac: 0.1, detail: `${po.drug} po is not active on the isolate` };
    if (w.stableH === null || po.startH < w.stableH) return { frac: 0.3, detail: `switched at ${po.startH} h, before clinical stability` };
    const ref = Math.max(w.stableH, w.milestones().ast ?? 0);
    return { frac: lerpScore(po.startH - ref, 24, 96), detail: `${po.drug} po at ${po.startH} h (stable from ${w.stableH} h)` };
  }),
  duration: (ref) => C('inf_duration', 'Total duration of active therapy as short as the evidence supports', 14, ref, p => {
    const w = p.ward, d = w.def.duration;
    if (w.firstActiveH === null) return { frac: 0, detail: 'never on active therapy' };
    if (w.rx.length) return { frac: 0, detail: 'antibiotics still running at the end of the case' };
    let start = w.firstActiveH;
    if (d.from === 'clearance') { start = w.milestones().clearH; if (start === null) return { frac: 0, detail: 'clearance of the bacteraemia not documented (no negative follow-up culture)' }; }
    const days = (w.lastActiveH - start) / 24;
    const frac = days < d.lo ? lerpScore(d.lo - days, 0, 2) : days > d.hi ? lerpScore(days - d.hi, 0, d.zeroAfter) : 1;
    return { frac, detail: `${daysTxt(days)} (${d.lo}-${d.hi} days${d.from === 'clearance' ? ' from the first negative blood culture' : ''})` };
  }),
  outcome: () => C('inf_outcome', 'Cured without relapse or transfer to intensive care', 10, 'design', p => {
    const s = p.ward.summary();
    if (s.icu) return { frac: 0, detail: 'deteriorated: transferred to intensive care' };
    if (s.relapse) return { frac: 0.2, detail: 'relapse after stopping therapy' };
    if (s.cured && !s.onTherapy) return { frac: 1, detail: 'cured' };
    return p.ward.b < 0.05 ? { frac: 0.6, detail: 'improving, still on treatment' } : { frac: 0, detail: 'infection not controlled' };
  }),
  lineRemoval: () => C('inf_line', 'Infected central line removed promptly once the blood grows Gram-positive cocci', 10, 'idsa_sab2026', p => {
    const w = p.ward; if (!w.def.line) return null;
    if (w.lineOutH === null) return { frac: 0, detail: 'line left in place' };
    const g = w.milestones().gram; return { frac: g === null ? 1 : lerpScore(w.lineOutH - g, 24, 72), detail: `removed at ${w.lineOutH} h` };
  }),
  followUpCultures: () => C('inf_fubc', 'Follow-up blood cultures about 48 h after the first positive set', 8, 'idsa_sab2026', p => {
    const w = p.ward, fp = w.milestones().firstPosSampleH; if (fp === null) return null;
    const later = w.samples.filter(x => x.kind === 'blood' && x.h > fp);
    if (!later.length) return { frac: 0, detail: 'none taken' };
    const ok = later.some(x => x.h >= fp + 36 && x.h <= fp + 96);                                  // tolerance around 48 h (REF design)
    return { frac: ok ? 1 : 0.5, detail: later.map(x => `${x.h - fp} h`).join(', ') + ' after the first positive set' };
  }),
  echo: () => C('inf_tte', 'Transthoracic echocardiography for S. aureus bacteraemia', 6, 'idsa_sab2026', p => (p.ward.orders.some(o => o.what === 'tte') ? { frac: 1, detail: 'done' } : { frac: 0, detail: 'not done' })),
  fluids: () => C('inf_fluids', 'At least 30 mL/kg crystalloid within 3 h for sepsis-induced hypoperfusion', 8, 'ssc2021', p => {
    const o = p.ward.orders.find(x => x.what === 'fluids30'); return o ? { frac: lerpScore(o.h, 3, 9), detail: `at ${o.h} h` } : { frac: 0, detail: 'not given' };
  }),
  lactate: () => C('inf_lactate', 'Lactate measured', 4, 'ssc2021', p => (p.ward.orders.some(x => x.what === 'lactate' || x.what === 'labs') ? { frac: 1, detail: 'measured' } : { frac: 0, detail: 'not measured' })),
  esblAgent: () => C('inf_esbl_agent', 'ESBL-producing isolate in the blood: a carbapenem as definitive therapy (piperacillin-tazobactam is not a preferred agent)', 8, 'idsa_amr2026', p => {
    const w = p.ward, ast = w.milestones().ast; if (ast === null) return null;
    const reg = regimenAt(w, Math.min(w.h, ast + 24)).concat(w.rx);
    const carb = reg.some(r => ABX[r.drug].cls === 'carbapenem'), pt = reg.some(r => r.drug === 'piptazo');
    return { frac: carb && !pt ? 1 : carb ? 0.6 : 0, detail: carb ? 'carbapenem' : pt ? 'piperacillin-tazobactam' : 'no carbapenem' };
  }),
};
const wardInit = (p) => { p.ward = new Ward(p.scenario.ward, { body: p.body, spec: p.spec, seed: p.seed }); };
const infScore = (timingH, durRef, extra = []) => () => [infCriteria.cultures(), infCriteria.timing(timingH), infCriteria.empiric(), infCriteria.deescalate(), infCriteria.oralSwitch(), infCriteria.duration(durRef), infCriteria.outcome(), ...extra.map(k => infCriteria[k]())];

SCENARIOS.inf_pyelo = {
  id: 'inf_pyelo', title: 'Pyelonephritis with bacteraemia', difficulty: 'beginner', durationS: 3600, kind: 'Infectiology',
  summary: 'A 46-year-old woman with two days of burning micturition, now 39 C, rigors and right flank pain. Tachycardic, blood pressure low-normal. Sample, treat, read the antibiogram and decide how long.',
  spec: { sex: 'F', age: 46, heightCm: 165, weightKg: 68, causes: [] },
  ward: {
    source: 'urine', bacteraemic: true, ttpH: 10, b0: 1, s0: 0.7, sbp0: 124, creat0: 70, mrsaRisk: false, mdrRisk: false, oral: true,
    targeted: ['ceftriaxone', 'cefotaxime', 'ciprofloxacin', 'levofloxacin', 'amoxiclav'],
    duration: { lo: 6.5, hi: 8, zeroAfter: 6 }, renalUs: 'us_normal',
    isolate: { name: 'Escherichia coli', group: 'Enterobacterales', mic: { ampicillin: 32, amoxicillin_po: 32, amoxiclav_iv: 8, amoxiclav_po: 8, piptazo: 2, cefuroxime_iv: 4, cefazolin: 2, cefotaxime: 0.125, ceftriaxone: 0.125, ceftazidime: 0.25, cefepime: 0.125, ertapenem: 0.016, meropenem: 0.03, ciprofloxacin: 0.03, levofloxacin: 0.06, gentamicin: 1, amikacin: 2, tmpsmx: 8 } },
  },
  init: wardInit, timeline: [],
  score: infScore(1, 'balance2025'),
  learning: ['Blood cultures and a urine culture before the first dose, then antibiotics within the hour when sepsis is likely (Surviving Sepsis 2021).',
    'Read the antibiogram with the EUCAST breakpoints: S = standard dose, I = susceptible at increased exposure (higher dose), R = resistant. Amoxicillin-resistant (penicillinase) E. coli is common.',
    'Once stable and eating, step down to an oral agent the isolate is susceptible to (here a fluoroquinolone; trimethoprim-sulfamethoxazole is R).',
    'Seven days of active therapy are enough for most Gram-negative bloodstream infections in patients who improve (BALANCE trial).'],
};
SCENARIOS.inf_cap = {
  id: 'inf_cap', title: 'Severe community-acquired pneumonia', difficulty: 'intermediate', durationS: 3600, kind: 'Infectiology',
  summary: 'A 72-year-old man, three days of cough and fever, now breathless (RR 30, SpO2 88 % on air), slightly confused. Chest X-ray pending. Treat as severe pneumonia, find the organism and narrow.',
  spec: { sex: 'M', age: 72, heightCm: 170, weightKg: 74, causes: [] },
  ward: {
    source: 'sputum', bacteraemic: false, ttpH: 14, b0: 1, s0: 0.74, sbp0: 132, lung: true, creat0: 95, need: 'atyp', mrsaRisk: false, mdrRisk: false, oral: true,
    targeted: ['amoxicillin', 'ceftriaxone', 'cefotaxime'],
    duration: { lo: 5, hi: 7, zeroAfter: 5 }, cxr: 'cxr_rll',
    isolate: { name: 'Streptococcus pneumoniae', group: 'S_pneumoniae', mic: { benzylpenicillin: 0.03, ampicillin: 0.03, amoxicillin_po: 0.03, cefuroxime_iv: 0.06, cefotaxime: 0.03, ceftriaxone: 0.03, cefepime: 0.06, ertapenem: 0.03, meropenem: 0.016, levofloxacin: 1, moxifloxacin: 0.125, clarithromycin: 8, vancomycin: 0.25 } },
  },
  init: wardInit, timeline: [],
  score: infScore(1, 'metlay2019'),
  learning: ['Severe CAP: blood and sputum cultures before treatment; a beta-lactam plus a macrolide (or plus a respiratory fluoroquinolone) covers the pneumococcus and atypical organisms (ATS/IDSA 2019).',
    'Penicillin MIC <= 0.06 mg/L is the EUCAST screen: every beta-lactam with a breakpoint is then reported S, so plain amoxicillin is enough.',
    'Levofloxacin is only I against the pneumococcus (S <= 0.001): it needs the high dose. The macrolide is R here and the Legionella antigen is negative: stop it.',
    'Treat for at least 5 days and until clinically stable; switch to oral once stable and eating.'],
};
SCENARIOS.inf_sab = {
  id: 'inf_sab', title: 'Central-line Staphylococcus aureus bacteraemia', difficulty: 'advanced', durationS: 3600, kind: 'Infectiology',
  summary: 'A 61-year-old man on day 5 after bowel surgery, fed through a central line, has rigors and 38.9 C; the line exit site is red. Sample, cover, find the source and manage the bacteraemia properly.',
  spec: { sex: 'M', age: 61, heightCm: 178, weightKg: 95, causes: [] },
  ward: {
    source: null, bacteraemic: true, line: true, lineFloor: 0.4, ttpH: 12, b0: 0.9, s0: 0.62, sbp0: 134, creat0: 85, mrsaRisk: true, mdrRisk: false, oral: false,
    targeted: ['flucloxacillin', 'cefazolin'],
    duration: { lo: 14, hi: 16, zeroAfter: 6, from: 'clearance' }, tte: 'tte_normal',
    isolate: { name: 'Staphylococcus aureus (methicillin-susceptible)', group: 'S_aureus', mic: { benzylpenicillin: 1, cefoxitin: 2, vancomycin: 1, clindamycin: 0.125, linezolid: 2, daptomycin: 0.5, rifampicin: 0.016, tmpsmx: 0.125, gentamicin: 0.5, levofloxacin: 0.25, moxifloxacin: 0.06 } },
  },
  init: wardInit, timeline: [],
  score: infScore(3, 'idsa_sab2026', ['lineRemoval', 'followUpCultures', 'echo']),
  learning: ['Hospital-onset bacteraemia with a central line: MRSA cover (vancomycin, loading dose by actual body weight) until the antibiogram, as the MRSA risk is high (Surviving Sepsis 2021).',
    'Cefoxitin MIC <= 4 mg/L: methicillin-susceptible. EUCAST then reports flucloxacillin S and cefazolin I (high dose only for S. aureus). Switch from vancomycin to the beta-lactam.',
    'Remove the infected central line, take follow-up blood cultures 48 h after the first positive set, and do an echocardiogram (IDSA/ESCMID 2026).',
    'Count the 14 days from the first negative blood culture, not from the first dose; the bacteraemia persists while the line stays in.'],
};
SCENARIOS.inf_esbl = {
  id: 'inf_esbl', title: 'Urosepsis with shock: ESBL-producing E. coli', difficulty: 'advanced', durationS: 3600, kind: 'Infectiology',
  summary: 'A 78-year-old woman (52 kg) from a nursing home, long-term urinary catheter, ESBL E. coli in a urine culture four months ago. Fever, confusion, BP 75/45, cold peripheries. Resuscitate, cover the resistant organism, then target.',
  spec: { sex: 'F', age: 78, heightCm: 158, weightKg: 52, causes: [] },
  ward: {
    source: 'urine', bacteraemic: true, ttpH: 9, b0: 1.05, s0: 0.9, sbp0: 122, creat0: 130, mrsaRisk: false, mdrRisk: true, oral: false,
    targeted: ['ertapenem', 'meropenem', 'piptazo'],
    duration: { lo: 6.5, hi: 8, zeroAfter: 6 }, renalUs: 'us_catheter',
    isolate: { name: 'Escherichia coli (ESBL producer)', group: 'Enterobacterales', mic: { ampicillin: 64, amoxicillin_po: 64, amoxiclav_iv: 16, amoxiclav_po: 16, piptazo: 4, cefuroxime_iv: 32, cefazolin: 32, cefotaxime: 16, ceftriaxone: 16, ceftazidime: 8, cefepime: 8, ertapenem: 0.03, meropenem: 0.03, ciprofloxacin: 4, levofloxacin: 8, gentamicin: 1, amikacin: 4, tmpsmx: 8 } },
  },
  init: wardInit, timeline: [],
  score: infScore(1, 'balance2025', ['fluids', 'lactate', 'esblAgent']),
  learning: ['Septic shock: antibiotics within the hour, lactate, and at least 30 mL/kg crystalloid in the first 3 h (Surviving Sepsis 2021); the volume depends on her weight.',
    'High risk of a multidrug-resistant organism (known ESBL carriage): an empirical agent active against it, e.g. a carbapenem; two Gram-negative agents are only suggested while susceptibilities are unknown.',
    'ESBL producer: third-generation cephalosporins R. Use a carbapenem for the bloodstream infection; piperacillin-tazobactam is not a preferred agent even when the MIC reads S (IDSA AMR guidance). Stop the second Gram-negative agent once the antibiogram is known.',
    'No oral agent is active here (fluoroquinolone and trimethoprim-sulfamethoxazole R): stay intravenous; 7 days are enough once she improves (BALANCE).'],
};

export const scenarioList = () => Object.values(SCENARIOS).map(({ id, title, difficulty, durationS, kind, summary, spec, learning }) => ({ id, title, difficulty, durationS, kind, summary, spec, learning }));

// ----------------------------------------------------------------------------- scoring
/** Score a (finished or in-progress) Patient against its scenario. Pure function of patient state + log. */
export function scoreSession(p, scenario = p.scenario) {
  if (!scenario?.score) return { items: [], total: 0, max: 0, pct: 0, grade: '-' };
  const items = [];
  for (const c of scenario.score()) {
    const r = c.eval(p); if (r === null || r === undefined) continue;
    items.push({ id: c.id, label: c.label, weight: c.weight, ref: c.ref, frac: +clamp(r.frac, 0, 1).toFixed(3), points: +(clamp(r.frac, 0, 1) * c.weight).toFixed(2), detail: r.detail });
  }
  const max = items.reduce((s, i) => s + i.weight, 0), total = items.reduce((s, i) => s + i.points, 0);
  const pct = max ? total / max * 100 : 0;
  return { items, total: +total.toFixed(1), max, pct: +pct.toFixed(1), grade: pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'F' };
}
