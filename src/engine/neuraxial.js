// Neuraxial anaesthesia: spinal and epidural blocks. The block is a single number, the highest blocked dermatome as a segment
// index (C1 = 1 ... C8 = 8, T1 = 9 ... T12 = 20, L1 = 21 ... L5 = 25, S1 = 26 ... S5 = 30; a smaller number is a higher block).
// The sympathetic block reaches about two segments above the sensory level (REF hocking2004).
//
// Spinal (hyperbaric bupivacaine 0.5 %): the peak level depends mainly on the dose; age raises it a little, sitting up during
// the first minutes keeps it lower, and the spread varies from patient to patient by about +/- 2 segments (REF hocking2004).
// Anchors: 7.5 mg about T10, 12.5 mg about T4 (REF hocking2004, textbook); the curve between and beyond them is REF design.
// The level rises over the first 10-20 min and regresses by two segments in about 90 min (REF textbook; rates REF design).
//
// Haemodynamics: blocked sympathetic outflow (T1-L2) dilates arterioles and veins; hypotension is more likely with a block at
// or above T5 and in older patients; a block reaching the cardioaccelerator fibres (T1-T4) slows the heart and weakens the
// reflex tachycardia, and a low venous return can trigger sudden bradycardia (REF carpenter1992; sizes REF design, calibrated
// so that a T4 block in an elderly patient lowers the MAP by 20-40 % untreated).
// High and total spinal: intercostal weakness above T1, diaphragmatic weakness when the block reaches C3-C5, apnoea and loss
// of consciousness when it reaches the brainstem (REF textbook; thresholds REF design).
//
// Epidural catheter: the test dose (lidocaine 60 mg with epinephrine 15 mcg) shows an intravascular catheter by a heart-rate
// rise of >= 10/min within a minute and an intrathecal one by a fast lower-limb block (REF guay2006). A top-up of 0.5 %
// bupivacaine spreads about 1.5 mL per segment up from L2 (REF textbook; REF design); given intrathecally it is a total
// spinal, given intravenously it is local anaesthetic toxicity (crises.js).
import { clamp } from './util.js';

export const SEG = Object.freeze({ C4: 4, T1: 9, T4: 12, T6: 14, T10: 18, L2: 22, S1: 26 });
export function segName(s) {
  const n = Math.max(1, Math.round(s));
  if (n <= 8) return 'C' + n; if (n <= 20) return 'T' + (n - 8); if (n <= 25) return 'L' + (n - 20); return n <= 30 ? 'S' + (n - 25) : 'none';
}
export const CATHETER = Object.freeze(['epidural', 'intrathecal', 'intravascular']);

export class Neuraxial {
  constructor(body, spec = {}) {
    this.body = body;
    this.kind = null;                                  // 'spinal' | 'epidural' | null
    this.seg = 31;                                     // current highest blocked segment (31 = no block)
    this.target = 31; this.tau = 4; this.t0 = null; this.peakAt = null; this.durMult = 1;
    this.catheter = CATHETER.includes(spec.catheter) ? spec.catheter : spec.epidural ? 'epidural' : null;
    this.out = this._neutral();
  }
  _neutral() { return { svr: 1, ven: 0, baro: 1, baroHr: 1, chrono: 1, hrAdd: 0, vaMult: 1, loc: false }; }
  get active() { return this.seg < 30.5; }
  get sensory() { return this.active ? segName(this.seg) : 'none'; }
  /** modified Bromage score 0 (free movement) .. 3 (cannot move feet or knees): dense with a spinal, lighter with an epidural */
  get bromage() { if (!this.active || this.seg > 25) return 0; return this.kind === 'spinal' ? (this.seg <= 20 ? 3 : 2) : this.seg <= 16 ? 1 : 0; }

  /** Peak level of an intrathecal dose of hyperbaric bupivacaine (mg) for this patient. */
  spinalTarget(doseMg, { headUp = false, spread = 0 } = {}) {
    const age = this.body.age ?? 40, h = this.body.heightCm ?? 170;
    return 18 - 11.7 * Math.log(Math.max(1, doseMg) / 7.5) - 1.5 * clamp((age - 40) / 40, 0, 1) + (h - 168) / 15 + (headUp ? 2 : 0) + spread;
  }
  _start(kind, target, tau, t, durMult = 1) {
    // a second dose on top of a working block adds to it: the higher of the two levels
    const tgt = this.active ? Math.min(this.target, target) : target;
    this.kind = this.kind === 'spinal' || kind === 'spinal' ? 'spinal' : kind;
    this.target = tgt; this.tau = tau; this.t0 = t; this.peakAt = t + 5 * tau * 60; this.durMult = durMult;
    if (!this.active) this.seg = 30;
  }
  spinal(doseMg, t, opt) { this._start('spinal', this.spinalTarget(doseMg, opt), 4, t); }
  /** Epidural top-up of `ml` of 0.5 % bupivacaine through a catheter in the epidural space. */
  epidural(ml, t) { this._start('epidural', 22 - 0.6 * ml, 7, t); }

  step(dt, ctx) {
    const o = this._neutral(); this.out = o;
    if (this.t0 === null) return o;
    const m = dt / 60, t = ctx.t;
    if (t <= this.peakAt) { if (this.seg > this.target) this.seg += (this.target - this.seg) * (1 - Math.exp(-m / this.tau)); }   // spreading
    else this.seg = Math.min(31, this.seg + m * 2 / (40 * this.durMult) * (1 + (t - this.peakAt) / 3600));                       // regression: two segments by ~90 min, faster later
    if (!this.active) { this.kind = this.seg >= 31 ? null : this.kind; return o; }
    const s = this.seg, symSeg = s - 2;
    const f = clamp((22 - symSeg) / 13, 0, 1);                         // share of the T1-L2 sympathetic outflow blocked
    const ageK = 1 + 0.6 * clamp(((this.body.age ?? 40) - 40) / 40, 0, 1);
    o.svr = 1 - clamp(0.26 * f * ageK, 0, 0.6);                        // arteriolar dilatation
    o.ven = -clamp(0.24 * f * ageK, 0, 0.5);                           // venous pooling: less venous return
    o.baro = 1 - 0.55 * f;                                             // reflex vasoconstriction lost in the blocked territory
    const cardiac = clamp((13 - symSeg) / 4, 0, 1);                     // cardioaccelerator fibres T1-T4
    o.chrono = 1 - 0.12 * cardiac; o.baroHr = 1 - 0.6 * cardiac;
    o.hrAdd = -22 * f * clamp((3 - (ctx.rap ?? 5)) / 4, 0, 1);         // low venous return: paradoxical bradycardia
    o.vaMult = (1 - 0.08 * clamp((20 - s) / 11, 0, 1)) * (s < 5 ? clamp((s - 2) / 3, 0, 1) : 1);   // intercostals, then the diaphragm (C3-C5)
    o.loc = s <= 2.2;                                                   // the block reaches the brainstem: total spinal
    return o;
  }
  hashVec() { return [this.seg, this.target, this.kind === 'spinal' ? 1 : this.kind === 'epidural' ? 2 : 0]; }
}
