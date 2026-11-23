// The two CPR rescuers, read from engine state each frame. Display only (never feeds the engine).
//  - while CPR is going on, one rescuer stands on a step stool at the patient's side with straight arms on the chest, and the
//    next one stands ready beside the bed;
//  - at each compressor switch (engine `cpr.switch`, the "switch every 2 minutes" of the guidelines) the compressor lifts the
//    hands and steps down to the free waiting place, and the one who was ready steps up and puts the hands on. The waiting place
//    alternates between the foot side and the head side so the two never walk through each other;
//  - the hands come off the chest when the defibrillator is charged ("all clear") and just after a shock, and when
//    compressions stop for a while (a rhythm or pulse check); they stay on through the pauses for breaths;
//  - when CPR stops for good the rescuers leave the scene.
// Places are names ('C' at the chest, 'R0' ready at the foot side, 'R1' ready at the head side); the scene turns them into
// positions. Timings are design values judged on screen.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
export const LIFT_S = 0.3, WALK_S = 1.2, GONE_S = 4;

export class RescuerAnim {
  constructor() { this.t = 0; this.n = null; this.who = 0; this.people = null; }

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
      return { from: q.from, to: q.to, u, hands, lift: i === this.who && clear ? 1 : 0 };
    });
    { const k = 1 - Math.exp(-dt / 0.15), q = out[this.who]; this.liftV = (this.liftV ?? q.lift) + (q.lift - (this.liftV ?? q.lift)) * k; q.lift = this.liftV; }
    return { who: this.who, people: out };
  }
}
