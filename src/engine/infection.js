// Infectiology ward course: bacterial isolates read against EUCAST clinical breakpoints, an antibiotic catalogue with
// the EUCAST breakpoint dosages, microbiology samples with result timing, and a multi-day host course stepped hourly.
// Pure engine code (no DOM, no wall clock, no Math.random). The ward has its own clock in hours that advances only through
// the `ward.advance` event, so a whole admission replays from the event log in a few milliseconds.
import { Rng } from './rng.js';
import { clamp, lag } from './util.js';

export const EUCAST_VERSION = '16.1';                     // REF eucast_v16_1 (valid from 2026-06-24)

// ------------------------------------------------------------------ EUCAST v16.1 MIC breakpoints (mg/L): S <= s, R > r
// A value between s and r is "susceptible, increased exposure" (I). s = 0.001 is EUCAST's convention for an agent that is
// only ever I ("(I) only"), never S at the standard dose. Brackets (bracket: true) follow EUCAST's guidance on bracketed
// breakpoints (the agent is used together with other active therapy). An agent EUCAST lists as "-" is reported R. REF eucast_v16_1, eucast_sir
export const BREAKPOINTS = {
  Enterobacterales: {                                       // REF eucast_v16_1 (Enterobacterales sheet)
    ampicillin:    { s: 8, r: 8 },
    amoxiclav_iv:  { s: 8, r: 8 },
    amoxiclav_po:  { s: 0.001, r: 8, note: 'infections originating from the urinary tract' },
    amoxicillin_po: { s: 0.001, r: 8, note: 'infections originating from the urinary tract' },
    piptazo:       { s: 8, r: 8, atu: 16 },
    cefuroxime_iv: { s: 0.001, r: 8 },
    cefazolin:     { s: 0.001, r: 4, note: 'infections originating from the urinary tract (E. coli, Klebsiella)' },
    cefotaxime:    { s: 1, r: 2 },
    ceftriaxone:   { s: 1, r: 2 },
    ceftazidime:   { s: 1, r: 4 },
    cefepime:      { s: 1, r: 4 },
    ertapenem:     { s: 0.5, r: 0.5 },
    meropenem:     { s: 2, r: 8 },
    ciprofloxacin: { s: 0.25, r: 0.5, atu: 0.5 },
    levofloxacin:  { s: 0.5, r: 1 },
    gentamicin:    { s: 2, r: 2, bracket: true },
    amikacin:      { s: 8, r: 8, bracket: true },
    tmpsmx:        { s: 0.5, r: 0.5 },
  },
  S_aureus: {                                               // REF eucast_v16_1 (Staphylococcus sheet)
    benzylpenicillin: { s: 0.125, r: 0.125 },
    cefoxitin:     { s: 4, r: 4, screen: true },            // MIC > 4 mg/L: methicillin resistant (note 4)
    vancomycin:    { s: 2, r: 2 },
    clindamycin:   { s: 0.25, r: 0.25 },
    linezolid:     { s: 4, r: 4 },
    daptomycin:    { s: 1, r: 1 },
    rifampicin:    { s: 0.06, r: 0.06 },
    tmpsmx:        { s: 0.5, r: 0.5 },
    gentamicin:    { s: 2, r: 2, bracket: true },
    levofloxacin:  { s: 0.001, r: 1 },
    moxifloxacin:  { s: 0.25, r: 0.25 },
  },
  S_pneumoniae: {                                           // REF eucast_v16_1 (S. pneumoniae sheet, indications other than meningitis/endocarditis)
    benzylpenicillin: { s: 0.06, r: 1, screen: true },      // MIC <= 0.06: screen negative, all beta-lactams with breakpoints reported S (note 1/B)
    ampicillin:    { s: 0.5, r: 1 },
    amoxicillin_po: { s: 0.5, r: 1 },
    cefuroxime_iv: { s: 0.5, r: 1 },
    cefotaxime:    { s: 0.5, r: 2 },
    ceftriaxone:   { s: 0.5, r: 2 },
    cefepime:      { s: 1, r: 2 },
    ertapenem:     { s: 0.5, r: 0.5 },
    meropenem:     { s: 2, r: 2 },
    levofloxacin:  { s: 0.001, r: 2 },
    moxifloxacin:  { s: 0.5, r: 0.5 },
    clarithromycin: { s: 0.25, r: 0.25 },
    vancomycin:    { s: 2, r: 2 },
  },
};

