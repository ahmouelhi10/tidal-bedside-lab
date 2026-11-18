// Pure part of the in-case help (coach.js): the live checklist read from a case's scoring criteria, the next item to do,
// and the help a finished session used. No DOM and no engine import, so it runs under node --test.
import { getLang, CRITERION_FR } from './i18n.js';

const label = (c) => (getLang() === 'fr' && CRITERION_FR[c.id] ? CRITERION_FR[c.id] : c.label);

/** Live state of every criterion of the running case: done, partly done, to do, not yet relevant, or 'keep' for an item
 *  already met before the learner did anything ("no vasopressin", "MAP kept within 20 %"): something to watch, not a tick. */
export function checklist(p, sc, keepIds = null) {
  if (!sc?.score) return [];
  return sc.score().map(c => {
    let r = null; try { r = c.eval(p); } catch { r = null; }
    let state = r == null ? 'later' : r.frac >= 0.95 ? 'done' : r.frac > 0.05 ? 'part' : 'todo';
    if (state === 'done' && keepIds?.has(c.id)) state = 'keep';
    return { id: c.id, text: label(c), detail: r?.detail || '', state };
  });
}
/** Ids met at the start of the case, before any learner action (see checklist). */
export const keepAtStart = (p, sc) => new Set(checklist(p, sc).filter(i => i.state === 'done').map(i => i.id));
export const nextItem = (items) => items.find(i => i.state === 'todo' || i.state === 'part') || null;

/** Help used in a finished session, read back from the event log (for the debrief). */
export function helpUsed(log) {
  const lv = log.find(e => e.type === 'note' && typeof e.text === 'string' && e.text.startsWith('level: '));
  const hints = log.filter(e => e.type === 'note' && typeof e.text === 'string' && e.text.startsWith('senior hint')).length;
  return { level: lv ? lv.text.slice(7) : null, hints };
}
