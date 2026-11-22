// Visible breathing: how far the left chest, the right chest and the abdomen move at this instant of the breath cycle.
// Display only (never feeds the engine). Read from engine state each frame:
//  - spontaneous breathing, supine: the diaphragm leads, so the abdomen rises first and carries most of the tidal volume,
//    and the upper chest follows. Active inspiration about 40 % of the cycle, passive expiration that falls off quickly,
//    then an end-expiratory pause. Small breath-to-breath variation and an occasional sigh.
//  - positive-pressure ventilation (ventilator or bag): passive chest. Volume rises as a ramp (constant flow), short plateau,
//    passive exponential expiration. The anterior chest moves more than the abdomen.
//  - airway obstruction with effort: see-saw breathing (the abdomen rises while the chest is pulled in).
//  - bronchospasm: short inspiration, long, incomplete expiration.
//  - pneumothorax: the affected side hardly moves; under tension it also stays hyperexpanded.
//    Endobronchial tube: the non-ventilated side stays still.
//  - high spinal block: intercostals paralysed, abdominal breathing only.
//  - respiratory distress: larger, chest-dominant (accessory muscle) breaths.
// Amplitudes (metres of anterior wall movement) are design values chosen to be readable on screen.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

/** volume fraction 0..1 at cycle position u (0..1). ti = inspiratory fraction, k = expiratory decay, ppv = ventilator-shaped. */
export function breathWave(u, ti, k, ppv) {
  u = ((u % 1) + 1) % 1;
  if (u < ti) {
    const x = u / ti;
    // spontaneous: smooth, flow peaks mid-inspiration; ventilator: constant flow (ramp) with rounded ends and a 15 % plateau
    const r = Math.min(1, x / 0.85);
    return ppv ? 0.7 * r + 0.3 * smooth(r) : 0.5 - 0.5 * Math.cos(Math.PI * x);
  }
  const x = (u - ti) / (1 - ti), e = Math.exp(-k);
  return Math.max(0, (Math.exp(-k * x) - e) / (1 - e));
}

/** Pose of the breathing wall for this frame. cycles = breath phase in cycles (integer part = breath number). */
export function breathPose(p, cycles) {
  const rr = p.resp?.rr || 0, vt = p.resp?.vt || 0, none = { L: 0, R: 0, A: 0 };
  // static hyperexpansion of a tension pneumothorax shows even without breaths
  const ch = p.chest || {}, tens = clamp(ch.tension || 0, 0, 1), bulge = 0.006 * tens;
  const stat = { L: ch.side === 'L' ? bulge : 0, R: ch.side === 'R' ? bulge : 0, A: 0 };
  if (rr < 0.5 || vt < 20) return stat.L || stat.R ? stat : none;
  const dev = p.airway?.device, ppv = p.vent?.mode === 'ctrl' && (dev === 'ett' || dev === 'bvm' || dev === 'sga' || !!p.o2);
  const br = clamp(p.crises?.br || 0, 0, 1), distress = ppv ? 0 : clamp((rr - 22) / 14, 0, 1);
  const n = Math.floor(cycles), u = cycles - n;
  // inspiratory fraction and expiratory decay
  const ti = ppv ? 0.33 : clamp(0.4 + 0.05 * distress - 0.14 * br, 0.24, 0.46);
  const k = (ppv ? 5 : 4.2) * (1 - 0.65 * br);
  // breath-to-breath variability and sighs (spontaneous only)
  let amp = clamp(vt / 500, 0.15, 1.8) * 0.028;
  if (!ppv) { amp *= 0.92 + 0.16 * hash(n); if (hash(n * 3.7 + 1) > 0.975 && !distress) amp *= 1.9; }
  amp *= 1 + 0.5 * distress;
  // chest / abdomen share; the abdomen leads during spontaneous breaths
  let cShare = ppv ? 0.62 : 0.45 + 0.3 * distress, aShare = ppv ? 0.45 : 0.75 - 0.3 * distress;
  const nx = p.neuraxial, seg = nx?.active ? nx.seg : 31, ic = ppv ? 0 : clamp((21 - seg) / 12, 0, 1);   // T1..T12 block: intercostals lost
  cShare *= 1 - ic; aShare *= 1 + 0.5 * ic;
  const wA = breathWave(u, ti, k, ppv), wC = ppv ? wA : breathWave(u - 0.045, ti, k, false);
  // airway obstruction while still trying to breathe: paradoxical chest
  const pat = clamp(p.airway?.patency ?? 1, 0, 1), para = ppv ? 0 : clamp((0.5 - pat) / 0.4, 0, 1);
  const effort = 1 + 0.6 * para;
  const chestMove = amp * effort * (cShare * (1 - para) - 0.55 * para) * wC;
  const abdMove = amp * effort * aShare * wA;
  // side by side: pneumothorax collapse, endobronchial tube
  const side = { L: 1, R: 1 };
  if (ch.side) side[ch.side] *= 1 - 0.85 * clamp(ch.air || 0, 0, 1) - 0.1 * tens;
  const ms = p.tube?.mainstem; if (ms && dev === 'ett') side[ms === 'R' ? 'L' : 'R'] *= 0.12;
  return { L: stat.L + chestMove * Math.max(0, side.L), R: stat.R + chestMove * Math.max(0, side.R), A: abdMove };
}

/** Body frame for the vertex shader: [cranial, anterior, left] axes and [xiphoid, clavicle] levels along the cranial axis. */
export function breathFrame(ls, anterior) {
  const sub = (a, b) => a.map((v, i) => v - b[i]), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const nrm = (a) => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const cr0 = nrm(sub(ls.airway, ls.abdomen)), cran = nrm(sub(cr0, anterior.map(v => v * dot(cr0, anterior))));
  let left = cross(cran, anterior); if (ls.padLeft && ls.padRight && dot(sub(ls.padLeft, ls.padRight), left) < 0) left = left.map(v => -v);
  const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const xiph = dot(lerp(ls.sternum, ls.abdomen, 0.28), cran), clav = dot(lerp(ls.sternum, ls.airway, 0.3), cran);
  return { axes: [...cran, ...anterior, ...left], ref: [xiph, clav, dot(ls.sternum, left)] };
}
