// Endotracheal tube position, airway secretions and fibre-optic bronchoscopy through the tube.
// All constants are design values (REF design) chosen for teaching: listed in docs/VALIDATION.md.
//   - The tube depth is measured at the incisors. The optimal depth grows with height (0.1 x height + 4 cm) and the carina lies
//     4 cm beyond it, so a well-placed tip sits about 4 cm above the carina. Beyond the carina the tube enters the right main
//     bronchus (straighter and wider): the left lung is no longer ventilated (one-lung ventilation shunt, 0.28).
//   - A tube pulled back more than 7 cm above the carina leaves the cuff at the cords: leak, lower effective ventilation.
//   - Secretions build up slowly in an intubated patient (about 0.5 after 30 min) and only obstruct (shunt) above that level.
//   - The scope occupies part of the tube lumen (lower effective ventilation) and every suction pass briefly de-recruits.
import { clamp } from './util.js';

export const SEGMENTS = ['trachea', 'R', 'L'];

export class EtTube {
  constructor(body) {
    this.body = body; this.depth = null;                 // cm at the incisors; null = no tracheal tube
    this.secr = { trachea: 0, R: 0, L: 0 };              // 0..1 secretion load per region
    this.scopeIn = false; this.derecruit = 0; this.suctions = 0;
  }
  get optimalDepth() { return Math.round((0.1 * this.body.heightCm + 4) * 2) / 2; }   // REF design
  get carinaDepth() { return this.optimalDepth + 4; }                                  // REF design
  get placed() { return this.depth !== null; }
  get tipAboveCarina() { return this.placed ? +(this.carinaDepth - this.depth).toFixed(1) : null; }
  /** 'R' when the tip has passed the carina (right main bronchus), else null */
  get mainstem() { const d = this.tipAboveCarina; return d !== null && d < -0.5 ? 'R' : null; }
  get high() { const d = this.tipAboveCarina; return d !== null && d > 7; }
  /** extra pulmonary shunt from the tube position, plugs and suction de-recruitment */
  get shuntExtra() {
    if (!this.placed) return 0;
    const plug = (x) => 0.12 * clamp((x - 0.5) / 0.5, 0, 1);                        // REF design
    return (this.mainstem ? 0.28 : 0) + plug(this.secr.R) + plug(this.secr.L) + this.derecruit;
  }
  /** effective alveolar ventilation multiplier */
  get vaMult() {
    if (!this.placed) return 1;
    return (this.mainstem ? 0.92 : 1) * (this.high ? 0.85 : 1) * (this.scopeIn ? 0.85 : 1) * (1 - 0.25 * clamp((this.secr.trachea - 0.5) / 0.5, 0, 1));   // REF design
  }
  place(depthCm) { this.depth = depthCm ?? this.optimalDepth; }
  remove() { this.depth = null; this.scopeIn = false; }
  adjust(cm) { if (!this.placed) return null; this.depth = clamp(Math.round((this.depth + cm) * 2) / 2, 12, 32); return this.depth; }
  suction(where) {
    if (!this.scopeIn) return { ok: false, error: 'insert the bronchoscope first' };
    const before = this.secr[where]; this.secr[where] = Math.max(0, before - 0.7);
    this.derecruit = Math.min(0.15, this.derecruit + 0.04); this.suctions++;          // REF design
    return { ok: true, cleared: +(before - this.secr[where]).toFixed(2) };
  }
  step(dt, { intubated }) {
    if (this.placed && intubated) for (const k of SEGMENTS) this.secr[k] = Math.min(1, this.secr[k] + dt * (k === 'trachea' ? 0.8 : 1) / 3600);   // REF design
    this.derecruit *= Math.exp(-dt / 60);
  }
  findings() {
    return { depthCm: this.depth, tipAboveCarinaCm: this.tipAboveCarina, mainstem: this.mainstem, high: this.high, optimalDepthCm: this.optimalDepth,
      secretions: Object.fromEntries(SEGMENTS.map(k => [k, +this.secr[k].toFixed(2)])) };
  }
  hashVec() { return [this.depth ?? -1, this.secr.trachea, this.secr.R, this.secr.L, this.scopeIn ? 1 : 0, this.derecruit]; }
}