// ------------------------------------------------------------------ antibiotic catalogue
// Doses are the EUCAST v16.1 "Dosages used to define breakpoints" (standard / high). REF eucast_dosage_v16
// EUCAST says the table is not dosing guidance for clinical practice: the simulator uses it because the breakpoints assume these exposures.
// bp: breakpoint row per organism group and route. '-' = no breakpoint, report R (EUCAST). null = not reported in this simulator.
// mrsa: active on MRSA; gn: Gram-negative agent; atyp: covers atypical pneumonia pathogens (beta-lactams do not).
export const ABX = {
  amoxicillin:   { cls: 'penicillin', routes: ['iv', 'po'], dose: { iv: { std: '1 g x 3-4', high: '2 g x 6' }, po: { std: '0.5 g x 3', high: '0.75-1 g x 3' } },
                   bp: { Enterobacterales: { iv: 'ampicillin', po: 'amoxicillin_po' }, S_pneumoniae: { iv: 'ampicillin', po: 'amoxicillin_po' }, S_aureus: 'pen_plain' }, gn: true },
  amoxiclav:     { cls: 'penicillin', routes: ['iv', 'po'], dose: { iv: { std: '1 g/0.2 g x 3-4', high: '2 g/0.2 g x 3' }, po: { std: '0.5 g/0.125 g x 3', high: '0.875 g/0.125 g x 3' } },
                   bp: { Enterobacterales: { iv: 'amoxiclav_iv', po: 'amoxiclav_po' }, S_pneumoniae: { iv: 'ampicillin', po: 'amoxicillin_po' }, S_aureus: 'pen_bli' }, gn: true },
  flucloxacillin: { cls: 'penicillin', routes: ['iv', 'po'], dose: { iv: { std: '2 g x 4', high: '2 g x 4' }, po: { std: '1 g x 3', high: '1 g x 3' } },
                   bp: { Enterobacterales: '-', S_pneumoniae: null, S_aureus: 'pen_isox' } },
  piptazo:       { cls: 'penicillin', routes: ['iv'], dose: { iv: { std: '4 g/0.5 g x 4 (30 min) or x 3 (4 h)', high: '4 g/0.5 g x 4 (3 h infusion)' } },
                   bp: { Enterobacterales: 'piptazo', S_pneumoniae: 'pn_beta', S_aureus: 'pen_bli' }, gn: true, broad: true },
  cefazolin:     { cls: 'cephalosporin', routes: ['iv'], dose: { iv: { std: '1 g x 3', high: '2 g x 3' } },
                   bp: { Enterobacterales: 'cefazolin', S_pneumoniae: null, S_aureus: 'ceph_mssa' }, gn: true },
  cefuroxime:    { cls: 'cephalosporin', routes: ['iv'], dose: { iv: { std: '0.75 g x 3', high: '1.5 g x 3' } },
                   bp: { Enterobacterales: 'cefuroxime_iv', S_pneumoniae: 'cefuroxime_iv', S_aureus: 'ceph_mssa' }, gn: true },
  ceftriaxone:   { cls: 'cephalosporin', routes: ['iv'], dose: { iv: { std: '2 g x 1', high: '2 g x 2 or 4 g x 1' } },
                   bp: { Enterobacterales: 'ceftriaxone', S_pneumoniae: 'ceftriaxone', S_aureus: 'ceph_mssa' }, gn: true },
  cefotaxime:    { cls: 'cephalosporin', routes: ['iv'], dose: { iv: { std: '1 g x 3', high: '2 g x 3' } },
                   bp: { Enterobacterales: 'cefotaxime', S_pneumoniae: 'cefotaxime', S_aureus: 'ceph_mssa' }, gn: true },
  ceftazidime:   { cls: 'cephalosporin', routes: ['iv'], dose: { iv: { std: '1 g x 3', high: '2 g x 3' } },
                   bp: { Enterobacterales: 'ceftazidime', S_pneumoniae: '-', S_aureus: '-' }, gn: true, broad: true },
  cefepime:      { cls: 'cephalosporin', routes: ['iv'], dose: { iv: { std: '1 g x 3 or 2 g x 2', high: '2 g x 3' } },
                   bp: { Enterobacterales: 'cefepime', S_pneumoniae: 'cefepime', S_aureus: 'ceph_mssa' }, gn: true, broad: true },
  ertapenem:     { cls: 'carbapenem', routes: ['iv'], dose: { iv: { std: '1 g x 1', high: null } },
                   bp: { Enterobacterales: 'ertapenem', S_pneumoniae: 'ertapenem', S_aureus: 'carb_mssa' }, gn: true, broad: true },
  meropenem:     { cls: 'carbapenem', routes: ['iv'], dose: { iv: { std: '1 g x 3', high: '2 g x 3 (3 h infusion)' } },
                   bp: { Enterobacterales: 'meropenem', S_pneumoniae: 'meropenem', S_aureus: 'carb_mssa' }, gn: true, broad: true },
  ciprofloxacin: { cls: 'fluoroquinolone', routes: ['iv', 'po'], dose: { iv: { std: '0.4 g x 2', high: '0.4 g x 3' }, po: { std: '0.5 g x 2', high: '0.75 g x 2' } },
                   bp: { Enterobacterales: 'ciprofloxacin', S_pneumoniae: null, S_aureus: null }, gn: true },
  levofloxacin:  { cls: 'fluoroquinolone', routes: ['iv', 'po'], dose: { iv: { std: '0.5 g x 1', high: '0.5 g x 2' }, po: { std: '0.5 g x 1', high: '0.5 g x 2' } },
                   bp: { Enterobacterales: 'levofloxacin', S_pneumoniae: 'levofloxacin', S_aureus: 'levofloxacin' }, gn: true, atyp: true },
  moxifloxacin:  { cls: 'fluoroquinolone', routes: ['iv', 'po'], dose: { iv: { std: '0.4 g x 1', high: null }, po: { std: '0.4 g x 1', high: null } },
                   bp: { Enterobacterales: null, S_pneumoniae: 'moxifloxacin', S_aureus: 'moxifloxacin' }, atyp: true },
  gentamicin:    { cls: 'aminoglycoside', routes: ['iv'], dose: { iv: { std: '6-7 mg/kg x 1', high: null } }, perKg: [6, 7],
                   bp: { Enterobacterales: 'gentamicin', S_pneumoniae: null, S_aureus: 'gentamicin' }, gn: true },
  amikacin:      { cls: 'aminoglycoside', routes: ['iv'], dose: { iv: { std: '25-30 mg/kg x 1', high: null } }, perKg: [25, 30],
                   bp: { Enterobacterales: 'amikacin', S_pneumoniae: null, S_aureus: null }, gn: true },
  tmpsmx:        { cls: 'folate', routes: ['iv', 'po'], dose: { iv: { std: '0.16 g/0.8 g x 2', high: '0.24 g/1.2 g x 2' }, po: { std: '0.16 g/0.8 g x 2', high: '0.24 g/1.2 g x 2' } },
                   bp: { Enterobacterales: 'tmpsmx', S_pneumoniae: null, S_aureus: 'tmpsmx' }, gn: true },
  vancomycin:    { cls: 'glycopeptide', routes: ['iv'], dose: { iv: { std: '1 g x 2 (weight-based, drug monitoring)', high: null } }, loadingPerKg: 25, loadingMaxMg: 3000,
                   bp: { Enterobacterales: '-', S_pneumoniae: 'vancomycin', S_aureus: 'vancomycin' }, mrsa: true },
  clarithromycin: { cls: 'macrolide', routes: ['iv', 'po'], dose: { iv: { std: '0.5 g x 2', high: null }, po: { std: '0.25 g x 2', high: null } },
                   bp: { Enterobacterales: '-', S_pneumoniae: 'clarithromycin', S_aureus: null }, atyp: true },
};
export const ABX_KEYS = Object.keys(ABX);
const BETA = new Set(['penicillin', 'cephalosporin', 'carbapenem']);

