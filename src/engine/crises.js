// Crises and treatments that sit on top of the core physiology: anaphylaxis, bronchospasm, malignant hyperthermia, local
// anaesthetic systemic toxicity (LAST), hypoglycaemia, trauma fibrinolysis, heparin, loop diuretics and transcutaneous pacing.
// Each returns modifiers that Patient._physio applies to the circulation, gas exchange, metabolism and fluids. Deterministic:
// random draws (arrhythmic arrest) use the patient's main stream only while the hazard exists, so normal cases are untouched.
// Effect sizes are design values calibrated to the clinical bands in tests/crises.test.js (REF design) unless cited.
import { clamp } from './util.js';

const hill = (c, c50, g = 1.5) => (c <= 0 ? 0 : 1 / (1 + Math.pow(c50 / c, g)));
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };

/** Toxic plasma levels of local anaesthetics, mg/L: CNS symptoms and seizures, then cardiovascular collapse. Bupivacaine is
 *  cardiotoxic at much lower levels than lidocaine (REF neal2018, textbook). */
export const LA_TOXIC = Object.freeze({ lidocaine: { cns: 5, cv: 20 }, bupivacaine: { cns: 1.6, cv: 4 } });
/** Pacing: capture needs a current above the patient's threshold, typically 50-100 mA through pads (REF erc2025, textbook);
 *  the threshold rises with body mass (REF design). */
/** Torsades de pointes risk rises steeply once the QTc passes 500 ms, more so with bradycardia and pauses; magnesium
 *  suppresses it without shortening the QT (REF drew2010). Hazard per minute; sizes REF design. */
export const TDP = Object.freeze({ qtcOnset: 480, h500: 0.05, scaleMs: 30, mgC50: 0.04, mgMax: 0.9 });
export const paceThreshold = (bmi) => clamp(45 + 0.8 * (bmi - 25), 35, 110);

export class Crises {
  constructor(spec, body) {
    this.bmi = body.bmi; this.weightKg = body.weightKg;
    this.mhSusceptible = !!spec.mhSusceptible;
    this.anaDrive = 0; this.ana = 0;                 // anaphylaxis: mediator release and current severity 0..1
    this.asthma = spec.asthma ? 0.6 : 0;             // intrinsic bronchospasm drive 0..1
    this.br = 0;                                     // bronchospasm actually present 0..1
    this.mhAt = null; this.mh = 0;                   // malignant hyperthermia: onset time, hypermetabolism 0..1
    this.lysis = 0;                                  // trauma hyperfibrinolysis 0..1
    this.seizure = false; this.laCv = 0;             // LAST state
    this.pace = { on: false, rate: 70, mA: 0 }; this.captured = false;
    this.se = { active: false, since: null, ever: false, bzExp: 0 };   // status epilepticus (generalised convulsive); bzExp: minutes seizing under a benzodiazepine
    this.qtDrug = 0;                                 // QTc prolongation (ms) from QT-prolonging drugs or a congenital long QT
    this.out = this._neutral();
  }
  _neutral() { return { svr: 1, ven: 0, inot: 1, hrAdd: 0, leakLpm: 0, vaMult: 1, shunt: 0, vo2: 1, loc: false, hazard: 0, cause: null, diuretic: 0, fibLossPerMin: 0, tdp: 0, patency: 1, seStop: 0, seRecur: 0, naSeizure: 0 }; }
  /** QTc (ms) that drives the torsades risk: drugs or congenital, plus hypokalaemia (QT-U). Hypocalcaemia lengthens the ST
   *  segment (see electrolytes.ecg) but rarely causes torsades, so it is left out here (REF drew2010, textbook). */
  riskQtc(lytes) { return 400 + this.qtDrug + 70 * smooth(3.5, 2.5, lytes.k) + 40 * smooth(0.7, 0.4, lytes.mg ?? 0.85); }   // hypomagnesaemia also promotes torsades (REF drew2010; size REF design)
  /** magnesium effect 0..1 on torsades (2 g IV, REF erc2025, drew2010) */
  mgEffect(drugs) { return hill(drugs.ce('magnesium'), TDP.mgC50, 2); }

  /** start a crisis (scenario timeline or live instructor) */
  trigger(what, t) {
    if (what === 'seizure') { if (!this.se.active) { this.se.active = true; this.se.since = t; this.se.ever = true; this.se.bzExp = 0; } }
    else if (what === 'anaphylaxis') this.anaDrive = 1;
    else if (what === 'bronchospasm') this.asthma = Math.max(this.asthma, 0.8);
    else if (what === 'mh') this.mhAt = this.mhAt ?? t;
  }
  /** a triggering agent was given: succinylcholine (or a volatile) in a susceptible patient starts malignant hyperthermia
   *  within minutes (REF hopkins2021; latency REF design) */
  exposed(drug, t) { if (!this.mhSusceptible) return; const at = t + (drug === 'succinylcholine' ? 240 : drug === 'sevoflurane' ? 900 : Infinity); if (at < (this.mhAt ?? Infinity)) this.mhAt = at; }   // a volatile alone triggers later than with succinylcholine (REF hopkins2021; latency REF design)

