// Scenario catalogue + guideline-derived scoring.
// A scenario is plain data + pure functions of the Patient (no wall clock, no Math.random), so a session is
// reproducible from (scenario id, patient spec, seed, event log).
//
// Scoring is derived ONLY from the replay log / patient state. Every criterion cites a registry id (references.js);
// criteria whose numeric target is a design choice say so (ref 'design') and are listed in docs/VALIDATION.md.
import { TEAM_CRITERION } from './team.js';
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
    const t0 = arrestT0(p); if (t0 === null || !['VF', 'VT_PULSELESS', 'TORSADES'].includes(p.arrest.events.find(e => e.type === 'rhythm' && e.t >= t0)?.to)) return null;
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
    const bad = [].concat(drugsGiven(p, 'vasopressin'), hk ? [] : drugsGiven(p, 'calciumChloride'), hk ? [] : drugsGiven(p, 'calciumGluconate'), hk ? [] : p.drugs.log.filter(d => d.key === 'sodiumBicarbonate')).filter(d => d.t >= t0);
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
  summary: 'A 61-year-old man, 6 days after hip surgery, suddenly breathless and tachycardic. His left calf is swollen and tender. Look at the right ventricle as carefully as the left, measure TAPSE, and decide.',
  spec: { sex: 'M', age: 61, heightCm: 176, weightKg: 88, rvLoad: 0.7, causes: [] },
  history: { recentSurgery: true, dvtSigns: true },
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
  for (const c of [...scenario.score(), TEAM_CRITERION]) {           // closed-loop communication counts once the learner led the team
    const r = c.eval(p); if (r === null || r === undefined) continue;
    items.push({ id: c.id, label: c.label, weight: c.weight, ref: c.ref, frac: +clamp(r.frac, 0, 1).toFixed(3), points: +(clamp(r.frac, 0, 1) * c.weight).toFixed(2), detail: r.detail });
  }
  const max = items.reduce((s, i) => s + i.weight, 0), total = items.reduce((s, i) => s + i.points, 0);
  const pct = max ? total / max * 100 : 0;
  return { items, total: +total.toFixed(1), max, pct: +pct.toFixed(1), grade: pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'F' };
}


// ----------------------------------------------------------------------------- anaesthesia and emergency crises (crises.js)
const ventilatedStart = (p, { rate = 12 } = {}) => {
  p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = p.flags.capnography = p.flags.ivAccess = p.flags.tempProbe = true;
  p.airway = { device: 'ett', patency: 1, intubated: true };
  p.vent = { mode: 'ctrl', rate, vt: Math.round(7 * p.body.pbw), fio2: 0.5, peep: 5, seal: 0.97, efficiency: 1 };
  p.drugs.bolus('propofol', 120, 0); p.drugs.infusion('propofol', 6);
  p.nibp = { sbp: 118, dbp: 70, t: 0, valid: true };
};
const firstDrugAfter = (p, keys, t0) => p.drugs.log.find(d => keys.includes(d.key) && d.t >= t0) || null;
const timedCrit = (id, label, w, ref, keys, t0Of, full, zero) => C(id, label, w, ref, p => {
  const t0 = t0Of(p); if (t0 == null) return null;
  const d = firstDrugAfter(p, keys, t0); if (!d) return { frac: 0, detail: 'not given' };
  return { frac: lerpScore(d.t - t0, full, zero), detail: `${d.key} ${Math.round(d.t - t0)} s after onset` };
});

SCENARIOS.anaphylaxis = {
  id: 'anaphylaxis', title: 'Anaphylaxis at induction', difficulty: 'intermediate', durationS: 1200, kind: 'Anaesthesia',
  summary: 'A 38-year-old woman (165 cm, 64 kg) has just been induced and intubated for a laparoscopy. One minute after the antibiotic and the muscle relaxant her pressure falls, the airway pressure rises and her chest is flushed. Recognise it and treat it.',
  spec: { sex: 'F', age: 38, heightCm: 165, weightKg: 64, causes: [] },
  startMonitored: true,
  init(p) { ventilatedStart(p); p.drugs.bolus('rocuronium', 40, 0); },
  timeline: [{ t: 60, run: p => { p.crises.trigger('anaphylaxis', p.t); p.anaOnset = p.t; } }],
  track(p) { if (p.anaOnset != null) p.minMap = Math.min(p.minMap ?? 200, p.circ.mapArt); },
  score: () => [
    timedCrit('ana_adrenaline', 'Adrenaline (IM 0.5 mg or IV titrated 50 mcg) within 5 min of onset', 30, 'rcuk2021_anaph', ['epinephrine'], p => p.anaOnset, 120, 300),
    C('ana_fluids', 'Fluid challenge >= 1 L', 15, 'rcuk2021_anaph', p => { const v = p.vol.totalCrystalloid; return { frac: Math.min(1, v / 1.0), detail: `${(v * 1000).toFixed(0)} mL crystalloid` }; }),
    C('ana_map', 'Lowest MAP after onset (65 full marks, 40 none)', 15, 'design', p => ({ frac: lerpScore(65 - (p.minMap ?? 100), 0, 25), detail: `nadir ${(p.minMap ?? 100).toFixed(0)} mmHg` })),
    criteria.survival('Alive with MAP >= 65 at the end'),
  ],
  learning: ['Anaphylaxis under anaesthesia: sudden hypotension, high airway pressure (bronchospasm), flushing or no skin sign at all. Neuromuscular blockers and antibiotics are the usual triggers (NAP6).', 'Adrenaline is the treatment: 0.5 mg IM, or under anaesthesia 50 mcg IV boluses titrated to effect, then an infusion if it keeps coming back.', 'Give fluid fast: the capillaries leak and the patient is empty.', 'Antihistamines and steroids are no longer part of the emergency treatment.'],
};

SCENARIOS.mh_crisis = {
  id: 'mh_crisis', title: 'Malignant hyperthermia', difficulty: 'advanced', durationS: 1800, kind: 'Anaesthesia',
  summary: 'A 24-year-old man (180 cm, 78 kg), intubated with succinylcholine and maintained on sevoflurane for an appendicectomy. Twenty minutes in, the EtCO2 keeps rising despite more ventilation and he is getting tachycardic. Find the cause and treat it.',
  spec: { sex: 'M', age: 24, heightCm: 180, weightKg: 78, causes: [], mhSusceptible: true },
  startMonitored: true,
  init(p) {
    ventilatedStart(p); p.drugs.stop('propofol'); p.drugs.bolus('succinylcholine', 120, 0); p.crises.mhAt = 0;
    p.volatile.set(2.2); p.volatile.fa = 1.8; p.volatile.p = [1.75, 1.2, 0.15];   // 20 min of sevoflurane maintenance at ~0.9 MAC
  },
  timeline: [],
  track(p) { if (p.mhRecognisedT == null && p.resp.etco2 > 55) p.mhRecognisedT = p.t; p.maxTemp = Math.max(p.maxTemp ?? 0, p.therm.tc); },
  score: () => [
    C('mh_dantrolene', 'Dantrolene >= 2.5 mg/kg within 10 min of EtCO2 > 55', 35, 'hopkins2021', p => {
      const t0 = p.mhRecognisedT; if (t0 == null) return null;
      const tot = drugsGiven(p, 'dantrolene').reduce((s, d) => s + d.amount, 0), d = drugsGiven(p, 'dantrolene')[0];
      if (!d || tot < 2.5 * p.body.weightKg) return { frac: d ? 0.3 : 0, detail: `${tot.toFixed(0)} mg in total` };
      return { frac: lerpScore(d.t - t0, 600, 1200), detail: `${tot.toFixed(0)} mg, first ${Math.round(d.t - t0)} s after EtCO2 > 55` };
    }),
    C('mh_trigger_off', 'Vaporiser off within 5 min of EtCO2 > 55 (hypnosis kept with propofol)', 10, 'hopkins2021', p => { const t0 = p.mhRecognisedT; if (t0 == null) return null; const e = p.log.find(x => x.type === 'vaporizer.set' && x.percent === 0 && x.t >= t0); return { frac: e ? lerpScore(e.t - t0, 300, 900) : 0, detail: e ? `${Math.round(e.t - t0)} s` : 'sevoflurane left on' }; }),
    C('mh_cool', 'Active cooling started', 10, 'hopkins2021', p => ({ frac: p.log.some(e => e.type === 'thermal.device' && e.target != null && e.target < 37) ? 1 : 0, detail: '' })),
    C('mh_vent', 'Minute ventilation increased (rate x1.5 or more)', 10, 'hopkins2021', p => ({ frac: p.vent.rate >= 18 ? 1 : 0, detail: `rate ${p.vent.rate}/min` })),
    C('mh_temp', 'Peak core temperature (38.5 full marks, 40 none)', 15, 'design', p => ({ frac: lerpScore((p.maxTemp ?? 37) - 38.5, 0, 1.5), detail: `peak ${(p.maxTemp ?? 37).toFixed(1)} C` })),
    criteria.survival(),
  ],
  learning: ['The earliest sign is an unexplained rise in EtCO2 despite more ventilation, with tachycardia; temperature rises later.', 'Stop the volatile, hyperventilate with 100 % oxygen, call for help and give dantrolene 2.5 mg/kg, repeated every 10 min until it settles.', 'Cool actively, treat hyperkalaemia and watch for arrhythmias and rhabdomyolysis.'],
};