/** EUCAST category of an MIC against a breakpoint row. */
export function interpret(mic, row) {
  if (!row) return null;
  if (mic <= row.s) return 'S';
  if (mic > row.r) return 'R';
  return 'I';
}

/** Category of `drug` given by `route` against an isolate { group, mic: {row: value} }, with the EUCAST inference rules.
 *  Returns { cat: 'S'|'I'|'R'|null, basis: 'mic'|'inferred'|'not_recommended'|'not_tested', row }. */
export function categorize(iso, drug, route = 'iv') {
  const a = ABX[drug]; if (!a) return { cat: null, basis: 'not_tested' };
  let map = a.bp[iso.group];
  if (map && typeof map === 'object') map = map[route] ?? map.iv;
  if (map == null) return { cat: null, basis: 'not_tested' };
  if (map === '-') return { cat: 'R', basis: 'not_recommended' };                    // REF eucast_sir ("-": report R)
  const bp = BREAKPOINTS[iso.group];
  if (iso.group === 'S_aureus') {
    const mr = iso.mic.cefoxitin > bp.cefoxitin.r;                                   // REF eucast_v16_1 (Staphylococcus note 4: cefoxitin MIC > 4 = methicillin resistant)
    const penS = iso.mic.benzylpenicillin <= bp.benzylpenicillin.s;
    switch (map) {
      case 'pen_plain': return { cat: !mr && penS ? 'S' : 'R', basis: 'inferred' };  // penicillinase or methicillin resistance: resistant to aminopenicillins (note 1)
      case 'pen_bli': case 'pen_isox': return { cat: mr ? 'R' : 'S', basis: 'inferred' };   // cefoxitin S: beta-lactam/inhibitor combinations and isoxazolylpenicillins S (note 1)
      case 'ceph_mssa': return { cat: mr ? 'R' : 'I', basis: 'inferred' };           // MSSA: cefazolin, cefotaxime, ceftriaxone, cefuroxime, cefepime reported I (high dose) (cephalosporin note 1)
      case 'carb_mssa': return { cat: mr ? 'R' : 'S', basis: 'inferred' };           // carbapenems inferred from cefoxitin (carbapenem note 1)
    }
  }
  if (iso.group === 'S_pneumoniae') {
    const screenNeg = iso.mic.benzylpenicillin <= bp.benzylpenicillin.s;              // REF eucast_v16_1 (S. pneumoniae note 1/B)
    if (map === 'pn_beta') return { cat: screenNeg ? 'S' : null, basis: screenNeg ? 'inferred' : 'not_tested' };
    if (screenNeg && BETA.has(a.cls)) return { cat: 'S', basis: 'inferred', row: map };
  }
  const row = bp[map]; if (!row) return { cat: null, basis: 'not_tested' };
  const mic = iso.mic[map]; if (mic == null) return { cat: null, basis: 'not_tested' };
  return { cat: interpret(mic, row), basis: 'mic', row: map, mic };
}

