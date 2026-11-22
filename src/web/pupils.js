// The pupils, read from engine state each frame. Display only (never feeds the engine). Diameters in mm, both eyes alike
// (the engine has no one-sided brain lesion to blow a single pupil).
//  - awake adult in a lit room: about 4 mm, smaller with age (senile miosis), with a slow natural wobble (hippus);
//  - opioids: pinpoint (down to ~1.5 mm), reversed by naloxone through the same opioid effect the engine computes;
//  - anaesthesia / sedation: small and central; stress, pain, shock, hypoxaemia and seizures: wider (sympathetic);
//  - cardiac arrest: dilate within about a minute of no flow and stop reacting; severe hypothermia: wide and sluggish;
//  - light reflex: a penlight constricts a reacting pupil within half a second; it re-dilates more slowly once the light goes.
// Sizes and time constants are design values (clinical rules of thumb), judged on screen.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const approach = (v, goal, dt, tau) => v + (goal - v) * (1 - Math.exp(-Math.max(0, dt) / tau));

/** Pupil size the patient's state calls for (pure): { mm, react, awake }. */
export function pupilTargets(p) {
  const arrested = !!p.arrest?.arrested;
  let eff = {}; try { eff = p.drugs?.effects?.({ inArrest: arrested }) || {}; } catch { eff = {}; }
  const age = p.spec?.age ?? p.body?.age ?? 40, H = eff.hyp ?? 0, opioid = clamp(eff.analgesia ?? 0, 0, 1);
  const sao2 = p.resp?.sao2 ?? 0.97, map = p.circ?.mapArt ?? 85, tc = p.therm?.tc ?? 37;
  const awake = !arrested && !eff.loc ? clamp(1 - H / 0.3, 0, 1) : 0;
  let mm = clamp(4.6 - 0.02 * (age - 30), 3.2, 4.8);                                     // baseline, smaller with age
  mm -= 2.6 * opioid;                                                                       // opioid miosis
  mm -= 0.8 * clamp(H, 0, 1);                                                               // anaesthetised: small, central
  const stress = Math.max(clamp((0.88 - sao2) / 0.25, 0, 1), awake * clamp((65 - map) / 20, 0, 1), p.crises?.seizure ? 1 : 0);
  mm += 1.6 * stress * (1 - 0.8 * opioid);                                                  // sympathetic dilation (opioid miosis holds through the hypoxia it causes)
  mm += 2.5 * clamp((32 - tc) / 4, 0, 1);                                                   // deep hypothermia
  if (arrested) mm = Math.max(mm, 4 + 3.5 * clamp((p.arrest?.tArrest ?? 0) / 60, 0, 1));   // no flow: dilate within about a minute (opioid miosis does not hold)
  mm = clamp(mm, 1.5, 8);
  const react = !arrested && sao2 > 0.5 && tc > 28;
  return { mm, react, awake };
}

/** Bedside words for what the pupils show: size class and light reaction. */
export function pupilFinding(mm, react) { return { size: mm < 2.2 ? 'pin' : mm > 5.5 ? 'dil' : 'norm', react }; }

export class PupilAnim {
  constructor() { this.base = null; this.mm = 4; this.t = 0; }
  /** dt: real seconds; simDt: simulated seconds; light: a penlight is on the eyes. Returns the diameter in mm. */
  update(dt, p, simDt = dt, light = false) {
    this.t += dt; const g = pupilTargets(p);
    const first = this.base == null; this.base = first ? g.mm : approach(this.base, g.mm, simDt, 6);   // a case loads in its current state; drugs and arrest act over seconds of patient time
    const hippus = 0.12 * g.awake * Math.sin(this.t * 1.9) * Math.sin(this.t * 0.7 + 1);
    const goal = light && g.react ? Math.max(1.5, this.base * 0.55) : this.base + hippus;
    this.mm = first ? goal : approach(this.mm, goal, dt, goal < this.mm ? 0.25 : 1.1);   // fast constriction, slower re-dilation
    this.react = g.react; return this.mm;
  }
}
