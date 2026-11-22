// Camera motion (display only): smooth moves between framings and the small life of a hand-held / head-mounted view.
//  - A move is a quintic Hermite curve on each orbit channel (yaw, pitch, distance, target): it starts with the velocity
//    the camera already has (a move that interrupts another one carries on without a jolt) and ends at rest with zero
//    acceleration; from rest it is the minimum-jerk profile (Flash & Hogan 1985), like a person turning their head.
//  - Hand-held: a few slow incommensurate sways (0.1 to 0.5 Hz, the operator's posture) and a gentle bob at the operator's
//    breathing rate (~14/min). Larger in close-ups, faded out while the camera travels, off when the user asks for reduced motion.
// Amplitudes are design values judged on screen.

const CH = ['yaw', 'pitch', 'dist'];

/** Quintic Hermite from p0 (velocity v0, units per second) to p1 (at rest), over dur seconds; u in 0..1. */
export function hermite5(p0, v0, p1, u, dur) {
  u = Math.min(1, Math.max(0, u));
  const u3 = u * u * u, h1 = u - 6 * u3 + 8 * u3 * u - 3 * u3 * u * u, h5 = 10 * u3 - 15 * u3 * u + 6 * u3 * u * u;
  return p0 + (p1 - p0) * h5 + v0 * dur * h1;
}

/** One camera move: from the current state and velocity to `to`, in `dur` seconds, with an optional outward swing `lift` (m). */
export class CamMove {
  constructor(from, vel, to, dur, lift = 0) {
    this.from = { ...from, target: [...from.target] }; this.to = { ...to, target: [...to.target] }; this.dur = Math.max(0.05, dur); this.lift = lift;
    const cap = (x, m) => (Number.isFinite(x) ? Math.max(-m, Math.min(m, x)) : 0);   // a hitch (long frame) must not fling the camera
    this.v = { yaw: cap(vel?.yaw, 1.2), pitch: cap(vel?.pitch, 1.2), dist: cap(vel?.dist, 1.5), target: [0, 1, 2].map(i => cap(vel?.target?.[i], 1.5)) };
  }
  /** State after `el` seconds: { yaw, pitch, dist, target, lift, done }. */
  at(el) {
    const u = el / this.dur, f = this.from, to = this.to, o = { target: [0, 0, 0] };
    for (const k of CH) o[k] = hermite5(f[k], this.v[k], to[k], u, this.dur);
    for (let i = 0; i < 3; i++) o.target[i] = hermite5(f.target[i], this.v.target[i], to.target[i], u, this.dur);
    o.lift = this.lift * Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
    o.done = u >= 1;
    return o;
  }
}

/** How long a move should take for how far it goes (seconds): short glances are quick, swings round the bed slower. */
export function moveDuration(from, to) {
  const dYaw = Math.atan2(Math.sin(to.yaw - from.yaw), Math.cos(to.yaw - from.yaw));
  const span = Math.abs(dYaw) + Math.abs(to.pitch - from.pitch) + Math.abs(to.dist - from.dist) * 0.6 + Math.hypot(...to.target.map((v, i) => v - from.target[i]));
  return { span, dur: Math.min(2.2, Math.max(0.9, 0.9 + span * 0.55)) };
}

/** Hand-held offsets at time t (s). amp 0..1 (0 = still). Returns { yaw, pitch (rad), dist (fraction), target: [dx, dy, dz] (m) }. */
export function handheld(t, amp) {
  if (!(amp > 0)) return { yaw: 0, pitch: 0, dist: 0, target: [0, 0, 0] };
  const s = Math.sin, br = 2 * Math.PI * 0.23 * t;                                        // operator's breathing, ~14 / min
  return {
    yaw: amp * (0.0045 * s(0.47 * t) + 0.0020 * s(1.13 * t + 1.7) + 0.0007 * s(2.9 * t + 0.4)),
    pitch: amp * (0.0035 * s(0.39 * t + 0.8) + 0.0016 * s(1.31 * t + 2.2) + 0.0006 * s(3.3 * t) + 0.0012 * s(br)),
    dist: amp * 0.004 * s(br + 0.6),
    target: [amp * 0.0012 * s(0.53 * t + 2.4), amp * 0.0012 * s(br + 0.5), amp * 0.0012 * s(0.61 * t + 0.9)],
  };
}

/** Hand-held strength for a framing: close-ups (dist ~0.6 m) get the full effect, the room overview a quarter of it. */
export const handheldAmp = (dist) => 0.25 + 0.75 * Math.min(1, Math.max(0, (2.4 - dist) / 1.6));
