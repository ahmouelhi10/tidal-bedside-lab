// Surgical gestures: pneumothorax / tension physiology, needle decompression, chest drain and emergency front-of-neck access (eFONA).
// Everything here is driven by the Patient's integer step and by a SEPARATE seeded stream (rngS), so adding or using these
// gestures never changes the random draws of the rest of the simulation and a replay reproduces every outcome.
// Evidence tags: see references.js. Constants that are design choices say so and are listed in docs/VALIDATION.md.
import { clamp, lag } from './util.js';

// ----------------------------------------------------------------------------------------------- chest wall
/** Needle-decompression sites. cwt27 = mean chest-wall thickness (mm) at BMI 27; slope = mm per BMI unit (slope: design). */
export const SITES = Object.freeze({
  mcl2: { label: '2nd intercostal space, mid-clavicular line', cwt27: 42.8, slope: 1.8 },   // REF laan2016 (mean 42.8 mm; 5-cm needle failure 38%)
  mal5: { label: '5th intercostal space, mid-axillary line', cwt27: 39.9, slope: 1.7 },    // REF laan2016 (39.9 mm; failure 31%)
  aal5: { label: '5th intercostal space, anterior axillary line', cwt27: 34.3, slope: 1.6 }, // REF laan2016 (34.3 mm; failure 13%); REF ahmad2025 (thinner than 2nd ICS MCL)
});
/** A catheter must be longer than the chest wall by this much (hub, skin tenting, oblique track) to reach the pleura: design value back-fitted so a 5-cm catheter fails ~36/26/12% at MCL2/MAL5/AAL5 in a BMI ~ N(27,5) population (REF laan2016). */
export const NEEDLE_MARGIN_MM = 3;
const CWT_SD_SHARED = 6, CWT_SD_SITE = 3.5;                // mm: patient-level and site-level residuals (design; total SD ~7 mm at fixed BMI)
export const cwtMean = (site, bmi) => Math.max(14, SITES[site].cwt27 + SITES[site].slope * (bmi - 27));

/** Pneumothorax state of the chest, needle and chest-drain mechanics. */
export class Chest {
  constructor(body, rng) {
    this.body = body; this.rng = rng;
    const zShared = rng.normal(), zs = { mcl2: rng.normal(), mal5: rng.normal(), aal5: rng.normal() };
    this.cwt = Object.fromEntries(Object.keys(SITES).map(k => [k, clamp(cwtMean(k, body.bmi) + CWT_SD_SHARED * zShared + CWT_SD_SITE * zs[k], 12, 110)]));
    this.reset();
  }
  reset() {
    this.side = null;            // 'L' | 'R' | null: side of the pneumothorax
    this.air = 0;                // fraction (0..1) of the hemithorax occupied by pleural air = ipsilateral lung collapse
    this.valve = false;          // one-way valve: air keeps accumulating (tension-capable)
    this.leak = 0;               // fraction of hemithorax per minute entering the pleura while the valve is open (spontaneous breathing)
    this.convertOnPpv = false;   // a simple pneumothorax that becomes a valve as soon as positive-pressure ventilation starts
    this.pip = 0;                // ipsilateral intrapleural pressure, mmHg above atmosphere
    this.needle = null;          // { t, site, patent }
    this.tube = null;            // { t, side, fr, ok, malposition }
    this.tubeBusy = false;
    this.attempts = [];          // procedure log used for scoring: { t, kind, side, site?, needleMm?, fr?, reached?, relieved?, risk?, ok? }
    this.tensionT0 = null; this.reliefT = null; this.maxTension = 0;
    this.subcutaneous = false;
  }
  /** Install a pneumothorax (scenario set-up, or barotrauma). */
  setPneumothorax({ side, air = 0.3, valve = true, leak = 0.04, convertOnPpv = false }) {
    this.side = side; this.air = clamp(air, 0, 1); this.valve = valve; this.leak = leak; this.convertOnPpv = convertOnPpv;
  }
  get tension() { return clamp(this.pip / 10, 0, 1); }                                 // 0..1 index (1 = 10 mmHg, the severe swine level; REF swine_ptx_peep)
  get venting() { return !!(this.needle?.patent || this.tube?.ok); }
  _rawPip() { if (!this.valve) return 0; const x = clamp((this.air - 0.45) / 0.55, 0, 1); return 14 * Math.pow(x, 1.5); }   // mmHg: 3 mmHg at air 0.65, 8 mmHg at 0.80 (design shape; REF chen2024_side for the haemodynamic range)
  /** pressure transmitted to the vena cavae / right atrium (right-sided tension compromises the circulation at lower pressure than left; REF chen2024_side, sheep_ptx_ppv) */
  get itp() { return this.side === 'R' ? 1.5 * this.pip : this.side === 'L' ? 1.0 * this.pip : 0; }
  /** extra intrapulmonary shunt: collapsed lung keeps ~45% of its flow after hypoxic vasoconstriction (textbook, UNVERIFIED) + contralateral compression */
  get shuntExtra() { return this.side ? (this.side === 'R' ? 0.55 : 0.45) * 0.45 * this.air + 0.3 * this.tension : 0; }
  get vaMult() { return 1 - 0.1 * this.air - 0.35 * this.tension; }                    // dead space / reduced compliance (REF swine_ptx_peep: shunt, dead space and PaCO2 rise)
  /** mediastinal shift and RV compression also blunt the pump itself (design) */
  get pumpMult() { return 1 - 0.45 * this.tension; }
  get cprMult() { return 1 - 0.65 * this.tension; }                                    // compressions fill an obstructed heart poorly (design)

