// The body reacting to events, read from engine state each frame. Display only (never feeds the engine).
//  - defibrillation / cardioversion: the whole body jumps (trunk lifts, arms jerk up, head kicks back), then settles.
//  - seizure: generalised shaking of the limbs and the head in irregular bursts, face clenched.
//  - shivering: fine fast tremor of the limbs and the jaw, more as the patient gets colder.
//  - succinylcholine: fasciculations, brief twitches all over the skin while the block sets in, then nothing.
//  - tube in place, patient too light and not paralysed: bouts of coughing / bucking (head comes forward, belly pulls in,
//    eyes squeezed shut).
//  - early cardiac arrest without compressions: agonal gasps every several seconds (head back, mouth open, chest heaves).
// Spring constants, amplitudes and timings are design values judged on screen.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const hash = (n) => { const s = Math.sin(n * 78.233 + 12.9898) * 43758.5453; return s - Math.floor(s); };
const bump = (x, w) => (x < 0 || x > w ? 0 : Math.sin(Math.PI * x / w));          // 0 -> 1 -> 0 over w seconds

/** What is going on (pure): seizure, shivering 0..1, fasciculation 0..1, coughing allowed, gasping allowed. */
export function bodyState(p, recentCompression = false) {
  let eff = {}; try { eff = p.drugs?.effects?.({ inArrest: !!p.arrest?.arrested }) || {}; } catch { eff = {}; }
  const arrested = !!p.arrest?.arrested, para = !!eff.paralyzed, H = eff.hyp ?? 0;
  const sux = p.drugs?.pk?.succinylcholine?.ce ?? 0, b = sux > 0 ? sux ** 3 / (sux ** 3 + 0.7 ** 3) : 0;   // succinylcholine block alone (drugs.js c50 0.7, gamma 3)
  return {
    seizure: !!p.crises?.seizure && !arrested,
    shiver: arrested ? 0 : clamp(p.therm?.shivering ?? 0, 0, 1),
    suxBlock: b,
    cough: !arrested && !para && p.airway?.device === 'ett' && H < 0.45,
    gasp: arrested && (p.arrest?.tArrest ?? 999) < 240 && !recentCompression,
  };
}

export class BodyAnim {
  constructor() {
    this.s = { lift: [0, 0], arms: [0, 0], head: [0, 0], belly: [0, 0] };
    this.seen = null; this.t = 0; this.prevB = 0; this.fasc = 0; this.nextCough = 3; this.coughT = -9; this.n = 0; this.nextGasp = 4; this.gaspT = -9;
    this.out = { head: 0, lift: 0, arms: 0, belly: 0, tremor: [0, 0, 0, 0], face: [0, 0, 0], chest: 0, abd: 0 };
  }

  /** dt: real seconds; p: Patient; recentCompression: compressions under way (no gasps then). */
  update(dt, p, recentCompression = false) {
    this.t += dt; const o = this.out, st = bodyState(p, recentCompression), s = this.s;
    // a delivered shock: kick the springs (velocity impulse)
    const last = p.shockLog?.[p.shockLog.length - 1];
    if (last && last.t !== this.seen) { if (this.seen !== null || p.t - last.t < 1) { s.lift[1] += 0.65; s.arms[1] += 1.35; s.head[1] += 4.5; s.belly[1] -= 0.25; } this.seen = last.t; }
    // coughing / bucking bouts
    let cough = 0;
    if (st.cough) { if (this.t >= this.nextCough) { this.coughT = this.t; this.n++; this.nextCough = this.t + 3.5 + 5 * hash(this.n); } }
    else this.nextCough = Math.max(this.nextCough, this.t + 1.5);
    const ca = this.t - this.coughT; cough = Math.max(bump(ca, 0.35), 0.7 * bump(ca - 0.45, 0.3));      // a double cough
    // agonal gasps
    if (st.gasp) { if (this.t >= this.nextGasp) { this.gaspT = this.t; this.n++; this.nextGasp = this.t + 7 + 7 * hash(this.n * 1.7); } }
    else this.nextGasp = Math.max(this.nextGasp, this.t + 3);
    const gasp = bump(this.t - this.gaspT, 1.2);
    // springs: goals from the ongoing reactions; shocks arrive as impulses above
    const spring = (st2, goal, k, c) => { const n = Math.max(1, Math.ceil(dt / 0.004)), h = Math.min(dt, 0.25) / n; for (let i = 0; i < n; i++) { st2[1] += (k * (goal - st2[0]) - c * st2[1]) * h; st2[0] += st2[1] * h; } return st2[0]; };
    o.lift = spring(s.lift, 0.004 * cough, 320, 16);
    o.arms = spring(s.arms, 0.01 * cough, 380, 12);
    o.head = spring(s.head, -0.14 * cough + 0.13 * gasp, 300, 18);              // + = chin up (extension), - = head comes forward
    o.belly = spring(s.belly, -0.012 * cough, 400, 20);
    // chest heave of a gasp, belly pulled in by a cough (added to the breathing wall)
    o.chest = 0.016 * gasp + 0.004 * cough; o.abd = 0.006 * gasp - 0.01 * cough;
    // tremor: [limb amplitude m, head amplitude rad, frequency Hz, fasciculation amplitude m]
    let limb = 0, headT = 0, freq = 9;
    if (st.seizure) { const burst = 0.55 + 0.45 * Math.sin(this.t * 1.3) * Math.sin(this.t * 0.47 + 1); limb = 0.014 * burst; headT = 0.07 * burst; freq = 4.2; }
    else if (st.shiver > 0) { limb = 0.0035 * st.shiver; headT = 0.012 * st.shiver; freq = 9.5; }
    const rising = st.suxBlock > this.prevB + 1e-6; this.prevB = st.suxBlock;
    const goalF = rising && st.suxBlock < 0.9 ? Math.sin(Math.PI * clamp((st.suxBlock - 0.02) / 0.88, 0, 1)) : 0;
    this.fasc += (goalF - this.fasc) * (1 - Math.exp(-dt / 0.4));
    o.tremor[0] = limb; o.tremor[1] = headT; o.tremor[2] = freq; o.tremor[3] = 0.0025 * this.fasc;
    // face: [blink, jaw, pain] added to face.js
    o.face[0] = 0.8 * cough + (st.seizure ? 0.3 : 0); o.face[1] = 0.5 * cough + 0.85 * gasp + (st.shiver > 0.3 ? 0.08 : 0); o.face[2] = 0.7 * cough + (st.seizure ? 0.6 : 0);
    return o;
  }
}
