// What the skin shows, read from engine state each frame. Display only (never feeds the engine).
//  - sweating (diaphoresis): shock in a conscious patient, hypoglycaemia, malignant hyperthermia, fever. Builds over a minute.
//  - mottling: a lacy purple network that starts at the knees and spreads up the thighs as perfusion fails (mottling score).
//  - central cyanosis: the lips go blue first (SpO2 below ~92 %), the whole skin only when it is much lower.
//  - peripheral cyanosis: blue hands and feet when the circulation is poor or the patient is cold and vasoconstricted.
//  - urticaria: raised red wheals on the trunk and limbs in anaphylaxis, with a general flush.
//  - distended neck veins: external jugular veins stand out when the central venous pressure is high
//    (tension pneumothorax, tamponade, right heart failure, fluid overload); flat when it is low.
// Thresholds and build-up times are design values for the display.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Instant targets (pure): every value 0..1. */
export function skinTargets(p) {
  const arrested = !!p.arrest?.arrested, map = p.circ?.mapArt ?? 85, co = p.circ?.co ?? 5, rap = p.circ?.rap ?? 6, sao2 = p.resp?.sao2 ?? 0.97;
  let eff = {}; try { eff = p.drugs?.effects?.({ inArrest: arrested }) || {}; } catch { eff = {}; }
  const conscious = !arrested && !eff.loc;
  const lost = p.vol?.fractionLost ?? 0, glucose = p.lytes?.glucose ?? 5.5, mh = p.crises?.mh ?? 0, tc = p.therm?.tc ?? 37;
  const shock = clamp((70 - map) / 20, 0, 1), bleed = clamp((lost - 0.15) / 0.2, 0, 1);
  const sweat = clamp(Math.max(conscious ? Math.max(shock, bleed) * 0.9 : 0.4 * Math.max(shock, bleed), clamp((3.4 - glucose) / 1.2, 0, 1), mh, clamp((tc - 38.6) / 1.2, 0, 1) * 0.6), 0, 1);
  const mottle = arrested ? 0.75 : clamp(Math.max((62 - map) / 22, (lost - 0.25) / 0.2, (2.2 - co) / 1.4), 0, 1);
  const cyanC = clamp((0.93 - sao2) / 0.13, 0, 1);
  const cyanP = clamp(Math.max(0.85 * cyanC, (2.8 - co) / 1.8, p.therm?.vasoconstricted ? 0.35 : 0, arrested ? 0.8 : 0), 0, 1);
  const hives = clamp((p.crises?.ana ?? 0) * 1.4, 0, 1);
  const jvd = arrested ? 0 : clamp((rap - 7) / 6, 0, 1);                       // the model rests near 4 mmHg supine
  return { sweat, mottle, cyanC, cyanP, hives, jvd, flush: 0.5 * hives };
}

export class SkinAnim {
  constructor() { this.v = null; }
  /** dt: real seconds. Returns smoothed values (sweat and mottling build over about a minute, the rest within seconds). */
  update(dt, p, simDt = dt) {
    const g = skinTargets(p);
    if (!this.v) { this.v = { ...g }; return this.v; }                   // a case loads in its current state
    const tau = { sweat: 40, mottle: 60, cyanC: 4, cyanP: 12, hives: 20, jvd: 6, flush: 20 };
    for (const k in g) this.v[k] += (g[k] - this.v[k]) * (1 - Math.exp(-Math.max(0, simDt) / tau[k]));
    return this.v;
  }
}
