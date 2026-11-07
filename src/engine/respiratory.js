// Gas exchange: one-compartment alveolar O2/N2 stores, tissue N2 store, venous O2 pool, Severinghaus SaO2 with Bohr shift, (REF severinghaus1979)
// CO2 body store + Fick-coupled excretion with perfusion-dependent alveolar dead space, acid-base (Henderson-Hasselbalch),
// ventilatory control with drug depression, atelectasis-driven shunt. Evidence tags: see references.js.
// Design logic: all constants that were NOT retrieved from a paper are listed in UNVERIFIED_PARAMS and appear in VALIDATION.md.
import { clamp, lag } from './util.js';

const PB = 760, PH2O = 47, DRY = PB - PH2O;           // mmHg (VERIFIED: alveolar gas equation page)
const BETA = 6.7;                                      // mL CO2 / L blood / mmHg, venous-arterial slope (textbook, UNVERIFIED)

export const sevSat = p => (p <= 0 ? 0 : 1 / (23400 / (p * p * p + 150 * p) + 1));            // Severinghaus (forward constants cross-checked vs verified inverse)
export const sevInv = s => Math.exp(-0.385 * Math.log(1 / s - 1) + 3.32 - 1 / (72 * s) - Math.pow(s, 6) / 6);
export const bohrShift = (pH, pco2, T) => Math.pow(10, 0.024 * (37 - T) + 0.40 * (pH - 7.40) + 0.06 * Math.log10(40 / Math.max(pco2, 5)));
export const alveolarPO2 = (fio2, paco2, R = 0.8) => fio2 * DRY - paco2 / R;                 // simple form (VERIFIED)
export const phHH = (hco3, pco2) => 6.1 + Math.log10(Math.max(hco3, 1) / (0.0307 * Math.max(pco2, 1)));
export const capContent = (sat, po2, hb) => 1.34 * hb * sat + 0.0031 * po2;                   // mL/dL
function satFromContent(c, hb) {                       // true SaO2 and virtual PO2 from content
  let lo = 1e-4, hi = 0.99999;
  for (let i = 0; i < 40; i++) { const m = 0.5 * (lo + hi); if (capContent(m, sevInv(m), hb) > c) hi = m; else lo = m; }
  return 0.5 * (lo + hi);
}

export class Respiratory {
  constructor(body, opt = {}) {
    this.body = body;
    const fem = body.sex === 'F', h = body.heightCm;
    // --- lung volumes (design values, back-fit to Jense 1991 / Farmery-Roe; see respiratory note section 3, 8) --- (REF jense1991) (REF farmery1996)
    const frcUpright = (fem ? 0.80 : 1.0) * 3.0 * Math.pow(h / 175, 2.6);               // L
    const gBmi = Math.exp(-0.03 * Math.max(0, body.bmi - 25));                          // awake FRC falls with BMI (ERV -48% at BMI 35, Srinivas 2011; FRC falls less than ERV) (REF srinivas2011)
    this.frcSupine = frcUpright * 0.80 * gBmi;                                          // supine, awake (LITFL: -20% supine)
    const gaDrop = 0.80 - 0.20 * clamp((body.bmi - 28) / 12, 0, 1);                     // GA: -20% (LITFL), larger in obesity (back-fit to Jense 1991; UNVERIFIED)
    this.frcAnesth = this.frcSupine * gaDrop;
    this.shuntBase = 0.02 + 0.001 * Math.max(0, body.age - 25);                         // age-related V/Q scatter lumped as shunt (design value; Hardie 2004 elderly PaO2 ~75) (REF hardie2004)
    this.vo2Rest = body.vo2 * (opt.vo2Scale ?? 1);
    this.vco2Rest = 0.8 * this.vo2Rest;
    this.q0 = opt.q0 ?? body.bsa * (body.sex === 'F' ? 3.0 : 2.8);                       // resting cardiac output; Patient passes Circulation.CO0 so both modules agree
    this.hb = opt.hb ?? (fem ? 13.5 : 15);
    this.vdAnat = 2.2 * body.pbw;                                                       // mL, Radford (textbook, UNVERIFIED)
    this.n2Cap = ((0.0118 * (body.tbw) + 0.067 * (body.fatMass / 0.9)) / 760) * 1000;    // mL/mmHg tissue N2 capacitance (solubility-based)
    this.cb = 1.05 * (body.lbm + 0.2 * body.fatMass);                                   // mL CO2 / mmHg body store (calibrated to ~3.4 mmHg/min apnea slope)
    this.reset(opt);
  }
  reset(opt = {}) {
    this.awakeTone = opt.anesthetized ? 0 : 1;
    const frc = this.frcSupine;
    this.paco2 = 40; this.phi0 = 0.95;
    this.pv = 40 + this.vco2Rest / (this.q0 * BETA);
    this.va0 = (863 * this.vco2Rest) / (40 * this.phi0);                                 // mL/min alveolar vent. giving PaCO2 40 at rest
    this.vO2 = 0.14 * frc * 1000 * 0 + 0;                                                // set below
    const fo2 = (0.21 * DRY - 40 / 0.8) / DRY, fn2 = 1 - fo2 - 40 / DRY;
    this.vL = frc * 1000; this.vO2 = fo2 * this.vL; this.vN2 = fn2 * this.vL;
    this.tissueN2 = 563 * 1; this.pt = 563;                                              // tissue PN2 (mmHg)
    this.lactate = 1.0; this.hco3Metab = 0; this.bicarbGiven = 0;
    this.shuntAtel = 0; this.atel = 0;
    const pA = fo2 * DRY;
    const cc = capContent(sevSat(pA), pA, this.hb);
    this.cv = cc - this.vo2Rest / (this.q0 * 10);
    this.pH = 7.40; this.hco3 = 24; this.sao2 = 0.975; this.pao2 = 95; this.paO2virtual = 0;
    this.pao2Alv = pA; this.etco2 = 38; this.vaNow = this.va0; this.ve = 6; this.rr = 12; this.vt = 500;
    this.vo2Eff = this.vo2Rest; this.dO2 = 0; this.spo2 = 97.5; this.spoBuf = []; this.timeS = 0;
    this.etco2Wave = 0; this.breathPhase = 0; this.fio2Eff = 0.21; this.vco2Eff = this.vco2Rest; this.shunt = 0.02; this.phiNow = this.phi0;
    this.eliminated = 0; this.drive = 1;
  }

