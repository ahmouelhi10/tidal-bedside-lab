// The patient moving as anaesthesia lightens or wears off, read from engine state each frame. Display only (never feeds the engine).
//  - emergence with a tube in place (hypnosis light but not gone): agitated, semi-purposeful movement: the left hand goes up to
//    the face and fumbles for the tube, the head turns from side to side, a knee is drawn up;
//  - an awake patient: occasional small, unhurried movements (a glance aside, a hand to the face, shifting a leg);
//  - a painful procedure in a patient who is not deep and not covered by analgesia: a quick withdrawal (head turns away, a limb
//    flexes), then it settles;
//  - nothing while paralysed (scaled by the neuromuscular block), deeply anaesthetised, unconscious or in cardiac arrest;
//  - a part that a hand is working on keeps still (`busy`).
// The body has no skeleton: the joints are smooth weighted rotations of the mesh in the vertex shader (renderer.js moveP), and
// movePoint() below is the same maths for things attached to the body (tube, mask, cuffs, lines). Angles, timings and
// probabilities are design values judged on screen.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const hash = (n) => { const s = Math.sin(n * 51.73 + 3.11) * 43758.5453; return s - Math.floor(s); };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sc = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => sc(a, 1 / (Math.hypot(...a) || 1));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const rotA = (v, k, th) => { const c = Math.cos(th), s = Math.sin(th); return add(add(sc(v, c), sc(cross(k, v), s)), sc(k, dot(k, v) * (1 - c))); };

/** What drives movement now (pure). */
export function wakeDrive(p) {
  const arrested = !!p.arrest?.arrested;
  let eff = {}; try { eff = p.drugs?.effects?.({ inArrest: arrested }) || {}; } catch { eff = {}; }
  const H = eff.hyp ?? 0, motor = arrested ? 0 : clamp(1 - (eff.nmb ?? (eff.paralyzed ? 1 : 0)), 0, 1);
  const awake = !arrested && !eff.loc ? clamp(1 - H / 0.3, 0, 1) : 0, tube = p.airway?.device === 'ett';
  const emergence = tube && !arrested ? clamp(1 - Math.abs(H - 0.22) / 0.2, 0, 1) : 0;   // light but not awake, a tube in the throat
  const distress = awake * clamp((0.88 - (p.resp?.sao2 ?? 0.97)) / 0.15, 0, 1);
  const activity = motor * Math.max(emergence, 0.35 * awake, distress);
  return { H, motor, awake, emergence, tube, activity, analgesia: eff.analgesia ?? 0, arrested };
}

/** Same rotations as the vertex shader (renderer.js moveP), for a point in the body mesh's own space. U: the frame and pose
 *  (Scene._moveU); j: [left arm, left leg, right leg] membership of the point (0..1), like the mesh's joint weights. */
export function movePoint(p, U, j = [0, 0, 0]) {
  const m = U.move, m2 = U.move2; if (!m || (m.every(v => !v) && m2.every(v => !v))) return p;
  const [cr, an, lf] = U.axes, c = dot(p, cr);
  if (m[1] || m[2] || m[3]) {
    const S = U.arm.slice(0, 3), D = U.armD.slice(0, 3), k = norm(cross(D, an)), t = dot(sub(p, S), D);
    const aw = j[0] * smooth(-0.03, 0.05, t), fw = aw * smooth(U.arm[3] - 0.03, U.arm[3] + 0.04, t);
    const E = add(S, sc(D, U.arm[3]));
    p = add(E, rotA(sub(p, E), k, m[2] * fw)); p = add(S, rotA(sub(p, S), k, m[1] * aw)); p = add(S, rotA(sub(p, S), cr, -m[3] * aw));
  }
  if (m2[0] || m2[1]) {
    const phi = m2[0] * j[1] + m2[1] * j[2];
    const hw = 1 - smooth(U.leg[0] - 0.08, U.leg[0], c), kw = 1 - smooth(U.leg[1] - 0.04, U.leg[1] + 0.04, c), l = dot(p, lf);
    const K = add(add(sc(cr, U.leg[1]), sc(an, U.leg[3])), sc(lf, l)), Hp = add(add(sc(cr, U.leg[0]), sc(an, U.leg[2])), sc(lf, l)), k = sc(lf, -1);
    p = add(K, rotA(sub(p, K), k, -2 * phi * kw)); p = add(Hp, rotA(sub(p, Hp), k, phi * hw));
  }
  if (m[0]) {
    const hw = smooth(U.cprRef[0] - 0.03, U.cprRef[0] + 0.04, c), O = add(add(sc(cr, U.cprRef[0]), sc(an, U.cprRef[1])), sc(lf, U.ref[2]));
    p = add(O, rotA(sub(p, O), cr, m[0] * hw));
  }
  return p;
}

