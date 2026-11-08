// Mean-value closed-loop circulation: Guyton venous return x Frank-Starling cardiac function,
// Pulse-style sigmoidal baroreflex (nu = 4), beat-averaged pressures with pulse pressure from SV/compliance.
// Parameters are CALIBRATED BY TARGETS per patient (see ADR-002), not copied between literature tables.
// Baselines: cardiac index 2.8 (M) / 3.0 (F) L/min/m2, MAP 87, CVP 4, mean systemic filling pressure 8 mmHg,
// stressed volume 30% of blood volume (REF pulse_cv_2024, magder2012). Age/obesity scalings are UNVERIFIED defaults.
import { clamp, lag } from './util.js';

export class Circulation {
  constructor(body, opt = {}) {
    const fem = body.sex === 'F';
    this.body = body;
    const ageAdj = body.age > 40 ? 1 - 0.008 * (body.age - 40) : 1;
    const obes = clamp((body.bmi - 25) / 25, 0, 1);
    this.CI0 = (fem ? 3.0 : 2.8) * ageAdj * (1 - 0.12 * obes);
    this.CO0 = this.CI0 * body.bsa;                      // L/min
    this.HR0 = opt.hr0 ?? 72;
    this.SV0 = (this.CO0 * 1000) / this.HR0;             // mL
    this.MAP0 = opt.map0 ?? 87 + (body.age > 40 ? 0.25 * (body.age - 40) : 0);
    this.CVP0 = 4; this.PMS0 = 8; this.lambda = 5.8; // Starling curve operating point ~70% of plateau at CVP 4 (UNVERIFIED design; gives fluid responsiveness ~ Toscani 2017 band) (REF toscani2017)
    this.BV0 = body.bloodVolume;
    this.Vs0 = 0.30 * this.BV0;
    this.Vu0 = this.BV0 - this.Vs0;
    this.Cven = this.Vs0 / this.PMS0;                    // L/mmHg
    this.Rvr = (this.PMS0 - this.CVP0) / this.CO0;       // mmHg.min/L
    this.SVR0 = (this.MAP0 - this.CVP0) / this.CO0;      // mmHg.min/L
    this.PP0 = 40 + (body.age > 40 ? 0.4 * (body.age - 40) : 0);
    this.Ca0 = this.SV0 / this.PP0;                      // mL/mmHg (effective, SV/PP)
    this.fn0 = this._f(this.CVP0);
    // baroreflex gains (tuned in tests against Pulse hemorrhage targets: HR +30%, CO -15..-20%, SVR +10..15%)
    this.g = { hr: 2.1, hrPar: 0.55, con: 0.6, svr: 0.8, ven: 0.5 };
    this.tau = { sens: 2, hr: 5, con: 8, svr: 18, ven: 30, art: 1.5 };
    this.reset();
  }
  reset() {
    this.mapArt = this.MAP0; this.mapSens = this.MAP0;
    this.x = { hr: 0, con: 0, svr: 0, ven: 0 };
    this.hr = this.HR0; this.sv = this.SV0; this.co = this.CO0; this.rap = this.CVP0;
    this.sbp = this.MAP0 + 0.67 * this.PP0; this.dbp = this.MAP0 - 0.33 * this.PP0;
    this.svr = this.SVR0; this.pms = this.PMS0; this.cpp = this.dbp - this.CVP0;
    this.baroDrive = 0;
  }
  _f(rap) { return rap <= -3 ? 0 : 1 - Math.exp(-(rap + 3) / this.lambda); }
  _hrFill(hr) { return hr <= 110 ? 1 : Math.max(0.35, 1 - 0.0045 * (hr - 110)); }

