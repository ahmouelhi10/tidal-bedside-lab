// Head of the bed raised (engine `headUp`, the "Head-up / ramped 25-30°" action), read from engine state each frame. Display only.
// The bed's back section turns about a hinge at the patient's hips, at the level of the mattress top, and carries the trunk, the
// head and everything on them (lines, tubes, monitoring, the hands working there). The renderer does the same turn per vertex
// (renderer.js bendW); bendPoint() below is that maths for the camera, the floating labels and picking. Anything off the bed
// (more than ~0.7 m to the side, or below the mattress: the IV pole, the drain bottle, the ventilator) stays put, so the lines
// running to it stretch from the patient to the equipment. The bend is spread over the hips so the body curves instead of folding.
// Angle (30°), motor speed (~3.5°/s, like an electric bed) and the hinge level are design values judged on screen.

export const HEAD_UP_RAD = 30 * Math.PI / 180, BED_RATE = 3.5 * Math.PI / 180, BEND_ZONE = 0.12;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/** How much of the turn a world point gets (0..1): along the bed past the hinge, on the bed, not below the mattress. */
export function bendWeight(w, U) {
  return smooth(U[0] - BEND_ZONE, U[0] + BEND_ZONE, w[0]) * smooth(0.62, 0.70, w[1]) * (1 - smooth(0.70, 0.80, Math.abs(w[2])));
}

/** U: [hinge x, pivot y, angle (rad), 0] (the renderer's uBend). Returns the point carried by the back section. */
export function bendPoint(w, U) {
  if (!U || !U[2]) return w;
  const th = U[2] * bendWeight(w, U), c = Math.cos(th), s = Math.sin(th), dx = w[0] - U[0], dy = w[1] - U[1];
  return [U[0] + dx * c - dy * s, U[1] + dx * s + dy * c, w[2]];
}

/** A direction turned by th about the bed's lateral axis (camera framing, normals). */
export const turnDir = (d, th) => [d[0] * Math.cos(th) - d[1] * Math.sin(th), d[0] * Math.sin(th) + d[1] * Math.cos(th), d[2]];

/** The bed's back section: rises to 30° when the head is up, back down when flat, at motor speed. A case loads in its current position. */
export class BedAnim {
  constructor() { this.a = null; }
  /** dt: seconds (real or patient time, whichever is longer: fast-forward finishes the move). Returns the angle (rad). */
  update(dt, p) {
    const goal = p?.headUp ? HEAD_UP_RAD : 0;
    if (this.a == null) { this.a = goal; return this.a; }
    const d = goal - this.a, step = BED_RATE * Math.max(0, dt);
    this.a = Math.abs(d) <= step ? goal : this.a + Math.sign(d) * step;
    return this.a;
  }
}