SCENARIOS.last_block = {
  id: 'last_block', title: 'Local anaesthetic toxicity after a nerve block', difficulty: 'advanced', durationS: 1200, kind: 'Anaesthesia',
  summary: 'A 70-year-old woman (158 cm, 55 kg) is having a femoral nerve block with bupivacaine for a hip fracture. Shortly after the injection she becomes confused and stops answering. Treat what is happening.',
  spec: { sex: 'F', age: 70, heightCm: 158, weightKg: 55, causes: [] },
  startMonitored: true,
  init(p) { p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = p.flags.ivAccess = true; p.nibp = { sbp: 132, dbp: 76, t: 0, valid: true }; },
  timeline: [{ t: 20, run: p => { p.drugs.bolus('bupivacaine', 110, p.t); p.lastT0 = p.t; } }],
  track(p) { if (p.lastSignT == null && (p.crises.seizure || p.arrest.arrested || p.crises.laCv > 0.6)) p.lastSignT = p.t; },
  score: () => [
    timedCrit('last_lipid', 'Lipid emulsion 20 % (1.5 mL/kg) within 3 min of the first sign', 35, 'neal2018', ['lipid'], p => p.lastSignT, 60, 300),
    C('last_airway', 'Oxygen / airway support', 15, 'neal2018', p => ({ frac: p.log.some(e => ['o2.mask', 'airway.set', 'airway.intubate', 'vent.set'].includes(e.type)) ? 1 : 0, detail: '' })),
    C('last_no_vaso', 'No vasopressin (avoid in LAST)', 10, 'neal2018', p => ({ frac: drugsGiven(p, 'vasopressin').length ? 0 : 1, detail: '' })),
    criteria.survival(),
  ],
  learning: ['Confusion, seizures, then arrhythmias and cardiovascular collapse shortly after a local anaesthetic: think LAST.', 'Stop injecting, call for help, oxygenate, treat seizures, and give lipid emulsion 20 %: 1.5 mL/kg over 2-3 min, then 0.25 mL/kg/min.', 'In cardiac arrest use smaller adrenaline doses (< 1 mcg/kg), avoid vasopressin, and keep CPR going: recovery can take long.'],
};

SCENARIOS.heart_block = {
  id: 'heart_block', title: 'Complete heart block with shock', difficulty: 'intermediate', durationS: 1200, kind: 'ACLS',
  summary: 'A 78-year-old man (172 cm, 74 kg) with high blood pressure and type 2 diabetes has had dizzy spells all day and is now grey and drowsy. The monitor shows a very slow rhythm. Stabilise him.',
  spec: { sex: 'M', age: 78, heightCm: 172, weightKg: 74, causes: [], rhythm: 'AV_BLOCK3' },
  history: { hypertension: true, diabetes: true },
  startMonitored: true,
  init(p) { p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = true; p.nibp = { sbp: 78, dbp: 42, t: 0, valid: true }; },
  timeline: [],
  track(p) { if (p.pacedT == null && p.crises.captured) p.pacedT = p.t; },
  score: () => [
    C('hb_pads', 'Pads on within 2 min', 10, 'erc2025', p => { const e = p.log.find(x => x.type === 'defib.pads'); return { frac: e ? lerpScore(e.t, 120, 360) : 0, detail: e ? `${Math.round(e.t)} s` : 'no pads' }; }),
    C('hb_capture', 'Paced with capture within 8 min', 35, 'erc2025', p => ({ frac: p.pacedT == null ? 0 : lerpScore(p.pacedT, 480, 900), detail: p.pacedT == null ? 'no capture' : `capture at ${Math.round(p.pacedT)} s` })),
    C('hb_analgesia', 'Analgesia or sedation for pacing', 10, 'erc2025', p => ({ frac: ['morphine', 'fentanyl', 'midazolam', 'ketamine'].some(k => drugsGiven(p, k).length) ? 1 : 0, detail: '' })),
    criteria.survival(),
  ],
  learning: ['Bradycardia with shock, syncope, ischaemia or heart failure needs treatment now: atropine 500 mcg (repeat to 3 mg), then pacing or an adrenaline/isoprenaline infusion.', 'Atropine rarely works in complete heart block below the AV node: go to pacing early.', 'Transcutaneous pacing: pads, demand mode, rate 60-70, increase the current until each spike gives a QRS AND a pulse. It hurts: give analgesia and sedation.'],
};

// ----------------------------------------------------------------------------- torsades de pointes (crises.js, cpr.js)
SCENARIOS.torsades = {
  id: 'torsades', title: 'Torsades de pointes', difficulty: 'advanced', durationS: 1500, kind: 'ACLS',
  summary: 'A 66-year-old woman (162 cm, 60 kg) takes sotalol for atrial fibrillation and treatment for high blood pressure, and has had diarrhoea for three days. She is on the monitor in the emergency department with a slow pulse when she suddenly loses consciousness. Recognise the rhythm, treat it and stop it coming back.',
  spec: { sex: 'F', age: 66, heightCm: 162, weightKg: 60, causes: [], rhythm: 'SINUS_BRADY' },
  history: { hypertension: true },
  startMonitored: true,
  init(p) {
    p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = p.flags.ivAccess = true; p.nibp = { sbp: 124, dbp: 70, t: 0, valid: true };
    p.crises.qtDrug = 120; p.lytes.kBase = 2.9; p.lytes.mgBase = 0.55;   // sotalol and hypokalaemia: QTc ~ 570 ms (REF drew2010)
  },
  timeline: [{ t: 75, run: p => { if (!p.arrest.arrested) { p.arrest.arrest('TORSADES', p.t); p.tdpCount = (p.tdpCount || 0) + 1; } } }],
  track(p) {
    if (p.tdpT0 == null && p.arrest.key === 'TORSADES') p.tdpT0 = p.t;
    if (p.arrest.key === 'TORSADES') p.lastTdpT = p.t;
  },
  score: () => [
    C('tdp_mg', 'Magnesium sulfate 2 g IV within 5 min of the first run', 35, 'drew2010', p => {
      const t0 = p.tdpT0; if (t0 == null) return null;
      const doses = drugsGiven(p, 'magnesium'), tot = doses.reduce((s, d) => s + d.amount, 0);
      if (tot < 2) return { frac: 0, detail: `${tot} g in total` };
      let acc = 0, at = null; for (const d of doses) { acc += d.amount; if (acc >= 2) { at = d.t; break; } }
      return { frac: lerpScore(at - t0, 300, 900), detail: `2 g reached ${Math.round(at - t0)} s after the first run` };
    }),
    C('tdp_no_amio', 'No amiodarone (it lengthens the QT)', 10, 'drew2010', p => ({ frac: drugsGiven(p, 'amiodarone').length ? 0 : 1, detail: '' })),
    C('tdp_rate', 'Heart rate raised (isoprenaline or overdrive pacing)', 15, 'drew2010', p => ({ frac: drugsGiven(p, 'isoprenaline').length || p.log.some(e => (e.type === 'drug.infusion' && e.drug === 'isoprenaline' && e.rate > 0) || (e.type === 'pacing.set' && e.on)) ? 1 : 0, detail: '' })),
    C('tdp_quiet', 'No torsades in the last 5 min', 15, 'design', p => ({ frac: p.lastTdpT == null || p.t - p.lastTdpT >= 300 ? 1 : 0, detail: p.lastTdpT == null ? '' : `last run at ${Math.round(p.lastTdpT)} s` })),
    criteria.survival(),
  ],
  learning: ['Torsades de pointes is a polymorphic VT whose QRS axis twists around the baseline, on a long QT. Pulseless or sustained: defibrillate.', 'Give magnesium sulfate 2 g IV even if the magnesium level is normal; it stops recurrences without shortening the QT.', 'Correct potassium (aim 4.5-5), stop every QT-prolonging drug (here sotalol), and avoid amiodarone.', 'Recurrent runs after pauses: raise the heart rate with isoprenaline or overdrive pacing.'],
};