/** Rows of the laboratory antibiogram: the MIC rows tested for this isolate plus the agents EUCAST lets the laboratory infer. */
export function antibiogram(iso) {
  const bp = BREAKPOINTS[iso.group], rows = [];
  for (const [k, mic] of Object.entries(iso.mic)) {
    const row = bp[k]; if (!row) continue;
    rows.push({ key: k, mic, s: row.s, r: row.r, cat: interpret(mic, row), bracket: !!row.bracket, screen: !!row.screen, note: row.note || null, atu: row.atu ?? null });
  }
  const inferred = [];
  if (iso.group === 'S_aureus') for (const d of ['amoxicillin', 'amoxiclav', 'flucloxacillin', 'cefazolin', 'ceftriaxone', 'meropenem']) inferred.push({ key: d, cat: categorize(iso, d).cat, inferred: true });
  if (iso.group === 'S_pneumoniae' && iso.mic.benzylpenicillin <= bp.benzylpenicillin.s) for (const d of ['amoxicillin', 'amoxiclav', 'piptazo']) inferred.push({ key: d, cat: 'S', inferred: true });
  return rows.concat(inferred);
}

// ------------------------------------------------------------------ dosing that depends on the body
/** Creatinine clearance by Cockcroft-Gault (mL/min) with actual body weight; creatinine in umol/L. REF cockcroft1976 */
export function cockcroftGault({ age, weightKg, sex }, creatUmol) {
  const scrMgDl = creatUmol / 88.4;                                                  // unit conversion (mg/dL = umol/L / 88.4)
  return ((140 - age) * weightKg * (sex === 'F' ? 0.85 : 1)) / (72 * scrMgDl);
}
/** Text of a prescription: the EUCAST regimen, and the amount in mg for weight-based agents. */
export function doseFor(drug, route, level, body) {
  const a = ABX[drug]; if (!a) return null;
  const d = a.dose[route]; if (!d) return null;
  const txt = d[level] ?? d.std; if (!txt) return null;
  const w = body.weightKg, out = { text: txt, level: d[level] ? level : 'std' };
  if (a.perKg) out.mg = [Math.round(a.perKg[0] * w / 10) * 10, Math.round(a.perKg[1] * w / 10) * 10];          // REF eucast_dosage_v16 (mg/kg, actual body weight)
  if (a.loadingPerKg) out.loadingMg = Math.min(a.loadingMaxMg, Math.round(a.loadingPerKg * w / 250) * 250);    // REF rybak2020 (loading 20-35 mg/kg actual body weight, max 3 g; 20-25 mg/kg when obese)
  return out;
}
/** Initial crystalloid volume for sepsis-induced hypoperfusion: at least 30 mL/kg in the first 3 h. REF ssc2021 */
export const fluidVolumeMl = (body) => Math.round(30 * body.weightKg / 50) * 50;

