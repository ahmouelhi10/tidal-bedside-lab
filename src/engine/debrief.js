// Structured debrief: finds the moments worth discussing in a replayed session and compares the learner's self-assessment
// with the verified score. Pure and read-only: it works on the timeline built by timeline.js and never touches a Patient.
//
// The debrief follows the PEARLS phases (reactions, description, analysis, summary; REF eppich2015). The analysis phase uses
// advocacy-inquiry: the instructor states what they observed and why it matters, then asks for the learner's frame (REF rudolph2006).
// This module only supplies the observations; the wording of the questions lives in the client's i18n strings.

export const PEARLS_PHASES = Object.freeze(['reactions', 'description', 'analysis', 'summary']);   // REF eppich2015
/** What a pre-brief covers before a scored case: the fiction contract, psychological safety, orientation to the
 *  environment and equipment, and the objectives (REF inacsl2021_prebrief). */
export const PREBRIEF_ITEMS = Object.freeze(['fiction', 'safety', 'orientation', 'objectives']);
/** Self-rating categories: the four ANTS non-technical skill categories (REF fletcher2003), rated 1-4 like ANTS. */
export const ANTS_CATEGORIES = Object.freeze(['task', 'team', 'sa', 'dm']);
/** Handover at the end of a case, structured as SBAR (REF haig2006). */
export const SBAR = Object.freeze(['s', 'b', 'a', 'r']);

/** Physiological thresholds for a "moment": hypoxaemia SpO2 < 90 % and hypotension MAP < 65 mmHg (the post-arrest targets
 *  are SpO2 >= 90 and MAP >= 65, REF aha2025_part11); a moment must last at least MIN_EPISODE_S to be worth raising (REF design). */
export const THRESH = Object.freeze({ spo2Low: 90, mapLow: 65, hrHigh: 150, hrLow: 40 });   // HR bounds REF design (marked tachy/bradycardia for discussion)
export const MIN_EPISODE_S = 60;                    // REF design
export const MONITOR_DELAY_S = 60;                  // monitoring attached later than 1 min is raised (REF design)
export const MAX_MOMENTS = 5;                       // a debrief discusses a few points well rather than everything (REF eppich2015)

/** Contiguous runs where test(value, i) holds for at least minDur seconds. */
export function findEpisodes(tl, key, test, minDur = MIN_EPISODE_S) {
  const out = []; let start = null, ext = null;
  const close = (endI) => { const s = tl.t[start], e = tl.t[endI]; if (e - s >= minDur) out.push({ start: s, end: e, dur: e - s, extreme: ext }); start = null; };
  for (let i = 0; i < tl.t.length; i++) {
    const v = tl[key][i], ok = Number.isFinite(v) && test(v, i);
    if (ok) { if (start == null) { start = i; ext = v; } else ext = key === 'hr' && v > THRESH.hrHigh ? Math.max(ext, v) : Math.min(ext, v); }
    else if (start != null) close(i);
  }
  if (start != null) close(tl.t.length - 1);
  return out;
}

/** The first accepted learner action after time s (what was done about it). */
const firstActionAfter = (events, s) => events.find(e => e.ok && e.t >= s && e.type !== 'instructor.inject') || null;   // the learner's actions, not the instructor's

/**
 * Moments for the analysis phase, most important first.
 * @param {{t:number[], hr:number[], map:number[], spo2:number[], arrested?:number[], events:object[]}} tl  timeline (timeline.js)
 * @param {{monitoring?:number|null}} keyTimes  first-action times (keyActionTimes)
 * @returns {{kind:string, t:number, dur?:number, value?:number, action?:object|null, severity:number}[]}
 */
export function debriefMoments(tl, keyTimes = {}) {
  const arr = tl.arrested || tl.t.map(() => 0), m = [];
  for (const e of findEpisodes(tl, 'arrested', (v) => v === 1, 1)) m.push({ kind: 'arrest', t: e.start, dur: e.dur, action: firstActionAfter(tl.events, e.start), severity: 4 });
  const alive = (i) => !arr[i];                     // during an arrest low SpO2 / MAP are the arrest itself, discussed once above
  for (const e of findEpisodes(tl, 'spo2', (v, i) => alive(i) && v < THRESH.spo2Low)) m.push({ kind: 'hypoxaemia', t: e.start, dur: e.dur, value: Math.round(e.extreme), action: firstActionAfter(tl.events, e.start), severity: 3 });
  for (const e of findEpisodes(tl, 'map', (v, i) => alive(i) && v < THRESH.mapLow)) m.push({ kind: 'hypotension', t: e.start, dur: e.dur, value: Math.round(e.extreme), action: firstActionAfter(tl.events, e.start), severity: 3 });
  for (const e of findEpisodes(tl, 'hr', (v, i) => alive(i) && v > THRESH.hrHigh)) m.push({ kind: 'tachycardia', t: e.start, dur: e.dur, value: Math.round(e.extreme), action: firstActionAfter(tl.events, e.start), severity: 2 });
  for (const e of findEpisodes(tl, 'hr', (v, i) => alive(i) && v < THRESH.hrLow && v > 0)) m.push({ kind: 'bradycardia', t: e.start, dur: e.dur, value: Math.round(e.extreme), action: firstActionAfter(tl.events, e.start), severity: 2 });
  const mon = keyTimes.monitoring;
  if (mon == null) m.push({ kind: 'no_monitoring', t: 0, severity: 2 });
  else if (mon > MONITOR_DELAY_S) m.push({ kind: 'late_monitoring', t: 0, dur: mon, severity: 1 });
  const rejected = tl.events.filter(e => !e.ok);
  if (rejected.length) m.push({ kind: 'rejected', t: rejected[0].t, value: rejected.length, action: rejected[0], severity: 1 });
  return m.sort((a, b) => b.severity - a.severity || (b.dur || 0) - (a.dur || 0) || a.t - b.t).slice(0, MAX_MOMENTS).sort((a, b) => a.t - b.t);
}

/** Learners judge their own performance poorly, so the debrief shows predicted vs actual (REF davis2006). Within
 *  CALIBRATION_BAND percentage points counts as accurate (REF design). */
export const CALIBRATION_BAND = 10;
export function calibration(selfPct, actualPct) {
  if (!Number.isFinite(selfPct) || !Number.isFinite(actualPct)) return null;
  const diff = Math.round(selfPct - actualPct);
  return { diff, verdict: Math.abs(diff) <= CALIBRATION_BAND ? 'accurate' : diff > 0 ? 'over' : 'under' };
}