// ----------------------------------------------------------------------------- diabetic ketoacidosis (metabolic.js)
const firstEv = (p, pred) => p.log.find(pred) || null;
SCENARIOS.dka = {
  id: 'dka', title: 'Diabetic ketoacidosis', difficulty: 'intermediate', durationS: 14400, kind: 'Emergency',
  summary: 'A 22-year-old woman (165 cm, 55 kg) with type 1 diabetes has been vomiting for two days and stopped her insulin because she was not eating. She is drowsy, breathing deeply and dry. Confirm the diagnosis and run the first four hours of treatment.',
  spec: { sex: 'F', age: 22, heightCm: 165, weightKg: 55, causes: [], dka: true, ketones: 5.5, glucose: 28, potassium: 3.6, dehydrationL: 3.5 },
  history: { diabetes: true },
  startMonitored: true,
  init(p) { p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = true; p.nibp = { sbp: 98, dbp: 70, t: 0, valid: true }; },
  timeline: [],
  track(p) { p.minK = Math.min(p.minK ?? 9, p.lytes.k); if (p.ket0 == null) p.ket0 = p.keto.ketones; },
  score: () => [
    C('dka_tests', 'Capillary ketones and a blood gas within 15 min', 10, 'jbds2023', p => {
      const k = firstEv(p, e => e.type === 'lab.order' && e.kind === 'ketones'), g = firstEv(p, e => e.type === 'lab.order' && e.kind === 'abg');
      return { frac: k && g ? lerpScore(Math.max(k.t, g.t), 900, 2700) : k || g ? 0.4 : 0, detail: `${k ? 'ketones ' + Math.round(k.t / 60) + ' min' : 'no ketones'}, ${g ? 'gas ' + Math.round(g.t / 60) + ' min' : 'no gas'}` };
    }),
    C('dka_fluid', 'IV fluid >= 1 L started within 30 min', 15, 'jbds2023', p => { const e = firstEv(p, x => x.type === 'fluid.bolus'); return { frac: e ? lerpScore(e.t, 1800, 3600) : 0, detail: e ? `${Math.round(e.t / 60)} min` : 'no fluid' }; }),
    C('dka_insulin', 'Fixed-rate insulin 0.1 U/kg/h within 1 h, no insulin bolus', 20, 'jbds2023', p => {
      const e = firstEv(p, x => x.type === 'drug.infusion' && x.drug === 'insulin' && x.rate > 0); if (!e) return { frac: 0, detail: 'no insulin infusion' };
      const uKgH = e.rate * 60 / p.body.weightKg, ok = uKgH >= 0.08 && uKgH <= 0.12, bolus = drugsGiven(p, 'insulin').length > 0;
      return { frac: (ok ? 1 : 0.5) * lerpScore(e.t, 3600, 7200) * (bolus ? 0.6 : 1), detail: `${uKgH.toFixed(2)} U/kg/h at ${Math.round(e.t / 60)} min${bolus ? ', insulin bolus given' : ''}` };
    }),
    C('dka_potassium', 'Potassium replaced, K never below 3.5', 15, 'jbds2023', p => {
      const given = drugsGiven(p, 'potassiumChloride').reduce((s, d) => s + d.amount, 0);
      return { frac: (p.minK >= 3.5 ? 0.7 : 0) + (given > 0 ? 0.3 : 0), detail: `lowest K ${p.minK.toFixed(1)}, ${given} mmol KCl` };
    }),
    C('dka_glucose10', 'Glucose 10 % added once glucose < 14', 10, 'jbds2023', p => {
      if (p.lytes.glucose >= 14 && !p.log.some(e => e.type === 'drug.infusion' && e.drug === 'glucose')) return null;
      return { frac: p.log.some(e => e.type === 'drug.infusion' && e.drug === 'glucose' && e.rate > 0) || p.lytes.glucose >= 14 ? 1 : 0, detail: `glucose ${p.lytes.glucose.toFixed(1)}` };
    }),
    C('dka_ketones', 'Ketones falling >= 0.5 mmol/L/h', 15, 'jbds2023', p => { const h = p.t / 3600, fall = (p.ket0 - p.keto.ketones) / Math.max(h, 0.1); return { frac: lerpScore(0.5 - fall, 0, 0.4), detail: `${fall.toFixed(2)} mmol/L/h` }; }),
    criteria.survival(),
  ],
  learning: ['DKA: ketones >= 3 mmol/L (or ketonuria 2+), glucose > 11 or known diabetes, and HCO3 < 15 or pH < 7.3.', 'Fluids first (0.9 % saline 1 L in the first hour), then a fixed-rate insulin infusion of 0.1 U/kg/h, without a bolus.', 'Insulin and the correction of the acidosis drive potassium into the cells: add 40 mmol/L potassium to the fluid once K is below 5.5 and check it hourly.', 'When glucose falls below 14 mmol/L, keep the insulin running and add glucose 10 % at 125 mL/h: the target is the ketones, not the glucose.'],
};

// ----------------------------------------------------------------------------- status epilepticus (crises.js)
const benzoDoses = (p) => p.drugs.log.filter(d => (d.key === 'midazolam' && d.amount >= 5) || (d.key === 'lorazepam' && d.amount >= 2) || (d.key === 'diazepam' && d.amount >= 5));
SCENARIOS.status_epilepticus = {
  id: 'status_epilepticus', title: 'Status epilepticus', difficulty: 'intermediate', durationS: 2700, kind: 'Emergency',
  summary: 'A 34-year-old man (178 cm, 80 kg) with epilepsy ran out of his tablets. The paramedics bring him in still fitting: the seizure started about 5 minutes ago. He has no IV access yet. Stop the seizure and keep him safe.',
  spec: { sex: 'M', age: 34, heightCm: 178, weightKg: 80, causes: [] },
  startMonitored: true,
  init(p) { p.flags.spo2Probe = p.flags.ecgLeads = true; p.crises.trigger('seizure', -300); },
  timeline: [],
  track(p) {   // on/off timeline of the seizure: [{ t, on }], one entry per change
    const on = !!p.crises.se.active, log = (p.seLog ??= []);
    if (!log.length || log[log.length - 1].on !== on) log.push({ t: p.t, on });
  },
  score: () => [
    C('se_benzo', 'First benzodiazepine within 5 min (IM midazolam 10 mg, IV lorazepam 4 mg or IV diazepam 10 mg)', 25, 'glauser2016', p => {
      const d = p.drugs.log.find(x => (x.key === 'midazolam' && x.amount >= 10) || (x.key === 'lorazepam' && x.amount >= 4) || (x.key === 'diazepam' && x.amount >= 10));
      return d ? { frac: lerpScore(d.t, 300, 900), detail: `${d.key} ${d.amount} mg at ${Math.round(d.t)} s` } : { frac: 0, detail: 'no adequate benzodiazepine dose' };
    }),
    C('se_two_benzo', 'No more than two benzodiazepine doses', 10, 'glauser2016', p => { const n = benzoDoses(p).length; return { frac: n <= 2 ? 1 : 0, detail: `${n} doses` }; }),
    C('se_second', 'Second-line drug by 20 min if the seizure continues (levetiracetam 60 mg/kg, max 4.5 g)', 20, 'esett2019', p => {
      // needed from the first moment, 10 min or more after the first benzodiazepine, that the seizure is active: it never stopped, or it came back
      const b = benzoDoses(p)[0], log = p.seLog ?? []; if (!b) return null;
      const t10 = b.t + 600, onAt = (t) => { let s = false; for (const e of log) { if (e.t > t) break; s = e.on; } return s; };
      const tNeed = onAt(t10) ? t10 : (log.find(e => e.on && e.t > t10)?.t ?? null); if (tNeed == null) return null;
      const l = p.drugs.log.find(x => x.key === 'levetiracetam' && x.amount >= Math.min(4500, 40 * p.body.weightKg));
      return l ? { frac: lerpScore(l.t - tNeed, 600, 1800), detail: `levetiracetam ${l.amount} mg ${Math.round(Math.max(0, l.t - tNeed) / 60)} min after it was needed` } : { frac: 0, detail: 'no second-line drug' };
    }),
    C('se_glucose', 'Glucose checked within 15 min', 10, 'glauser2016', p => { const e = p.log.find(x => x.type === 'lab.order' && ['cbg', 'abg', 'chem'].includes(x.kind)); return { frac: e ? lerpScore(e.t, 900, 1800) : 0, detail: e ? `${Math.round(e.t / 60)} min` : 'not checked' }; }),
    C('se_oxygen', 'Oxygen within 5 min', 10, 'glauser2016', p => { const e = p.log.find(x => ['o2.mask', 'niv.set', 'vent.set'].includes(x.type)); return { frac: e ? lerpScore(e.t, 300, 900) : 0, detail: e ? `${Math.round(e.t)} s` : 'none' }; }),
    C('se_stopped', 'Seizure stopped by 30 min', 15, 'glauser2016', p => {
      const log = p.seLog ?? [], stop = log.find(e => !e.on), again = log.filter(e => e.on).length - 1;
      if (p.crises.se.active || !stop) return { frac: 0, detail: 'still seizing' };
      return { frac: lerpScore(stop.t, 1200, 2400), detail: `stopped at ${Math.round(stop.t / 60)} min` + (again > 0 ? `, recurred ${again} time(s), controlled` : '') };
    }),
    criteria.survival(),
  ],
  learning: ['A seizure lasting 5 minutes is status epilepticus: treat it, do not wait.', 'First line: a benzodiazepine, IM midazolam 10 mg if there is no IV line, or IV lorazepam 4 mg; repeat once after 5-10 min if it continues.', 'Benzodiazepines work less well the longer the seizure lasts. By 20 minutes give a second-line drug: levetiracetam 60 mg/kg (max 4.5 g), fosphenytoin or valproate.', 'Check glucose, give oxygen, protect the airway. Still fitting at 40 minutes: anaesthesia and intubation (refractory status).'],
};