// ------------------------------------------------------------------ microbiology
export const SAMPLE_KINDS = ['blood', 'urine', 'sputum', 'uag'];
export const WARD_ORDERS = ['labs', 'lactate', 'fluids30', 'remove_line', 'tte', 'renal_us', 'cxr'];
const GRAM = { Enterobacterales: 'gnr', S_aureus: 'gpc_clusters', S_pneumoniae: 'gpdc' };
// Result timing (hours) and test performance below are design values. REF design
const T = { stain: 1, idAfterPos: 18, astAfterPos: 30, urineId: 24, urineAst: 48, negFinal: 120, negPrelim: 24 };
const BC_POS_BURDEN = 0.3;                  // follow-up blood cultures are positive while the burden index is above this (REF design)
const BC_AFTER_ABX = 0.53;                  // sensitivity of blood cultures drawn after the first antibiotic dose, relative to before (REF fabled2019)

// ------------------------------------------------------------------ host course (design values calibrated to targets in tests/infection.test.js)
const KILL_HALF_H = 12;                     // burden half-life on fully active therapy (REF design)
const GROW = 0.06;                          // logistic regrowth rate per hour without active therapy (REF design)
const BMAX = 1.5;                           // burden ceiling (REF design)
const HOST_TAU_H = 24;                      // host response lags the burden (REF design)
const ERADICATE = 0.002;                    // burden below which stopping therapy does not relapse (REF design)
const ORAL_UNSTABLE = 0.6;                  // oral activity when the patient is too sick to absorb reliably (REF design)

/** Clinical stability: temperature <= 37.8 C, HR <= 100, RR <= 24, SBP >= 90, SpO2 >= 90 %, normal mentation, eating. REF metlay2019 */
export function isStable(v) { return v.temp <= 37.8 && v.hr <= 100 && v.rr <= 24 && v.sbp >= 90 && v.spo2 >= 90 && v.alert && v.eating; }

