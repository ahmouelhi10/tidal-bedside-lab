// Team leadership with closed-loop communication. In team mode the learner leads a virtual team: an order goes to a team
// member, who reads it back; the leader confirms (or corrects) before the action is carried out. Read-backs are sometimes
// wrong, as in real resuscitations, so the leader has to listen. Closed-loop communication improves task completion and
// reduces errors in resuscitation teams (REF elshafy2018).
// Read-back errors use their own random stream (Patient.rngT), so team mode never shifts the physiology's random sequence.

export const TEAM_ROLES = Object.freeze(['nurse', 'defib']);
/** Actions carried out by a team member in team mode (and which member). */
export const TEAM_ACTS = Object.freeze({ 'drug.bolus': 'nurse', 'drug.infusion': 'nurse', 'fluid.bolus': 'nurse', 'blood.transfuse': 'nurse', 'bicarb.bolus': 'nurse', 'lab.order': 'nurse', 'defib.shock': 'defib' });
/** Probability that a read-back contains an error (REF design: frequent enough to be met in most cases). */
export const READBACK_ERROR_P = 0.12;

/** The read-back of an order: the same action, or a plausible error (tenfold dose, double volume, wrong product). */
export function readbackOf(act, rng) {
  if (!rng.chance(READBACK_ERROR_P)) return { act, error: false };
  const a = { ...act };
  switch (act.type) {
    case 'drug.bolus': a.amount = rng.chance(0.5) ? act.amount * 10 : +(act.amount / 10).toFixed(3); break;   // the classic decimal-point error
    case 'drug.infusion': a.rate = act.rate * 10; break;
    case 'fluid.bolus': a.volumeL = +(act.volumeL * 2).toFixed(2); break;
    case 'bicarb.bolus': a.mEq = act.mEq * 2; break;
    case 'blood.transfuse': a.kind = act.kind === 'ffp' ? 'prbc' : 'ffp'; break;
    case 'lab.order': a.kind = act.kind === 'abg' ? 'lactate' : 'abg'; break;
    default: return { act, error: false };                          // a shock is called out, not dosed: no read-back error
  }
  return { act: a, error: true };
}

/** Communication criterion, added to every scored case once the learner has led the team (not applicable otherwise).
 *  An order counts when it was closed with a correct read-back; a wrong read-back that was confirmed counts against. */
export function teamCriterion(p) {
  const o = p.team?.orders || []; if (!o.length) return null;
  const closed = o.filter(x => x.status === 'confirmed').length, accepted = o.filter(x => x.status === 'accepted_error').length;
  const caught = o.filter(x => x.corrected).length, open = o.filter(x => x.status === 'pending').length;
  return { frac: closed / o.length, detail: `${o.length} orders: ${closed} closed-loop, ${caught} read-back error(s) caught, ${accepted} wrong read-back(s) confirmed, ${open} never closed` };
}
export const TEAM_CRITERION = Object.freeze({ id: 'closed_loop', label: 'Closed-loop communication with the team', weight: 10, ref: 'elshafy2018', eval: teamCriterion });
