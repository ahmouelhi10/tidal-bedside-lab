// Scripted infectiology learners: a guideline-following "expert" and variants used by tests/infection.test.js and the scenario tests.
// They act only through Patient.dispatch, so every run replays.

import { WARD_PLANS } from '../../src/web/ward-plan.js';   // the same plan the beginner pointer follows
export { WARD_PLANS };

/** Run the ward course as an expert would. opts.days overrides the duration; opts.noCultures skips sampling; opts.delayH delays the first dose. */
export function wardExpert(p, id, opts = {}) {
  const plan = { ...WARD_PLANS[id], ...opts }, w = p.ward, D = ev => p.dispatch(ev);
  if (!plan.noCultures) for (const k of plan.samples) D({ type: 'ward.sample', kind: k });
  for (const o of plan.orders) D({ type: 'ward.order', what: o });
  if (plan.delayH) D({ type: 'ward.advance', hours: plan.delayH });
  for (const [drug, route, dose] of plan.empiric) D({ type: 'ward.rx.start', drug, route, dose });
  let targeted = !plan.targeted, oral = !plan.oral, fubc = false, stopped = false, stopAt = null;
  for (let i = 0; i < 24 * 30 && !stopped; i++) {
    D({ type: 'ward.advance', hours: 1 });
    const m = w.milestones();
    if (plan.line && m.gram !== null && w.lineIn) { D({ type: 'ward.order', what: 'remove_line' }); D({ type: 'ward.order', what: 'tte' }); }
    if (plan.line && !fubc && m.firstPosSampleH !== null && w.h >= m.firstPosSampleH + 48) { fubc = true; D({ type: 'ward.sample', kind: 'blood' }); D({ type: 'ward.sample', kind: 'blood' }); }
    if (!targeted && m.ast !== null) {
      targeted = true;
      const keep = new Set(plan.targeted.map(x => x[0]));
      for (const r of [...w.rx]) if (!keep.has(r.drug)) D({ type: 'ward.rx.stop', drug: r.drug });
      for (const [drug, route, dose] of plan.targeted) if (!w.rx.some(r => r.drug === drug)) D({ type: 'ward.rx.start', drug, route, dose });
    }
    if (!oral && m.ast !== null && w.stable()) {
      oral = true;
      for (const r of [...w.rx]) D({ type: 'ward.rx.stop', drug: r.drug });
      D({ type: 'ward.rx.start', drug: plan.oral[0], route: 'po', dose: plan.oral[1] });
    }
    const start = plan.fromClearance ? m.clearH : w.firstActiveH;
    if (stopAt === null && start !== null) stopAt = start + plan.days * 24;
    if (stopAt !== null && w.h >= stopAt) { for (const r of [...w.rx]) D({ type: 'ward.rx.stop', drug: r.drug }); stopped = true; }
  }
  D({ type: 'ward.advance', hours: 72 });
  return p;
}
