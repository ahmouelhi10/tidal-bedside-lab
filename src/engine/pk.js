// Mammillary 3-compartment pharmacokinetic model with an effect-site compartment.
// Units: amounts mg, volumes L, rate constants 1/min, concentrations mg/L (= mcg/mL).
// The system is linear, so each fixed step is solved EXACTLY:  x(t+dt) = Phi x(t) + Gamma R
// where R is the constant infusion rate (mg/min) during the step.
import { expm, zeros } from './linalg.js';

export class PKModel {
  /**
   * @param {{V1:number,k10:number,k12:number,k21:number,k13?:number,k31?:number,ke0?:number}} p
   * @param {number} dtSec fixed step in seconds
   */
  constructor(p, dtSec) {
    this.p = { k13: 0, k31: 0, ke0: 5, ...p };
    this.dtSec = dtSec;
    this.a = [0, 0, 0];   // mg in central, shallow peripheral, deep peripheral
    this.ce = 0;          // effect-site concentration mg/L
    this.rate = 0;        // mg/min
    this.cumulativeIn = 0;
    this.cumulativeOut = 0;
    this._build();
  }
  _build() {
    const { V1, k10, k12, k21, k13, k31, ke0 } = this.p;
    const dt = this.dtSec / 60;
    // state x = [a1, a2, a3, ce, 1]; the constant 1 carries the unit infusion input.
    const M = zeros(5);
    M[0][0] = -(k10 + k12 + k13); M[0][1] = k21; M[0][2] = k31; M[0][4] = 1;
    M[1][0] = k12; M[1][1] = -k21;
    M[2][0] = k13; M[2][2] = -k31;
    M[3][0] = ke0 / V1; M[3][3] = -ke0;
    const E = expm(M.map(r => r.map(v => v * dt)));
    this.Phi = E.slice(0, 4).map(r => r.slice(0, 4));
    this.Gamma = E.slice(0, 4).map(r => r[4]);
  }
  get c1() { return this.a[0] / this.p.V1; }
  get c2() { return this.a[1] / (this.p.V1 * this.p.k12 / this.p.k21); }
  get totalAmount() { return this.a[0] + this.a[1] + this.a[2]; }
  bolus(mg) { this.a[0] += mg; this.cumulativeIn += mg; }
  setInfusion(mgPerMin) { this.rate = Math.max(0, mgPerMin); }
  /** Remove drug from the central compartment (e.g. chelation by a reversal agent). Returns mg removed. */
  removeCentral(mg) { const r = Math.min(mg, this.a[0]); this.a[0] -= r; return r; }
  step() {
    const x = [this.a[0], this.a[1], this.a[2], this.ce];
    const y = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      let s = this.Gamma[i] * this.rate;
      for (let j = 0; j < 4; j++) s += this.Phi[i][j] * x[j];
      y[i] = s;
    }
    const dtMin = this.dtSec / 60;
    this.cumulativeIn += this.rate * dtMin;
    // eliminated mass over the step = input - change in body amount
    const before = x[0] + x[1] + x[2];
    const after = y[0] + y[1] + y[2];
    this.cumulativeOut += before + this.rate * dtMin - after;
    this.a = [y[0], y[1], y[2]];
    this.ce = y[3];
  }
}

/** Reference RK4 integration used only by tests as an independent oracle. */
export function rk4Reference(p, bolusMg, rateMgMin, tEndMin, h = 1e-3) {
  const { V1, k10, k12, k21, k13 = 0, k31 = 0, ke0 = 5 } = p;
  let x = [bolusMg, 0, 0, 0];
  const f = s => [
    -(k10 + k12 + k13) * s[0] + k21 * s[1] + k31 * s[2] + rateMgMin,
    k12 * s[0] - k21 * s[1],
    k13 * s[0] - k31 * s[2],
    ke0 * (s[0] / V1 - s[3]),
  ];
  const add = (a, b, c) => a.map((v, i) => v + c * b[i]);
  for (let t = 0; t < tEndMin - 1e-12; t += h) {
    const k1 = f(x), k2 = f(add(x, k1, h / 2)), k3 = f(add(x, k2, h / 2)), k4 = f(add(x, k3, h));
    x = x.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  }
  return x;
}