// ----------------------------------------------------------------------------- COPD exacerbation with hypercapnic respiratory failure (respiratory.js)
SCENARIOS.copd_exacerbation = {
  id: 'copd_exacerbation', title: 'COPD exacerbation', difficulty: 'intermediate', durationS: 5400, kind: 'Emergency',
  summary: 'A 71-year-old man (172 cm, 68 kg) with severe COPD has been more breathless for three days with more sputum. He is sitting up, using his neck muscles, and drowsy. Give the right oxygen, treat the airway obstruction, and decide on ventilatory support.',
  spec: { sex: 'M', age: 71, heightCm: 172, weightKg: 68, causes: [], copd: 1 },
  startMonitored: true,
  preRunS: 2400,
  init(p) { p.flags.spo2Probe = p.flags.ecgLeads = p.flags.nibp = true; p.crises.asthma = 0.75; },
  timeline: [],
  track(p) { if (p.flags.spo2Probe) { p.highO2S = (p.highO2S ?? 0) + (p.o2 && p.resp.spo2 > 96 ? p.dt : 0); p.inTargetS = (p.inTargetS ?? 0) + (p.t > 900 && p.resp.spo2 >= 88 && p.resp.spo2 <= 94 ? p.dt : 0); } },
  score: () => [
    C('copd_target', 'SpO2 kept at 88-92 % after the first 15 min (titrated oxygen)', 15, 'beasley2017_o2', p => ({ frac: Math.min(1, (p.inTargetS ?? 0) / Math.max(1, p.t - 900) / 0.7), detail: `${Math.round(100 * (p.inTargetS ?? 0) / Math.max(1, p.t - 900))} % of the time in 88-94 %` })),
    C('copd_no_high_o2', 'No high-concentration oxygen (SpO2 > 96 % on oxygen < 10 min)', 15, 'beasley2017_o2', p => ({ frac: lerpScore((p.highO2S ?? 0) / 60, 10, 30), detail: `${Math.round((p.highO2S ?? 0) / 60)} min above 96 %` })),
    C('copd_bronchodilator', 'Nebulised salbutamol within 10 min', 10, 'gold2024', p => { const d = drugsGiven(p, 'salbutamol')[0]; return { frac: d ? lerpScore(d.t, 600, 1800) : 0, detail: d ? `${Math.round(d.t / 60)} min` : 'none' }; }),
    C('copd_steroid', 'Systemic corticosteroid given', 5, 'gold2024', p => ({ frac: drugsGiven(p, 'hydrocortisone').length || drugsGiven(p, 'prednisolone').length ? 1 : 0, detail: '' })),
    C('copd_gas', 'Blood gas within 15 min', 10, 'davidson2016_niv', p => { const e = p.log.find(x => x.type === 'lab.order' && x.kind === 'abg'); return { frac: e ? lerpScore(e.t, 900, 2400) : 0, detail: e ? `${Math.round(e.t / 60)} min` : 'none' }; }),
    C('copd_niv', 'Bilevel NIV started within 60 min for a persistent respiratory acidosis', 20, 'davidson2016_niv', p => { const e = p.log.find(x => x.type === 'niv.set' && x.mode === 'bipap'); return { frac: e ? lerpScore(e.t, 3600, 5400) : 0, detail: e ? `BiPAP ${e.ipap}/${e.epap} at ${Math.round(e.t / 60)} min` : 'no NIV' }; }),
    C('copd_ph', 'pH >= 7.30 at the end', 15, 'davidson2016_niv', p => ({ frac: lerpScore(7.30 - p.resp.pH, 0, 0.08), detail: `pH ${p.resp.pH.toFixed(2)}` })),
    criteria.survival(),
  ],
  learning: ['In COPD at risk of CO2 retention, aim for SpO2 88-92 % with a 24-28 % Venturi mask: high-concentration oxygen raises the PaCO2 (less hypoxic vasoconstriction, Haldane effect, less hypoxic drive).', 'Treat the obstruction: nebulised salbutamol (with ipratropium), prednisolone 30-40 mg, antibiotics if the sputum is purulent.', 'Check a blood gas early. If pH < 7.35 and PaCO2 > 6.5 kPa (49 mmHg) persist after medical treatment, start bilevel NIV (IPAP 15 rising to 20+, EPAP 4-5) and recheck the gas within 1-2 h.'],
};

// ----------------------------------------------------------------------------- cases that use the existing engine
const ecg12At = (p) => p.log.find(e => (e.type === 'order' && e.what === 'ecg12') || e.type === 'exam.ecg12') || null;
const ecg12Crit = (ref, within = 300) => C('ecg12', `12-lead ECG within ${within / 60} min`, 10, ref, p => { const e = ecg12At(p); return { frac: e ? lerpScore(e.t, within, within * 3) : 0, detail: e ? `${Math.round(e.t)} s` : 'no 12-lead' }; });

SCENARIOS.svt = {
  id: 'svt', title: 'Narrow-complex tachycardia', difficulty: 'beginner', durationS: 1200, kind: 'ACLS',
  summary: 'A 32-year-old woman (165 cm, 60 kg) has had a fast regular heartbeat for 40 minutes. She is anxious but talking, with a pressure of 112/70. Make the diagnosis and bring her back to sinus rhythm safely.',
  spec: { sex: 'F', age: 32, heightCm: 165, weightKg: 60, causes: [], rhythm: 'SVT' },
  startMonitored: true,
  init(p) { p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = true; p.nibp = { sbp: 112, dbp: 70, t: 0, valid: true }; },
  timeline: [],
  track(p) { if (p.svtEndT == null && p.arrest.key === 'NSR') p.svtEndT = p.t; },
  score: () => [
    ecg12Crit('erc2025'),
    C('svt_vagal', 'Vagal manoeuvre first (modified Valsalva)', 15, 'appelboam2015', p => {
      const v = p.log.find(e => e.type === 'procedure.vagal'), a = drugsGiven(p, 'adenosine')[0];
      if (!v) return { frac: 0, detail: 'no vagal manoeuvre' };
      return { frac: (a && a.t < v.t ? 0.3 : 1) * (v.technique === 'standard' ? 0.6 : 1), detail: `${v.technique || 'modified'} at ${Math.round(v.t)} s` };
    }),
    C('svt_adenosine', 'Adenosine 6 mg rapid IV bolus, then 12 mg (and 18 mg) if needed', 25, 'erc2025', p => {
      const doses = drugsGiven(p, 'adenosine'); if (p.svtEndT != null && !doses.length) return null;   // a vagal manoeuvre was enough
      if (!doses.length) return { frac: 0, detail: 'no adenosine' };
      const first = doses[0], esc = doses.length < 2 || doses[1].amount >= 12;
      return { frac: (first.amount === 6 ? 1 : 0.6) * (esc ? 1 : 0.6), detail: doses.map(d => d.amount + ' mg').join(', ') };
    }),
    C('svt_no_early_shock', 'No shock while she is stable and adenosine has not been tried', 15, 'erc2025', p => {
      const s = p.log.find(e => e.type === 'defib.shock'); if (!s) return { frac: 1, detail: '' };
      return { frac: drugsGiven(p, 'adenosine').filter(d => d.t < s.t).length >= 2 ? 1 : 0, detail: `shock at ${Math.round(s.t)} s` };
    }),
    C('svt_converted', 'Sinus rhythm within 10 min', 25, 'erc2025', p => ({ frac: p.svtEndT == null ? 0 : lerpScore(p.svtEndT, 600, 1200), detail: p.svtEndT == null ? 'still in SVT' : `sinus at ${Math.round(p.svtEndT)} s` })),
    criteria.survival(),
  ],
  learning: ['Regular narrow-complex tachycardia without adverse features (shock, syncope, ischaemia, heart failure): vagal manoeuvres first. The modified Valsalva (strain 15 s, then lie flat with the legs raised) works about 2.5 times as often as the standard one.', 'Then adenosine 6 mg as a rapid bolus with a flush into a large vein, then 12 mg, then 18 mg. Warn the patient: a few seconds of chest discomfort and a pause on the monitor.', 'Synchronised cardioversion only if she becomes unstable or the drugs fail.'],
};