  step(dt, c, t) {
    if (!this.side) { this.pip = 0; return; }
    const dtm = dt / 60, obes = clamp((this.body.bmi - 30) / 20, 0, 1);
    if (!this.valve && this.convertOnPpv && c.ppv) { this.valve = true; this.convertOnPpv = false; }   // REF kheirabadi2013, sheep_ptx_ppv: air accumulates faster under positive pressure
    if (this.valve && this.leak > 0) {
      const k = c.ppv ? 3 * (1 + 0.04 * (c.peep ?? 0)) : 1;                         // positive pressure drives air through the leak (design factor)
      this.air = clamp(this.air + this.leak * k * Math.max(0, 1.05 - this.air) * dtm, 0, 1);
    }
    if (this.needle?.patent && this.rng.chance(1 - Math.exp(-dt / (420 / (1 + 0.5 * obes))))) {   // catheter kinks or clots: mean patency ~7 min (design)
      this.needle.patent = false;
    }
    if (this.tube?.ok) {
      this.air = Math.max(0, this.air - this.air * 0.9 * Math.pow(this.tube.fr / 28, 2) * dtm);  // drainage rate grows with the bore (Poiseuille-like, design)
      this.leak *= Math.exp(-dt / 600);                                                   // re-expansion seals the leak over ~10 min
    } else if (this.needle?.patent) {
      this.air = lag(this.air, Math.min(this.air, 0.42), dt, 20);                          // a 14G catheter vents the tension but the lung stays partly collapsed
    }
    this.pip = this.venting ? 0 : this._rawPip();
    this.maxTension = Math.max(this.maxTension, this.tension);
    if (this.tensionT0 === null && this.tension >= 0.3) this.tensionT0 = t;
    if (this.venting && this.reliefT === null && this.tensionT0 !== null) this.reliefT = t;
  }

