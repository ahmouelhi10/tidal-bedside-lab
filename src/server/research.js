// Research export for validity studies (docs/VALIDITY_STUDY.md): one de-identified row per submitted session with the
// verified score, each criterion, the key action times, team communication and the learner's self-assessment.
// Learners are pseudonymised with a salted hash, so rows from the same learner can be linked without exposing the name.
import crypto from 'node:crypto';
import { keyActionTimes } from '../engine/timeline.js';
import { ANTS_CATEGORIES } from '../engine/debrief.js';
import { SCENARIOS } from '../engine/scenarios.js';

/** What helped the learner, read from the notes the client logs (coach.js, procedures.js): the help level chosen
 *  (beginner: coach; intermediate: senior on request; expert: none), senior hints, guided-panel steps. A study compares
 *  like with like: these are confounders, not scores. */
function helpUsed(log) {
  const notes = log.filter(e => e.type === 'note' && typeof e.text === 'string').map(e => e.text);
  const lv = notes.filter(s => s.startsWith('level: ')).pop();
  return { level: lv ? lv.slice(7) : '', senior_hints: notes.filter(s => s.startsWith('senior hint')).length, guided_steps: notes.filter(s => s.startsWith('guide ')).length };
}
/** The patient played, and whether it is the case's own (the learner can change sex, age and size, which changes the case). */
function patientOf(r) {
  const s = r.spec || {}, d = r.scenario ? SCENARIOS[r.scenario]?.spec || {} : null, keys = ['sex', 'age', 'heightCm', 'weightKg'];
  const bmi = s.weightKg && s.heightCm ? +(s.weightKg / (s.heightCm / 100) ** 2).toFixed(1) : '';
  return { patient_default: d ? (keys.every(k => s[k] === d[k]) ? 1 : 0) : '', sex: s.sex ?? '', age: s.age ?? '', height_cm: s.heightCm ?? '', weight_kg: s.weightKg ?? '', bmi };
}

const KEY_TIMES = ['monitoring', 'ivAccess', 'oxygen', 'firstDrug', 'airwaySecured', 'cprStart', 'firstShock', 'firstLab'];

/** Self-assessment sent by the learner after the case: estimated score 0-100 and ANTS ratings 1-4. */
export function validateSelf(b) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'self-assessment must be an object' };
  if (!(Number.isFinite(b.pct) && b.pct >= 0 && b.pct <= 100)) return { ok: false, error: 'pct must be in [0, 100]' };
  const ants = {};
  for (const k of ANTS_CATEGORIES) { const v = b.ants?.[k]; if (v == null) continue; if (!(Number.isInteger(v) && v >= 1 && v <= 4)) return { ok: false, error: `ants.${k} must be 1-4` }; ants[k] = v; }
  return { ok: true, self: { pct: Math.round(b.pct), ants } };
}

const pid = (salt, learner) => (learner ? crypto.createHash('sha256').update(salt + '\u0000' + learner).digest('hex').slice(0, 12) : '');
/** One CSV cell. Text that a spreadsheet would read as a formula (starting with = + - @, tab or carriage return; some
 *  of it is learner-written, e.g. the help level note) gets a leading apostrophe, so it opens as plain text. */
export const csvCell = (v) => {
  if (v == null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/** Rows for every submitted session (sorted by date), and the CSV text. */
export function researchRows(records, salt) {
  const subs = records.filter(r => r.status === 'submitted' && r.result).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const critIds = [...new Set(subs.flatMap(r => (r.result.score?.items || []).map(i => i.id)))].sort();
  const rows = subs.map(r => {
    // key times come from the server's replay (only actions the engine accepted); sessions stored before the replay
    // recorded them fall back to the raw log, which also counts refused actions, and say so in key_times_source
    const fromReplay = !!r.result.keyTimes;
    const k = fromReplay ? r.result.keyTimes : keyActionTimes((r.log || []).map(e => ({ t: e.t, type: e.type, ok: true, ev: e }))), team = (r.log || []).filter(e => e.type === 'team.order').length, crit = Object.fromEntries((r.result.score?.items || []).map(i => [i.id, i.frac]));
    const row = { session: r.id.slice(0, 12), learner_pid: pid(salt, r.learner), scenario: r.scenario || 'free', created: r.createdAt, submitted: r.submittedAt || '',
      verified: r.result.verified ? 1 : 0, sim_time_s: Math.round(r.result.simTimeS ?? 0), played_out_s: r.result.playedOutS == null ? '' : Math.round(r.result.playedOutS), score_pct: r.result.score?.pct ?? '', grade: r.result.score?.grade ?? '',
      instructor_changes: (r.log || []).filter(e => e.type === 'instructor.inject').length, team_orders: team, ...helpUsed(r.log || []), ...patientOf(r),
      self_pct: r.self?.pct ?? '', ...Object.fromEntries(ANTS_CATEGORIES.map(a => ['self_ants_' + a, r.self?.ants?.[a] ?? ''])) };
    for (const kk of KEY_TIMES) row['t_' + kk] = k[kk] == null ? '' : +k[kk].toFixed(1);
    row.key_times_source = fromReplay ? 'replay' : 'raw_log';
    for (const id of critIds) row['crit_' + id] = crit[id] ?? '';
    return row;
  });
  const cols = rows.length ? Object.keys(rows[0]) : ['session'];
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
  return { rows, csv };
}
