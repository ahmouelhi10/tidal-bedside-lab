// The infectiology ward done as the guidelines say (display only, pure, no DOM): the plan of each case and, from the ward's
// state, the next thing to do. The beginner pointer follows it (dock-hint.js); the scripted expert in the tests runs the same plan.
// Plans follow each case's objectives (Surviving Sepsis 2021, ATS/IDSA 2019, IDSA/ESCMID 2026, EUCAST v16.1, BALANCE).

export const WARD_PLANS = Object.freeze({
  inf_pyelo: { samples: ['blood', 'blood', 'urine'], orders: ['labs'], empiric: [['ceftriaxone', 'iv', 'std']], targeted: null, oral: ['ciprofloxacin', 'std'], days: 7 },
  inf_cap: { samples: ['blood', 'blood', 'sputum', 'uag'], orders: ['labs', 'cxr'], empiric: [['ceftriaxone', 'iv', 'std'], ['clarithromycin', 'iv', 'std']], targeted: [['amoxicillin', 'iv', 'high']], oral: ['amoxicillin', 'high'], days: 5 },
  inf_sab: { samples: ['blood', 'blood'], orders: ['labs'], empiric: [['vancomycin', 'iv', 'std']], targeted: [['flucloxacillin', 'iv', 'std']], oral: null, days: 14, fromClearance: true, line: true },
  inf_esbl: { samples: ['blood', 'blood', 'urine'], orders: ['lactate', 'fluids30'], empiric: [['meropenem', 'iv', 'std'], ['amikacin', 'iv', 'std']], targeted: [['meropenem', 'iv', 'std']], oral: null, days: 7 },
});
export const OBSERVE_H = 72;              // after the last dose: watch for a relapse before ending the case
export const STEP_H = 4;                  // time moves on in steps of this many hours while nothing is due

/** The next step on the ward: { act (an engine event, or { type: 'ward.finish' }), why (an i18n key) } or null. w: the Ward; id: the case. */
export function wardStep(w, id) {
  const plan = WARD_PLANS[id]; if (!w || !plan) return null;
  const m = w.milestones(), count = (list, k) => list.filter(x => x === k).length;
  const started = w.courses.length > 0, taken = w.samples.map(x => x.kind), ordered = w.orders.map(x => x.what);
  if (!started) for (const k of new Set(plan.samples)) if (count(taken, k) < count(plan.samples, k)) return { act: { type: 'ward.sample', kind: k }, why: 'dh_w_sample' };
  for (const o of plan.orders) if (!ordered.includes(o)) return { act: { type: 'ward.order', what: o }, why: 'dh_w_order' };
  const start = plan.fromClearance ? m.clearH : w.firstActiveH, stopAt = start == null ? null : start + plan.days * 24, done = stopAt != null && w.h >= stopAt;
  if (done) {
    const r = w.rx[0]; if (r) return { act: { type: 'ward.rx.stop', drug: r.drug }, why: 'dh_w_stop' };
    return w.h >= stopAt + OBSERVE_H ? { act: { type: 'ward.finish' }, why: 'dh_w_end' } : { act: { type: 'ward.advance', hours: STEP_H }, why: 'dh_w_wait' };
  }
  const rx = (d) => ({ type: 'ward.rx.start', drug: d[0], route: d[1], dose: d[2] });
  if (!m.ast || !plan.targeted) for (const d of plan.empiric) if (!w.courses.some(c => c.drug === d[0]) && !(m.ast && plan.targeted)) return { act: rx(d), why: 'dh_w_empiric' };
  if (plan.line && m.gram !== null && w.lineIn) return { act: { type: 'ward.order', what: 'remove_line' }, why: 'dh_w_line' };
  if (plan.line && m.gram !== null && !ordered.includes('tte')) return { act: { type: 'ward.order', what: 'tte' }, why: 'dh_w_tte' };
  if (plan.line && m.firstPosSampleH !== null && w.h >= m.firstPosSampleH + 48 && w.samples.filter(x => x.kind === 'blood' && x.h >= m.firstPosSampleH + 48).length < 2)
    return { act: { type: 'ward.sample', kind: 'blood' }, why: 'dh_w_fubc' };
  const oralNow = plan.oral && w.rx.some(r => r.route === 'po');
  if (m.ast !== null && plan.oral && !oralNow && w.stable()) {                          // stable and eating, antibiogram known: oral
    const iv = w.rx.find(r => r.route !== 'po'); if (iv) return { act: { type: 'ward.rx.stop', drug: iv.drug }, why: 'dh_w_oral' };
    return { act: { type: 'ward.rx.start', drug: plan.oral[0], route: 'po', dose: plan.oral[1] }, why: 'dh_w_oral' };
  }
  if (m.ast !== null && plan.targeted && !oralNow) {                                    // the antibiogram: narrow to the targeted agent
    const keep = new Set(plan.targeted.map(d => d[0])), extra = w.rx.find(r => !keep.has(r.drug));
    if (extra) return { act: { type: 'ward.rx.stop', drug: extra.drug }, why: 'dh_w_narrow' };
    for (const d of plan.targeted) if (!w.rx.some(r => r.drug === d[0])) return { act: rx(d), why: 'dh_w_narrow' };
  }
  return { act: { type: 'ward.advance', hours: STEP_H }, why: 'dh_w_wait' };
}
