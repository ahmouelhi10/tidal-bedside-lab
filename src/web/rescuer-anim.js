// The two CPR rescuers, read from engine state each frame. Display only (never feeds the engine).
//  - while CPR is going on, one rescuer stands on a step stool at the patient's side with straight arms on the chest, and the
//    next one stands ready beside the bed;
//  - at each compressor switch (engine `cpr.switch`, the "switch every 2 minutes" of the guidelines) the compressor lifts the
//    hands off the chest and back toward the body (role 'push' until they are off, so the arms stay on), and steps down to the free waiting place, and the one who was ready steps up and puts the hands on. The waiting place
//    alternates between the foot side and the head side so the two never walk through each other;
//  - the hands come off the chest when the defibrillator is charged ("all clear") and just after a shock, and when
//    compressions stop for a while (a rhythm or pulse check); they stay on through the pauses for breaths;
//  - when CPR stops for good the rescuers leave the scene.
//  - the body moves like a person's, not a statue's (posture(), flexPoint()): the compressor pushes from the hips with locked
//    elbows, so the trunk tips down by exactly the distance the hands travel and comes back up with the recoil, the head
//    nodding with it; through the pauses for breaths they ease back and look up at the airway; when the hands come off they
//    lean back. Effort builds up over the two minutes of compressions (fatigue: heavier, faster breathing, the head dropping,
//    a sway) and wears off while waiting. The one waiting stands more upright, breathes and shifts their weight; walking,
//    they straighten and sway with the steps;
// Places are names ('C' at the chest, 'R0' ready at the foot side, 'R1' ready at the head side); the scene turns them into
// positions. Timings, angles and the fatigue build-up are design values judged on screen.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
export const LIFT_S = 0.45, WALK_S = 1.2, GONE_S = 4;

export class RescuerAnim {
  constructor() { this.t = 0; this.n = null; this.who = 0; this.people = null; this.fat = [0, 0]; this.base = [null, null]; }

