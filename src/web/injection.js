// How a drug is given at the bedside, step by step (display only, pure, no DOM): the route, how long the push takes and the
// saline flush after it, so the syringe on the patient moves as it would in real hands. The engine still receives the dose
// when the push begins (its own transit time from arm to heart is ~15 s); this file only times what is shown.
// Times are common-practice values from drug monographs and resuscitation teaching, rounded (design, display only):
//  - rapid push then a fast flush: adenosine (1-2 s, 20 mL), cardiac-arrest drugs (adrenaline, amiodarone, calcium, atropine);
//  - slow push: induction agents over ~20-30 s, opioids and benzodiazepines over 30-60 s (lorazepam at most 2 mg/min), antiemetics
//    over >= 30 s, labetalol / furosemide / hydrocortisone over 1-2 min, ceftriaxone 2-4 min, glucose 20-30 % over 2-3 min;
//  - too slow for a hand-held push (more than PUMP_S): the syringe goes on a driver: magnesium out of arrest (10-15 min),
//    tranexamic acid (10 min), levetiracetam (10 min), potassium chloride (60 min), calcium gluconate (10 min);
//  - IM into the anterolateral thigh (2-3 s); nebulised drugs at the face (a mask, not a syringe).

export const PUMP_S = 150;                 // longer than this: on a syringe driver, not pushed by hand
export const SWAB_S = 2, CONNECT_S = 1.5, FLUSH_S = 3, LEAVE_S = 1.2;

/** Push time in seconds by drug, out of cardiac arrest. */
const PUSH_S = {
  propofol: 30, etomidate: 30, ketamine: 60, midazolam: 30, dexmedetomidine: 60,
  fentanyl: 30, remifentanil: 30, morphine: 60, naloxone: 30, flumazenil: 15,
  rocuronium: 5, succinylcholine: 5, sugammadex: 10, neostigmine: 60,
  epinephrine: 10, norepinephrine: 10, phenylephrine: 10, ephedrine: 10, vasopressin: 10, atropine: 5, isoprenaline: 10,
  adenosine: 2, amiodarone: 180, lidocaine: 60, esmolol: 30, metoprolol: 60, labetalol: 90, urapidil: 60,
  nitroglycerin: 30, furosemide: 90, hydrocortisone: 60, dexamethasone: 60, ondansetron: 30, droperidol: 30,
  lorazepam: 120, diazepam: 120, glucose: 150, glucagon: 30, insulin: 10, heparin: 10, terlipressin: 60, ceftriaxone: 180,
  calciumChloride: 120, lipid: 120, bicarbonate: 120, pethidine: 60, dantrolene: 120, aspirin: 10,
  magnesium: 900, tranexamicAcid: 600, levetiracetam: 600, potassiumChloride: 3600, calciumGluconate: 600,
};
/** In cardiac arrest: given fast, each followed by a 20 mL flush (and the arm raised). */
const ARREST_S = { epinephrine: 3, amiodarone: 5, calciumChloride: 10, atropine: 3, magnesium: 90, lidocaine: 5, bicarbonate: 60, lipid: 60, vasopressin: 3 };
const NEB = new Set(['salbutamol', 'ipratropium']);
const RAPID_FLUSH = new Set(['adenosine']);

/** { route: 'iv' | 'im' | 'neb' | 'regional', pushS, flushMl, pump } for a drug.bolus event; arrested: the patient is in cardiac arrest. */
export function injectionPlan(ev, arrested = false) {
  const d = ev?.drug;
  if (ev?.type === 'bicarb.bolus') return { route: 'iv', pushS: arrested ? 60 : 120, flushMl: 10, pump: false };
  if (ev?.route === 'im') return { route: 'im', pushS: 3, flushMl: 0, pump: false };
  if (ev?.route === 'regional') return { route: 'regional', pushS: 60, flushMl: 0, pump: false };
  if (NEB.has(d)) return { route: 'neb', pushS: 0, flushMl: 0, pump: false };
  const s = arrested && ARREST_S[d] != null ? ARREST_S[d] : PUSH_S[d] ?? 30;
  if (s > PUMP_S) return { route: 'iv', pushS: s, flushMl: 0, pump: true };
  return { route: 'iv', pushS: s, flushMl: RAPID_FLUSH.has(d) || arrested ? 20 : 10, pump: false };
}

/** Phases of a hand-held injection in real seconds (speed: the simulation speed, which shortens what is shown). */
export function injectionPhases(plan, speed = 1) {
  const k = 1 / Math.max(1, speed), push = plan.pump ? 0 : plan.pushS * k, flush = plan.flushMl ? FLUSH_S * Math.min(1, 2 * k) : 0;
  const swab = plan.route === 'im' ? 1.2 : plan.route === 'neb' ? 0 : SWAB_S * Math.min(1, 2 * k), connect = plan.route === 'neb' ? 2.6 : CONNECT_S;
  const a = swab, b = a + connect, c = b + Math.max(plan.route === 'neb' ? 0 : 0.6, push), d = c + flush, e = d + LEAVE_S;
  return { swab: [0, a], connect: [a, b], push: [b, c], flush: [c, d], leave: [d, e], dur: e };
}