// one movement: rises, holds (with a little fumbling), falls; values are [headTurn, shoulder, elbow, across, kneeL, kneeR]
const ACTIONS = {
  reach: { rise: 0.9, hold: 2.2, fall: 1.1, pose: [0, 1.2, 2.15, 1.0, 0, 0], fumble: true },   // hand up to the face / the tube
  turn: { rise: 0.8, hold: 1.2, fall: 1.0, pose: [0.45, 0, 0, 0, 0, 0] },
  knee: { rise: 1.0, hold: 1.6, fall: 1.2, pose: [0, 0, 0, 0, 0.4, 0] },              // kept modest: the sheet over the thigh only partly follows
  withdraw: { rise: 0.25, hold: 0.7, fall: 1.2, pose: [0.35, 0.35, 0.9, 0, 0.35, 0] },
};

export class WakeAnim {
  constructor() { this.t = 0; this.next = 2.5; this.cur = null; this.n = 0; this.out = { move: [0, 0, 0, 0], move2: [0, 0, 0, 0] }; this.wasPainful = false; this.v = [0, 0, 0, 0, 0, 0]; }

  /** dt: real seconds; ctx: { painful (a painful gesture is under way), busy: Set of 'head' | 'armL' | 'legL' | 'legR' }. */
  update(dt, p, ctx = {}) {
    this.t += dt; const d = wakeDrive(p), busy = ctx.busy || new Set();
    // pain: a quick withdrawal at the start of a painful procedure, unless deep or covered by analgesia
    const painResp = d.motor * clamp(1 - d.H / 0.6, 0, 1) * (1 - d.analgesia) * (d.arrested ? 0 : 1);
    if (ctx.painful && !this.wasPainful && painResp > 0.15) { this.n++; this.cur = { k: 'withdraw', t0: this.t, amp: painResp, side: hash(this.n) < 0.5 ? 1 : -1 }; }
    this.wasPainful = !!ctx.painful;
    // spontaneous movements, more often the lighter / more agitated
    if (!this.cur && this.t >= this.next) {
      this.n++;
      if (d.activity > 0.08) {
        const r = hash(this.n * 1.37), emerg = d.emergence > 0.3;
        const k = emerg ? (r < 0.45 ? 'reach' : r < 0.75 ? 'turn' : 'knee') : (r < 0.5 ? 'turn' : r < 0.8 ? 'knee' : 'reach');
        this.cur = { k, t0: this.t, amp: clamp(d.activity * 1.4, 0, 1) * (emerg ? 1 : 0.55), side: hash(this.n * 2.9) < 0.5 ? 1 : -1 };
      }
      this.next = this.t + (d.activity > 0.08 ? 14 - 10 * d.activity : 3) + 3 * hash(this.n * 0.7);
    }
    let goal = [0, 0, 0, 0, 0, 0];
    if (this.cur) {
      const A = ACTIONS[this.cur.k], e = this.t - this.cur.t0, tot = A.rise + A.hold + A.fall;
      if (e >= tot) { this.cur = null; this.next = Math.max(this.next, this.t + 1); }
      else {
        const env = e < A.rise ? smooth(0, A.rise, e) : e < A.rise + A.hold ? 1 : 1 - smooth(A.rise + A.hold, tot, e), s = this.cur.side, amp = this.cur.amp * env;
        goal = A.pose.map(v => v * amp);
        goal[0] *= s;                                                     // which way the head turns
        if (this.cur.k === 'knee' || this.cur.k === 'withdraw') { if (s < 0) [goal[4], goal[5]] = [goal[5], goal[4]]; }
        if (A.fumble) { const f = Math.sin(e * 5.3) * Math.sin(e * 2.1 + 1); goal[2] += 0.12 * amp * f; goal[3] += 0.1 * amp * Math.sin(e * 3.7); }
      }
    }
    if (busy.has('head')) goal[0] = 0;
    if (busy.has('armL')) goal[1] = goal[2] = goal[3] = 0;
    if (busy.has('legL')) goal[4] = 0;
    if (busy.has('legR')) goal[5] = 0;
    if (d.motor < 1) goal = goal.map(v => v * d.motor);                   // partial block: weaker movement
    const k = 1 - Math.exp(-dt / 0.12); this.v = this.v.map((v, i) => v + (goal[i] - v) * k);
    this.out.move = [this.v[0], this.v[1], this.v[2], this.v[3]]; this.out.move2 = [this.v[4], this.v[5], 0, 0];
    return this.out;
  }
}
