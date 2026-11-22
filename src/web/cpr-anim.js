// What chest compressions look like on the 3D patient. Display only (never feeds the engine): it reads the engine's
// compression events ({t, depth cm, recoil}) and the CPR surface.
//  - each compression: the sternum goes down in about 45 % of the cycle and comes back up (recoil). Without full recoil
//    (leaning) the chest stays partly pressed.
//  - the body sinks into the mattress with each push (a little on a firm board, a lot on a soft mattress).
//  - follow-through, as springs: the head rocks a little (chin up), the arms jiggle, the belly bulges as the chest is pushed.
// Spring constants and amplitudes are design values judged on screen.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

/** Sternum travel 0..1 at `age` seconds after a compression that lasts a cycle of `period` s (recoil = full release). */
export function compressionShape(age, period, recoil = true) {
  if (age < 0) return 0;
  const down = 0.45 * period, up = 0.4 * period;
  const s = age < down ? smooth(age / down) : 1 - smooth((age - down) / up);
  return recoil ? s : Math.max(s, 0.18);                                     // leaning: the chest never comes all the way back up
}

export class CprAnim {
  constructor() { this.head = [0, 0]; this.arms = [0, 0]; this.belly = [0, 0]; this.out = { sternum: 0, sink: 0, head: 0, arms: 0, belly: 0, active: false }; }

  /** p: Patient; dt: real seconds since the last frame. Returns displacements in metres and the head angle in radians. */
  update(dt, p) {
    const ev = p.cpr?.events || [], comps = [];
    for (let i = ev.length - 1; i >= 0 && comps.length < 2; i--) if (ev[i].depth != null && !ev[i].type) comps.push(ev[i]);
    const e = comps[0], age = e ? p.t - e.t : 99;
    const period = e && comps[1] ? clamp(e.t - comps[1].t, 0.4, 1.2) : 0.55;
    const s = e && age < 1.5 ? compressionShape(age, period, e.recoil !== false) : 0;
    const depth = e ? clamp(e.depth, 0, 8) / 100 : 0;
    const soft = (p.cpr?.surface || 'hard') === 'soft';
    const o = this.out;
    o.sternum = depth * s;
    o.sink = depth * s * (soft ? 0.45 : 0.1);
    o.active = !!e && age < 1.5;
    // follow-through: damped springs driven by the push (sub-stepped so a long frame cannot blow them up)
    const spring = (st, goal, k, c) => { const n = Math.max(1, Math.ceil(dt / 0.004)), h = Math.min(dt, 0.25) / n; for (let i = 0; i < n; i++) { st[1] += (k * (goal - st[0]) - c * st[1]) * h; st[0] += st[1] * h; } return st[0]; };
    o.head = spring(this.head, 1.1 * o.sternum, 260, 14);      // rad per metre of travel: about 3.5 degrees for a 5.5 cm push
    o.arms = spring(this.arms, 0.25 * o.sternum, 520, 9);       // loose and underdamped: they wobble
    o.belly = spring(this.belly, 0.22 * o.sternum, 380, 22);
    return o;
  }
}