  /** dt: real seconds. Returns null when nobody is there, else
   *  { who, people: [{ from, to, u (0..1 along the walk), hands (0..1 on the chest, 0 = off), lift (0..1 hands raised off the chest) }] } */
  update(dt, p) {
    this.t += dt;
    const c = p.cpr || {}, ev = c.events || [], last = ev.length ? ev[ev.length - 1].t : null;
    const since = last == null ? 99 : p.t - last, on = (c.mode && c.mode !== 'off') || since < GONE_S;
    if (!on) { this.people = null; this.n = c.switches || 0; return null; }
    const n = c.switches || 0;
    if (!this.people) {                                                   // CPR begins: the first rescuer steps up, the second waits
      this.people = [{ from: 'R0', to: 'C', t0: this.t }, { from: 'R1', to: 'R1', t0: this.t }]; this.who = 0; this.n = n;
    } else if (n !== this.n) {                                             // switch: the compressor steps down to the free place, the other steps up
      this.n = n;
      const a = this.who, b = 1 - a, free = this.people[b].to === 'R0' ? 'R1' : 'R0';
      this.people[a] = { from: 'C', to: free, t0: this.t };
      this.people[b] = { from: this.people[b].to, to: 'C', t0: this.t + LIFT_S * 0.5 };
      this.who = b;
    }
    // hands off: defibrillator charged ("all clear"), just after a shock, or compressions stopped for a while (rhythm check)
    const shock = p.shockLog?.length ? p.t - p.shockLog[p.shockLog.length - 1].t : 99;
    const breaths = c.mode === 'auto' && (c.auto?.pauseUntil ?? 0) > p.t - 0.5;   // the pause for two breaths (30:2), until the next push: hands stay on the chest
    const clear = !!p.defib?.charged || (shock >= 0 && shock < 1.2) || (since > 2.5 && !breaths);
    const out = this.people.map((q, i) => {
      const e = this.t - q.t0, leaving = q.from === 'C' && q.to !== 'C', arriving = q.to === 'C' && q.from !== 'C';
      const u = q.from === q.to ? 1 : smooth((e - (leaving ? LIFT_S : 0)) / WALK_S);
      let hands = 0;
      if (leaving) hands = 1 - smooth(e / LIFT_S);
      else if (q.to === 'C') hands = arriving ? smooth((e - WALK_S) / LIFT_S) : 1;
      // at the chest while the hands are on it or coming off / going on: the one leaving lifts them before stepping down, the
      // one arriving puts them on once there, so the arms are never switched while the hands are on the chest
      const atChest = hands > 0 && (q.to === 'C' ? u >= 1 : leaving && e < LIFT_S);
      const role = atChest ? 'push' : q.from !== q.to && u < 1 ? 'walk' : 'wait';
      return { from: q.from, to: q.to, u, hands, lift: i === this.who && clear ? 1 : 0, role };
    });
    { const k = 1 - Math.exp(-dt / 0.15), q = out[this.who]; this.liftV = (this.liftV ?? q.lift) + (q.lift - (this.liftV ?? q.lift)) * k; q.lift = this.liftV; }
    // effort: builds up while pushing (shows after about a minute, heavy by three), wears off while waiting
    out.forEach((q, i) => {
      this.fat[i] = q.role === 'push' && q.lift < 0.5 ? Math.min(1, this.fat[i] + dt / 150) : this.fat[i] * Math.exp(-dt / 45);
      q.fatigue = clamp((this.fat[i] - 0.35) / 0.65, 0, 1); q.effort = this.fat[i];
      // the slow part of the posture (lean, head) eases between roles; the push itself is added on top, frame by frame
      const goal = q.role === 'push' ? (q.lift > 0.5 ? [-0.12, -0.1] : breaths ? [-0.08, -0.16] : [0, 0.12 * q.fatigue]) : q.role === 'walk' ? [-0.4, -0.18] : [-0.45, -0.22];
      const b = this.base[i] || (this.base[i] = goal.slice()), kk = 1 - Math.exp(-dt / 0.35); b[0] += (goal[0] - b[0]) * kk; b[1] += (goal[1] - b[1]) * kk;
      q.base = [b[0], b[1]];
    });
    return { who: this.who, people: out, breaths, t: this.t };
  }
}

/** A person's posture now (pure): trunk and head angles (rad, positive = bending forward) and a sideways sway (rad) about the
 *  feet. q: one person from update(); drop: how far the hands are pushed down now (m; negative = lifted off the chest);
 *  Z: how far the shoulders are in front of the hip hinge (m), so that the trunk tips just enough for the shoulders to follow
 *  the hands with locked elbows; t: seconds; seed: one person's own rhythm. */
export function posture(q, drop, Z, t, seed = 0) {
  const f = q.fatigue || 0, e = q.effort || 0, [b0, b1] = q.base || [0, 0];
  const bf = 0.25 + 0.35 * e, ba = 0.006 + 0.022 * e;                                              // breathing: faster and deeper with effort
  const breath = ba * Math.sin(2 * Math.PI * bf * t + seed);
  if (q.role === 'push') {
    const push = q.hands * (1 - q.lift) * drop / Math.max(0.12, Z);
    return { trunk: b0 + push + breath, head: b1 + 0.6 * push + 0.5 * breath, sway: 0.02 * f * Math.sin(2 * Math.PI * 0.4 * t + seed) };
  }
  if (q.role === 'walk') { const step = Math.sin(Math.PI * 3 * q.u); return { trunk: b0 + 0.03 * Math.abs(step), head: b1, sway: 0.035 * step }; }
  const shift = Math.sin(2 * Math.PI * 0.07 * t + seed * 3);                                         // shifting the weight from one foot to the other
  return { trunk: b0 + breath, head: b1 + 0.05 * Math.sin(2 * Math.PI * 0.11 * t + seed) + 0.3 * breath, sway: 0.012 * shift };
}