export class Ward {
  /** def: case definition (scenario.ward); body: describeBody(); spec: patient spec; seed: session seed. */
  constructor(def, { body, spec, seed = 1 }) {
    this.def = def; this.body = body; this.spec = spec;
    this.rng = new Rng(((seed ^ 0x5bd1e995) >>> 0) || 11);                          // own stream: never perturbs the physiology streams
    this.h = 0; this.b = def.b0; this.s = def.s0; this.fl = 0;
    this.crp = def.crp0 ?? 120; this.pct = def.pct0 ?? 4; this.creat = def.creat0 ?? 80;
    this.lineIn = !!def.line; this.lineOutH = null;
    this.rx = []; this.courses = []; this.samples = []; this.orders = []; this.labs = [];
    this.firstAbxH = null; this.firstActiveH = null; this.lastActiveH = null; this.activeH = 0;
    this.crit = 0; this.icuH = null; this.stableH = null; this.cured = false; this.relapseH = null; this.obs = [];
    this._record();
  }
  get iso() { return this.def.isolate; }

  // ---------------------------------------------------------------- vitals derived from the host response
  vitals() {
    const s = this.s, d = this.def, fl = this.fl;
    const temp = 36.9 + 2.5 * s + 0.2 * Math.sin((this.h - 6) / 24 * 2 * Math.PI) * s;   // evening peak (REF design)
    const hr = 76 + 48 * s;
    const sbp = (d.sbp0 ?? 128) - 58 * s ** 1.6 + 14 * fl;
    const rr = 15 + 13 * s * (d.lung ? 1.25 : 1);
    const spo2 = 97 - (d.lung ? 12 : 3) * s;
    const lactate = 1.0 + 3.6 * Math.max(0, s - 0.45) / 0.55 - 0.6 * fl * (s > 0.45 ? 1 : 0);
    return { temp: +temp.toFixed(1), hr: Math.round(hr), sbp: Math.round(sbp), dbp: Math.round(0.6 * sbp), rr: Math.round(rr), spo2: Math.round(Math.min(99, spo2)),
      alert: s < 0.7, eating: s < 0.4, lactate: +Math.max(0.6, lactate).toFixed(1) };
  }
  stable() { return isStable(this.vitals()); }
  labPanel() {
    const v = this.vitals();
    return { h: this.h, wbc: +(6.5 + 13 * this.s).toFixed(1), crp: Math.round(this.crp), pct: +this.pct.toFixed(2), lactate: v.lactate, creat: Math.round(this.creat), crcl: Math.round(cockcroftGault(this.spec, this.creat)) };
  }

  // ---------------------------------------------------------------- therapy
  /** fraction of full killing delivered by the current regimen (best single agent). */
  activity() {
    let best = 0;
    for (const r of this.rx) {
      const c = categorize(this.iso, r.drug, r.route).cat;
      let a = c === 'S' ? 1 : c === 'I' ? (r.dose === 'high' ? 1 : 0.5) : 0;          // I = susceptible at increased exposure (REF eucast_sir); standard dose half effect (REF design)
      if (r.route === 'po' && !this.vitals().eating) a *= ORAL_UNSTABLE;
      best = Math.max(best, a);
    }
    return best;
  }
  activeNow() { return this.activity() >= 0.99; }
  start(drug, route, dose) {
    const a = ABX[drug]; if (!a) return { ok: false, error: 'unknown antibiotic' };
    if (!a.routes.includes(route)) return { ok: false, error: `${drug} has no ${route} form here` };
    if (this.rx.some(r => r.drug === drug)) return { ok: false, error: `${drug} is already prescribed` };
    const level = a.dose[route][dose] ? dose : 'std';
    const r = { drug, route, dose: level, startH: this.h, stopH: null };
    this.rx.push(r); this.courses.push(r);
    if (this.firstAbxH === null) this.firstAbxH = this.h;
    this._markActive();
    return { ok: true, dose: doseFor(drug, route, level, this.body), cat: categorize(this.iso, drug, route).cat ?? null };
  }
  stop(drug) {
    const i = this.rx.findIndex(r => r.drug === drug); if (i < 0) return { ok: false, error: `${drug} is not prescribed` };
    this.rx[i].stopH = this.h; this.rx.splice(i, 1); return { ok: true };
  }
  _markActive() { if (this.activeNow()) { if (this.firstActiveH === null) this.firstActiveH = this.h; } }