  /**
   * @param {number} dt seconds
   * @param {object} c context: {rhythm:{perfusing,rate}, bloodVolume, fx:{chrono,hrAdd,inotropy,svr,ven}, lvFunction, tempC,
   *                             cprFlow, cprAmp, arrestTone}
   */
  step(dt, c) {
    const fx = c.fx || {}, vs = c.bloodVolume - this.Vu0 * (1 - this.g.ven * Math.max(-0.5, this.x.ven) - (fx.ven || 0));
    this.pms = Math.max(-2, vs / this.Cven);
    // --- baroreflex (Pulse-style sigmoid, nu = 4), with the CNS ischemic response below MAP 45
    this.mapSens = lag(this.mapSens, this.mapArt, dt, this.tau.sens);
    const eta = 1 / (1 + Math.pow(Math.max(this.mapSens, 1) / this.MAP0, 4));
    let d = (2 * eta - 1) * clamp(fx.baro ?? 1, 0, 1.5);
    let eff = 1;
    if (this.mapSens < 45) eff = this.mapSens > 40 ? 1.35 : this.mapSens > 30 ? 0.35 + (this.mapSens - 30) * 0.1 : 0.2;
    if (d > 0) d *= eff;
    this.baroDrive = d;
    this.x.hr = lag(this.x.hr, d * clamp(fx.baroHr ?? 1, 0, 1.5), dt, this.tau.hr);       // propofol / opioids blunt the chronotropic limb more than the vascular limb
    this.x.con = lag(this.x.con, d, dt, this.tau.con);
    this.x.svr = lag(this.x.svr, d, dt, this.tau.svr);
    this.x.ven = lag(this.x.ven, d, dt, this.tau.ven);

    const temp = c.tempC ?? 37;
    const tempHr = 1 + 0.08 * (temp - 37);
    const perf = c.rhythm.perfusing;
    let hr;
    if (c.rhythm.rate != null) hr = c.rhythm.rate * (1 + 0.15 * this.x.hr);
    else hr = this.HR0 * (1 + (this.x.hr >= 0 ? this.g.hr : this.g.hrPar) * this.x.hr) * (fx.chrono ?? 1) * tempHr + (fx.hrAdd || 0);
    hr = clamp(hr, 25, 210);
    this.hrElectrical = c.rhythm.perfusing || c.rhythm.rate != null ? hr : (c.rhythm.rate ?? 0);

    const svrFx = (fx.svr ?? 1);
    if (perf) {
      const contr = clamp((1 + this.g.con * this.x.con) * (fx.inotropy ?? 1) * (c.lvFunction ?? 1), 0.05, 3);
      this.contr = contr;                              // effective contractility (read by the echo image model; no effect on the trajectory)
      const after = clamp(1 - 0.45 * (this.mapArt - this.MAP0) / this.MAP0, 0.55, 1.25);
      const svMax = (this.SV0 / this.fn0) * contr * this._hrFill(hr) * after;
      const itp = c.itp ?? 0;                          // intrapleural pressure transmitted to the vena cavae (tension pneumothorax): lowers the gradient for venous return, cardiac filling follows the transmural pressure
      const rvShift = c.rvShift ?? 0;                  // a pressure-overloaded RV needs a higher RA pressure to deliver the same flow to the LV (REF design)
      const F = rap => (hr * svMax * this._f(rap - rvShift)) / 1000 - (this.pms - itp - rap) / this.Rvr;
      let lo = -6, hi = 30;
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (F(mid) < 0) lo = mid; else hi = mid; }
      const rapTm = (lo + hi) / 2;
      this.co = (hr * svMax * this._f(rapTm - rvShift)) / 1000;
      this.rap = rapTm + itp;                          // the CVP trace reads the absolute pressure
      this.hr = hr; this.sv = hr > 0 ? (this.co * 1000) / hr : 0;
      const svr = this.SVR0 * (1 + this.g.svr * this.x.svr) * svrFx * (c.svrTone ?? 1) * (1 - 0.02 * (temp - 37));
      this.svr = svr;
      const mapT = this.co * svr + this.rap;
      this.mapArt = lag(this.mapArt, mapT, dt, this.tau.art);
      const ca = this.Ca0 * clamp(c.body ? 1 : 1, 0.5, 2) * (c.complianceMult ?? 1);
      let pp = clamp(this.sv / ca, 6, 140);
      const phi = clamp(0.33 + 0.0008 * (hr - 70), 0.30, 0.42);
      this.dbp = Math.max(this.rap + 1, this.mapArt - phi * pp);
      this.sbp = this.dbp + pp;
    } else {
      // arrest: flow only from compressions; venous return still limits it
      const flow = (c.cprFlow ?? 0) * this.CO0 * clamp(vs / this.Vs0, 0, 1);
      this.co = flow; this.hr = 0; this.sv = 0;
      this.contr = 0;
      const itp = c.itp ?? 0;
      this.rap = Math.max(-2, this.pms - itp - flow * this.Rvr) + itp;
      this.svr = this.SVR0 * (c.arrestTone ?? 1) * svrFx;
      const mapT = flow * this.svr + this.rap;
      this.mapArt = lag(this.mapArt, mapT, dt, flow > 0.05 ? this.tau.art : 6);
      const amp = flow > 0.05 ? (c.cprAmp ?? 0) : 0;
      this.dbp = Math.max(this.rap, this.mapArt - 0.25 * amp);
      this.sbp = this.dbp + amp;
    }
    this.cpp = this.dbp - this.rap;                      // coronary perfusion pressure (aortic diastolic - RA)
    this.shockIndex = this.sbp > 1 ? this.hr / this.sbp : 0;
    return this;
  }
}