  /** A catheter is advanced through the chest wall. */
  decompress(t, { side, site, needleMm }) {
    const cwt = this.cwt[site], reached = needleMm >= cwt + NEEDLE_MARGIN_MM;
    const excess = needleMm - cwt - NEEDLE_MARGIN_MM;
    const risk = reached && side === 'L' && site !== 'mcl2' && excess > 35 ? 'cardiac' : null;     // REF lesperance_nd (8 cm at the 5th ICS AAL endangers the heart); REF ahmad2025 (left side: 2nd ICS MCL is safer)
    const hasAir = this.side === side && this.air > 0.2;
    const relieved = reached && hasAir;
    if (relieved) {
      this.needle = { t, site, patent: true };
      if (this.tensionT0 !== null && this.reliefT === null && this.tension >= 0.05) this.reliefT = t;
      this.pip = 0;
    }
    const hiss = relieved && this._rawPip() > 0.5;
    this.attempts.push({ t, kind: 'needle', side, site, needleMm, reached, relieved, risk, wrongSide: this.side !== null && this.side !== side });
    return { reached, relieved, hiss, risk, wrongSide: this.side !== side };
  }

  /** Large-bore intercostal drain in the safe triangle (finger thoracostomy first). */
  insertTube(t, { side, fr }) {
    const obes = clamp((this.body.bmi - 30) / 20, 0, 1);
    const malposition = this.rng.chance(0.05 + 0.10 * obes);                          // kinked, subcutaneous or intraparenchymal: design (published rates vary widely)
    const ok = !malposition && this.side === side;
    this.tube = { t, side, fr, ok, malposition };
    if (ok && this.reliefT === null && this.tensionT0 !== null) this.reliefT = t;
    this.tubeBusy = false;
    this.attempts.push({ t, kind: 'tube', side, fr, ok, malposition, wrongSide: this.side !== null && this.side !== side });
    return this.tube;
  }
  /** Legacy zero-argument decompression (older clients / scripted cases): an ideal catheter on the affected side. */
  relieveIdeal(t) {
    if (!this.side) return;
    this.needle = { t, site: 'aal5', patent: true };
    if (this.tensionT0 !== null && this.reliefT === null) this.reliefT = t;
    this.attempts.push({ t, kind: 'needle', side: this.side, site: 'aal5', needleMm: 80, reached: true, relieved: true, risk: null, wrongSide: false, legacy: true });
  }

  /** Bedside examination: codes the client translates. `c` = { ppv, rap }. */
  findings(c) {
    const f = [], s = this.side, a = this.air, T = this.tension;
    if (!s || a < 0.15) f.push('chest_normal');
    else {
      f.push('chest_rise_reduced_' + s);
      f.push(a >= 0.75 ? 'breath_sounds_absent_' + s : 'breath_sounds_reduced_' + s);
      if (a >= 0.3) f.push('percussion_hyperresonant_' + s);
      if (T >= 0.5) f.push('trachea_deviated_' + (s === 'R' ? 'L' : 'R'));            // late sign
      if (T >= 0.35 && (c.rap ?? 0) > 6) f.push('neck_veins_distended');
      if (T >= 0.3 && c.ppv) f.push('bagging_resistance');
      if (this.subcutaneous) f.push('subcutaneous_emphysema');
    }
    if (this.tube) f.push(this.tube.ok ? (this.air > 0.05 ? 'drain_bubbling' : 'drain_swinging') : 'drain_no_function');
    if (this.needle) f.push(this.needle.patent ? 'catheter_in_situ_patent' : 'catheter_in_situ_blocked');
    return f;
  }
  /** Point-of-care ultrasound: lung sliding and chest-wall thickness (reported to the nearest mm, +-0.5 mm of deterministic reading error). */
  pocus() {
    const sliding = { L: true, R: true };
    if (this.side && this.air > 0.2) sliding[this.side] = false;
    const cwtMm = Object.fromEntries(Object.keys(SITES).map(k => [k, +(this.cwt[k] + 0.5 * Math.sin(this.cwt[k] * 7)).toFixed(0)]));
    return { sliding, lungPoint: !!this.side && this.air > 0.2 && this.air < 0.85, cwtMm };
  }
  snapshot() { return { side: this.side, air: +this.air.toFixed(3), pip: +this.pip.toFixed(2), tension: +this.tension.toFixed(3), needle: this.needle ? { site: this.needle.site, patent: this.needle.patent } : null, tube: this.tube ? { side: this.tube.side, fr: this.tube.fr, ok: this.tube.ok } : null }; }
}