SCENARIOS.hyperkalaemia = {
  id: 'hyperkalaemia', title: 'Severe hyperkalaemia', difficulty: 'intermediate', durationS: 3600, kind: 'Emergency',
  summary: 'A 64-year-old man (175 cm, 80 kg) with chronic kidney disease on an ACE inhibitor feels weak. His potassium on the point-of-care gas is 7.0 mmol/L. Protect his heart and bring the potassium down.',
  spec: { sex: 'M', age: 64, heightCm: 175, weightKg: 80, causes: [], potassium: 7.0 },
  history: { hypertension: true },
  startMonitored: true,
  init(p) { p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = true; p.nibp = { sbp: 146, dbp: 84, t: 0, valid: true }; },
  timeline: [],
  track(p) { p.minGlu = Math.min(p.minGlu ?? 99, p.lytes.glucose); },
  score: () => [
    ecg12Crit('renal_hyperk2023'),
    C('hk_calcium', 'IV calcium within 10 min (about 6.8 mmol: calcium chloride 10 % 10 mL or gluconate 10 % 30 mL)', 20, 'renal_hyperk2023', p => {
      const d = p.drugs.log.find(x => (x.key === 'calciumChloride' || x.key === 'calciumGluconate') && x.amount >= 3.3);   // at least half of the full dose, either salt
      return d ? { frac: lerpScore(d.t, 600, 1200), detail: `${d.key} ${d.amount} mmol at ${Math.round(d.t / 60)} min` } : { frac: 0, detail: 'no calcium' };
    }),
    C('hk_insulin', 'Insulin 10 U with glucose 25 g within 20 min', 20, 'renal_hyperk2023', p => {
      const proc = p.log.find(e => e.type === 'procedure.treat_hyperkalemia'); if (proc) return { frac: lerpScore(proc.t, 1200, 2400), detail: `insulin-glucose at ${Math.round(proc.t / 60)} min` };
      const ins = drugsGiven(p, 'insulin').find(d => d.amount >= 8); if (!ins) return { frac: 0, detail: 'no insulin' };
      const glu = drugsGiven(p, 'glucose').some(d => d.amount >= 20 && Math.abs(d.t - ins.t) <= 600) || p.log.some(e => e.type === 'drug.infusion' && e.drug === 'glucose' && e.rate > 0);
      return { frac: lerpScore(ins.t, 1200, 2400) * (glu ? 1 : 0.3), detail: `insulin at ${Math.round(ins.t / 60)} min${glu ? '' : ', without glucose'}` };
    }),
    C('hk_salbutamol', 'Nebulised salbutamol 10-20 mg', 10, 'renal_hyperk2023', p => { const d = drugsGiven(p, 'salbutamol').reduce((s, x) => s + x.amount, 0); return { frac: Math.min(1, d / 10), detail: `${d} mg` }; }),
    C('hk_recheck', 'Potassium rechecked', 10, 'renal_hyperk2023', p => { const n = p.log.filter(e => e.type === 'lab.order' && ['abg', 'chem'].includes(e.kind)).length; return { frac: n >= 1 ? 1 : 0, detail: `${n} samples` }; }),
    C('hk_no_hypo', 'No hypoglycaemia (glucose >= 4 throughout)', 10, 'renal_hyperk2023', p => ({ frac: (p.minGlu ?? 5) >= 4 ? 1 : (p.minGlu ?? 5) >= 3 ? 0.4 : 0, detail: `lowest glucose ${(p.minGlu ?? 5).toFixed(1)}` })),
    criteria.survival('No cardiac arrest; alive and stable at the end'),
  ],
  learning: ['K >= 6.5 is severe: get a 12-lead and put him on a monitor. Peaked T waves, flat P waves and a widening QRS warn of arrest.', 'Calcium first if the ECG is abnormal: it protects the heart within minutes but does not lower the potassium.', 'Shift potassium into cells: insulin 10 U with glucose 25 g (falls ~0.6-1 mmol/L in 30-60 min) and nebulised salbutamol 10-20 mg. Then remove it (dialysis, binders) and stop the cause.', 'Insulin can cause hypoglycaemia for hours: check glucose regularly.'],
};

SCENARIOS.hypoglycaemia = {
  id: 'hypoglycaemia', title: 'Hypoglycaemia', difficulty: 'beginner', durationS: 2700, kind: 'Emergency',
  summary: 'A 68-year-old woman (160 cm, 70 kg) with type 2 diabetes started on long-acting insulin last week. Her daughter found her drowsy and sweaty; she is not making sense. Find the cause and treat it so that it stays treated.',
  spec: { sex: 'F', age: 68, heightCm: 160, weightKg: 70, causes: [], glucose: 1.8 },
  history: { diabetes: true, hypertension: true },
  startMonitored: true,
  init(p) { p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = true; p.nibp = { sbp: 152, dbp: 86, t: 0, valid: true }; },
  timeline: [],
  track(p) { if (p.t > 300) p.minGluLate = Math.min(p.minGluLate ?? 99, p.lytes.glucose); },
  score: () => [
    C('hy_cbg', 'Capillary glucose within 5 min', 15, 'jbds_hypo2022', p => { const e = p.log.find(x => x.type === 'lab.order' && ['cbg', 'abg', 'chem'].includes(x.kind)); return { frac: e ? lerpScore(e.t, 300, 900) : 0, detail: e ? `${Math.round(e.t)} s` : 'not checked' }; }),
    C('hy_treat', 'IV glucose 15-20 g or glucagon 1 mg within 10 min', 25, 'jbds_hypo2022', p => {
      const d = p.drugs.log.find(x => (x.key === 'glucose' && x.amount >= 10) || (x.key === 'glucagon' && x.amount >= 0.5));
      return d ? { frac: lerpScore(d.t, 600, 1200) * (d.key === 'glucose' && d.amount > 30 ? 0.7 : 1), detail: `${d.key} ${d.amount} at ${Math.round(d.t / 60)} min` } : { frac: 0, detail: 'not treated' };
    }),
    C('hy_recheck', 'Glucose rechecked within 15 min of treatment', 15, 'jbds_hypo2022', p => {
      const d = p.drugs.log.find(x => x.key === 'glucose' || x.key === 'glucagon'); if (!d) return null;
      const e = p.log.find(x => x.type === 'lab.order' && ['cbg', 'abg', 'chem'].includes(x.kind) && x.t > d.t); return { frac: e ? lerpScore(e.t - d.t, 900, 1800) : 0, detail: e ? `${Math.round((e.t - d.t) / 60)} min after` : 'no recheck' };
    }),
    C('hy_sustain', 'Kept up (long-acting insulin): glucose infusion or repeat dose, no relapse below 4', 25, 'jbds_hypo2022', p => {
      const inf = p.log.some(e => e.type === 'drug.infusion' && e.drug === 'glucose' && e.rate > 0), lo = p.minGluLate ?? 99;
      return { frac: (lo >= 4 ? 0.7 : lo >= 3 ? 0.3 : 0) + (inf ? 0.3 : 0), detail: `lowest after 5 min ${lo === 99 ? '-' : lo.toFixed(1)}${inf ? ', infusion started' : ''}` };
    }),
    criteria.survival(),
  ],
  learning: ['Anyone drowsy, confused or fitting: check the glucose. Hypoglycaemia is < 4 mmol/L.', 'Unconscious or cannot swallow: IV glucose 15-20 g (150-200 mL of 10 % or 75-100 mL of 20 %), or glucagon 1 mg IM without IV access. Recheck after 10-15 min.', 'With long-acting insulin or a sulfonylurea it comes back: start a glucose infusion and keep checking.'],
};

SCENARIOS.mobitz_brady = {
  id: 'mobitz_brady', title: 'Bradycardia with Mobitz II block', difficulty: 'intermediate', durationS: 1500, kind: 'ACLS',
  summary: 'A 72-year-old man (176 cm, 78 kg) felt faint twice this morning. His pulse is slow and his pressure low. Assess the rhythm, treat it, and protect him from asystole.',
  spec: { sex: 'M', age: 72, heightCm: 176, weightKg: 78, causes: [], rhythm: 'AV_BLOCK2' },
  history: { hypertension: true },
  startMonitored: true,
  init(p) { p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = true; p.nibp = { sbp: 84, dbp: 48, t: 0, valid: true }; },
  timeline: [],
  track(p) { if (p.supportT == null && (p.crises.captured || p.log.some(e => e.type === 'drug.infusion' && ['isoprenaline', 'epinephrine'].includes(e.drug) && e.rate > 0))) p.supportT = p.t; },
  score: () => [
    ecg12Crit('erc2025'),
    C('mb_atropine', 'Atropine 500 mcg IV for adverse features', 10, 'erc2025', p => { const d = drugsGiven(p, 'atropine')[0]; return { frac: d ? lerpScore(d.t, 300, 900) : 0, detail: d ? `${d.amount} mcg at ${Math.round(d.t)} s` : 'no atropine' }; }),
    C('mb_pads', 'Pads on (risk of asystole)', 10, 'erc2025', p => { const e = p.log.find(x => x.type === 'defib.pads'); return { frac: e ? lerpScore(e.t, 300, 900) : 0, detail: e ? `${Math.round(e.t)} s` : 'no pads' }; }),
    C('mb_support', 'Pacing with capture or an isoprenaline / adrenaline infusion within 10 min', 30, 'erc2025', p => ({ frac: p.supportT == null ? 0 : lerpScore(p.supportT, 600, 1200), detail: p.supportT == null ? 'no interim measure' : `at ${Math.round(p.supportT / 60)} min` })),
    C('mb_analgesia', 'Analgesia or sedation if paced', 10, 'erc2025', p => { if (!p.crises.captured && !p.log.some(e => e.type === 'pacing.set' && e.on)) return null; return { frac: ['morphine', 'fentanyl', 'midazolam', 'ketamine'].some(k => drugsGiven(p, k).length) ? 1 : 0, detail: '' }; }),
    criteria.survival(),
  ],
  learning: ['Bradycardia with adverse features (shock, syncope, ischaemia, heart failure): atropine 500 mcg IV, repeat up to 3 mg.', 'Mobitz II, complete heart block, a recent pause > 3 s or asystole are a risk of asystole: start an interim measure even if atropine helps, pacing or isoprenaline 5 mcg/min or adrenaline 2-10 mcg/min, and call for transvenous pacing.', 'The block is below the AV node in Mobitz II, so atropine changes little.'],
};