  /**
   * @param {number} dt seconds
   * @param {object} c {
   *   co (L/min), hb (g/dL), tempC, anesthetized, paralyzed, perfusing(bool),
   *   dep:{slope(0..1 residual), shift(mmHg), hypoxic(0..1 residual)},          drug ventilatory depression
   *   vent:{mode:'spont'|'ctrl'|'none', rate, vt, fio2, peep, seal},             controlled/BVM ventilation (mL, /min)
   *   airwayPatency (0..1), o2:{fio2, seal} for spontaneous breathing devices, apOx:{fio2, eff}, shuntExtra, vo2Scale, bicarbMmol
   * }
   */
  step(dt, c) {
    const dtm = dt / 60, T = c.tempC ?? 37, hb = c.hb ?? this.hb;
    const q = Math.max(c.co ?? this.q0, 0);
    this.timeS += dt;
    // ---------- metabolism ----------
    const tempQ = Math.pow(2, (T - 37) / 10);
    const anesth = c.anesthetized ? 0.82 : 1;                                        // general anaesthesia lowers VO2/VCO2 by ~15-25% (REF textbook)
    const vo2Want = this.vo2Rest * tempQ * anesth * (c.vo2Scale ?? 1);
    const cvCrit = 3.0;
    const supply = clamp(this.cv / cvCrit, 0, 1);
    this.vo2Eff = vo2Want * supply;
    this.vco2Eff = 0.8 * vo2Want * (0.35 + 0.65 * supply);                           // some CO2 still produced from buffering/anaerobic metabolism (UNVERIFIED)
    const dO2now = q * 10 * (c.caO2 ?? 19);                                          // mL/min (approx, refined below once Ca known)
    const dO2crit = 2.0 * vo2Want;                                                   // critical DO2 = 2 x VO2 (UNVERIFIED design; clinical critical DO2 ~4-8 mL/kg/min)
    const debt = Math.max((vo2Want - this.vo2Eff) / Math.max(vo2Want, 1), clamp((dO2crit - this.dO2) / dO2crit, 0, 1));
    // lactate (mmol/L): production when O2-limited, first-order clearance when perfused (all UNVERIFIED design values)
    this.lactate = Math.max(0.6, this.lactate + (debt * 1.2 - (q > 1 ? 0.04 * (this.lactate - 1) * (1 - debt) : 0)) * dtm);

    // ---------- ventilation ----------
    const v = c.vent || { mode: 'spont' };
    let va = 0, rr = 0, vt = 0, fio2Raw = 0.21, seal = 1;
    const dep = c.dep || { slope: 1, shift: 0, hypoxic: 1 };
    if (v.mode === 'ctrl') {
      rr = v.rate ?? 10; vt = v.vt ?? 450; fio2Raw = v.fio2 ?? 0.21; seal = v.seal ?? 1;
      va = Math.max(0, rr * (vt - this.vdAnat)) * (v.efficiency ?? 1);
      this.ve = rr * vt / 1000;
    } else if (v.mode === 'spont' && !c.paralyzed) {
      const hypox = Math.max(0, 70 - this.pao2Art());
      const sCo2 = 2.0 * dep.slope * (this.vco2Rest / 196);                           // L/min/mmHg (hypercapnic response, UNVERIFIED)
      const B = 36.75 + dep.shift;                                                   // apnoeic threshold (UNVERIFIED)
      const ve = Math.max(0, sCo2 * (this.paco2 - B) + 0.25 * hypox * dep.hypoxic) * (this.awakeTone * 0.0 + 1);
      const patency = clamp(c.airwayPatency ?? 1, 0, 1);
      rr = clamp(12 * Math.sqrt(Math.max(ve, 0.01) / 6.5), 0, 40);
      this.drive = ve;
      this.ve = ve * patency;
      vt = rr > 0 ? (this.ve * 1000) / Math.max(rr, 1) : 0;
      va = Math.max(0, rr * (vt - this.vdAnat));
      fio2Raw = c.o2 ? c.o2.fio2 : 0.21; seal = c.o2 ? (c.o2.seal ?? 0.85) : 0;
    }
    va *= c.vaMult ?? 1;                                                              // pneumothorax: dead space and lost compliance (1 when absent)
    this.rr = v.mode === 'none' || (rr < 0.5) ? 0 : rr; this.vt = vt; this.vaNow = va;
    const fio2Eff = 0.21 + (fio2Raw - 0.21) * (v.mode === 'ctrl' ? Math.max(seal, 0.95) : seal);
    this.fio2Eff = fio2Eff;

    // ---------- shunt and lung volume ----------
    const peep = v.peep ?? 0;
    const tauForm = 4.5 * Math.exp((1 - clamp(fio2Eff, 0.21, 1)) / 0.33);            // min; anchors Magnusson&Spahn 2003 (recurs ~5 min at 1.0, ~40 min at 0.4) (REF magnusson2003)
    if (c.anesthetized || c.paralyzed) {
      const prevent = clamp(peep / 6, 0, 1);
      this.atel += ((1 - this.atel) / tauForm * (1 - prevent) - (peep >= 10 ? this.atel / 1.5 : 0)) * dtm;
    } else this.atel -= this.atel / 8 * dtm;
    this.atel = clamp(this.atel, 0, 1);
    const obes = clamp((this.body.bmi - 30) / 20, 0, 1);
    this.shunt = clamp(this.shuntBase + this.atel * 0.065 * (1 + obes) + (c.shuntExtra ?? 0), 0.01, 0.8);
    const frcBase = (c.anesthetized || c.paralyzed) ? this.frcAnesth : this.frcSupine;
    const vTarget = frcBase * 1000 * (1 + 0.02 * Math.min(peep, 15)) * (c.frcMult ?? 1);

    // ---------- alveolar gas ----------
    const pc = this.paco2;
    const vLung = (this.vO2 + this.vN2) / (1 - pc / DRY);
    const fO2 = this.vO2 / vLung, fN2 = this.vN2 / vLung;
    const pAO2 = fO2 * DRY, pAN2 = fN2 * DRY;
    this.pao2Alv = pAO2;
    // blood O2 content leaving perfused alveoli, with Bohr shift from current pH/PCO2
    const sh = bohrShift(this.pH, pc, T);
    const cc = capContent(sevSat(pAO2 * sh), pAO2, hb);
    const cvNow = Math.max(this.cv, 0);
    let uptake = (1 - this.shunt) * q * 10 * (cc - cvNow); uptake = Math.max(uptake, 0);
    // tissue N2 exchange (perfusion limited)
    const n2flux = q * 1000 * (0.0118 / 760) * (this.pt - pAN2);                      // mL/min into lung (neg = into blood)
    this.pt -= (n2flux * dtm) / this.n2Cap;
    // CO2: body store with Fick-coupled excretion
    const vaGross = va;
    const phi = clamp(q / this.q0, 0.02, 1) * this.phi0 + (1 - clamp(q / this.q0, 0.02, 1)) * 0.02;
    this.phiNow = phi;
    const qb = q * BETA;
    let paco2Target, E;
    if (vaGross > 20) {
      const kappa = (qb * 863) / (vaGross * phi);
      paco2Target = this.pv * kappa / (1 + kappa);
      E = qb * (this.pv - paco2Target);
    } else { paco2Target = this.pv; E = 0; }
    this.paco2 = lag(this.paco2, paco2Target, dt, 10);
    this.pv += ((this.vco2Eff - E) * dtm) / this.cb;
    this.pv = clamp(this.pv, 10, 250);
    this.eliminated += E * dtm;
    this.etco2 = vaGross > 20 ? clamp((863 * E) / vaGross, 0, 150) : 0;
    // gas stores (fluxes are STPD; lung pool is BTPS-dry: x CV)
    const CV = 863 / DRY, uV = uptake * CV, eV = E * CV, nV = n2flux * CV;
    let dO2 = -uV, dN2 = nV;
    if (vaGross > 20) {
      const vap = vaGross * phi;                         // ventilation reaching perfused units
      const vai = Math.max(vap - eV + uV - nV, 0);       // inspired volume so alveolar volume balance holds
      dO2 += vai * fio2Eff - vap * fO2;
      dN2 += vai * (1 - fio2Eff) - vap * fN2;
    } else if (c.apOx && v.mode !== 'ctrl') {
      const inflow = (c.apOx.eff ?? 0.5) * Math.max(uV - eV - nV, 0);
      dO2 += inflow * c.apOx.fio2; dN2 += inflow * (1 - c.apOx.fio2);
    }
    this.vO2 = Math.max(this.vO2 + dO2 * dtm, 0); this.vN2 = Math.max(this.vN2 + dN2 * dtm, 0);
    {
      const tot = this.vO2 + this.vN2, want = vTarget * (1 - this.paco2 / DRY);
      if (vaGross > 20) { this.vO2 *= want / tot; this.vN2 *= want / tot; }         // ventilated: volume held at FRC (+PEEP)
      else if (tot > want) {                                                         // apnoeic: when FRC falls (loss of muscle tone, supine, obesity) the excess gas, with its O2 store, is expired (tau ~20 s)
        const f = 1 - ((tot - want) / tot) * Math.min(1, dt / 20); this.vO2 *= f; this.vN2 *= f;
      }
    }
    // venous pool (tissue extraction at vo2Eff)
    const ca = (1 - this.shunt) * cc + this.shunt * cvNow;
    const vv = 0.7 * (c.bloodVolume ?? this.body.bloodVolume) * 10;                 // dL
    this.cv = Math.max(this.cv + ((q * 10 * (ca - cvNow) - this.vo2Eff) / vv) * dtm, 0);
    // arterial values (reported)
    const s = satFromContent(ca, hb);
    this.sao2 = s; this.paO2virtual = sevInv(s);
    this.dO2 = q * 10 * ca;
    // acid-base
    this.hco3Metab = -0.8 * (this.lactate - 1) + (c.bicarbMmol ?? 0);
    this.hco3 = clamp(24 + 0.1 * (this.paco2 - 40) + this.hco3Metab, 2, 60);
    this.pH = phHH(this.hco3, this.paco2);
    this.pao2 = this.paO2virtual / bohrShift(this.pH, this.paco2, T);
    // pulse oximeter: pure delay + first order lag; finger default 28 s delay (30-40 s band), slower when perfusion is poor
    const perfIdx = clamp(q / this.q0, 0.05, 1);
    const delay = 28 / Math.sqrt(perfIdx);
    this.spoBuf.push([this.timeS, s * 100]);
    while (this.spoBuf.length > 2 && this.spoBuf[1][0] <= this.timeS - delay) this.spoBuf.shift();
    this.spo2 = lag(this.spo2, this.spoBuf[0][1], dt, 4);
    return this;
  }
  pao2Art() { return this.pao2; }
  /** end-tidal oxygen fraction of dry alveolar gas (what the anaesthesia gas monitor reads at end-expiration) */
  get etO2() { return this.vO2 / ((this.vO2 + this.vN2) / (1 - this.paco2 / DRY)); }
}
