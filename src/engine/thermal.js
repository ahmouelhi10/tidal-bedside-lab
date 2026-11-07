// Two-compartment (core / periphery) heat balance with redistribution during anesthesia and active temperature management.
// Anchors: heat from VO2 (20.1 J per mL O2), body specific heat 3.47 kJ/kg/C (tunable, UNVERIFIED), basal heat ~40 kcal/m2/h,
// redistribution 1.0-1.5 C in the first hour of general anesthesia, vasoconstriction threshold ~34.5 C under anesthesia,
// shivering threshold ~1 C below (REF sessler1993, insler2006, kurz1995).
import { clamp } from './util.js';
export class Thermal {
  constructor(body) {
    this.body = body;
    const wtSa = body.weightKg / body.bsa;
    this.coreFrac = clamp(0.62 + 0.004 * (wtSa - 38), 0.55, 0.82);   // larger/fatter -> more heat held in the core pool (smaller redistribution)
    this.cap = 3.47 * body.weightKg;                                 // kJ/C total
    this.Cc = this.cap * this.coreFrac; this.Cp = this.cap * (1 - this.coreFrac);
    this.tc = 37.0; this.tp = 33.0; this.ambient = 22;
    const q0 = 40 * 1.163 * body.bsa;                                // W (40 kcal/m2/h)
    this.G0 = q0 / (this.tc - this.tp);
    this.kSkin = q0 / (this.tp - this.ambient) * 0.97;
    this.cover = 1;                                                  // 1 = sheet, <1 = better insulated (warming blanket 0.7)
    this.device = null;                                              // {targetC, maxWatts}
    this.shivering = 0; this.vasoconstricted = false;
  }
  setAmbient(c) { this.ambient = c; }
  setDevice(d) { this.device = d; }
  step(dt, ctx) {
    const { vo2 = 250, anesthetized = false, vasodilation = 0, perfusion = 1 } = ctx;
    // thresholds
    // awake: narrow inter-threshold range just below the 37 C set-point; anaesthesia widens it by ~2.5 C (REF sessler1993)
    const vcThr = anesthetized ? 34.5 : 36.8, shiverThr = anesthetized ? 33.5 : 36.0;
    this.vasoconstricted = this.tc < vcThr;
    const metab = vo2 * 20.1 / 60;                                    // W; the caller passes the effective (already anaesthesia-reduced) VO2
    this.shivering = clamp((shiverThr - this.tc) / 1.5, 0, 1) * (ctx.paralyzed ? 0 : 1);
    const shiverW = this.shivering * 3 * 86 * 0.5;
    const nst = anesthetized ? 0 : clamp((vcThr - this.tc) / 0.8, 0, 1) * 0.5 * metab;   // non-shivering thermogenesis (design)
    const q = metab + shiverW + nst;
    let G = this.G0 * (1 + 2.2 * vasodilation) * (this.vasoconstricted ? 0.45 : 1) * clamp(perfusion, 0.05, 1.2);
    const skinK = this.kSkin * this.cover * (this.vasoconstricted ? 0.6 : 1);
    const toP = G * (this.tc - this.tp);                              // W core -> periphery
    const loss = skinK * (this.tp - this.ambient);
    let dev = 0;
    if (this.device) { const err = this.device.targetC - this.tc; dev = clamp(err * 250, -this.device.maxWatts, this.device.maxWatts); }
    const dtc = (q - toP) / this.Cc / 1000 * dt;                      // C
    const dtp = (toP - loss + dev) / this.Cp / 1000 * dt;
    this.tc += dtc; this.tp += dtp;
    this.heatIn = q; this.heatLoss = loss - dev;
  }
}
