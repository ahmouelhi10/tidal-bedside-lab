// The bags on the IV pole and their drip, read from engine state each frame. Display only (never feeds the engine).
//  - a fluid bolus hangs a bag of that volume (balanced crystalloid, 0.9 % or 3 % saline, glucose 5 %) that empties exactly as
//    the engine runs it in (vol.infusions: remaining, rate); once given, the empty bag stays on the pole until a newer one
//    needs the hook;
//  - a blood product hangs its bag (red cells, whole blood, plasma, platelets, cryoprecipitate). The engine gives a unit at
//    once, so here the bag runs through in TRANSFUSE_S of patient time, as with a pressure bag: that time is display only;
//  - drops fall in the drip chamber at the rate the line runs (a standard giving set makes 20 drops per mL, a blood set 15);
//    above STREAM drops a second they run together into a stream;
//  - with nothing running, one full spare bag of crystalloid hangs unconnected.
// Bag sizes, colours and the transfusion time are design values judged on screen.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const TRANSFUSE_S = 120, STREAM = 6, HOOKS = 3;
export const BLOOD_ML = { prbc: 300, whole: 500, ffp: 250, platelets: 250, cryo: 100 };
const COLOR = { crystalloid: [0.86, 0.94, 0.98], saline: [0.86, 0.94, 0.98], saline3: [0.86, 0.93, 0.97], glucose5: [0.9, 0.95, 0.96],
  prbc: [0.4, 0.0, 0.015], whole: [0.46, 0.01, 0.025], ffp: [0.92, 0.78, 0.36], platelets: [0.94, 0.86, 0.6], cryo: [0.95, 0.88, 0.62] };

export class DripAnim {
  constructor() { this.bags = []; this.seen = new Set(); this.logN = 0; this.p = null; }

  /** p: Patient. Returns { bags: [{ kind, set: 'fluid' | 'blood' | 'spare', color, totalMl, leftMl, mlPerMin, running, dropsPerS }], fluid, blood }
   *  with at most HOOKS bags, running ones first. */
  update(p) {
    if (p !== this.p) { this.p = p; this.bags = []; this.seen = new Set(); this.logN = 0; }
    for (const f of p.vol?.infusions || []) if (!this.seen.has(f)) { this.seen.add(f); this.bags.push({ src: f, kind: f.kind, set: 'fluid', totalMl: (f.total ?? f.remaining) * 1000, t0: p.t }); }
    const log = p.log || [];
    for (; this.logN < log.length; this.logN++) { const e = log[this.logN]; if (e.type === 'blood.transfuse' && BLOOD_ML[e.kind]) this.bags.push({ kind: e.kind, set: 'blood', totalMl: BLOOD_ML[e.kind], t0: e.t }); }
    const live = new Set(p.vol?.infusions || []);
    for (const b of this.bags) {
      if (b.set === 'fluid') { const on = live.has(b.src) && b.src.remaining > 1e-9; b.leftMl = on ? b.src.remaining * 1000 : 0; b.mlPerMin = on ? b.src.rate * 1000 : 0; }
      else { const u = clamp((p.t - b.t0) / TRANSFUSE_S, 0, 1); b.leftMl = b.totalMl * (1 - u); b.mlPerMin = u < 1 ? b.totalMl / (TRANSFUSE_S / 60) : 0; }
      b.running = b.mlPerMin > 0;
    }
    // the hooks: everything running, then the most recently hung empty bags
    this.bags.sort((a, b) => (b.running - a.running) || (b.t0 - a.t0));
    if (this.bags.length > HOOKS * 3) this.bags.length = HOOKS * 3;
    const shown = this.bags.slice(0, HOOKS).map(b => ({ kind: b.kind, set: b.set, color: COLOR[b.kind] || COLOR.crystalloid, totalMl: b.totalMl, leftMl: b.leftMl, mlPerMin: b.mlPerMin, running: b.running,
      dropsPerS: b.mlPerMin / 60 * (b.set === 'blood' ? 15 : 20) }));
    if (!shown.length) shown.push({ kind: 'crystalloid', set: 'spare', color: COLOR.crystalloid, totalMl: 1000, leftMl: 1000, mlPerMin: 0, running: false, dropsPerS: 0 });
    return { bags: shown, fluid: shown.some(b => b.running && b.set === 'fluid'), blood: shown.some(b => b.running && b.set === 'blood') };
  }
}

/** Where the drop is in the drip chamber now (pure): { stream } above STREAM drops a second, else { y } with y = 0 at the
 *  nozzle and 1 on the fluid in the chamber, or null between drops. t: patient seconds. */
export function dropAt(dropsPerS, t) {
  if (dropsPerS <= 0) return null;
  if (dropsPerS > STREAM) return { stream: true };
  const ph = (t * dropsPerS) % 1, ff = Math.min(0.5, 0.12 * dropsPerS);                   // a drop grows at the nozzle, then falls in about 0.12 s
  return ph < 1 - ff ? { y: 0, grow: ph / (1 - ff) } : { y: (ph - (1 - ff)) / ff, grow: 1 };
}