// ----------------------------------------------------------------------------- sodium, pulmonary oedema, hypertensive emergency, variceal bleeding
const labAt = (p, kinds, after = -1) => p.log.find(e => e.type === 'lab.order' && kinds.includes(e.kind) && e.t > after) || null;

SCENARIOS.hyponatraemia = {
  id: 'hyponatraemia', title: 'Severe symptomatic hyponatraemia', difficulty: 'advanced', durationS: 5400, kind: 'Emergency',
  summary: 'A 72-year-old woman (160 cm, 62 kg) started a thiazide diuretic three weeks ago. Since yesterday she has been vomiting and confused, and she is now very drowsy. Find the cause, treat the danger, and do not overshoot.',
  spec: { sex: 'F', age: 72, heightCm: 160, weightKg: 62, causes: [], sodium: 113 },
  history: { hypertension: true },
  startMonitored: true,
  init(p) { p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = true; p.nibp = { sbp: 128, dbp: 74, t: 0, valid: true }; },
  timeline: [],
  track(p) { if (p.na0 == null) p.na0 = p.lytes.na; },
  score: () => [
    C('na_measure', 'Sodium measured within 10 min', 10, 'spasovski2014', p => { const e = labAt(p, ['abg', 'chem']); return { frac: e ? lerpScore(e.t, 600, 1800) : 0, detail: e ? `${Math.round(e.t / 60)} min` : 'not measured' }; }),
    C('na_hypertonic', '150 mL of 3 % saline over 20 min, started within 15 min', 25, 'spasovski2014', p => {
      const e = p.log.find(x => x.type === 'fluid.bolus' && x.fluid === 'saline3'); if (!e) return { frac: 0, detail: 'no hypertonic saline' };
      const dose = e.volumeL >= 0.1 && e.volumeL <= 0.25 ? 1 : 0.6;
      return { frac: dose * lerpScore(e.t, 900, 2400), detail: `${Math.round(e.volumeL * 1000)} mL at ${Math.round(e.t / 60)} min` };
    }),
    C('na_recheck', 'Sodium rechecked after the bolus', 10, 'spasovski2014', p => { const b = p.log.find(x => x.type === 'fluid.bolus' && x.fluid === 'saline3'); if (!b) return null; const e = labAt(p, ['abg', 'chem'], b.t + 600); return { frac: e ? 1 : 0, detail: e ? `${Math.round((e.t - b.t) / 60)} min after` : 'no recheck' }; }),
    C('na_rise', 'Sodium up by about 5 mmol/L in the first hours', 20, 'spasovski2014', p => { const r = p.lytes.na - p.na0; return { frac: lerpScore(4 - r, 0, 3), detail: `+${r.toFixed(1)} mmol/L` }; }),
    C('na_limit', 'No overcorrection (rise <= 10 mmol/L)', 15, 'spasovski2014', p => { const r = p.lytes.na - p.na0; return { frac: lerpScore(r, 10, 14), detail: `+${r.toFixed(1)} mmol/L` }; }),
    C('na_no_hypotonic', 'No hypotonic fluid (glucose 5 %)', 10, 'spasovski2014', p => ({ frac: p.log.some(x => x.type === 'fluid.bolus' && x.fluid === 'glucose5') ? 0 : 1, detail: '' })),
    criteria.survival(),
  ],
  learning: ['Hyponatraemia with severe symptoms (vomiting, deep drowsiness, seizures, coma) is an emergency whatever the cause: brain swelling kills.', 'Give 150 mL of 3 % saline over 20 minutes, check the sodium, and repeat up to twice until it has risen by 5 mmol/L.', 'Then stop: limit the rise to 10 mmol/L in the first 24 hours (8 after that). Faster correction risks osmotic demyelination.', 'Stop the thiazide. Never give hypotonic fluid.'],
};

SCENARIOS.pulmonary_oedema = {
  id: 'pulmonary_oedema', title: 'Acute pulmonary oedema', difficulty: 'intermediate', durationS: 2700, kind: 'Emergency',
  summary: 'A 74-year-old man (172 cm, 82 kg) with heart failure woke up fighting for breath. He is sitting bolt upright, grey and sweating, with pink frothy sputum and a pressure of 190/115. Relieve him.',
  spec: { sex: 'M', age: 74, heightCm: 172, weightKg: 82, causes: [], lvFunction: 0.5, map0: 132, congestion: true },
  history: { chf: true, hypertension: true },
  startMonitored: true, preRunS: 900,
  init(p) { p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = true; p.vol.vp += 0.6; },
  timeline: [],
  track(p) { if (p.sbp0 == null) p.sbp0 = p.circ.sbp; },
  score: () => [
    ecg12Crit('esc_hf2021', 600),
    C('po_upright', 'Sat upright', 5, 'esc_hf2021', p => ({ frac: p.headUp ? 1 : 0, detail: '' })),
    C('po_cpap', 'CPAP or bilevel NIV within 10 min', 20, 'rochwerg2017_niv', p => { const e = p.log.find(x => x.type === 'niv.set' && ['cpap', 'bipap'].includes(x.mode)); return { frac: e ? lerpScore(e.t, 600, 1500) : 0, detail: e ? `${e.mode} at ${Math.round(e.t / 60)} min` : 'no NIV' }; }),
    C('po_nitrate', 'IV nitrate within 10 min (systolic > 110)', 20, 'esc_hf2021', p => {
      const e = p.log.find(x => (x.type === 'drug.infusion' && x.drug === 'nitroglycerin' && x.rate > 0) || (x.type === 'drug.bolus' && x.drug === 'nitroglycerin'));
      return { frac: e ? lerpScore(e.t, 600, 1500) : 0, detail: e ? `${Math.round(e.t / 60)} min` : 'no nitrate' };
    }),
    C('po_diuretic', 'IV furosemide 40 mg or more within 15 min', 15, 'esc_hf2021', p => { const d = drugsGiven(p, 'furosemide')[0]; return { frac: d ? (d.amount >= 40 ? 1 : 0.6) * lerpScore(d.t, 900, 1800) : 0, detail: d ? `${d.amount} mg at ${Math.round(d.t / 60)} min` : 'none' }; }),
    C('po_no_fluid', 'No fluid bolus', 10, 'esc_hf2021', p => ({ frac: p.vol.totalCrystalloid > 0.25 ? 0 : 1, detail: `${Math.round(p.vol.totalCrystalloid * 1000)} mL` })),
    C('po_spo2', 'SpO2 >= 92 % at the end', 10, 'esc_hf2021', p => ({ frac: lerpScore(92 - p.resp.spo2, 0, 6), detail: `${p.resp.spo2.toFixed(0)} %` })),
    criteria.survival(),
  ],
  learning: ['Acute pulmonary oedema with a high pressure: the lungs are flooded because the left heart cannot empty against the afterload. Sit the patient up.', 'CPAP or bilevel NIV early: it re-opens flooded alveoli and reduces the work of breathing.', 'IV nitrate when systolic pressure is above 110 mmHg (it lowers preload and afterload), and IV furosemide 40 mg (or the home dose).', 'No fluid. Look for the trigger: ischaemia (12-lead), arrhythmia, missed tablets.'],
};

