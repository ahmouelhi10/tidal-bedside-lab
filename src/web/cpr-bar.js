// CPR quality bar: what a real-time CPR feedback device shows, read from the engine (display only, pure, no DOM).
// Targets are the adult guideline ones (REF aha2025_part7 / erc2025 in the engine): depth 5-6 cm, rate 100-120/min, full
// chest recoil (here: at least 80 % of the last compressions fully released, a design threshold), chest compression fraction at least 60 % (80 % the aim), pauses under 10 s, a new compressor about every 2 min.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const CQ = Object.freeze({ depth: [5, 6], rate: [100, 120], recoil: 0.8, ccf: [0.6, 0.8], pauseS: 10, switchS: 120, showS: 10 });
export const SCALE = Object.freeze({ depth: [0, 8], rate: [60, 160] });   // the range drawn on each gauge
const pos = (v, [a, b]) => clamp((v - a) / (b - a), 0, 1);
const band = (v, [lo, hi]) => (v < lo ? 'low' : v > hi ? 'high' : 'good');

/** null when there is no CPR to show (never started, or stopped for good more than showS ago), else
 *  { going, depth, rate, recoil, ccf, pause, switchIn, tip }: each gauge { v, ok: 'good'|'low'|'high', x (0..1 on its scale) };
 *  pause: seconds hands off while CPR is on (null while compressing); switchIn: seconds to the 2-minute compressor switch
 *  (negative: overdue); tip: the first thing to fix (an i18n key), or null when everything is in target. */
export function cprBar(p) {
  const c = p?.cpr; if (!c || c.firstCompressionT == null) return null;
  const s = c.stats || {}, ev = c.events || [], last = ev.length ? ev[ev.length - 1] : null;
  const on = c.mode && c.mode !== 'off', age = last ? p.t - last.t : 99;   // hands off since the last compression (the engine's stats only look back 8 s)
  if (!on && age > CQ.showS) return null;
  // rate from the last few pushes in a row, as a device measures it (the engine's 8 s window counts a 30:2 pause as slow pushing)
  let n = 0, sum = 0; for (let i = ev.length - 1; i > 0 && n < 6; i--) { const dt = ev[i].t - ev[i - 1].t; if (dt > 1.5) break; sum += dt; n++; }
  const going = age < 1.5 && n > 0;
  const d = last ? last.depth : 0, r = n ? 60 * n / sum : 0, rec = s.recoilFrac ?? 1, f = (c.arrestElapsedS ?? 0) > 5 ? c.ccf : (s.ccf ?? 0);   // over the arrest; before it is counted, the last minute
  const out = {
    going,
    depth: { v: d, ok: going ? band(d, CQ.depth) : 'low', x: pos(d, SCALE.depth) },
    rate: { v: r, ok: going ? band(r, CQ.rate) : 'low', x: pos(r, SCALE.rate) },
    recoil: { v: rec, ok: rec >= CQ.recoil ? 'good' : 'low', x: rec },
    ccf: { v: f, ok: f >= CQ.ccf[1] ? 'good' : f >= CQ.ccf[0] ? 'fair' : 'low', x: f },
    pause: going ? null : age,
    switchIn: on ? CQ.switchS - (p.t - (c.compressorSince ?? p.t)) : null,
  };
  out.tip = !going ? (on && age >= CQ.pauseS ? 'cq_tip_resume' : null)
    : out.depth.ok === 'low' ? 'cq_tip_harder' : out.depth.ok === 'high' ? 'cq_tip_softer'
    : out.rate.ok === 'low' ? 'cq_tip_faster' : out.rate.ok === 'high' ? 'cq_tip_slower'
    : out.recoil.ok !== 'good' ? 'cq_tip_recoil' : out.switchIn != null && out.switchIn <= 0 ? 'cq_tip_switch' : null;
  return out;
}
