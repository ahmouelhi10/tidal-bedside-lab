// Visible blood, read from engine state each frame. Display only (never feeds the engine). The engine knows how much blood is lost
// (vol.totalLost) and how fast (vol.rates.bleed), not where from, so the source is the case: variceal bleeding comes out of the
// mouth (haematemesis), any other haemorrhage from a wound on the right thigh (the trauma case).
//  - the blood shed since the case began is shared out the way it really goes: the sheet / skin soak up the first ~350 mL, then a
//    pool spreads on the mattress (a vinyl film ~2 mm deep), and past ~300 mL more it runs over the edge and drips onto the floor;
//  - a wet stain is a thin film: its radius grows with the square root of the volume;
//  - while it bleeds, drops fall from the mattress edge, faster with the bleeding rate;
//  - once controlled nothing grows, and over ten minutes the blood darkens and goes matt as it dries;
//  - with a coagulopathy the puncture sites ooze.
// Film depths and the shares are design values judged on screen.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const SHEET_ML = 350, MATTRESS_ML = 300;

/** Pure: what the blood looks like now. lost0: litres already lost when the case was opened (not shown: it happened elsewhere). */
export function bloodState(p, lost0 = 0) {
  const varix = !!p.varix, source = varix ? 'mouth' : 'thigh';
  const ml = Math.max(0, ((p.vol?.totalLost ?? 0) - lost0) * 1000), rate = (p.vol?.rates?.bleed ?? 0) * 1000;   // mL, mL/min
  const active = rate > 0 && !(varix && p.varix.controlled);
  const sheet = Math.min(ml, SHEET_ML), mat = clamp(ml - SHEET_ML, 0, MATTRESS_ML), floor = Math.max(0, ml - SHEET_ML - MATTRESS_ML);
  const film = (v, depth, cap) => Math.min(cap, Math.sqrt(v * 1e-6 / depth / Math.PI));             // radius (m) of a film of v mL
  const controlledAt = p.bleedControlledAt;
  const dry = !active && controlledAt != null ? clamp((p.t - controlledAt) / 600, 0, 1) : 0;
  const overflow = ml > SHEET_ML + MATTRESS_ML * 0.5;                                                  // the pool has reached the edge
  return {
    source: ml > 2 ? source : null, ml, rate, active, dry,
    r: { stain: ml > 2 ? clamp(0.02 + 0.012 * Math.sqrt(sheet), 0.02, varix ? 0.12 : 0.26) : 0,       // soaked cloth / smeared skin (m)
      mat: film(mat, 0.002, 0.34), floor: film(floor, 0.0015, 0.85) },
    drips: active && overflow ? clamp(rate / 60, 0.3, 6) : 0,                                          // drops per second off the edge
    ooze: clamp((0.6 - (p.vol?.coagFn ?? 1)) / 0.35, 0, 1),                                            // puncture sites ooze when clotting fails
  };
}