SCENARIOS.hypertensive_emergency = {
  id: 'hypertensive_emergency', title: 'Hypertensive emergency', difficulty: 'intermediate', durationS: 3600, kind: 'Emergency',
  summary: 'A 58-year-old man (176 cm, 88 kg) stopped his blood pressure tablets a month ago. He has a severe headache, blurred vision and is muddled. His pressure is 230/140. Lower it safely.',
  spec: { sex: 'M', age: 58, heightCm: 176, weightKg: 88, causes: [], map0: 160, ecg: ['lvh'] },
  history: { hypertension: true },
  startMonitored: true,
  init(p) { p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = true; },
  timeline: [],
  track(p) { if (p.map0 == null) p.map0 = p.circ.mapArt; p.minMapHt = Math.min(p.minMapHt ?? 999, p.circ.mapArt); },
  score: () => [
    ecg12Crit('esc_htn2018', 600),
    C('ht_drug', 'Titratable IV drug within 15 min (labetalol, urapidil or nitrate)', 20, 'esc_htn2018', p => {
      const d = p.drugs.log.find(x => ['labetalol', 'urapidil', 'nitroglycerin', 'esmolol'].includes(x.key)), inf = p.log.find(x => x.type === 'drug.infusion' && ['nitroglycerin', 'labetalol', 'urapidil'].includes(x.drug) && x.rate > 0);
      const t0 = Math.min(d ? d.t : 1e9, inf ? inf.t : 1e9); return { frac: t0 < 1e9 ? lerpScore(t0, 900, 2400) : 0, detail: t0 < 1e9 ? `${Math.round(t0 / 60)} min` : 'no IV drug' };
    }),
    C('ht_aline', 'Invasive arterial pressure', 10, 'esc_htn2018', p => ({ frac: p.flags.aline ? 1 : 0, detail: '' })),
    C('ht_target', 'MAP lowered by 20-25 % at one hour', 30, 'esc_htn2018', p => { const r = 1 - p.circ.mapArt / p.map0; return { frac: r < 0.2 ? lerpScore(0.2 - r, 0.03, 0.14) : lerpScore(r - 0.25, 0.03, 0.12), detail: `-${(r * 100).toFixed(0)} %` }; }),
    C('ht_no_crash', 'Never more than 30 % below the starting MAP', 20, 'esc_htn2018', p => { const r = 1 - p.minMapHt / p.map0; return { frac: lerpScore(r, 0.30, 0.42), detail: `lowest -${(r * 100).toFixed(0)} %` }; }),
    criteria.survival(),
  ],
  learning: ['A hypertensive emergency is a very high pressure WITH acute organ damage (brain, heart, kidney, retina, aorta). Without organ damage it is not an emergency.', 'Lower the mean pressure by 20-25 % over the first hours with a titratable IV drug (labetalol, urapidil, nicardipine): the brain has adapted to the high pressure and a fast fall causes a stroke.', 'Exceptions that need a faster, lower target: aortic dissection, acute pulmonary oedema, pre-eclampsia.', 'Monitor the pressure invasively and repeat small doses.'],
};

SCENARIOS.variceal_bleed = {
  id: 'variceal_bleed', title: 'Variceal bleeding', difficulty: 'advanced', durationS: 2700, kind: 'Emergency',
  summary: 'A 54-year-old man (178 cm, 80 kg) with alcohol-related cirrhosis vomits a large amount of fresh blood in the waiting room. He is pale, sweaty and jaundiced, with a distended abdomen. Resuscitate him and stop the bleeding.',
  spec: { sex: 'M', age: 54, heightCm: 178, weightKg: 80, causes: [] },
  startMonitored: true,
  init(p) {
    p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = true;
    p.varix = { rate: 110, controlled: false };                         // mL/min at a normal pressure
    p.vol.fAmt *= 0.65; p.vol.fibAmt *= 0.7; p.vol.pltAmt *= 0.45;      // cirrhosis: INR ~1.5, low fibrinogen, platelets ~110
    p.vol.res.f *= 0.65; p.vol.res.fib *= 0.7; p.vol.res.plt *= 0.45;
  },
  timeline: [],
  track(p) { if (p.vol.totalBlood > 0) p.maxHbTx = Math.max(p.maxHbTx ?? 0, p.vol.hb); },
  score: () => [
    C('vb_terlipressin', 'Vasoactive drug (terlipressin 2 mg) within 15 min', 20, 'baveno7', p => { const d = drugsGiven(p, 'terlipressin')[0]; return { frac: d ? lerpScore(d.t, 900, 1800) : 0, detail: d ? `${d.amount} mg at ${Math.round(d.t / 60)} min` : 'none' }; }),
    C('vb_antibiotic', 'Antibiotic prophylaxis (ceftriaxone 1 g)', 10, 'baveno7', p => ({ frac: drugsGiven(p, 'ceftriaxone').length ? 1 : 0, detail: '' })),
    C('vb_transfusion', 'Restrictive transfusion (Hb kept near 7-8, never above 9.5 g/dL after transfusion)', 15, 'villanueva2013', p => {
      if (p.vol.totalBlood === 0) return { frac: p.vol.hb >= 7 ? 1 : 0.3, detail: `no transfusion, Hb ${p.vol.hb.toFixed(1)}` };
      return { frac: lerpScore(p.maxHbTx, 9.5, 11.5) * (p.vol.hb >= 6.5 ? 1 : 0.5), detail: `highest Hb after transfusion ${p.maxHbTx.toFixed(1)}, final ${p.vol.hb.toFixed(1)}` };
    }),
    C('vb_endoscopy', 'Endoscopy with band ligation', 20, 'baveno7', p => { const e = p.log.find(x => x.type === 'procedure.endoscopy'); return { frac: e ? lerpScore(e.t, 1500, 2700) : 0, detail: e ? `${Math.round(e.t / 60)} min` : 'not done' }; }),
    C('vb_no_txa', 'No tranexamic acid', 5, 'baveno7', p => ({ frac: drugsGiven(p, 'tranexamicAcid').length ? 0 : 1, detail: '' })),
    C('vb_controlled', 'Bleeding controlled', 15, 'baveno7', p => ({ frac: p.varix && p.varix.controlled ? 1 : 0, detail: p.varix && p.varix.controlled ? `at ${Math.round(p.bleedControlledAt / 60)} min` : 'still bleeding' })),
    criteria.survival(),
  ],
  learning: ['Haematemesis in cirrhosis is variceal until proven otherwise. Two large IV lines, blood for group and crossmatch.', 'Start a vasoactive drug at once, before endoscopy (terlipressin 2 mg IV): it lowers the portal pressure. Give antibiotic prophylaxis (ceftriaxone 1 g).', 'Transfuse restrictively to a haemoglobin of 7-8 g/dL and do not over-fill: more volume means more portal pressure and more bleeding.', 'Endoscopic band ligation within 12 hours, sooner if unstable; protect the airway if he is drowsy or vomiting blood. Tranexamic acid does not help.'],
};


// ---------------------------------------------------------------- regional anaesthesia and the recovery room
const firstAfter = (p, keys, t0) => p.drugs.log.find(d => keys.includes(d.key) && d.t >= t0) || null;
const VASOPRESSORS = ['phenylephrine', 'ephedrine', 'norepinephrine', 'epinephrine'];
const trackMap = (p) => { if (p.spinalT0 != null) { p.minMapRatio = Math.min(p.minMapRatio ?? 1, p.circ.mapArt / p.mapRef); if (p.lowMapT == null && p.circ.mapArt < 0.8 * p.mapRef) p.lowMapT = p.t; } };

SCENARIOS.spinal_hypotension = {
  id: 'spinal_hypotension', title: 'Hypotension after a spinal', difficulty: 'intermediate', durationS: 1500, kind: 'Anaesthesia',
  summary: 'An 82-year-old woman (155 cm, 52 kg) with a fractured neck of femur has just had a spinal with 12.5 mg of hyperbaric bupivacaine 0.5 % for a hemiarthroplasty. She is monitored and has an IV line. Look after her for the next 25 minutes.',
  spec: { sex: 'F', age: 82, heightCm: 155, weightKg: 52, causes: [] },
  startMonitored: true,
  init(p) { p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = p.flags.ivAccess = true; p.nibp = { sbp: 138, dbp: 72, t: 0, valid: true }; },
  timeline: [{ t: 5, run: p => { p.neuraxial.spinal(12.5, p.t, { spread: 0 }); p.spinalT0 = p.t; p.mapRef = p.circ.mapArt; } }],
  track: trackMap,
  score: () => [
    C('sp_vaso', 'Vasopressor within 2 min of the MAP falling below 80 % of baseline', 30, 'griffiths2021', p => {
      if (p.lowMapT == null) return { frac: 1, detail: 'MAP kept within 20 %' };
      const d = firstAfter(p, VASOPRESSORS, p.spinalT0); if (!d) return { frac: 0, detail: 'no vasopressor' };
      return { frac: lerpScore(d.t - p.lowMapT, 120, 420), detail: `${d.key} ${Math.round(d.t - p.lowMapT)} s after the fall` };
    }),
    C('sp_nadir', 'Lowest MAP within 20 % of baseline (none at 40 % below)', 25, 'griffiths2021', p => ({ frac: lerpScore(1 - (p.minMapRatio ?? 1), 0.2, 0.4), detail: `${Math.round(100 * (1 - (p.minMapRatio ?? 1)))} % below baseline` })),
    C('sp_level', 'Block height checked within 10 min', 10, 'hocking2004', p => { const e = p.log.find(x => x.type === 'neuraxial.assess'); return { frac: e ? lerpScore(e.t - (p.spinalT0 ?? 0), 600, 1200) : 0, detail: e ? `at ${Math.round(e.t / 60)} min` : 'never checked' }; }),
    C('sp_fluid', 'Fluid 250-1000 mL, not more (frail, elderly)', 10, 'griffiths2021', p => { const v = p.vol.totalCrystalloid; return { frac: v < 0.25 ? v / 0.25 : v <= 1.0 ? 1 : lerpScore(v, 1.0, 2.0), detail: `${Math.round(v * 1000)} mL` }; }),
    C('sp_nausea', 'No vomiting', 5, 'carpenter1992', p => ({ frac: p.ponv.vomits.length ? 0 : 1, detail: `${p.ponv.vomits.length} episode(s)` })),
  ],
  learning: ['A spinal blocks the sympathetic outflow below the block: arterioles and veins dilate. The higher the block and the older the patient, the deeper the fall in pressure.', 'For a hip fracture use a low dose (hyperbaric bupivacaine 10 mg or less) and keep the pressure within 20 % of baseline: treat early with a vasopressor (phenylephrine 50-100 mcg, ephedrine 3-6 mg, or a norepinephrine infusion) rather than litres of fluid.', 'A block at or above T4 reaches the cardioaccelerator fibres: the heart cannot speed up, and a low venous return can cause sudden bradycardia. Ephedrine or atropine, legs raised.', 'Nausea after a spinal is usually hypotension: correct the pressure first.'],
};