  // ---------------------------------------------------------------- samples and orders
  sample(kind) {
    const d = this.def, pre = this.firstAbxH === null;
    const rec = { kind, h: this.h, preAbx: pre, positive: false };
    if (kind === 'blood') {
      const followUp = this.samples.some(x => x.kind === 'blood' && x.positive);                  // follow-up sets: positive while the bacteraemia persists
      const bact = this.b > BC_POS_BURDEN && (followUp || d.bacteraemic);
      rec.positive = bact && (pre || followUp || this.rng.chance(BC_AFTER_ABX));
      if (rec.positive) rec.posH = this.h + d.ttpH + 4 * this.rng.next();            // time to positivity (REF design)
    } else if (kind === 'urine' || kind === 'sputum') {
      rec.positive = d.source === kind && (pre || this.b > BC_POS_BURDEN);
      rec.stainPos = d.source === kind && (pre || this.h - this.firstAbxH < 12 || this.b > BC_POS_BURDEN);
    } else if (kind === 'uag') rec.positive = d.isolate.group === 'S_pneumoniae';     // pneumococcal antigen; Legionella antigen negative in every case
    this.samples.push(rec);
    return { ok: true, n: this.samples.length };
  }
  order(what) {
    const rec = { what, h: this.h };
    this.orders.push(rec);
    switch (what) {
      case 'labs': case 'lactate': { const l = this.labPanel(); this.labs.push(l); return { ok: true, labs: l }; }
      case 'fluids30': this.fl = 1; return { ok: true, volumeMl: fluidVolumeMl(this.body) };
      case 'remove_line': if (!this.lineIn) return { ok: false, error: 'no line to remove' }; this.lineIn = false; this.lineOutH = this.h; return { ok: true };
      case 'tte': return { ok: true, finding: this.def.tte ?? 'tte_normal' };
      case 'renal_us': return { ok: true, finding: this.def.renalUs ?? 'us_normal' };
      case 'cxr': return { ok: true, finding: this.def.cxr ?? 'cxr_normal' };
      default: return { ok: false, error: 'unknown order' };
    }
  }
  /** Microbiology reports available now (pure function of the samples and the ward clock). */
  reports() {
    const out = [], g = GRAM[this.iso.group], h = this.h;
    this.samples.forEach((x, i) => {
      const r = { i, kind: x.kind, h: x.h, lines: [] };
      if (x.kind === 'blood') {
        if (x.positive && h >= x.posH) {
          r.lines.push({ k: 'bc_pos', gram: g });
          if (h >= x.posH + T.idAfterPos) r.lines.push({ k: 'id', org: this.iso.name });
          if (h >= x.posH + T.astAfterPos) r.lines.push({ k: 'ast' });
        } else if (!x.positive && h >= x.h + T.negFinal) r.lines.push({ k: 'bc_neg_final' });
        else if (h >= x.h + T.negPrelim) r.lines.push({ k: 'bc_neg_prelim' });
        else r.lines.push({ k: 'pending' });
      } else if (x.kind === 'uag') {
        if (h >= x.h + T.stain) r.lines.push({ k: x.positive ? 'uag_pos' : 'uag_neg' }); else r.lines.push({ k: 'pending' });
      } else {
        if (h >= x.h + T.stain) r.lines.push(x.stainPos ? { k: 'stain', gram: g } : { k: 'stain_neg' }); else r.lines.push({ k: 'pending' });
        if (x.positive) { if (h >= x.h + T.urineId) r.lines.push({ k: 'id', org: this.iso.name }); if (h >= x.h + T.urineAst) r.lines.push({ k: 'ast' }); }
        else if (h >= x.h + 48) r.lines.push({ k: 'cult_neg' });
      }
      out.push(r);
    });
    return out;
  }
  /** first ward hour at which each microbiology milestone was available (null = not yet). */
  milestones() {
    let gram = null, id = null, ast = null, firstPosSampleH = null, clearH = null;
    const min = (a, b) => (a === null ? b : Math.min(a, b));
    for (const x of this.samples) {
      if (!x.positive) continue;
      const t0 = x.kind === 'blood' ? x.posH : x.h + T.stain, ti = x.kind === 'blood' ? x.posH + T.idAfterPos : x.h + T.urineId, ta = x.kind === 'blood' ? x.posH + T.astAfterPos : x.h + T.urineAst;
      if (this.h >= t0) gram = min(gram, t0); if (this.h >= ti) id = min(id, ti); if (this.h >= ta) ast = min(ast, ta);
      if (x.kind === 'blood') firstPosSampleH = min(firstPosSampleH, x.h);
    }
    if (firstPosSampleH !== null) for (const x of this.samples) if (x.kind === 'blood' && !x.positive && x.h > firstPosSampleH && this.h >= x.h + T.negPrelim) { clearH = min(clearH, x.h); }
    return { gram, id, ast, firstPosSampleH, clearH };
  }