// ----------------------------------------------------------------------------------------------- front of neck
/** Probability that landmarks are correctly identified by palpation: women 0.70 (71% non-obese in labour), the male advantage vanishes with obesity, falls with BMI (39% in obese women). Design fit to REF lavelle2021, aslani2012. */
export const pPalpable = (sex, bmi) => {
  const male = 0.85 - 0.15 * clamp((bmi - 25) / 15, 0, 1);
  return clamp((sex === 'F' ? 0.70 : male) - 0.010 * Math.max(0, bmi - 25) - 0.014 * Math.max(0, bmi - 30), 0.12, 0.95);
};

/** Emergency front-of-neck access plan: success probability and duration (s) for a technique/approach. */
export function fonaPlan(neck, technique, approach, body, rng) {
  const obes = clamp((body.bmi - 30) / 20, 0, 1);
  const known = neck.palpable || neck.marked;
  let p, dur;
  if (technique === 'scalpel_bougie') {
    p = known ? 0.90 : approach === 'vertical' ? 0.80 : 0.45;                         // REF umek2020 (device placement 92%), airwayapp_fona (18% first-attempt failure), das2015 (vertical incision when impalpable)
    dur = 90 + (approach === 'vertical' && !known ? 20 : 0);                          // REF umek2020 (median 90 s)
  } else {
    p = known ? 0.75 : 0.35; if (neck.depthMm > 30) p *= 0.7;                          // REF umek2020 (73%); design for the penalties
    dur = 108;                                                                         // REF umek2020 (median 108 s)
  }
  p *= 1 - 0.10 * obes;
  dur *= (1 + 0.35 * obes) * (0.8 + 0.4 * rng.next()) * (neck.marked ? 0.9 : 1);
  return { p: clamp(p, 0.05, 0.97), dur };
}

export class Neck {
  constructor(body, rng) {
    this.body = body; this.rng = rng;
    this.palpable = rng.chance(pPalpable(body.sex, body.bmi));
    this.depthMm = clamp(8 + 1.1 * Math.max(0, body.bmi - 22) + 3 * rng.normal(), 5, 55);   // skin to cricothyroid membrane (design)
    this.marked = false;          // landmark marked by ultrasound
    this.fona = null;             // { kind: 'tube'|'cannula', t, ok } once access is achieved
    this.attempts = [];           // { t, technique, approach, ok, falsePassage }
    this.busy = false;
  }
  get cannulaOk() { return !!this.fona && this.fona.kind === 'cannula' && !this.fona.displaced; }
  get tubeOk() { return !!this.fona && this.fona.kind === 'tube'; }
  /** cannula hazards while it is used for ventilation: displacement and barotrauma when the upper airway is obstructed (REF nap4) */
  step(dt, c, chest) {
    if (!this.cannulaOk || !c.ventilating) return;
    const obes = clamp((this.body.bmi - 30) / 20, 0, 1);
    if (this.rng.chance(1 - Math.exp(-dt / (480 / (1 + obes))))) { this.fona.displaced = true; return; }
    if (c.cap < 0.5 && this.rng.chance(1 - Math.exp(-dt * 0.15 / 60))) {            // breath stacking: no expiratory path through the larynx (design rate)
      if (!chest.side) { chest.setPneumothorax({ side: this.rng.chance(0.5) ? 'R' : 'L', air: 0.35, valve: true, leak: 0.06 }); chest.subcutaneous = true; }
    }
  }
  exam(method) {
    if (method === 'ultrasound') return { ctm: 'marked', depthMm: +this.depthMm.toFixed(0), palpable: this.palpable };
    return { ctm: this.palpable ? 'palpable' : 'impalpable' };
  }
}