SCENARIOS.high_spinal = {
  id: 'high_spinal', title: 'High block after an epidural top-up', difficulty: 'advanced', durationS: 1200, kind: 'Anaesthesia',
  summary: 'A 52-year-old man (178 cm, 85 kg) has an epidural catheter for a knee replacement. A colleague has just given a top-up of 15 mL of bupivacaine 0.5 % without a test dose and left the room. A minute later he says his hands are tingling and he cannot breathe properly. Manage him.',
  spec: { sex: 'M', age: 52, heightCm: 178, weightKg: 85, causes: [], catheter: 'intrathecal' },
  startMonitored: true,
  init(p) { p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = p.flags.ivAccess = true; p.nibp = { sbp: 134, dbp: 78, t: 0, valid: true }; p.o2 = { fio2: 0.3, seal: 0.6 }; },
  timeline: [{ t: 2, run: p => { p.neuraxial._start('spinal', p.neuraxial.spinalTarget(75), 1.2, p.t); p.spinalT0 = p.t; p.mapRef = p.circ.mapArt; } }],
  track(p) { trackMap(p); if (p.breathT == null && p.neuraxial.seg < 5) p.breathT = p.t; if (p.bradyT == null && p.circ.hr < 50 && !p.arrest.arrested) p.bradyT = p.t; },
  score: () => [
    C('hs_vent', 'Ventilation supported within 2 min of the block reaching the diaphragm (C3-C5)', 30, 'textbook', p => {
      if (p.breathT == null) return null;
      const e = p.log.find(x => (x.type === 'vent.set' && x.settings?.mode === 'ctrl') || x.type === 'airway.intubate'); if (!e) return { frac: 0, detail: 'never ventilated' };
      return { frac: lerpScore(e.t - p.breathT, 120, 360), detail: `${Math.round(e.t - p.breathT)} s after onset` };
    }),
    C('hs_vaso', 'Vasopressor within 2 min of the MAP falling below 80 % of baseline', 20, 'carpenter1992', p => {
      if (p.lowMapT == null) return { frac: 1, detail: 'MAP kept within 20 %' };
      const d = firstAfter(p, VASOPRESSORS, p.spinalT0 ?? 0); if (!d) return { frac: 0, detail: 'no vasopressor' };
      return { frac: lerpScore(d.t - p.lowMapT, 120, 420), detail: `${d.key} ${Math.round(d.t - p.lowMapT)} s after the fall` };
    }),
    C('hs_brady', 'Bradycardia treated (atropine, ephedrine or epinephrine) within 2 min', 10, 'carpenter1992', p => {
      if (p.bradyT == null) return null;
      const d = firstAfter(p, ['atropine', 'ephedrine', 'epinephrine', 'glycopyrrolate'], p.bradyT - 30); if (!d) return { frac: 0, detail: 'not treated' };
      return { frac: lerpScore(d.t - p.bradyT, 120, 360), detail: `${d.key} ${Math.round(d.t - p.bradyT)} s after` };
    }),
    C('hs_airway', 'Airway secured with a tracheal tube', 10, 'textbook', p => ({ frac: p.airway.intubated ? 1 : 0, detail: p.airway.intubated ? 'intubated' : 'not intubated' })),
    C('hs_sedation', 'Sedation once intubated (he may be awake under the block)', 10, 'textbook', p => {
      const it = p.log.find(x => x.type === 'airway.intubate'); if (!it) return null;
      const d = firstAfter(p, ['midazolam', 'propofol', 'ketamine', 'etomidate'], it.t - 120); return { frac: d ? 1 : 0, detail: d ? d.key : 'none' };
    }),
    criteria.survival(),
  ],
  learning: ['Tingling or weak hands, difficulty breathing or speaking and a falling pressure soon after an epidural dose: the block is too high. A catheter can lie in, or migrate into, the subarachnoid space: always aspirate and give a test dose, and stay with the patient.', 'High block: call for help, stop the epidural, oxygen, support the breathing (bag-mask, then intubate if the block reaches the diaphragm), vasopressor and atropine or epinephrine for bradycardia; raise the legs.', 'The patient may be fully awake while unable to breathe or move: talk to them, and give sedation once the airway is secured.', 'The block wears off in 1-2 hours: support until then.'],
};

SCENARIOS.pacu_ponv = {
  id: 'pacu_ponv', title: 'Recovery room: nausea, vomiting and shivering', difficulty: 'beginner', durationS: 3600, kind: 'Anaesthesia',
  summary: 'A 34-year-old woman (165 cm, 62 kg), a non-smoker who was sick after her last operation, has just arrived in recovery after a laparoscopic cholecystectomy. She received 10 mg of morphine and no antiemetic. She is awake, cold and shaking. Look after her in recovery.',
  spec: { sex: 'F', age: 34, heightCm: 165, weightKg: 62, causes: [], pacu: true, ponvHistory: true, smoker: false },
  startMonitored: true,
  init(p) {
    p.flags.ecgLeads = p.flags.spo2Probe = p.flags.nibp = p.flags.ivAccess = p.flags.tempProbe = true; p.nibp = { sbp: 124, dbp: 74, t: 0, valid: true };
    p.therm.tc = 35.2; p.therm.tp = 30.5; p.drugs.bolus('morphine', 10, 0);
  },
  track(p) { if (p.vomitT == null && p.ponv.vomits.length) p.vomitT = p.ponv.vomits[0]; if (p.nauseaT == null && p.ponv.nausea > 0.6) p.nauseaT = p.t; },
  score: () => [
    C('pacu_rescue', 'Rescue antiemetic (ondansetron or droperidol) within 5 min of nausea', 30, 'gan2020', p => {
      const t0 = p.nauseaT ?? p.vomitT; if (t0 == null) return { frac: 1, detail: 'no nausea' };
      const d = firstAfter(p, ['ondansetron', 'droperidol'], 0); if (!d) return { frac: 0, detail: firstAfter(p, ['dexamethasone'], 0) ? 'dexamethasone only (too slow for rescue)' : 'none given' };
      return { frac: lerpScore(d.t - t0, 300, 900), detail: `${d.key} ${Math.max(0, Math.round(d.t - t0))} s after` };
    }),
    C('pacu_settled', 'No vomiting in the last 10 min', 15, 'gan2020', p => { const late = p.ponv.vomits.filter(x => x > p.t - 600).length; return { frac: late ? 0 : 1, detail: `${p.ponv.vomits.length} episode(s) in all, ${late} in the last 10 min` }; }),
    C('pacu_warm', 'Shivering treated: forced-air warming or pethidine within 10 min', 20, 'kranke2002', p => {
      const w = p.log.find(x => x.type === 'thermal.device' && x.target != null), d = firstAfter(p, ['pethidine'], 0), t = Math.min(w?.t ?? Infinity, d?.t ?? Infinity);
      return Number.isFinite(t) ? { frac: lerpScore(t, 600, 1200), detail: `${w ? 'warming' : 'pethidine'} at ${Math.round(t / 60)} min` } : { frac: 0, detail: 'not treated' };
    }),
    C('pacu_o2', 'Oxygen while she is shivering', 10, 'sessler2016', p => ({ frac: p.log.some(x => x.type === 'o2.mask' || x.type === 'niv.set') ? 1 : 0, detail: '' })),
    C('pacu_temp', 'Core temperature at least 36.0 C before discharge from recovery', 15, 'nice_cg65', p => ({ frac: p.therm.tc >= 36.0 ? 1 : lerpScore(36.0 - p.therm.tc, 0, 0.3), detail: `${p.therm.tc.toFixed(1)} C` })),
  ],
  learning: ['Apfel score: female, non-smoker, previous PONV or motion sickness, postoperative opioids. Four factors: about 80 % risk. She should have had two or three antiemetics as prophylaxis.', 'Rescue with a class not already given (ondansetron 4 mg, or droperidol 0.625-1.25 mg). Dexamethasone takes 1-2 hours: prophylaxis, not rescue.', 'Shivering after surgery: warm actively (forced air), give oxygen (it raises the oxygen consumption), and pethidine 25 mg IV if it continues.', 'Discharge from recovery only when the core temperature is at least 36.0 C.'],
};