  /** ctx: { drugs (DrugSystem), lytes, map, bleeding (L/min), t, paralyzedOrArrest, rhythm } */
  step(dt, ctx) {
    const m = dt / 60, d = ctx.drugs, ce = (k) => d.ce(k), o = this._neutral();
    // ---- anaphylaxis: vasodilation, capillary leak, bronchospasm. Epinephrine reverses all three and stops mediator release
    //      (REF rcuk2021_anaph); untreated, mediator release fades over about an hour (REF design).
    const epi = ce('epinephrine'), epiRelief = hill(epi, 0.9, 1.5);
    this.anaDrive *= Math.exp(-m / (epiRelief > 0.5 ? 12 : 45));
    const anaTarget = this.anaDrive * (1 - 0.85 * epiRelief);
    this.ana += (anaTarget - this.ana) * (1 - Math.exp(-m / 1.5));
    o.svr *= 1 - 0.75 * this.ana; o.ven -= 0.5 * this.ana;
    o.leakLpm = 0.10 * this.ana;                                      // up to ~35 % of plasma volume in 10 min in severe cases (REF textbook)
    // ---- bronchospasm (asthma or anaphylaxis): relieved by salbutamol, epinephrine, magnesium and ketamine (REF gina2024)
    const drive = Math.max(this.asthma, 0.75 * this.ana);
    const relief = 1 - (1 - 0.8 * hill(ce('salbutamol'), 1.2)) * (1 - 0.7 * hill(epi, 2.0)) * (1 - 0.3 * hill(ce('magnesium'), 0.08, 2)) * (1 - 0.35 * hill(ce('ketamine'), 1.0, 2)) * (1 - 0.35 * hill(ce('ipratropium'), 0.25, 1.5)) * (1 - 0.5 * hill(ctx.volatileMac || 0, 0.7, 2));   // volatile agents are bronchodilators (REF textbook)
    this.br = drive * (1 - relief);
    o.vaMult = 1 - 0.65 * this.br; o.shunt = 0.06 * this.br + 0.04 * this.ana;
    // ---- malignant hyperthermia: hypermetabolism (CO2 and heat production up to ~3x, tachycardia, rising potassium from
    //      rhabdomyolysis) halted by dantrolene 2.5 mg/kg (REF hopkins2021); early sign rising EtCO2 (REF larach1994)
    if (this.mhAt != null && ctx.t >= this.mhAt) {
      const dant = hill(ce('dantrolene'), 2.5, 3);                    // 2.5 mg/kg in 0.5 L/kg -> 5 mg/L
      const target = 1 - dant;
      this.mh += (target - this.mh) * (1 - Math.exp(-m / (target > this.mh ? 8 : 12)));
    }
    o.vo2 *= 1 + 4.0 * this.mh; o.hrAdd += 40 * this.mh;            // oxygen consumption up to ~5x at the height of a crisis (REF design; textbook 2-6x)
    if (this.mh > 0.05) ctx.lytes.kBase = Math.min(8.5, ctx.lytes.kBase + 0.1 * this.mh * m);   // ~ +2 mmol/L over 20 min at full crisis (REF design)
    // ---- local anaesthetic toxicity: CNS (agitation, seizures) then cardiovascular (depression, arrhythmia, arrest). Lipid
    //      emulsion takes up part of the drug (a "lipid sink") and supports the heart (REF neal2018; size REF design)
    const sink = 1 - 0.5 * hill(ce('lipid'), 20, 2);
    const cns = Math.max(ce('lidocaine') / LA_TOXIC.lidocaine.cns, ce('bupivacaine') / LA_TOXIC.bupivacaine.cns) * sink;
    const cv = Math.max(ce('lidocaine') / LA_TOXIC.lidocaine.cv, ce('bupivacaine') / LA_TOXIC.bupivacaine.cv) * sink;
    this.laCv = cv;
    // ---- status epilepticus: benzodiazepines first (less effective the longer it lasts), levetiracetam second line, anaesthetic doses
    //      of propofol for refractory seizures (REF glauser2016, silbergleit2012, esett2019; hazard sizes REF design, calibrated in
    //      tests/seizure.test.js). Without a long-acting drug a stopped seizure can come back.
    const bz = ce('midazolam') / 0.13 + ce('lorazepam') / 0.035 + ce('diazepam') / 0.18;
    const bzEff = hill(bz, 1, 2), levEff = hill(ce('levetiracetam') / 40, 1, 2), propEff = hill(ce('propofol') / 3, 1, 3);
    o.seStop = 0; o.seRecur = 0;
    if (this.se.active && !ctx.arrested) {
      const durMin = Math.max(0, (ctx.t - this.se.since) / 60), decline = clamp(1 - durMin / 40, 0.3, 1);
      // a seizure that goes on under a benzodiazepine becomes resistant to it (GABA-A receptor internalisation): most responders stop
      // within minutes, the rest are benzodiazepine-refractory (REF silbergleit2012, esett2019; time constant REF design)
      if (bzEff > 0.3) this.se.bzExp += m;
      o.seStop = 0.005 + 0.8 * bzEff * decline * Math.exp(-this.se.bzExp / 5) + 0.015 * levEff + 1.5 * propEff;   // per minute
      o.loc = true; o.vo2 *= 1.6; o.hrAdd += 25; o.svr *= 1.15; o.vaMult *= 0.85; o.patency = 0.85;
    } else if (this.se.ever && !this.se.active && !ctx.arrested) {
      const protect = Math.max(levEff, hill(ce('lorazepam') / 0.02, 1, 2), hill(ce('diazepam') / 0.15, 1, 2), propEff);
      o.seRecur = 0.02 * (1 - protect);
    }
    this.seizure = (cns > 1.6 || this.se.active) && !ctx.paralyzedOrArrest;
    if (this.seizure) { o.loc = true; o.vo2 *= 1.6; }
    if (cns > 1.0) o.hrAdd += 15 * smooth(1, 1.6, cns);
    o.inot *= 1 - 0.7 * smooth(0.5, 1.3, cv); o.svr *= 1 - 0.3 * smooth(0.6, 1.3, cv);
    if (cv > 1) { o.hazard += 0.3 * Math.exp(2 * (cv - 1)); o.cause = 'local_anaesthetic'; }
    // ---- sodium: acute hyponatraemia swells the brain: confusion below ~125, coma and seizures below ~115-120; hypernatraemia
    //      shrinks it: lethargy above ~155, coma above ~165 (REF spasovski2014, adrogue2000; thresholds REF design)
    const na = ctx.lytes.na;
    if (na < 116 || na > 168) o.loc = true;
    o.naSeizure = na < 120 && !this.se.active ? 0.03 * (120 - na) / 5 : 0;   // per minute
    // ---- hypoglycaemia: neuroglycopenia below ~3 mmol/L, coma below ~2 (REF textbook); adrenergic response
    const g = ctx.lytes.glucose;
    if (g < 2.2) o.loc = true;
    o.hrAdd += 20 * smooth(3.5, 2.5, g);
    // ---- trauma: shock with bleeding switches on hyperfibrinolysis that consumes fibrinogen; tranexamic acid blocks it
    //      (REF crash2_2010, rossaint2023; rates REF design)
    const txa = hill(ce('tranexamicAcid'), 10, 2);
    const lysisTarget = ctx.bleeding > 0.02 && ctx.map < 65 ? 1 - txa : 0;
    this.lysis += (lysisTarget * (1 - txa) - this.lysis) * (1 - Math.exp(-m / 10));
    o.fibLossPerMin = 0.05 * this.lysis;
    // ---- loop diuretic: urine output up to ~5x for about 2 h after 40 mg (REF textbook)
    o.diuretic = hill(ce('furosemide'), 0.5, 1.5);
    // ---- pacing: capture above the threshold; the paced rate replaces a slower perfusing rhythm (REF erc2025)
    this.captured = this.pace.on && this.pace.mA >= paceThreshold(this.bmi) && ctx.rhythm !== 'ASYSTOLE' && ctx.perfusing;
    // ---- torsades de pointes: QTc-dependent, faster heart rates (isoprenaline, overdrive pacing) protect, magnesium suppresses
    const q = this.riskQtc(ctx.lytes);
    if (q > TDP.qtcOnset && ctx.perfusing) {
      const hr = clamp(ctx.hr || 70, 25, 200), brady = clamp((70 / hr) ** 2, 0.3, 4);
      o.tdp = TDP.h500 * Math.exp((q - 500) / TDP.scaleMs) * brady * (1 - TDP.mgMax * this.mgEffect(d));
    }
    this.out = o;
    return o;
  }
  /** heparin effect on the aPTT (ratio) and on in-vivo clotting (REF textbook: 5000 U doubles to triples the aPTT) */
  heparinEffect(drugs) { const h = drugs.cp('heparin'); return { apttMult: 1 + 1.8 * hill(h, 1200, 1.3), fnMult: 1 - 0.5 * hill(h, 1200, 1.3) }; }
  get airwayResistance() { return 30 * this.br; }                     // cmH2O.s/L added by bronchospasm (mechanics.js; REF design)
  hashVec() { return [this.anaDrive, this.ana, this.asthma, this.mhAt ?? -1, this.mh, this.lysis, this.pace.on ? 1 : 0, this.pace.rate, this.pace.mA, this.qtDrug, this.se.active ? 1 : 0, this.se.since ?? -1, this.se.ever ? 1 : 0, this.se.bzExp]; }
}
