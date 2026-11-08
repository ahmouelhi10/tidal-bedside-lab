// Learner progress kept in this browser only (localStorage): finished cases and guided procedures, and what derives
// from them (level, skill profile, achievements). Nothing here affects the engine or the server score.
const KEY = 'tbl.progress.v1';
const MAX = 500;

export const AREAS = ['resus', 'chal', 'skills', 'echo', 'inf', 'lab'];

export function loadProgress() {
  try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX))); return true; } catch { return false; }
}
/** rec: { area, id, title, pct (0-100 or null), grade?, verified?, spec? } */
export function recordProgress(rec) {
  const list = loadProgress();
  list.push({ at: new Date().toISOString(), ...rec, pct: Number.isFinite(rec.pct) ? Math.round(rec.pct * 10) / 10 : null });
  return save(list);
}
export function clearProgress() { try { localStorage.removeItem(KEY); } catch { /* storage blocked */ } }

/** Experience: 20 points for finishing anything, plus the score in points; a level every 400 points. */
export function levelOf(list) {
  const xp = list.reduce((s, r) => s + 20 + (Number.isFinite(r.pct) ? Math.round(r.pct) : 0), 0);
  const level = Math.floor(xp / 400) + 1;
  return { xp, level, into: xp % 400, need: 400 };
}

export function profileOf(list) {
  const out = {};
  for (const a of AREAS) {
    const r = list.filter(x => x.area === a), s = r.filter(x => Number.isFinite(x.pct)).map(x => x.pct);
    out[a] = { n: r.length, best: s.length ? Math.max(...s) : null, mean: s.length ? s.reduce((p, q) => p + q, 0) / s.length : null };
  }
  return out;
}

/** Achievements derived from the history (ids are translated in i18n: ach_<id>). */
export function achievementsOf(list, { skillIds = [], challengeIds = [] } = {}) {
  const done = (a, id) => list.some(r => r.area === a && r.id === id && (r.pct ?? 0) >= 60);
  return [
    ['first', list.length >= 1],
    ['five', list.length >= 5],
    ['twenty', list.length >= 20],
    ['excellent', list.some(r => (r.pct ?? 0) >= 90)],
    ['resus80', list.some(r => r.area === 'resus' && (r.pct ?? 0) >= 80)],
    ['allskills', skillIds.length > 0 && skillIds.every(id => done('skills', id))],
    ['allchal', challengeIds.length > 0 && challengeIds.every(id => list.some(r => r.area === 'chal' && r.id === id))],
    ['verified', list.some(r => r.verified)],
    ['bodies', new Set(list.filter(r => r.spec).map(r => bodyKey(r.spec))).size >= 4],
  ].map(([id, ok]) => ({ id, ok }));
}
const bodyKey = (s) => `${s.sex}-${bmiBand(s.weightKg / (s.heightCm / 100) ** 2)}`;
const bmiBand = (b) => (b < 18.5 ? 'u' : b < 25 ? 'n' : b < 30 ? 'o' : b < 40 ? 'b' : 'm');