  // ---------------------------------------------------------------- time
  advance(hours) { for (let i = 0; i < hours; i++) this._step(); return { ok: true, h: this.h }; }
  _step() {
    const act = this.activity();
    const floor = this.lineIn ? (this.def.lineFloor ?? 0.4) : 0;                     // an infected device keeps seeding the blood (REF design)
    if (act > 0 && this.b > floor) this.b = floor + (this.b - floor) * Math.exp(-act * Math.LN2 / KILL_HALF_H);
    else if (act === 0 && this.b > 0) this.b = Math.min(BMAX, this.b + GROW * this.b * (1 - this.b / BMAX));
    else if (this.b < floor) this.b += 0.1 * (floor - this.b);
    if (act >= 0.99) { this.activeH += 1; this.lastActiveH = this.h + 1; }
    if (this.firstActiveH !== null) this.minB = Math.min(this.minB ?? this.b, this.b);
    if (act === 0 && this.firstActiveH !== null && this.b > 0) {
      if (this.b < ERADICATE && !this.lineIn) { this.b = 0; this.cured = true; }        // eradicated: stopping now does not relapse
      else if (this.relapseH === null && this.minB < 0.05 && this.b > 0.2) this.relapseH = this.h;   // stopped too early: the infection comes back
    }
    this.s = lag(this.s, Math.min(1, this.b), 1, HOST_TAU_H);
    this.fl = this.fl * Math.exp(-1 / 8);                                             // a fluid bolus supports the pressure for hours (REF design)
    this.crp = lag(this.crp, 5 + 300 * this.s, 1, 20);                                 // CRP lags the response by about a day (REF design)
    this.pct = lag(this.pct, 0.05 + 20 * this.s ** 2, 1, 10);                          // procalcitonin falls faster than CRP (REF design)
    this.creat = lag(this.creat, (this.def.creat0 ?? 80) * (1 + 0.9 * Math.max(0, this.s - 0.5)), 1, 24);
    if (this.s > 0.92) this.crit += 1; else this.crit = Math.max(0, this.crit - 0.5);
    if (this.crit >= 6 && this.icuH === null) this.icuH = this.h + 1;                 // sustained shock: transferred to intensive care (REF design)
    this.h += 1;
    if (this.firstActiveH === null && act >= 0.99) this.firstActiveH = this.h - 1;
    if (this.stableH === null && this.stable()) this.stableH = this.h;
    if (this.h % 4 === 0) this._record();
  }
  _record() { const v = this.vitals(); this.obs.push({ h: this.h, ...v }); if (this.obs.length > 200) this.obs.shift(); }
  /** therapy totals: active days, whether therapy is still running, and the stopped-before-cure flag. */
  summary() {
    return { h: this.h, activeDays: this.activeH / 24, onTherapy: this.rx.length > 0, cured: this.b === 0 || this.b < ERADICATE, relapse: this.relapseH !== null, icu: this.icuH !== null };
  }
  hashVec() {
    const rx = this.rx.map(r => ABX_KEYS.indexOf(r.drug) * 10 + (r.route === 'po' ? 1 : 0) + (r.dose === 'high' ? 2 : 0));
    return [this.h, this.b, this.s, this.fl, this.crp, this.pct, this.creat, this.lineIn ? 1 : 0, this.samples.length, this.orders.length, this.rng.state, this.crit, this.activeH, ...rx];
  }
}
