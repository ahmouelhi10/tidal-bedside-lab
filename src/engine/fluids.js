// Plasma / interstitial volume kinetics and red-cell mass (hematocrit, hemoglobin), after Hahn-type two-pool kinetics.
// Design anchors (REF hahn2024, hahn_review): distribution half-life ~8 min, urinary elimination constant
// 0.023/min awake vs 0.002/min under general anesthesia, plasma retains ~25-30% of infused crystalloid once distributed,
// transcapillary refill during hypovolemia is slow. Rate constants for refill and third-space filling are UNVERIFIED design values.
import { clamp } from './util.js';

export class Volumes {
  constructor(body) {
    this.body = body;
    const fem = body.sex === 'F';
    this.hctV0 = fem ? 0.40 : 0.45;                      // venous hematocrit (design value; UNVERIFIED reference range)
    const bv = body.bloodVolume;
    this.rbc0 = bv * 0.91 * this.hctV0;                  // whole-body factor 0.91 (UNVERIFIED)
    this.vp0 = bv - this.rbc0;
    this.vi0 = 0.46 * (body.ecf - this.vp0 - 0.5);       // fast interstitial pool (Hahn Vt1 ~ 6-7 L in a 70 kg adult)
    this.vp = this.vp0; this.rbc = this.rbc0; this.vi = this.vi0; this.v3 = 0;
    const kTot = Math.LN2 / 8;                                    // REF hahn2024: distribution half-life ~8 min => k12 + k21 = ln2/8; plasma keeps ~30% at equilibrium
    this.kd = kTot * 0.7; this.kr = kTot * 0.3; this.kRefill = 0.03; this.k3 = 0.01;
    this.rates = { crystalloid: 0, bleed: 0 };           // L/min
    this.infusions = [];                                 // {remaining L, rate L/min, kind}
    this.urine = 0; this.totalCrystalloid = 0; this.totalBlood = 0; this.totalLost = 0;
  }
  get bloodVolume() { return this.vp + this.rbc; }
  get hct() { return this.rbc / (0.91 * (this.vp + this.rbc)); }       // venous hematocrit
  get hb() { return this.hct * 33; }                                    // g/dL
  get fractionLost() { return 1 - this.bloodVolume / (this.vp0 + this.rbc0); }
  startInfusion(litres, minutes, kind = 'crystalloid') { this.infusions.push({ remaining: litres, rate: litres / Math.max(minutes, 0.05), kind }); }
  setBleed(mlPerMin) { this.rates.bleed = Math.max(0, mlPerMin) / 1000; }
  transfuse(kind) { // instantaneous unit for simplicity (pRBC 300 mL Hct 0.60, whole blood 500 mL Hct 0.40, FFP 250 mL plasma)
    if (kind === 'prbc') { this.rbc += 0.3 * 0.60; this.vp += 0.12; }
    else if (kind === 'whole') { this.rbc += 0.5 * 0.40; this.vp += 0.30; }
    else if (kind === 'ffp') { this.vp += 0.25; }
    this.totalBlood += 1;
  }
  step(dt, ctx = {}) {
    const dtm = dt / 60;
    let inflow = 0;
    for (const f of this.infusions) {
      const dv = Math.min(f.remaining, f.rate * dtm);
      f.remaining -= dv; inflow += dv; this.totalCrystalloid += dv;
    }
    this.infusions = this.infusions.filter(f => f.remaining > 1e-9);
    const ex = this.vp - this.vp0;
    // exchange between plasma and fast interstitium
    let toI = 0;
    if (ex > 0) toI = this.kd * ex * dtm;
    else toI = this.kRefill * ex * dtm * clamp(this.vi / this.vi0, 0.3, 1);   // negative: refill plasma from interstitium
    const back = this.kr * (this.vi - this.vi0) * dtm * (ex > 0 ? 1 : 0.3);
    // slow third-space drain when the fast pool is over-expanded
    const over = Math.max(0, this.vi - this.vi0 - 0.75);
    const to3 = this.k3 * over * dtm;
    // urinary elimination of plasma excess
    const anesth = ctx.anesthetized ? 0.09 : 1;
    const mapF = clamp((ctx.map ?? 90) / 70, 0, 1);
    const k10 = 0.023 * anesth * mapF * mapF * (ex < 0 ? 0.2 : 1);
    const urine = ex > 0 ? k10 * ex * dtm : 0;
    // hemorrhage (whole blood)
    const bleed = Math.min(this.rates.bleed * dtm, this.bloodVolume * 0.5);
    const frac = this.vp / (this.vp + this.rbc);
    this.vp += inflow - toI + back - urine - bleed * frac;
    this.rbc -= bleed * (1 - frac);
    this.vi += toI - back - to3;
    this.v3 += to3;
    this.urine += urine; this.totalLost += bleed;
    this.vp = Math.max(this.vp, 0.05); this.rbc = Math.max(this.rbc, 0.02);
  }
}