/** The bending as the vertex shader does it (renderer.js flexP), for a point of the rescuer mesh (shoulders, for the arms).
 *  meta: rescuer.json person (hip, neck, shoulderL/R); pose: posture(). Also returns the uniforms the shader needs. */
export function rescuerFlex(meta, pose) {
  const sm = [(meta.shoulderL[1] + meta.shoulderR[1]) / 2, (meta.shoulderL[2] + meta.shoulderR[2]) / 2], ny = meta.neck[1], nz = meta.neck[2];
  const dy = ny - sm[0], dz = nz - sm[1], dl = Math.hypot(dy, dz) || 1;
  return { a: [meta.hip[1], meta.hip[2], pose.trunk, pose.head], b: [ny, nz, dy / dl, dz / dl], c: [1, 0, 0, 0] };   // c: weights from the mesh (COLOR_0)
}
const smoothE = (e0, e1, x) => { const v = clamp((x - e0) / (e1 - e0), 0, 1); return v * v * (3 - 2 * v); };
/** w: [trunk, head] weights of the point (as the mesh's COLOR_0); without it they come from its position, like the shader's fallback. */
export function flexPoint(p, F, w = null) {
  const [hy, hz, ta, ha] = F.a, [ny, nz, dy, dz] = F.b; let [x, y, z] = p; const y0 = y, z0 = z;
  const rot = (cy, cz, a) => { const c = Math.cos(a), s = Math.sin(a), d0 = y - cy, d1 = z - cz; y = cy + d0 * c - d1 * s; z = cz + d0 * s + d1 * c; };
  if (ha) rot(ny, nz, ha * (w ? w[1] : smoothE(-0.02, 0.05, (y0 - ny) * dy + (z0 - nz) * dz)));
  if (ta) rot(hy, hz, ta * (w ? w[0] : smoothE(hy - 0.05, hy + 0.12, y0)));
  return [x, y, z];
}

/** The third rescuer, at the head with the bag-valve-mask (display only). Present while CPR is going on and the engine ventilates
 *  by bag: controlled ventilation without a tracheal tube (a tube goes on the ventilator). Nobody bags before the learner starts
 *  the ventilation, so the scene never shows breaths the patient is not getting. The squeezes follow the engine: two in each
 *  30:2 pause (one at 0.4 s, one at 2.4 s; about 1 s each), else at the set rate (continuous compressions), the same pauses
 *  the compressors make. Returns null when nobody bags, else { squeeze (0..1, the bag pressed), cycles (breath phase for breathing.js, so the
 *  chest rises with each squeeze), mask (false on a supraglottic airway: the bag goes on its connector) }. Timings are design
 *  values (inspiration about 1 s, as the guidelines ask). */
export const BAG_BREATH_S = 3;
export function bagger(p, cprOn) {
  const aw = p.airway || {};
  if (!cprOn || p.vent?.mode !== 'ctrl' || aw.intubated || aw.device === 'ett') return null;
  const c = p.cpr || {}, a = c.auto || {}, sga = aw.device === 'sga';
  let s, n;
  if (c.mode === 'auto' && a.ratio === '30:2') {
    const p0 = (a.pauseUntil ?? 0) - 4.5, x = p.t - p0;
    if (p0 < 0 || x < 0.4) return { squeeze: 0, cycles: 0.999, mask: !sga };
    const k = x < 2.4 ? 0 : 1; s = x - (k ? 2.4 : 0.4); n = Math.round(p0) * 2 + k;
  } else { const T = 60 / Math.max(4, p.vent.rate || 10); n = Math.floor(p.t / T); s = p.t - n * T; }
  const squeeze = s < 0.8 ? smooth(s / 0.8) : 1 - smooth((s - 0.8) / 0.6);
  return { squeeze, cycles: n + Math.min(s / BAG_BREATH_S, 0.999), mask: !sga };
}
