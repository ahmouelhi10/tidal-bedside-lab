// The patient's face: eyelids, jaw, pain grimace and gaze, read from engine state each frame. Display only (never feeds the engine).
// Weights go to the renderer's uFace = [blink, jaw, pain, gaze] (face shape keys in assets/patient.glb, built by assets-src/build_patient.py).
//  - awake: eyes open, a blink every 2-6 s (about 150 ms, the lid falls faster than it rises), the eyes jump between points of
//    fixation (saccades) and look toward a procedure on their side.
//  - sedated: heavy lids, slow blinks, wandering gaze. Unconscious or anaesthetised: eyes closed, jaw slack.
//  - cardiac arrest: eyes half open and fixed, mouth open.
//  - paralysed (neuromuscular block): no blink, no grimace, whatever the depth of anaesthesia.
//  - pain: a painful procedure on a patient who is not deeply asleep and not covered by analgesia makes him grimace;
//    breathlessness (low SpO2, fast breathing) opens the mouth and strains the face.
// Timings are design values judged on screen.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const hash = (n) => { const s = Math.sin(n * 91.37 + 17.13) * 43758.5453; return s - Math.floor(s); };
const approach = (v, goal, dt, tau) => v + (goal - v) * (1 - Math.exp(-dt / tau));

/** What the face should show for this patient (pure). painful: a painful procedure is under way; side: -1..1 where it is. */
export function faceTargets(p, { painful = false, side = 0 } = {}) {
  let eff = {}; try { eff = p.drugs?.effects?.({ inArrest: !!p.arrest?.arrested }) || {}; } catch { eff = {}; }
  const H = eff.hyp ?? 0, loc = !!eff.loc, para = !!eff.paralyzed, analg = eff.analgesia ?? 0, arrested = !!p.arrest?.arrested;
  const awake = !arrested && !loc ? clamp(1 - H / 0.3, 0, 1) : 0;                  // 1 = fully awake, 0 = unconscious
  const sao2 = p.resp?.sao2 ?? 0.97, rr = p.resp?.rr ?? 14, dev = p.airway?.device;
  const dyspnoea = awake > 0.3 && !para ? clamp((0.9 - sao2) / 0.12, 0, 1) * 0.7 + clamp((rr - 24) / 14, 0, 1) * 0.5 : 0;
  // eyelids: 0 = open, 1 = closed
  let lid = arrested ? 0.55 : loc || para ? 0.97 : 0.04 + 0.5 * (1 - awake);
  // jaw: slack when unconscious, held open by a tube or a supraglottic airway, mouth breathing when breathless
  let jaw = arrested ? 0.7 : loc ? 0.45 : 0.05 + 0.4 * (1 - awake);
  if (dev === 'ett' || dev === 'sga') jaw = Math.max(jaw, 0.4);
  jaw = Math.max(jaw, 0.6 * clamp(dyspnoea, 0, 1));
  const pain = para || arrested ? 0 : clamp((painful ? awake * (1 - analg) : 0) + 0.35 * clamp(dyspnoea, 0, 1), 0, 1);
  return { lid, jaw, pain, awake: para ? 0 : awake, blinks: !para && !arrested && awake > 0.15, side: clamp(side, -1, 1) };
}

export class FaceAnim {
  constructor() { this.t = 0; this.w = [0, 0, 0, 0]; this.nextBlink = 2; this.blinkT = -1; this.nextSacc = 1; this.gaze = 0; this.gazeGoal = 0; this.n = 0; this.tg = null; this.tgAge = 9; this.pain = 0; }

  /** Advance by dt seconds of real time; returns [blink, jaw, pain, gaze] for the renderer. */
  update(dt, p, ctx) {
    this.t += dt; this.tgAge += dt;
    if (!this.tg || this.tgAge > 0.25) { this.tg = faceTargets(p, ctx); this.tgAge = 0; }    // reading the drug effects four times a second is plenty
    const g = this.tg;
    // blinks: close in 60 ms, reopen in 100 ms; slower and rarer when drowsy
    let blink = 0;
    if (g.blinks) {
      if (this.blinkT < 0 && this.t >= this.nextBlink) { this.blinkT = 0; this.n++; }
      if (this.blinkT >= 0) {
        const slow = 1 + 1.5 * (1 - g.awake), c = 0.06 * slow, o = 0.1 * slow; this.blinkT += dt;
        blink = this.blinkT < c ? this.blinkT / c : Math.max(0, 1 - (this.blinkT - c) / o);
        if (this.blinkT > c + o) { this.blinkT = -1; this.nextBlink = this.t + (2 + 4 * hash(this.n)) * (1 + (1 - g.awake)); }
      }
    }
    // pain rises quickly and fades over about 1.5 s
    this.pain = g.pain > this.pain ? approach(this.pain, g.pain, dt, 0.12) : approach(this.pain, g.pain, dt, 0.6);
    const lidBase = Math.max(g.lid, 0.35 * this.pain);
    this.w[0] = clamp(lidBase + (1 - lidBase) * blink, 0, 1);
    this.w[1] = approach(this.w[1], g.jaw + 0.15 * this.pain, dt, 0.35);
    this.w[2] = this.pain;
    // gaze: saccades between fixation points (each jump about 40 ms), biased toward a procedure on one side; still when unconscious
    if (g.awake > 0.15) {
      if (this.t >= this.nextSacc) { this.n++; this.gazeGoal = clamp(0.55 * g.side + (hash(this.n * 2.3) - 0.5) * 0.9 * g.awake, -0.9, 0.9); this.nextSacc = this.t + 0.6 + 2.8 * hash(this.n * 5.1); }
      this.gaze = approach(this.gaze, this.gazeGoal, dt, 0.035);
    } else this.gaze = approach(this.gaze, 0, dt, 1.5);
    this.w[3] = this.gaze;
    return this.w;
  }
}
