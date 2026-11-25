// Syringe pumps on the IV pole, read from engine state each frame. Display only (never feeds the engine).
//  - each drug running as an infusion (the engine's drug models, and insulin) has its own pump with a 50 mL syringe made up at a
//    standard strength (CONC: design values, common 50 mL preparations);
//  - the plunger moves as the drug goes in: the volume given is the logged infusion rates over patient time, divided by the
//    strength; a syringe that runs out is replaced by a full one;
//  - the pump shows green while running, amber and flashing when the syringe is nearly empty (as real pumps warn), dark when stopped;
//  - the syringe carries the colour of the ISO 26825 user-applied label for its drug class (induction agents yellow,
//    benzodiazepines orange, opioids blue, neuromuscular blockers red, vasopressors violet, local anaesthetics grey...).
// Glucose 10 % and lipid emulsion run from bags at high rates, not from a syringe pump, so they are not shown here.

import { injectionPlan } from './injection.js';

export const SYRINGE_ML = 50, NEAR_END_ML = 3, PUMPS = 4;
/** Strength of the 50 mL syringe, in the engine's dose unit per mL (mg, mcg, units or g per mL). Design values. */
export const CONC = { propofol: 10, ketamine: 10, midazolam: 1, dexmedetomidine: 4, remifentanil: 50, fentanyl: 50, rocuronium: 10,
  epinephrine: 100, norepinephrine: 80, phenylephrine: 100, vasopressin: 0.4, dobutamine: 5000, isoprenaline: 20, ephedrine: 3000,
  nitroglycerin: 1000, esmolol: 10, labetalol: 5, urapidil: 5, amiodarone: 18, lidocaine: 10, magnesium: 0.1, heparin: 500,
  terlipressin: 0.02, insulin: 1, morphine: 1, dantrolene: 0.33, salbutamol: 100, tranexamicAcid: 20, furosemide: 10 };
const LABEL = { propofol: 'yellow', ketamine: 'yellow', etomidate: 'yellow', dexmedetomidine: 'yellow', midazolam: 'orange', lorazepam: 'orange', diazepam: 'orange',
  remifentanil: 'blue', fentanyl: 'blue', morphine: 'blue', rocuronium: 'red', succinylcholine: 'red',
  epinephrine: 'violet', norepinephrine: 'violet', phenylephrine: 'violet', vasopressin: 'violet', dobutamine: 'violet', isoprenaline: 'violet', ephedrine: 'violet', terlipressin: 'violet',
  nitroglycerin: 'violetStripe', esmolol: 'violetStripe', labetalol: 'violetStripe', urapidil: 'violetStripe', lidocaine: 'grey', bupivacaine: 'grey' };
export const LABEL_RGB = { yellow: [0.95, 0.82, 0.1], orange: [0.95, 0.5, 0.08], blue: [0.35, 0.65, 0.95], red: [0.95, 0.22, 0.25], violet: [0.6, 0.38, 0.78],
  violetStripe: [0.72, 0.58, 0.85], grey: [0.62, 0.62, 0.64], white: [0.95, 0.95, 0.95] };

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
/** The rate the engine is giving now, in its dose unit per minute (null: no infusion model for this drug). */
function engineRate(p, drug) { if (drug === 'insulin') return p.keto ? p.keto.rate || 0 : null; const m = p.drugs?.pk?.[drug]; return m ? m.rate || 0 : null; }

/** The pumps (pure): [{ drug, label, rgb, milky, rateMlH, ml (left in the syringe), running, nearEnd }], running first then the
 *  most recently started, at most PUMPS. */
export function syringePumps(p) {
  const seen = new Map();                                     // drug -> { used (dose units), r (rate now, per min), t (last change), t0 }
  for (const e of p.log || []) {
    if (e.type !== 'drug.infusion' && e.type !== 'drug.stop') continue;
    const d = e.drug; if (!CONC[d] || engineRate(p, d) == null) continue;   // only drugs the engine runs as an infusion, at a known strength
    if (e.type === 'drug.infusion' && !(fin(e.rate) && e.rate >= 0)) continue;
    const s = seen.get(d) || { used: 0, r: 0, t: e.t, t0: e.t };
    s.used += s.r * Math.max(0, e.t - s.t) / 60; s.t = e.t;
    const r = e.type === 'drug.stop' ? 0 : e.rate; if (r > 0 && s.r === 0) s.t0 = e.t;           // (re)started now
    s.r = r;
    seen.set(d, s);
  }
  const out = [];
  for (const [drug, s] of seen) {
    const now = engineRate(p, drug) || 0, used = (s.used + s.r * Math.max(0, p.t - s.t) / 60) / CONC[drug];   // mL given so far
    const inSyr = SYRINGE_ML - (used % SYRINGE_ML);                                          // an empty syringe is replaced by a full one
    const label = LABEL[drug] || 'white', running = now > 0;
    out.push({ drug, label, rgb: LABEL_RGB[label], milky: drug === 'propofol', rateMlH: now * 60 / CONC[drug], ml: inSyr, running, nearEnd: running && inSyr < NEAR_END_ML, t0: s.t0 });
  }
  // a dose given over many minutes (magnesium, tranexamic acid, levetiracetam, potassium...): its own 50 mL syringe on a driver,
  // emptied at an even rate over the drug's time (injection.js), then shown stopped
  for (const e of p.log || []) {
    if (e.type !== 'drug.bolus' || !fin(e.amount) || e.amount <= 0) continue;
    const plan = injectionPlan(e, false); if (!plan.pump) continue;
    const left = Math.max(0, 1 - (p.t - e.t) / plan.pushS), label = LABEL[e.drug] || 'white', running = left > 0;
    out.push({ drug: e.drug, label, rgb: LABEL_RGB[label], milky: false, rateMlH: running ? SYRINGE_ML * 3600 / plan.pushS : 0, ml: SYRINGE_ML * left, running, nearEnd: running && SYRINGE_ML * left < NEAR_END_ML, t0: e.t });
  }
  out.sort((a, b) => (b.running - a.running) || (b.t0 - a.t0));
  return out.slice(0, PUMPS).map(({ t0, ...q }) => q);
}

/** What the pump's screen says (pure): the drug, the rate in mL/h, then the volume left or a warning.
 *  name: the drug's display name; w: words for { left, end, stop } in the interface language. tone: 'run' | 'end' | 'stop'. */
export function pumpScreen(q, name, w = { left: 'mL left', end: 'NEAR END', stop: 'STOPPED' }) {
  const tone = q.nearEnd ? 'end' : q.running ? 'run' : 'stop';
  const rate = q.rateMlH >= 100 ? q.rateMlH.toFixed(0) : q.rateMlH.toFixed(1);          // pumps show 0.1 mL/h up to 99.9
  return { tone, lines: [String(name).toUpperCase().slice(0, 14), `${rate} mL/h`, tone === 'end' ? w.end : tone === 'stop' ? w.stop : `${q.ml.toFixed(1)} ${w.left}`] };
}
