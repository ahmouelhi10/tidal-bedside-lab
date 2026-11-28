// Patient: integrates all physiology modules on a deterministic 0.1 s step and exposes an event-based intervention API.
// Determinism contract: state(t) is a pure function of (patientSpec, seed, scenario, ordered event log). No wall-clock, no Math.random.
import { Rng } from './rng.js';
import { describeBody } from './anthropometrics.js';
import { Circulation } from './cardio.js';
import { Volumes } from './fluids.js';
import { Thermal } from './thermal.js';
import { Respiratory } from './respiratory.js';
import { DrugSystem, DRUGS, IV_TRANSIT_S } from './drugs.js';
import { CprMechanics, Defibrillator, ArrestState } from './cpr.js';
import { RHYTHMS } from './rhythm.js';
import { clamp, lag } from './util.js';
import { Chest, Neck, SITES, fonaPlan } from './surgical.js';
import { EtTube, SEGMENTS } from './ett.js';
import { ABX, SAMPLE_KINDS, WARD_ORDERS } from './infection.js';
import { Pericardium, ECHO_VIEWS, ECHO_MEASURES, ECHO_REPORT, echoState, measureTruth } from './echo.js';
import { Electrolytes } from './electrolytes.js';
import { coagStatus } from './coag.js';
import { TEAM_ACTS, readbackOf } from './team.js';
import { Crises } from './crises.js';
import { Volatile, AGENTS, VAPOURS } from './volatile.js';
import { Ketosis } from './metabolic.js';
import { CALCIUM, CA_MAX_BOLUS_MMOL } from './drugs.js';
import { CA_FULL_SHIELD_MMOL } from './electrolytes.js';
import { Neuraxial } from './neuraxial.js';
import { Ponv } from './ponv.js';
import { FLUID_NA } from './fluids.js';
import { LAB_KINDS, TURNAROUND_S, sampleValues, flags as labFlags } from './labs.js';

export const DT = 0.1;
const AIRWAYS = { none: 1.0, chin_lift: 0.8, jaw_thrust: 0.9, opa: 0.9, sga: 0.95, ett: 1.0 };

/** Every intervention accepted by Patient.dispatch(); the server validates replay logs against this list. */
export const EVENT_TYPES = Object.freeze(['drug.bolus', 'bicarb.bolus', 'drug.infusion', 'drug.stop', 'fluid.bolus', 'blood.transfuse', 'bleed.set', 'bleed.control', 'order', 'airway.set', 'position.set', 'airway.intubate', 'vent.set', 'o2.mask', 'apox.set', 'monitor.attach', 'iv.access', 'nibp.cycle', 'cpr.start', 'cpr.stop', 'cpr.compress', 'cpr.switch', 'cpr.surface', 'defib.pads', 'defib.setEnergy', 'defib.mode', 'defib.charge', 'defib.shock', 'procedure.needle_decompression', 'procedure.chest_tube', 'procedure.cricothyroidotomy', 'exam.chest', 'exam.pocus', 'exam.neck', 'procedure.pericardiocentesis', 'procedure.pci', 'procedure.thrombolysis', 'procedure.treat_hyperkalemia', 'airway.tube_adjust', 'bronch.insert', 'bronch.suction', 'bronch.remove', 'thermal.device', 'thermal.cover', 'thermal.ambient', 'echo.view', 'echo.measure', 'echo.report', 'ward.advance', 'ward.sample', 'ward.rx.start', 'ward.rx.stop', 'ward.order', 'lab.order', 'instructor.inject', 'team.order', 'team.confirm', 'team.correct', 'io.access', 'pacing.set', 'procedure.arterial_line', 'procedure.central_line', 'procedure.ng_tube', 'procedure.urinary_catheter', 'exam.ecg12', 'vaporizer.set', 'n2o.set', 'niv.set', 'procedure.vagal', 'procedure.endoscopy', 'neuraxial.spinal', 'neuraxial.epidural', 'neuraxial.assess', 'equipment.remove', 'note']);
/** What a live instructor can change during a case (event 'instructor.inject'). Each goes through the replay log like any
 *  other event, so a session run with an instructor still replays to the same hash. Clinical course after the change is the
 *  engine's own physiology; the changes themselves are scenario-design choices (REF design). */
/** calcium gluconate carries a third of the calcium of the same mass of calcium chloride (2.2 vs 6.8 mmol/g, REF textbook) */
/** HCO3- lowered by the chloride of 0.9 % saline: ~0.11 mmol/L per mL/kg (60 mL/kg over 2 h -> base excess ~ -6.5, REF scheingraber1999) */
const SALINE_HCO3_PER_MLKG = 0.11;
export const INJECTS = Object.freeze(['vf', 'pea', 'asystole', 'svt', 'af', 'brady', 'avblock3', 'bleed', 'bleed_stop', 'tension_ptx', 'hyperkalaemia', 'airway_obstruction', 'anaphylaxis', 'bronchospasm', 'mh', 'hypoglycaemia', 'torsades', 'flutter', 'avblock1', 'avblock2', 'wenckebach', 'lbbb', 'rbbb', 'bbb_off', 'seizure', 'ecg_wpw', 'ecg_lvh', 'ecg_lahb', 'ecg_nstemi', 'ecg_pericarditis', 'ecg_wellens', 'ecg_bigeminy', 'ecg_clear', 'ponv', 'high_spinal', 'marker']);

const NUMERIC_EVENT_PARAMS = ['amount', 'rate', 'volumeL', 'minutes', 'mlPerMin', 'c', 'factor', 'energy', 'mEq', 'target', 'maxWatts', 'fio2', 'seal', 'eff', 'depth', 'needleMm', 'fr', 'depthCm', 'cm', 'quality', 'value', 'hours', 'percent', 'volumeMl'];

/** The physical envelope of the amounts an event may carry (REF design). Wide enough for any overdose a learner can make with
 *  the dose buttons (an overdose is something to learn from), narrow enough to rule out a sign error or an impossible amount:
 *  without it a negative dose would cancel a real one, and a hand-made log would still replay, verify and be scored.
 *  Bolus: in the drug's own unit (drugs.js); infusion: per minute, a tenth of the bolus ceiling. */
export const BOLUS_MAX = Object.freeze({ mg: 10000, mcg: 100000, units: 100000, mmol: 200, g: 100, mL: 2000 });   // REF design
export const EVENT_RANGES = Object.freeze({                                                                         // REF design
  'fluid.bolus': { volumeL: [0.01, 5], minutes: [0.5, 1440] },
  'bleed.set': { mlPerMin: [0, 2000] },
  'bicarb.bolus': { mEq: [1, 300] },
  'thermal.ambient': { c: [-10, 50] },
  'thermal.cover': { factor: [0.1, 2] },                     // 1 = a sheet, < 1 better insulated (thermal.js)
  'thermal.device': { target: [30, 42], maxWatts: [0, 1000] },
});
function outOfRange(ev) {
  const r = EVENT_RANGES[ev.type]; if (!r) return null;
  for (const [k, [lo, hi]] of Object.entries(r)) if (ev[k] != null && !(ev[k] >= lo && ev[k] <= hi)) return `${k} must be in [${lo}, ${hi}]`;
  return null;
}
function doseOutOfRange(ev) {
  const unit = DRUGS[ev.drug]?.unit; if (!unit || !(unit in BOLUS_MAX)) return null;   // an unknown drug is refused further on
  if (ev.type === 'drug.bolus' && !(ev.amount > 0 && ev.amount <= BOLUS_MAX[unit])) return `amount must be more than 0 and at most ${BOLUS_MAX[unit]} ${unit}`;
  if (ev.type === 'drug.infusion' && !(ev.rate >= 0 && ev.rate <= BOLUS_MAX[unit] / 10)) return `rate must be in [0, ${BOLUS_MAX[unit] / 10}] ${unit}/min`;
  return null;
}

/** Structural validation of nested event payloads (settings/opts/items) so a malformed browser payload cannot inject NaN, strings or unknown flags. */
const VENT_NUM = { rate: [0, 60], vt: [0, 1500], fio2: [0.21, 1], peep: [0, 25], seal: [0, 1] };
const CPR_NUM = { rate: [40, 200], depth: [0, 10] };
const FLAG_KEYS = ['ecgLeads', 'spo2Probe', 'nibp', 'aline', 'capnography', 'tempProbe'];
/** What equipment.remove can take off (skills training starts without the equipment the learner is about to place). */
export const REMOVABLE = Object.freeze(['ivAccess', 'ecgLeads', 'spo2Probe', 'nibp', 'capnography', 'tempProbe', 'padsOn', 'o2']);
function validateEventShape(ev) {
  const isNum = x => typeof x === 'number' && Number.isFinite(x);
  const range = outOfRange(ev) || doseOutOfRange(ev); if (range) return range;
  switch (ev.type) {
    case 'vent.set': {
      const s = ev.settings; if (!s || typeof s !== 'object') return 'settings required';
      for (const [k, v] of Object.entries(s)) {
        if (k === 'mode') { if (!['spont', 'ctrl', 'none'].includes(v)) return 'invalid ventilation mode'; }
        else if (k in VENT_NUM) { if (!isNum(v) || v < VENT_NUM[k][0] || v > VENT_NUM[k][1]) return `invalid ${k}`; }
        else return `unknown ventilator setting ${k}`;
      }
      return null;
    }
    case 'equipment.remove': {
      if (!Array.isArray(ev.items) || ev.items.length > REMOVABLE.length || !ev.items.every(k => REMOVABLE.includes(k))) return 'items must be a list of removable equipment';
      return null;
    }
    case 'monitor.attach': {
      const it = ev.items; if (!it || typeof it !== 'object') return 'items required';
      for (const [k, v] of Object.entries(it)) if (!FLAG_KEYS.includes(k) || typeof v !== 'boolean') return `invalid monitor item ${k}`;
      return null;
    }
    case 'cpr.start': {
      if (ev.mode != null && !['manual', 'auto'].includes(ev.mode)) return 'invalid CPR mode';
      if (ev.surface != null && !['hard', 'soft'].includes(ev.surface)) return 'invalid surface';
      const o = ev.opts; if (o == null) return null; if (typeof o !== 'object') return 'invalid opts';
      for (const [k, v] of Object.entries(o)) {
        if (k === 'ratio') { if (!['30:2', 'continuous'].includes(v)) return 'invalid ratio'; }
        else if (k in CPR_NUM) { if (!isNum(v) || v < CPR_NUM[k][0] || v > CPR_NUM[k][1]) return `invalid ${k}`; }
        else return `unknown CPR option ${k}`;
      }
      return null;
    }
    case 'cpr.compress': return (ev.depth == null || (isNum(ev.depth) && ev.depth >= 0 && ev.depth <= 10)) && (ev.recoil == null || typeof ev.recoil === 'boolean' || (isNum(ev.recoil) && ev.recoil >= 0 && ev.recoil <= 1)) ? null : 'invalid compression';
    case 'cpr.surface': return ['hard', 'soft'].includes(ev.surface) ? null : 'invalid surface';
    case 'defib.mode': return ['async', 'sync'].includes(ev.mode) ? null : 'invalid defibrillator mode';
    case 'blood.transfuse': return ['prbc', 'whole', 'ffp', 'platelets', 'cryo'].includes(ev.kind) ? null : 'invalid blood product';
    case 'position.set': return typeof ev.headUp === 'boolean' ? null : 'headUp must be boolean';
    case 'apox.set': return typeof ev.on === 'boolean' ? null : 'on must be boolean';
    // bedside airway adjuncts only: a tracheal tube is placed by airway.intubate, which checks relaxation, draws success and
    // counts attempts. A replayed log must not reach an intubated patient by naming the device.
    case 'airway.set': return typeof ev.device === 'string' && Object.hasOwn(AIRWAYS, ev.device) && ev.device !== 'ett' ? null : 'invalid airway device (a tracheal tube is placed with airway.intubate)';
    case 'procedure.needle_decompression': {
      if (ev.side != null && !['L', 'R'].includes(ev.side)) return 'invalid side';
      if (ev.site != null && !(ev.site in SITES)) return 'invalid site';
      if (ev.needleMm != null && !(isNum(ev.needleMm) && ev.needleMm >= 20 && ev.needleMm <= 150)) return 'invalid needle length';
      return null;
    }
    case 'procedure.chest_tube': {
      if (!['L', 'R'].includes(ev.side)) return 'side required (L or R)';
      if (ev.fr != null && !(isNum(ev.fr) && ev.fr >= 12 && ev.fr <= 40)) return 'invalid drain size';
      return null;
    }
    case 'procedure.cricothyroidotomy': {
      if (ev.technique != null && !['scalpel_bougie', 'cannula'].includes(ev.technique)) return 'invalid technique';
      if (ev.approach != null && !['palpate', 'vertical'].includes(ev.approach)) return 'invalid approach';
      return null;
    }
    case 'exam.neck': return ev.method == null || ['palpation', 'ultrasound'].includes(ev.method) ? null : 'invalid method';
    case 'airway.intubate': return ev.depthCm == null || (isNum(ev.depthCm) && ev.depthCm >= 12 && ev.depthCm <= 32) ? null : 'invalid tube depth';
    case 'airway.tube_adjust': return isNum(ev.cm) && ev.cm !== 0 && Math.abs(ev.cm) <= 5 ? null : 'cm must be a non-zero number in [-5, 5]';
    case 'bronch.suction': return SEGMENTS.includes(ev.where) ? null : 'invalid suction site';
    case 'order': return typeof ev.what === 'string' && ev.what.length <= 40 ? null : 'invalid order';
    case 'note': return typeof ev.text === 'string' && ev.text.length <= 300 ? null : 'invalid note';
    case 'ward.advance': return Number.isInteger(ev.hours) && ev.hours >= 1 && ev.hours <= 72 ? null : 'hours must be an integer in [1, 72]';
    case 'ward.sample': return SAMPLE_KINDS.includes(ev.kind) ? null : 'invalid sample';
    case 'lab.order': return LAB_KINDS.includes(ev.kind) ? null : 'invalid laboratory test';
    case 'team.order': {
      if (!Number.isInteger(ev.id) || ev.id < 1 || ev.id > 100000) return 'order id must be a positive integer';
      const a = ev.act;
      if (!a || typeof a !== 'object' || Array.isArray(a) || !(a.type in TEAM_ACTS)) return 'this action cannot be ordered to the team';
      for (const k of NUMERIC_EVENT_PARAMS) if (k in a && a[k] != null && !(typeof a[k] === 'number' && Number.isFinite(a[k]))) return `parameter ${k} must be a finite number`;
      return validateEventShape(a);
    }
    case 'team.confirm': case 'team.correct': return Number.isInteger(ev.id) ? null : 'order id must be an integer';
    case 'drug.bolus': if (ev.drug in CALCIUM && !(ev.amount > 0 && ev.amount <= CA_MAX_BOLUS_MMOL)) return `calcium is given in mmol of elemental calcium (at most ${CA_MAX_BOLUS_MMOL} mmol a bolus)`;
      return ev.route == null || (DRUGS[ev.drug]?.routes || ['iv']).includes(ev.route) ? null : 'route not available for this drug';
    case 'vaporizer.set': { const a = ev.agent ?? 'sevoflurane'; return VAPOURS.includes(a) && typeof ev.percent === 'number' && Number.isFinite(ev.percent) && ev.percent >= 0 && ev.percent <= AGENTS[a].maxDial ? null : 'invalid vaporiser setting (sevoflurane 0-8, isoflurane 0-5, desflurane 0-18 %)'; }
    case 'fluid.bolus': return (ev.fluid == null || ['balanced', 'saline', 'saline3', 'glucose5'].includes(ev.fluid)) && !(ev.fluid === 'saline3' && ev.volumeL > 0.5) ? null : 'fluid must be balanced, saline, saline3 (at most 500 mL a bolus) or glucose5';
    case 'niv.set': { if (!['off', 'cpap', 'bipap', 'hfno'].includes(ev.mode)) return 'mode must be off, cpap, bipap or hfno';
      const bad = (k, lo, hi) => ev[k] != null && !(typeof ev[k] === 'number' && Number.isFinite(ev[k]) && ev[k] >= lo && ev[k] <= hi);
      return bad('fio2', 0.21, 1) || bad('epap', 0, 20) || bad('ipap', 0, 30) || bad('flow', 0, 70) || (ev.ipap != null && ev.epap != null && ev.ipap < ev.epap) ? 'invalid NIV / high-flow setting' : null; }
    case 'procedure.vagal': return ev.technique == null || ['standard', 'modified'].includes(ev.technique) ? null : 'technique must be standard or modified';
    case 'neuraxial.spinal': return typeof ev.amount === 'number' && ev.amount >= 2 && ev.amount <= 25 ? null : 'spinal dose: 2-25 mg of hyperbaric bupivacaine 0.5 %';
    case 'neuraxial.epidural': return ev.action === 'test' || (ev.action === 'topup' && typeof ev.volumeMl === 'number' && ev.volumeMl >= 1 && ev.volumeMl <= 25) ? null : 'epidural: action test, or topup with 1-25 mL';
    case 'n2o.set': return typeof ev.percent === 'number' && Number.isFinite(ev.percent) && ev.percent >= 0 && ev.percent <= AGENTS.n2o.maxDial ? null : 'invalid nitrous oxide setting (0-70 %)';
    case 'pacing.set': return typeof ev.on === 'boolean' && (ev.rate == null || (isNum(ev.rate) && ev.rate >= 30 && ev.rate <= 180)) && (ev.mA == null || (isNum(ev.mA) && ev.mA >= 0 && ev.mA <= 200)) ? null : 'pacing: on boolean, rate 30-180, mA 0-200';
    case 'procedure.central_line': return ['ijv', 'scv', 'fem'].includes(ev.site) && (ev.us == null || typeof ev.us === 'boolean') ? null : 'site ijv|scv|fem, us boolean';
    case 'procedure.arterial_line': return ev.us == null || typeof ev.us === 'boolean' ? null : 'us must be boolean';
    case 'instructor.inject': {
      if (!INJECTS.includes(ev.what)) return 'unknown instructor change';
      if (ev.what === 'bleed' && !(isNum(ev.mlPerMin) && ev.mlPerMin >= 20 && ev.mlPerMin <= 1000)) return 'mlPerMin must be in [20, 1000]';
      if (ev.what === 'tension_ptx' && ev.side != null && !['L', 'R'].includes(ev.side)) return 'invalid side';
      if (ev.what === 'marker' && !(typeof ev.text === 'string' && ev.text.length <= 200)) return 'marker text up to 200 characters';
      return null;
    }
    case 'ward.rx.start': {
      if (typeof ev.drug !== 'string' || !Object.hasOwn(ABX, ev.drug)) return 'unknown antibiotic';
      if (!['iv', 'po'].includes(ev.route)) return 'route must be iv or po';
      return ev.dose == null || ['std', 'high'].includes(ev.dose) ? null : 'dose must be std or high';
    }
    case 'ward.rx.stop': return typeof ev.drug === 'string' && Object.hasOwn(ABX, ev.drug) ? null : 'unknown antibiotic';
    case 'ward.order': return WARD_ORDERS.includes(ev.what) ? null : 'invalid ward order';
    case 'echo.view': return ECHO_VIEWS.includes(ev.view) && isNum(ev.quality) && ev.quality >= 0 && ev.quality <= 1 ? null : 'invalid echo view';
    case 'echo.measure': return ECHO_MEASURES.includes(ev.what) && isNum(ev.value) && ev.value >= 0 && ev.value <= 100 ? null : 'invalid echo measurement';
    case 'echo.report': {
      for (const [k, v] of Object.entries(ev)) {
        if (k === 'type') continue;
        if (!(k in ECHO_REPORT)) return `unknown report field ${k}`;
        if (!(v === null || ECHO_REPORT[k].includes(v))) return `invalid ${k}`;
      }
      return null;
    }
    default: return null;
  }
}

export class Patient {
  constructor(spec, { seed = 1, scenario = null, dt = DT } = {}) {
    this.spec = { sex: 'M', age: 50, heightCm: 175, weightKg: 80, ...spec };
    this.seed = seed; this.dt = dt; this.n = 0;
    this.body = describeBody(this.spec);
    this.rng = new Rng(seed);
    this.circ = new Circulation(this.body, { map0: this.spec.map0, hr0: this.spec.hr0 });
    this.vol = new Volumes(this.body);
    this.therm = new Thermal(this.body);
    this.resp = new Respiratory(this.body, { hb: this.vol.hb, vo2Scale: this.spec.vo2Scale, q0: this.circ.CO0 });
    if (this.spec.copd) this.resp.setCopd(this.spec.copd);   // chronic obstructive pulmonary disease (respiratory.js)
    this.niv = null;   // non-invasive ventilation / high-flow nasal oxygen
    this.drugs = new DrugSystem(this.body, { dtSec: dt, propofolModel: this.spec.propofolModel, remiModel: this.spec.remiModel, pseudocholinesterase: this.spec.pseudocholinesterase ?? 1 });
    this.cpr = new CprMechanics(this.body, this.rng);
    this.defib = new Defibrillator(this.body);
    this.arrest = new ArrestState(this.rng, spec?.causes || []);
    this.rhythmBase = this.spec.rhythm || 'NSR';
    this.arrest.key = this.rhythmBase;
    this.airway = { device: 'none', patency: 1, intubated: false };
    this.rngS = new Rng(((seed ^ 0x9e3779b9) >>> 0) || 7);
    this.rngT = new Rng(((seed ^ 0x2545f491) >>> 0) || 11);  // team read-back errors: own stream (team.js)
    this.team = { orders: [] };
    this.oedema = 0; this.pcwp = 8;                    // pulmonary oedema 0..1 and the estimated wedge pressure (cases with spec.congestion)
    this.varix = null;                                 // variceal bleeding: { rate mL/min, controlled } (scenario)
    this.bbb = this.spec.bbb === 'L' || this.spec.bbb === 'R' ? this.spec.bbb : null;
    this.ecgx = Array.isArray(this.spec.ecg) ? this.spec.ecg.filter(k => ['wpw', 'lvh', 'lahb', 'nstemi', 'pericarditis', 'wellens', 'bigeminy'].includes(k)) : [];   // ECG features (clinical.js)   // bundle branch block: 'L', 'R' or none
    this.volatile = new Volatile(this.body); this.drugs.volatile = this.volatile;   // sevoflurane (volatile.js)
    this.crises = new Crises(this.spec, this.body);    // anaphylaxis, bronchospasm, MH, LAST, hypoglycaemia, fibrinolysis, pacing (crises.js)   // separate stream for surgical gestures: never perturbs the main random sequence
    this.chest = new Chest(this.body, this.rngS); this.neck = new Neck(this.body, this.rngS);
    this.tube = new EtTube(this.body);                 // tracheal tube depth, secretions, bronchoscope
    this.ward = null;                                  // infectiology ward course (Ward from infection.js), set by an infectiology scenario's init
    this.hard = null;                                  // difficult-airway case: { ett: P(success) of laryngoscopy, cap: ceiling of upper-airway patency for mask / supraglottic device }
    this.vent = { mode: 'spont', rate: 10, vt: 500, fio2: 0.21, peep: 0, seal: 0.9, efficiency: 1 };
    this.o2 = null;                                    // spontaneous-breathing oxygen device {fio2, seal}
    this.apOx = null;
    this.lv = this.spec.lvFunction ?? 1;               // structural LV function (MI size, cardiomyopathy)
    this.peri = new Pericardium(this.spec.effusionMl ?? 0);   // pericardial effusion (mL); its pressure is transmitted to the heart like an intrathoracic pressure
    this.rvLoad = clamp(this.spec.rvLoad ?? 0, 0, 1);  // acute RV pressure overload (e.g. pulmonary embolism) 0..1
    this.echo = { views: [], measures: [], reports: [] };   // focused echo record (scored; no effect on the physiology)
    this.flags = { padsOn: false, ivAccess: false, ioAccess: false, ecgLeads: false, spo2Probe: false, nibp: false, aline: false, capnography: false, tempProbe: false, cvc: false, ngTube: false, urineCath: false };
    this.timers = { hypoxic: 0, lowMap: 0, hypotensionPostRosc: 0, lowMapRenal: 0 };
    this.arrestTone = 1; this.postRoscTone = 1;
    this.log = []; this.timeline = []; this.scenario = scenario;
    this.stimulus = 0; this.nibp = { sbp: null, dbp: null, t: null }; this.antiarr = 0;
    this.monitor = { hr: 72, spo2: 97, sbp: 114, dbp: 74, map: 87, etco2: 38, rr: 12, temp: 37, rhythm: 'NSR' };
    this.shockLog = []; this.pendingEvents = []; this.notes = []; this.orders = []; this.labs = []; this.bleedControlledAt = null;
    this.bicarbMmol = 0; this.painIndex = 0; this.hrSmooth = 72; this.myoHypox = 0;   // progressive hypoxic myocardial depression 0..1 (design)
    this.keto = new Ketosis(this.spec, this.body);   // ketosis and insulin infusion (metabolic.js)
    this.neuraxial = new Neuraxial(this.body, this.spec);   // spinal / epidural block (neuraxial.js)
    this.ponv = new Ponv(this.spec); this.aspShunt = 0;     // nausea and vomiting (ponv.js); shunt after an aspiration
    if (this.spec.dehydrationL) { const L = clamp(this.spec.dehydrationL, 0, 8); this.vol.vp -= 0.2 * L; this.vol.vi -= 0.6 * L; }   // water and salt deficit: plasma and interstitial share of an extracellular loss (REF design)
    this.lytes = new Electrolytes(this.spec, this.body);   // K+, Na+, ionised Ca2+, glucose (reported; no feedback on the physiology yet)
    if (scenario?.init) scenario.init(this);
    if (this.arrest.causes.hyperkalemia && this.spec.potassium == null) this.lytes.kBase = Math.max(this.lytes.kBase, 7.4);
    if (this.airway.device === 'ett' && !this.tube.placed) this.tube.place();   // a scenario that starts intubated has a well-placed tube
    this.flags0 = { ...this.flags };                   // what the scenario had already in place at t = 0 (scoring credits it; not part of the state hash)
    if (scenario?.timeline) this.timeline = scenario.timeline.map(x => ({ ...x, done: false }));
    this._warm(30 + (scenario?.preRunS ?? 0));
  }
  get t() { return this.n * this.dt; }
  _warm(seconds) { this.warming = true; const steps = Math.round(seconds / this.dt); for (let i = 0; i < steps; i++) this._physio(); this.warming = false; this.n = 0; this.cpr.totalElapsedS = 0; this.cpr.windowLog = []; this.resp.timeS = 0; this.resp.spoBuf = [[0, this.resp.sao2 * 100]]; this.drugs.log = []; }

  // ------------------------------------------------------------------ interventions
  /** Apply an intervention immediately and record it in the replay log. Returns a feedback object. */
  dispatch(ev) {
    const rec = { t: +this.t.toFixed(3), ...ev };
    if (ev.type === 'o2.mask') rec.spo2Before = +this.resp.spo2.toFixed(1);
    this.log.push(rec);
    const r = this._apply(ev);
    // How the engine took it, kept on the record but not enumerable, so the serialised replay log is unchanged:
    // ok (it took effect) and refused (rejected with no effect at all). Scoring counts only actions that were not refused;
    // a failed attempt that still happened (intubating a patient who is not relaxed) is not refused.
    const ok = !(r && r.ok === false);
    Object.defineProperty(rec, 'ok', { value: ok }); Object.defineProperty(rec, 'refused', { value: !ok && !r.attempted });
    return r;
  }
  _apply(ev) {
    // Input contract: every numeric parameter of an event must be a finite number. Malformed events are rejected
    // (and still logged, so a replay rejects them identically) instead of corrupting state with NaN.
    for (const k of NUMERIC_EVENT_PARAMS) {
      if (k in ev && ev[k] != null && !(typeof ev[k] === 'number' && Number.isFinite(ev[k]))) return { ok: false, error: `parameter ${k} must be a finite number` };
    }
    if ((ev.type === 'thermal.ambient' && !Number.isFinite(ev.c)) || (ev.type === 'thermal.cover' && !Number.isFinite(ev.factor)) ||
        (ev.type === 'drug.bolus' && !Number.isFinite(ev.amount)) || (ev.type === 'drug.infusion' && !Number.isFinite(ev.rate)) ||
        (ev.type === 'fluid.bolus' && !Number.isFinite(ev.volumeL)) || (ev.type === 'bleed.set' && !Number.isFinite(ev.mlPerMin)) ||
        (ev.type === 'bicarb.bolus' && !Number.isFinite(ev.mEq))) return { ok: false, error: 'missing or non-numeric required parameter' };
    const bad = validateEventShape(ev); if (bad) return { ok: false, error: bad };
    const t = this.t;
    switch (ev.type) {
      case 'drug.bolus': {
        const d = DRUGS[ev.drug]; if (!d) return { ok: false, error: 'unknown drug' };
        if (ev.drug === 'adenosine') this._adenosine(ev.amount);
        if (ev.drug in CALCIUM) this.lytes.calcium(ev.amount);   // membrane stabilisation against hyperkalaemia; mmol of elemental calcium, either salt
        if (ev.drug === 'potassiumChloride') this.lytes.potassiumMmol(ev.amount);
        if (ev.drug === 'glucagon') this.lytes.glucagonMg(ev.amount);
        if (ev.drug === 'magnesium') this.lytes.magnesiumGrams(ev.amount);
        if (ev.drug === 'naloxone' && ev.amount >= 200) this.arrest.fixCause('toxins');        // opioid reversal is effective at >= 0.2 mg IV (design)
        if (ev.drug === 'amiodarone' || ev.drug === 'lidocaine') this.antiarr = Math.min(1, this.antiarr + (ev.drug === 'amiodarone' ? 0.5 : 0.35));
        if (ev.drug === 'succinylcholine') { this.lytes.succinylcholine(ev.amount / this.body.weightKg); this.crises.exposed('succinylcholine', t); }
        if (ev.drug === 'glucose') this.lytes.glucoseGrams(ev.amount);
        if (ev.drug === 'insulin') this.lytes.insulinUnits(ev.amount);
        this.drugs.bolus(ev.drug, ev.amount, t, ev.route || 'iv'); return { ok: true };
      }
      case 'bicarb.bolus': this.bicarbMmol += ev.mEq / (0.5 * this.body.weightKg); this.drugs.log.push({ t, key: 'sodiumBicarbonate', amount: ev.mEq }); return { ok: true };
      case 'drug.infusion':
        if (ev.drug === 'insulin') { this.keto.setInsulin(ev.rate); return { ok: true }; }        // fixed-rate insulin infusion, U/min
        if (ev.drug === 'glucose') { this.keto.setGlucose(ev.rate); return { ok: true }; }        // glucose infusion, g/min (glucose 10 %: 0.1 g/mL)
        if (DRUGS[ev.drug]?.kind === 'direct') return { ok: false, error: 'no infusion for this drug' };
        this.drugs.infusion(ev.drug, ev.rate); return { ok: true };
      case 'vaporizer.set': this.volatile.set(ev.percent, ev.agent ?? 'sevoflurane'); if (ev.percent > 0) this.crises.exposed('sevoflurane', t); return { ok: true };   // every volatile agent triggers MH
      case 'n2o.set': this.volatile.setN2O(ev.percent); return { ok: true };
      case 'niv.set': this.niv = ev.mode === 'off' ? null : { mode: ev.mode, fio2: ev.fio2 ?? 0.5, epap: ev.mode === 'hfno' ? 0 : ev.epap ?? 5, ipap: ev.mode === 'bipap' ? ev.ipap ?? 15 : ev.epap ?? 5, flow: ev.mode === 'hfno' ? ev.flow ?? 50 : 0 }; return { ok: true };
      case 'drug.stop': if (ev.drug === 'insulin') this.keto.setInsulin(0); else if (ev.drug === 'glucose') this.keto.setGlucose(0); else this.drugs.stop(ev.drug); return { ok: true };
      case 'fluid.bolus': this.vol.startInfusion(ev.volumeL, ev.minutes ?? 15, { saline: 'saline', saline3: 'saline3', glucose5: 'glucose5' }[ev.fluid] || 'crystalloid'); return { ok: true };   // balanced crystalloid unless 0.9 % saline is chosen
      case 'blood.transfuse': this.vol.transfuse(ev.kind); this.lytes.transfuse(); return { ok: true };
      case 'bleed.set': this.vol.setBleed(ev.mlPerMin); return { ok: true };
      case 'bleed.control': if (this.varix && !this.varix.controlled) return { ok: true, note: 'internal bleeding: pressure does not reach it' };
        this.vol.setBleed(0); this.bleedControlledAt = t; this.notes.push({ t, text: 'haemorrhage source controlled' }); return { ok: true };
      case 'lab.order': {                              // the sample freezes the values now; the result is released after the turnaround
        const rec = { id: this.labs.length + 1, kind: ev.kind, t, readyAt: +(t + TURNAROUND_S[ev.kind]).toFixed(1), values: sampleValues(ev.kind, this) };
        rec.flags = labFlags(rec.values, this.spec.sex, this.spec.age); this.labs.push(rec);
        return { ok: true, id: rec.id, readyAt: rec.readyAt, willTakeS: TURNAROUND_S[ev.kind] };
      }
      case 'order': { const rec = { t, what: ev.what, ...(ev.mg != null ? { mg: ev.mg } : {}) }; this.orders.push(rec); return { ok: true, result: this.scenario?.orderResult?.(ev.what, this) ?? null }; }
      case 'airway.set': {
        const d = ev.device;
        if (this.airway.device === 'fona') return { ok: false, error: 'surgical airway in place' };
        this.airway.device = d; this.airway.intubated = d === 'ett'; this.airway.patency = AIRWAYS[d]; if (d !== 'ett') this.tube.remove(); else if (!this.tube.placed) this.tube.place(); return { ok: true };
      }
      case 'position.set': this.headUp = !!ev.headUp; return { ok: true };
      case 'airway.intubate': return this._intubate(ev.depthCm);
      case 'airway.tube_adjust': { if (this.airway.device !== 'ett' || !this.tube.placed) return { ok: false, error: 'no tracheal tube' }; const d = this.tube.adjust(ev.cm); return { ok: true, depthCm: d, ...this.tube.findings() }; }
      case 'bronch.insert': if (this.airway.device !== 'ett' || !this.tube.placed) return { ok: false, error: 'bronchoscopy needs a tracheal tube' }; this.tube.scopeIn = true; return { ok: true, ...this.tube.findings() };
      case 'bronch.suction': return this.tube.suction(ev.where);
      case 'bronch.remove': this.tube.scopeIn = false; return { ok: true };
      case 'vent.set': Object.assign(this.vent, ev.settings); return { ok: true };
      case 'o2.mask': this.o2 = ev.fio2 > 0.21 ? { fio2: ev.fio2, seal: ev.seal ?? 0.9 } : null; return { ok: true };
      case 'apox.set': this.apOx = ev.on ? { fio2: ev.fio2 ?? 1, eff: ev.eff ?? 0.5 } : null; return { ok: true };
      case 'monitor.attach': Object.assign(this.flags, ev.items); return { ok: true };
      case 'iv.access': this.flags.ivAccess = true; return { ok: true };
      case 'nibp.cycle': this.nibp = { sbp: this.circ.sbp + this.rng.normal() * 3, dbp: this.circ.dbp + this.rng.normal() * 2, t, valid: this.arrest.info.perfusing && this.circ.sbp > 50 }; return { ok: true };
      case 'cpr.start': this.cpr.start(ev.mode || 'auto', t, ev.opts || {}); this.cpr.surface = ev.surface || this.cpr.surface; if (ev.ventilation === 'bvm') { this.airway.device = this.airway.device === 'none' ? 'none' : this.airway.device; } return { ok: true };
      case 'cpr.stop': this.cpr.stop(); return { ok: true };
      case 'cpr.compress': this.cpr.compress(t, ev.depth ?? 5.5, ev.recoil ?? true); return { ok: true };
      case 'cpr.switch': this.cpr.switchCompressor(t); return { ok: true };
      case 'cpr.surface': this.cpr.surface = ev.surface; return { ok: true };
      case 'defib.pads': this.flags.padsOn = true; this.defib.padsOn = true; return { ok: true };
      case 'equipment.remove':                                   // equipment off the patient (skills training: the learner places it)
        for (const k of ev.items) { if (k === 'o2') this.o2 = null; else { this.flags[k] = false; if (k === 'padsOn') this.defib.padsOn = false; if (k === 'nibp') this.nibp = { sbp: null, dbp: null, t: null }; } }
        return { ok: true, removed: ev.items.slice() };
      case 'defib.setEnergy': this.defib.setEnergy(ev.energy); return { ok: true };
      case 'defib.mode': this.defib.mode = ev.mode; return { ok: true };
      case 'defib.charge': this.defib.charge(t); return { ok: true, readyAt: this.defib.chargeAt };
      case 'defib.shock': return this._shock();
      case 'procedure.needle_decompression': return this._needle(ev);
      case 'procedure.chest_tube': return this._chestTube(ev);
      case 'procedure.cricothyroidotomy': return this._fona(ev);
      case 'exam.chest': {
        let f = this.chest.findings({ ppv: this._ppv(), rap: this.circ.rap });
        const ms = this.tube.mainstem;                                            // endobronchial tube: the other lung is not ventilated (REF design)
        if (ms) { const o = ms === 'R' ? 'L' : 'R'; f = f.filter(c => c !== 'chest_normal'); for (const c of ['chest_rise_reduced_' + o, 'breath_sounds_reduced_' + o]) if (!f.includes(c) && !f.includes('breath_sounds_absent_' + o)) f.unshift(c); }
        const wd = this.ward?.def;                                                 // pneumonia: crackles over the consolidated lobe while the infection is active (threshold REF design)
        if (wd?.lung && this.ward.s > 0.25) { f = f.filter(c => c !== 'chest_normal'); f.push('crackles_' + (/^cxr_l/.test(wd.cxr || '') ? 'L' : 'R')); }
        return { ok: true, findings: f };
      }
      case 'exam.pocus': return { ok: true, ...this.chest.pocus() };
      case 'exam.neck': return this._examNeck(ev);
      case 'procedure.pericardiocentesis': { this.arrest.fixCause('tamponade'); const ml = this.peri.drain(); if (ml > 1) this.notes.push({ t, text: `pericardiocentesis: ${Math.round(ml)} mL drained` }); return { ok: true, drainedMl: Math.round(ml) }; }
      case 'echo.view': { const s = echoState(this); this.echo.views.push({ t, view: ev.view, quality: ev.quality }); return { ok: true, findings: s }; }
      case 'echo.measure': { const s = echoState(this); this.echo.measures.push({ t, what: ev.what, value: ev.value, truth: measureTruth(s, ev.what) }); return { ok: true }; }
      case 'echo.report': { const { type, ...r } = ev; this.echo.reports.push({ t, ...r, state: echoState(this) }); return { ok: true }; }
      case 'procedure.pci': this.arrest.fixCause('coronary_thrombosis'); this.notes.push({ t, text: 'reperfusion' }); return { ok: true };
      case 'procedure.thrombolysis': this.arrest.fixCause('pulmonary_embolism'); this.arrest.fixCause('coronary_thrombosis'); return { ok: true };
      case 'instructor.inject': return this._inject(ev, t);
      case 'io.access': this.flags.ioAccess = true; this.flags.ivAccess = true; this.notes.push({ t, text: 'intraosseous access' }); return { ok: true };   // drugs given IO reach the circulation like IV (REF erc2025)
      case 'pacing.set': {
        if (ev.on && !this.flags.padsOn) return { ok: false, error: 'pads first' };
        Object.assign(this.crises.pace, { on: ev.on, rate: ev.rate ?? this.crises.pace.rate, mA: ev.mA ?? this.crises.pace.mA });
        return { ok: true, threshold: undefined };
      }
      case 'procedure.arterial_line': {                                // ultrasound raises first-pass success (REF gu2016); time REF design
        const ok = this.rngS.chance(ev.us ? 0.9 : 0.65);
        this.pendingEvents.push({ at: t + (ev.us ? 120 : 180), run: p => { if (ok) { p.flags.aline = true; p.notes.push({ t: p.t, text: 'arterial line in place' }); } else p.notes.push({ t: p.t, text: 'arterial line: failed attempt' }); } });
        return { ok: true, willTakeS: ev.us ? 120 : 180 };
      }
      case 'procedure.central_line': {                                 // pneumothorax: subclavian 1.5-3 %, jugular ~0.1-0.2 %, femoral none; ultrasound lowers it (REF mcgee2003)
        const risk = { scv: 0.025, ijv: 0.002, fem: 0 }[ev.site] * (ev.us ? 0.3 : 1), ptx = this.rngS.chance(risk);
        this.pendingEvents.push({ at: t + 600, run: p => { p.flags.cvc = true; p.notes.push({ t: p.t, text: `central line (${ev.site}) in place` }); if (ptx && !p.chest.side) { p.chest.setPneumothorax({ side: 'R', air: 0.15, valve: false }); p.notes.push({ t: p.t, text: 'complication: pneumothorax' }); } } });
        return { ok: true, willTakeS: 600 };
      }
      case 'procedure.vagal': {                        // Valsalva: converts re-entrant SVT in ~17 %, the modified manoeuvre (leg raise after the strain) in ~43 % (REF appelboam2015)
        const mod = ev.technique !== 'standard';
        if (this.arrest.key === 'SVT' && this.rng.chance(mod ? 0.43 : 0.17)) { this.arrest.setRhythm('NSR', t); this.notes.push({ t, text: 'SVT converted by a vagal manoeuvre' }); return { ok: true, converted: true }; }
        return { ok: true, converted: false };
      }
      case 'neuraxial.spinal': {                      // hyperbaric bupivacaine 0.5 % intrathecally (REF hocking2004)
        if (this.neuraxial.kind === 'spinal') return { ok: false, error: 'a spinal has already been given' };
        const spread = (this.rng.next() - 0.5) * 4;   // patient-to-patient spread +/- 2 segments
        this.neuraxial.spinal(ev.amount, t, { headUp: !!this.headUp, spread }); this.notes.push({ t, text: `spinal: bupivacaine ${ev.amount} mg` });
        return { ok: true, peak: this.neuraxial.target };
      }
      case 'neuraxial.epidural': {                    // through the catheter; where it really lies decides what happens (REF guay2006)
        const where = this.neuraxial.catheter ?? 'epidural';
        if (ev.action === 'test') {                   // lidocaine 60 mg with epinephrine 15 mcg
          if (where === 'intravascular') { this.drugs.bolus('epinephrine', 15, t); this.drugs.bolus('lidocaine', 60, t); }
          else if (where === 'intrathecal') this.neuraxial._start('spinal', this.neuraxial.spinalTarget(7), 1.5, t, 0.4);
          return { ok: true };
        }
        const mg = 5 * ev.volumeMl;                   // bupivacaine 0.5 %
        if (where === 'intravascular') this.drugs.bolus('bupivacaine', mg, t);
        else if (where === 'intrathecal') this.neuraxial._start('spinal', this.neuraxial.spinalTarget(mg), 1.2, t);
        else { this.neuraxial.epidural(ev.volumeMl, t); this.drugs.bolus('bupivacaine', mg, t, 'regional'); }
        this.notes.push({ t, text: `epidural top-up ${ev.volumeMl} mL bupivacaine 0.5 %` });
        return { ok: true };
      }
      case 'neuraxial.assess': return { ok: true, sensory: this.neuraxial.sensory, bromage: this.neuraxial.bromage };   // cold / pinprick and leg movement
      case 'procedure.endoscopy': {                    // endoscopic band ligation: controls variceal bleeding in ~90 % (REF baveno7; REF design)
        if (!this.varix || this.varix.controlled) return { ok: true, controlled: false, note: 'no variceal bleeding' };
        const ok = this.rng.chance(0.9); if (ok) { this.varix.controlled = true; this.vol.setBleed(0); this.bleedControlledAt = t; this.notes.push({ t, text: 'varices banded: bleeding controlled' }); }
        return { ok: true, controlled: ok };
      }
      case 'procedure.ng_tube': this.flags.ngTube = true; this.notes.push({ t, text: 'nasogastric tube' }); return { ok: true };
      case 'procedure.urinary_catheter': this.flags.urineCath = true; this.urine0 = this.vol.urine + this.vol.urineBasal; this.urineT0 = t; return { ok: true };
      case 'exam.ecg12': return { ok: true };
      case 'team.order': {                                             // the team member reads the order back (team.js)
        if (this.team.orders.some(o => o.id === ev.id)) return { ok: false, error: 'duplicate order id' };
        const rb = readbackOf(ev.act, this.rngT);
        this.team.orders.push({ id: ev.id, t, role: TEAM_ACTS[ev.act.type], act: ev.act, readback: rb.act, error: rb.error, corrected: false, status: 'pending' });
        return { ok: true, readback: rb.act, role: TEAM_ACTS[ev.act.type] };
      }
      case 'team.correct': {
        const o = this.team.orders.find(x => x.id === ev.id && x.status === 'pending'); if (!o) return { ok: false, error: 'no pending order' };
        if (o.error) o.corrected = true;
        o.readback = o.act; o.error = false; return { ok: true, readback: o.act };
      }
      case 'team.confirm': {
        const o = this.team.orders.find(x => x.id === ev.id && x.status === 'pending'); if (!o) return { ok: false, error: 'no pending order' };
        o.status = o.error ? 'accepted_error' : 'confirmed'; o.tConfirm = t;
        return { ok: true, act: o.readback };                         // the client now carries out exactly what was read back
      }
      case 'procedure.treat_hyperkalemia': this.lytes.calcium(CA_FULL_SHIELD_MMOL); this.lytes.insulinGlucose(); if (this.lytes.kEff < 6.5) this.arrest.fixCause('hyperkalemia'); return { ok: true };   // calcium 1 g + insulin 10 U with glucose 25 g
      case 'thermal.device': this.therm.setDevice(ev.target == null ? null : { targetC: ev.target, maxWatts: ev.maxWatts ?? 300 }); return { ok: true };
      case 'thermal.cover': this.therm.cover = ev.factor; return { ok: true };
      case 'thermal.ambient': this.therm.setAmbient(ev.c); return { ok: true };
      case 'note': this.notes.push({ t, text: ev.text }); return { ok: true };
      case 'ward.advance': case 'ward.sample': case 'ward.rx.start': case 'ward.rx.stop': case 'ward.order': return this._ward(ev);
      default: return { ok: false, error: 'unknown event ' + ev.type };
    }
  }
  /** Infectiology ward course (only in cases that define one): the ward has its own clock in hours. */
  _ward(ev) {
    const w = this.ward; if (!w) return { ok: false, error: 'no ward course in this case' };
    switch (ev.type) {
      case 'ward.advance': return w.advance(ev.hours);
      case 'ward.sample': return w.sample(ev.kind);
      case 'ward.rx.start': return w.start(ev.drug, ev.route, ev.dose ?? 'std');
      case 'ward.rx.stop': return w.stop(ev.drug);
      case 'ward.order': return w.order(ev.what);
    }
    return { ok: false };
  }
  _ppv() { return this.vent.mode === 'ctrl' && !this.airway.intubating; }
  /** needle thoracostomy. With no parameters (older clients, scripted cases) an ideal catheter is placed on the affected side. */
  _needle(ev) {
    const t = this.t;
    if (ev.side == null && ev.site == null && ev.needleMm == null) {
      this.arrest.fixCause('tension_ptx'); this.chest.relieveIdeal(t);
      this.notes.push({ t, text: 'needle decompression' }); return { ok: true };
    }
    const side = ev.side ?? this.chest.side ?? 'R', site = ev.site ?? 'mcl2', needleMm = ev.needleMm ?? 50;
    const r = this.chest.decompress(t, { side, site, needleMm });
    if (r.relieved) this.arrest.fixCause('tension_ptx');
    this.notes.push({ t, text: `needle decompression ${side} ${site} ${needleMm} mm: ${r.reached ? (r.relieved ? 'air released' : 'pleura reached, no air') : 'did not reach the pleural space'}` });
    return { ok: true, ...r };
  }
  _chestTube(ev) {
    const t = this.t, side = ev.side, fr = ev.fr ?? 28;
    if (this.chest.tubeBusy) return { ok: false, error: 'chest drain insertion in progress' };
    if (this.chest.tube && this.chest.tube.side === side) return { ok: false, error: 'a drain is already in place on this side' };
    const obes = clamp((this.body.bmi - 30) / 20, 0, 1);
    const dur = (120 + 60 * this.rngS.next()) * (1 + 0.3 * obes);                     // minimal-access thoracostomy + drain: 2-3 min (design)
    this.chest.tubeBusy = true;
    this.pendingEvents.push({ at: t + dur, run: p => {
      const tube = p.chest.insertTube(p.t, { side, fr });
      if (tube.ok) p.arrest.fixCause('tension_ptx');
      p.notes.push({ t: p.t, text: `chest drain ${fr} Fr ${side}: ${tube.malposition ? 'malpositioned' : tube.ok ? 'in the pleural space, draining' : 'no air on this side'}` });
    } });
    this.notes.push({ t, text: `chest drain started (${side}, ${fr} Fr)` });
    return { ok: true, willTakeS: +dur.toFixed(1) };
  }
  _examNeck(ev) {
    const method = ev.method ?? 'palpation';
    if (method !== 'ultrasound') return { ok: true, ...this.neck.exam('palpation') };
    if (this.airway.intubating) return { ok: false, error: 'busy with another airway procedure' };
    this.airway.intubating = true;                                                    // 30 s with the hands off the airway (REF lavelle2021: ultrasound is slower than palpation)
    this.pendingEvents.push({ at: this.t + 30, run: p => { p.airway.intubating = false; p.neck.marked = true; p.notes.push({ t: p.t, text: 'cricothyroid membrane marked by ultrasound' }); } });
    return { ok: true, willTakeS: 30, ...this.neck.exam('ultrasound') };
  }
  /** emergency front-of-neck access. The outcome is drawn now (separate stream) and revealed after the procedure time. */
  _fona(ev) {
    const t = this.t, technique = ev.technique ?? 'scalpel_bougie', approach = ev.approach ?? 'palpate';
    if (this.airway.intubating) return { ok: false, error: 'attempt in progress' };
    if (this.airway.intubated) return { ok: false, error: 'airway already secured' };
    const plan = fonaPlan(this.neck, technique, approach, this.body, this.rngS);
    const ok = this.rngS.chance(plan.p);
    this.airway.intubating = true;
    this.pendingEvents.push({ at: t + plan.dur, run: p => {
      p.airway.intubating = false;
      p.neck.attempts.push({ t: p.t, technique, approach, ok, startT: t });
      if (ok && technique === 'scalpel_bougie') {
        p.neck.fona = { kind: 'tube', t: p.t }; p.airway.device = 'fona'; p.airway.intubated = true; p.airway.patency = 1; p.airway.cannula = null;
        p.notes.push({ t: p.t, text: 'surgical airway: cuffed tube in the trachea' });
      } else if (ok) {
        p.neck.fona = { kind: 'cannula', t: p.t, displaced: false }; p.airway.cannula = p.neck.fona;
        p.notes.push({ t: p.t, text: 'cannula in the trachea (narrow bore: low ventilation efficiency)' });
      } else p.notes.push({ t: p.t, text: `front-of-neck access failed (${technique}, ${approach}): false passage or membrane not found` });
    } });
    this.notes.push({ t, text: `front-of-neck access started (${technique}, ${approach})` });
    return { ok: true, willTakeS: +plan.dur.toFixed(1) };
  }
  _intubate(depthCm) {
    if (this.airway.intubating) return { ok: false, error: 'attempt in progress' };
    if (this.airway.device === 'fona') return { ok: false, error: 'surgical airway in place' };
    const eff = this.drugs.effects({ inArrest: this.arrest.arrested });
    const t = this.t, relaxed = (eff.loc && eff.nmb > 0.9) || this.arrest.arrested;
    if (!relaxed) { this.notes.push({ t, text: 'intubation attempted on a patient who is not paralysed/unconscious' }); this.failedAttempts = (this.failedAttempts || 0) + 1; return { ok: false, attempted: true, error: 'patient not relaxed: laryngospasm / bucking' }; }
    const obes = clamp((this.body.bmi - 30) / 20, 0, 1), pOk = Math.min(clamp(0.92 - 0.18 * obes - 0.05 * (this.headUp ? -1 : 0), 0.4, 0.97), this.hard?.ett ?? 1);
    const dur = 22 + 8 * this.rng.next() + 8 * obes;
    this.airway.intubating = true; this.attempts = (this.attempts || 0) + 1;
    const ok = this.rng.chance(pOk);
    this.pendingEvents.push({ at: t + dur, run: p => { p.airway.intubating = false; if (ok) { p.airway.device = 'ett'; p.airway.intubated = true; p.airway.patency = 1; p.tube.place(depthCm); p.notes.push({ t: p.t, text: `intubated, tube at ${p.tube.depth} cm` }); } else { p.failedAttempts = (p.failedAttempts || 0) + 1; p.notes.push({ t: p.t, text: 'intubation attempt failed' }); } } });
    return { ok: true, willTakeS: +dur.toFixed(1), success: ok };
  }
  _adenosine(mg) {
    // First-pass effect at the AV node once the bolus reaches the heart: 17.5 +/- 1.0 s after an antecubital injection (REF ng1999),
    // about 20 s in healthy volunteers, lasting < 10 s (REF watt1986). The 2.5 s response after arrival and the block length (4 s in sinus rhythm, 6 s of asystole on SVT conversion) are design.
    const at = this.t + IV_TRANSIT_S + 2.5;
    if (['SVT'].includes(this.arrest.key) && mg >= 6 && this.rng.chance(mg >= 12 ? 0.9 : 0.7)) {
      this.pendingEvents.push({ at, run: p => { if (p.arrest.key === 'SVT') p.arrest.setRhythm('ASYSTOLE', p.t); } });
      this.pendingEvents.push({ at: at + 6, run: p => { if (p.arrest.key === 'ASYSTOLE' && !p.arrest.arrested) p.arrest.setRhythm('NSR', p.t); } });
      this.brief = true;
    } else if (this.arrest.key === 'FLUTTER' && mg >= 6) {
      // flutter: adenosine does not convert it, it slows the ventricles for seconds and unmasks the flutter waves (REF textbook)
      this.pendingEvents.push({ at, run: p => { p.flutterBlockUntil = p.t + 8; } });
    } else if (['NSR', 'SINUS_BRADY', 'SINUS_TACH'].includes(this.arrest.key) && mg >= 6) {
      // sinus rhythm: short-lasting high-grade AV block (REF label_adenosine "first-, second- or third-degree heart block"), then back
      const before = this.arrest.key;
      this.pendingEvents.push({ at, run: p => { if (p.arrest.key === before) p.arrest.setRhythm('AV_BLOCK3', p.t); } });
      this.pendingEvents.push({ at: at + 4, run: p => { if (p.arrest.key === 'AV_BLOCK3') p.arrest.setRhythm(before, p.t); } });
    }
  }
  _shock() {
    const t = this.t, d = this.defib;
    if (!d.padsOn) return { ok: false, error: 'no pads' };
    if (!d.charged) return { ok: false, error: 'not charged' };
    d.charged = false; d.chargeAt = null;
    const syncOk = d.mode !== 'sync' || this.arrest.info.perfusing;
    this.cpr.events = [];                                  // pause for shock: compressions restart explicitly (auto mode resumes at next scheduled beat)
    const rec = { t, energy: d.energy, mode: d.mode, rhythmBefore: this.arrest.key };
    let res = { ok: true, delivered: true };
    if (this.arrest.arrested) {
      const out = this.arrest.shock(d.energy, d.impedance, { antiarr: this.antiarr });
      Object.assign(res, out);
      if (out.terminated && out.rosc) { this._rosc(); }
      else if (out.terminated) { this.arrest.setRhythm(this.rng.chance(0.55) ? 'PEA' : 'ASYSTOLE', t); }
    } else if (this.arrest.info.perfusing && ['VT_PULSE', 'SVT', 'AF', 'FLUTTER'].includes(this.arrest.key) && d.mode === 'sync') {
      const p = this.arrest.key === 'AF' ? (d.energy >= 200 ? 0.85 : 0.6) : this.arrest.key === 'FLUTTER' ? (d.energy >= 70 ? 0.9 : 0.7) : (d.energy >= 100 ? 0.85 : 0.6);   // flutter converts at lower energy (REF erc2025: 70-120 J)   // REF aha2025_part9 (AF >= 200 J)
      if (this.rng.chance(p)) { this.arrest.setRhythm('NSR', t); res.converted = true; } else res.converted = false;
    } else if (this.arrest.info.perfusing && d.mode === 'async') {
      // shock on a perfusing rhythm can induce VF (R-on-T); design probability, mostly for scoring
      if (this.rng.chance(0.08)) { this.arrest.arrest('VF', t); res.induced = 'VF'; }
    }
    rec.result = { terminated: res.terminated, rosc: res.rosc, converted: res.converted }; rec.syncOk = syncOk;
    this.shockLog.push(rec);
    if (this.cpr.mode === 'auto') this.cpr.auto.next = t + 1.0;   // resume compressions ~1 s after the shock
    return res;
  }
  /** A live instructor's change to the case (see INJECTS). */
  _inject(ev, t) {
    switch (ev.what) {
      case 'vf': case 'pea': case 'asystole': this.arrest.arrest({ vf: 'VF', pea: 'PEA', asystole: 'ASYSTOLE' }[ev.what], t); break;
      case 'svt': case 'af': if (this.arrest.arrested) return { ok: false, error: 'patient in cardiac arrest' }; this.arrest.setRhythm(ev.what === 'svt' ? 'SVT' : 'AF', t); break;
      case 'bleed': this.vol.setBleed(ev.mlPerMin); this.bleedControlledAt = null; break;
      case 'bleed_stop': this.vol.setBleed(0); break;
      case 'tension_ptx': if (this.chest.side) return { ok: false, error: 'a pneumothorax is already present' }; this.chest.setPneumothorax({ side: ev.side || 'R', air: 0.35, valve: true }); break;
      case 'brady': if (this.arrest.arrested) return { ok: false, error: 'patient in cardiac arrest' }; this.arrest.setRhythm('SINUS_BRADY', t); break;
      case 'flutter': case 'avblock1': case 'avblock2': case 'wenckebach': if (this.arrest.arrested) return { ok: false, error: 'patient in cardiac arrest' }; this.arrest.setRhythm({ flutter: 'FLUTTER', avblock1: 'AV_BLOCK1', avblock2: 'AV_BLOCK2', wenckebach: 'AV_BLOCK2W' }[ev.what], t); break;
      case 'lbbb': case 'rbbb': this.bbb = ev.what === 'lbbb' ? 'L' : 'R'; break;   // a conduction defect under any supraventricular rhythm
      case 'bbb_off': this.bbb = null; break;
      case 'ecg_clear': this.ecgx = []; break;
      case 'ecg_wpw': case 'ecg_lvh': case 'ecg_lahb': case 'ecg_nstemi': case 'ecg_pericarditis': case 'ecg_wellens': case 'ecg_bigeminy': { const k = ev.what.slice(4); if (!this.ecgx.includes(k)) this.ecgx.push(k); break; }
      case 'avblock3': if (this.arrest.arrested) return { ok: false, error: 'patient in cardiac arrest' }; this.arrest.setRhythm('AV_BLOCK3', t); break;
      case 'anaphylaxis': case 'bronchospasm': case 'mh': case 'seizure': this.crises.trigger(ev.what, t); break;
      case 'hypoglycaemia': this.lytes.gluBase = Math.min(this.lytes.gluBase, 1.8); break;
      case 'hyperkalaemia': this.lytes.kBase = Math.max(this.lytes.kBase, 7.4); if (this.arrest.arrested) this.arrest.causes.hyperkalemia = true; break;
      case 'airway_obstruction': this.airway.patency = Math.min(this.airway.patency, 0.15); break;
      case 'torsades': this.crises.qtDrug = Math.max(this.crises.qtDrug, 140); this.arrest.arrest('TORSADES', t); break;   // long-QT substrate so it can recur
      case 'ponv': this.ponv.extra = 0.9; break;
      case 'high_spinal': this.neuraxial._start('spinal', 1, 1.5, t); break;   // total spinal
      case 'marker': break;
    }
    this.notes.push({ t, text: 'instructor: ' + (ev.what === 'marker' ? ev.text : ev.what) });
    return { ok: true };
  }
  _rosc() { this.arrest.rosc(this.t); this.postRoscTone = 0.65; this.lv = Math.min(this.lv, 0.9); this.cpr.stop(); this.cpr.events = []; this.timers.lowMap = 0; this.timers.hypoxic = 0; }

  // ------------------------------------------------------------------ physiology
  _physio() {
    const dt = this.dt, t = this.t, info = this.arrest.info, arrested = this.arrest.arrested;
    // timeline + deferred events (not during the pre-simulation warm-up)
    if (!this.warming) for (const e of this.timeline) if (!e.done && t >= e.t) { e.done = true; e.run(this); }
    if (!this.warming) for (let i = this.pendingEvents.length - 1; i >= 0; i--) if (t >= this.pendingEvents[i].at) { const e = this.pendingEvents.splice(i, 1)[0]; e.run(this); }
    this.defib.tick(t);
    this.antiarr = Math.max(0, this.antiarr - dt / 1800);
    // drugs
    this.drugs.step();
    const eff = this.drugs.effects({ inArrest: arrested });
    const paralyzed = eff.paralyzed;
    const cx = this.crises.step(dt, { drugs: this.drugs, lytes: this.lytes, map: this.circ.mapArt, bleeding: this.vol.rates.bleed, t, paralyzedOrArrest: paralyzed || arrested, rhythm: this.arrest.key, perfusing: info.perfusing, hr: this.circ.hr, volatileMac: this.volatile.macFrac, arrested });
    eff.fx = { ...eff.fx, svr: eff.fx.svr * cx.svr, ven: eff.fx.ven + cx.ven, inotropy: eff.fx.inotropy * cx.inot, hrAdd: eff.fx.hrAdd + cx.hrAdd };
    // neuraxial block: sympathetic block, cardioaccelerator fibres, respiratory muscles (neuraxial.js)
    const nx = this.neuraxial.step(dt, { t, rap: this.circ.rap });
    const shiv = this.therm.shivering;                 // shivering: sympathetic activation (REF sessler2016; size REF design)
    eff.fx = { ...eff.fx, svr: eff.fx.svr * nx.svr, ven: eff.fx.ven + nx.ven, baro: (eff.fx.baro ?? 1) * nx.baro, baroHr: (eff.fx.baroHr ?? 1) * nx.baroHr, chrono: (eff.fx.chrono ?? 1) * nx.chrono, hrAdd: eff.fx.hrAdd + nx.hrAdd + 12 * shiv };
    const anesth = eff.loc || cx.loc || nx.loc;
    if (cx.leakLpm > 0) { const l = Math.min(cx.leakLpm * dt / 60, this.vol.vp * 0.01); this.vol.vp -= l; this.vol.vi += l; }   // capillary leak into the tissues
    if (cx.fibLossPerMin > 0) this.vol.fibAmt *= 1 - cx.fibLossPerMin * dt / 60;
    this.vol.hepFn = this.crises.heparinEffect(this.drugs).fnMult;
    if (this.circ.mapArt < 65) this.timers.lowMapRenal += dt;            // renal hypoperfusion time (clinical.js)
    // CPR
    this.cpr.step(dt, t, arrested);
    // arrest sympathetic surge then decline (design)
    if (arrested) this.arrestTone = lag(this.arrestTone, this.arrest.tArrest < 1200 ? 1.8 : 1.0, dt, 60);
    else this.arrestTone = lag(this.arrestTone, 1, dt, 30);
    this.postRoscTone = lag(this.postRoscTone, 1, dt, 420);
    this.arrest.lvStun = Math.max(0, this.arrest.lvStun - dt / 1800);
    // myocardial function: hypoxia, acidosis, post-ROSC stunning
    const pH = this.resp.pH, sat = this.resp.sao2;
    const lvAcid = pH >= 7.1 ? 1 : clamp(1 - 0.5 * (7.1 - pH) / 0.3, 0.5, 1);
    // hypoxic myocardial depression accumulates over minutes below SaO2 ~60% (severity-weighted) and clears slowly after reoxygenation (REF design)
    if (sat < 0.6) this.myoHypox = Math.min(1, this.myoHypox + dt * ((0.6 - sat) / 0.6) / 120);
    else if (sat > 0.75) this.myoHypox = Math.max(0, this.myoHypox - dt / 600);
    const lvHyp = 1 - 0.85 * this.myoHypox;
    const lvNow = clamp(this.lv * lvAcid * lvHyp * (1 - this.arrest.lvStun), 0.05, 1.3);
    // rhythm-specific rate
    let rate = null;
    const hrAdd = eff.fx.hrAdd;
    switch (this.arrest.key) {
      case 'SINUS_BRADY': rate = clamp(42 + hrAdd * 0.9, 20, 110); break;
      case 'SVT': rate = 178 * (1 - 0.3 * (eff.fx.avSlow || 0)); break; case 'VT_PULSE': rate = 168; break; case 'AF': rate = (125 + hrAdd * 0.3) * (1 - (eff.fx.avSlow || 0)); break;   // beta-blockers slow AV conduction (REF esc_af2024; size REF design)
      case 'AV_BLOCK3': rate = 34 + (eff.fx.escape || 0); break;
      case 'FLUTTER': rate = t < (this.flutterBlockUntil ?? -1) ? 50 : clamp(150 / (1 + 1.4 * (eff.fx.avSlow || 0)), 60, 150); break;   // atrial ~300/min with 2:1 conduction; AV-nodal drugs raise the block to 3:1-4:1, adenosine briefly more (REF esc_af2024, textbook)
      case 'AV_BLOCK2': rate = clamp((78 + hrAdd * 0.8) / 2, 30, 70); break;
      case 'AV_BLOCK2W': rate = clamp((78 + hrAdd * 0.9) * (0.75 + 0.2 * clamp(hrAdd / 40, 0, 1)), 35, 120); break;   // Wenckebach 4:3 at the AV node: three of four P waves conducted; atropine and beta agonists improve nodal conduction (REF erc2025, textbook)   // Mobitz II 2:1: half the sinus rate; the block is below the AV node, so atropine helps little (REF erc2025)     // ventricular escape ~30-40/min (REF textbook), sped up by beta agonists
    }
    if (this.crises.captured && rate !== null ? rate < this.crises.pace.rate : this.crises.captured && this.circ.hr < this.crises.pace.rate) rate = this.crises.pace.rate;   // electrical capture: the paced rate replaces a slower rhythm
    const cprActive = arrested ? this.cpr.flow * this.chest.cprMult : 0;
    this.chest.step(dt, { ppv: this._ppv(), peep: this.vent.peep }, t);
    const ctx = {
      itp: this.chest.itp + this.peri.pressure,          // a pericardial effusion compresses the heart like a raised surrounding pressure (REF design)
      rhythm: { perfusing: info.perfusing, rate },
      bloodVolume: this.vol.bloodVolume,
      fx: eff.fx, lvFunction: lvNow * this.chest.pumpMult, tempC: this.therm.tc, rvShift: 14 * this.rvLoad,   // a pressure-overloaded RV limits LV filling (REF design)
      cprFlow: cprActive, cprAmp: this.cpr.amp, arrestTone: this.arrestTone, svrTone: this.postRoscTone,
    };
    // pressure support: the exact bleeding / volume loads enter through vol
    this.circ.step(dt, ctx);
    if (this.varix && !this.varix.controlled && !this.warming) {
      // variceal bleeding follows the portal pressure: terlipressin lowers it (splanchnic vasoconstriction), over-transfusion and
      // over-filling raise it (REF baveno7, villanueva2013; sizes REF design); it slows as the arterial pressure falls
      const terli = this.drugs.ce('terlipressin'), tEff = terli > 0 ? 1 / (1 + Math.pow(0.02 / terli, 1.5)) : 0;
      const over = 1 + 0.9 * clamp((this.vol.bloodVolume / this.circ.BV0 - 1) / 0.15, 0, 1);   // filled above the starting blood volume: portal pressure and bleeding rise
      this.vol.setBleed(this.varix.rate * (1 - 0.6 * tEff) * over * clamp(this.circ.mapArt / 70, 0.2, 1.2));
    }
    if (this.spec.congestion) {
      // pulmonary congestion: wedge pressure estimated from the right atrial pressure, the LV function and the afterload; alveolar
      // flooding above ~18-20 mmHg builds over minutes and clears more slowly (REF esc_hf2021, textbook; sizes REF design)
      this.pcwp = this.circ.rap + 4 + 22 * (1 - Math.min(1, lvNow)) + 0.18 * Math.max(0, this.circ.mapArt - 95) * (1.6 - Math.min(1, lvNow));
      const tgt = clamp((this.pcwp - 18) / 12, 0, 1), m = dt / 60;
      this.oedema += (tgt - this.oedema) * (1 - Math.exp(-m / (tgt > this.oedema ? 5 : 12)));
    }
    for (const [kind, dv] of this.vol.delivered) this.lytes.fluid(FLUID_NA[kind] ?? 140, dv);   // sodium follows the fluids given (previous step)
    this.vol.step(dt, { map: this.circ.mapArt, anesthetized: anesth, coreC: this.therm.tc, ph: this.resp.pH, diuretic: cx.diuretic, glucose: this.lytes.glucose });
    // ventilation configuration; nitrous oxide takes part of the inspired gas, so oxygen cannot exceed 100 % minus its share
    // pressure support unloads the respiratory muscles: it recovers up to 60 % of the ventilation lost to airway obstruction (REF design)
    const nivVa = (vm, n) => (n && n.ps > 0 ? vm + (1 - vm) * Math.min(0.6, 0.045 * n.ps) : vm);
    const n2oCap = (f) => (this.volatile.n2oFi > 0 ? Math.max(0.21, Math.min(f, 1 - this.volatile.n2oFi / 100)) : f);
    let vent = { mode: 'none' };
    if (arrested || paralyzed || (this.vent.mode === 'ctrl')) {
      if (this.vent.mode === 'ctrl') {
        let rr = this.vent.rate, eff2 = this.vent.efficiency;
        if (arrested && this.cpr.mode === 'auto' && this.cpr.auto.ratio === '30:2' && !this.airway.intubated) rr = 5.9;      // 2 breaths per 30:2 cycle
        const secured = this.airway.intubated, cannula = this.neck.cannulaOk, cap = this.hard?.cap ?? 1;
        const efficiency = secured ? 1 : cannula ? 0.5 : (this.airway.device === 'sga' ? 1 : 0.75 * eff2) * cap;   // a cannula ventilates at about half the efficiency (design); a difficult upper airway caps mask / supraglottic ventilation
        vent = { mode: 'ctrl', rate: rr, vt: this.vent.vt, fio2: n2oCap(this.vent.fio2), peep: this.vent.peep, seal: this.vent.seal, efficiency };
      }
    } else vent = { mode: 'spont' };
    // non-invasive ventilation (CPAP / BiPAP through a tight mask) or high-flow nasal oxygen: only on a spontaneously breathing patient
    // without a tube or supraglottic airway (REF davidson2016_niv, rochwerg2017_niv, rochwerg2020_hfno)
    const niv = this.niv && vent.mode === 'spont' && !['ett', 'sga'].includes(this.airway.device) ? this.niv : null;
    let nivCtx = null, vdWash = 0;
    if (niv) {
      if (niv.mode === 'hfno') {
        // delivered FiO2 depends on how much of the inspiratory flow the device covers (peak inspiratory flow ~ 3 x minute ventilation);
        // ~1 cmH2O of PEEP per 10 L/min with the mouth closed, and dead-space washout (REF parke2011, mauri2017)
        const cover = clamp(niv.flow / Math.max(10, 3 * this.resp.ve), 0, 1);
        nivCtx = { fio2: 0.21 + (niv.fio2 - 0.21) * cover, seal: 1, ps: 0 }; vent.peep = Math.min(5, niv.flow / 10 * 0.6); vdWash = 0.2 * Math.min(1, niv.flow / 60);
      } else { nivCtx = { fio2: niv.fio2, seal: 0.95, ps: Math.max(0, niv.ipap - niv.epap) }; vent.peep = niv.epap; }
    }
    const sedPatency0 = anesth && !this.airway.intubated && this.airway.device === 'none' ? 0.35 : this.airway.patency;
    const sedPatency = this.airway.intubated || !(anesth || paralyzed) ? sedPatency0 : Math.min(sedPatency0, this.hard?.cap ?? 1);   // the difficult-airway cap only bites once the airway muscles are relaxed
    const rctx = {
      co: this.circ.co, hb: this.vol.hb, tempC: this.therm.tc, anesthetized: anesth || paralyzed, paralyzed: paralyzed || arrested,
      shuntExtra: this.chest.shuntExtra + this.tube.shuntExtra + cx.shunt + this.aspShunt + 0.38 * this.oedema * (1 - clamp(0.045 * (vent.peep ?? 0), 0, 0.55)),   // flooded alveoli; CPAP / PEEP re-opens up to half (REF rochwerg2017_niv; REF design)
 vaMult: nivVa(this.chest.vaMult * this.tube.vaMult * cx.vaMult * (vent.mode === 'ctrl' ? 1 : nx.vaMult), nivCtx), vo2Scale: cx.vo2 * (1 + 1.0 * shiv) /* shivering up to doubles the oxygen consumption (REF sessler2016) */, niv: nivCtx, vdWash, br: this.crises.br, dyspnoea: this.oedema,
      dep: eff.dep, vent, airwayPatency: sedPatency * (1 - 0.8 * this.volatile.irritation) * cx.patency, o2: this.o2 ? { ...this.o2, fio2: n2oCap(this.o2.fio2) } : this.o2, o2Dilution: this.volatile.dilution, apOx: this.apOx, bicarbMmol: this.bicarbMmol - SALINE_HCO3_PER_MLKG * this.vol.salineLoad - this.keto.hco3Loss, bloodVolume: this.vol.bloodVolume,
    };
    if (vent.mode === 'none' && arrested) rctx.vent = { mode: 'none' };
    if (this.airway.intubating) rctx.vent = { mode: 'none' };
    rctx.frcMult = this.headUp ? 1.15 : 1;
    this.resp.step(dt, rctx);
    // breathing circuit connected: ventilator or bag (leak with a mask), supraglottic airway or tube, or a sealed anaesthetic face mask
    const circuit = vent.mode === 'ctrl' ? clamp(vent.seal ?? 0.97, 0.5, 1) : ['sga', 'ett'].includes(this.airway.device) ? 1 : this.o2 && this.o2.seal >= 0.95 ? this.o2.seal : 0;
    this.volatile.step(dt, { delivered: circuit, va: this.resp.vaNow / 1000, q: this.circ.co, frc: (anesth || paralyzed ? this.resp.frcAnesth : this.resp.frcSupine), secured: ['sga', 'ett'].includes(this.airway.device) });
    this.neck.step(dt, { ventilating: vent.mode === 'ctrl', cap: this.hard?.cap ?? 1 }, this.chest);
    this.tube.step(dt, { intubated: this.airway.device === 'ett' });
    this.bicarbMmol = Math.max(0, this.bicarbMmol - this.bicarbMmol * dt / 1800);
    if (this.ponv.pacu || this.neuraxial.t0 !== null || this.ponv.extra > 0.01 || this.ponv.nausea > 0.01) {
      const pv = this.ponv.step(dt, { drugs: this.drugs, mapRatio: this.circ.mapArt / this.circ.MAP0, suppressed: paralyzed || arrested || eff.loc, loc: anesth, protectedAirway: this.airway.device === 'ett', t });
      if (pv.vomited) { this.notes.push({ t, text: 'vomiting' }); if (this.ponv.aspirated && this.aspShunt === 0) { this.aspShunt = 0.12; this.notes.push({ t, text: 'aspiration of gastric content' }); } }   // REF design
    }
    // pethidine lowers the shivering threshold about twice as much as the vasoconstriction threshold (REF kurz1997; size REF design)
    const antiShiver = 1.2 * (this.drugs.pk.pethidine ? 1 / (1 + Math.pow(0.05 / Math.max(1e-9, this.drugs.ce('pethidine')), 2)) : 0);
    this.therm.step(dt, { shiverShift: antiShiver, vo2: this.resp.vo2Eff / (1 + shiv), paralyzed,   // shivering heat is added by thermal.js itself
      anesthetized: anesth || paralyzed, vasodilation: clamp(1 - eff.fx.svr, 0, 1), perfusion: clamp(this.circ.co / this.circ.CO0, 0.05, 1.2) });
    // ---- pre-arrest degeneration (deterministic timers) and arrest dynamics
    if (!arrested && info.perfusing) {
      this.timers.hypoxic = this.resp.sao2 < 0.50 ? this.timers.hypoxic + dt : Math.max(0, this.timers.hypoxic - dt);
      this.timers.lowMap = this.circ.mapArt < 35 ? this.timers.lowMap + dt : Math.max(0, this.timers.lowMap - dt);
      if (this.timers.hypoxic > 45 && this.arrest.key !== 'SINUS_BRADY') { this.arrest.setRhythm('SINUS_BRADY', t); this.hypoxicBrady = true; }
      else if (this.hypoxicBrady && this.arrest.key === 'SINUS_BRADY' && this.timers.hypoxic === 0 && this.resp.sao2 > 0.9) { this.arrest.setRhythm('NSR', t); this.hypoxicBrady = false; }   // hypoxic bradycardia resolves once oxygenation is restored (REF textbook)
      else if (this.arrest.key !== 'SINUS_BRADY') this.hypoxicBrady = false;
      if (((this.timers.hypoxic > 90 || this.timers.lowMap > 20) && this.circ.mapArt < 40) || (this.timers.hypoxic > 120 && this.myoHypox > 0.8)) {
        const cause = this.resp.sao2 < 0.5 ? 'hypoxia' : (this.chest.tension >= 0.4 ? 'tension_ptx' : 'hypovolemia'); this.arrest.causes[cause] = true;
        if (this.chest.tension >= 0.4) this.arrest.causes.tension_ptx = true;
        this.arrest.arrest('PEA', t); this.notes.push({ t, text: 'arrest: PEA from ' + cause });
      }
      if (this.arrest.postRosc) {
        if (this.circ.mapArt < 55 || this.resp.sao2 < 0.85) this.timers.hypotensionPostRosc += dt; else this.timers.hypotensionPostRosc = Math.max(0, this.timers.hypotensionPostRosc - dt);
        const refib = (this.arrest.causes.coronary_thrombosis ? 1 / 240 : 1 / 3600) * (this.timers.hypotensionPostRosc > 20 ? 4 : 1) * (1 - 0.6 * this.antiarr);
        if (this.rng.chance(1 - Math.exp(-refib * dt))) { this.arrest.rearrests++; this.arrest.arrest(this.arrest.causes.coronary_thrombosis ? 'VF' : 'PEA', t); }
      }
    }
    if (arrested) {
      const cs = this.arrest.causes;
      if (cs.hypoxia && this.resp.sao2 >= 0.92) cs.hypoxia = false;
      if (cs.acidosis && this.resp.pH >= 7.15) cs.acidosis = false;
      if (cs.tension_ptx && this.chest.side && this.chest.tension < 0.15) cs.tension_ptx = false;
      if (cs.hypovolemia && this.vol.fractionLost < 0.2 && this.vol.rates.bleed === 0) cs.hypovolemia = false;
      const r = this.arrest.step(dt, { cpp: this.circ.cpp, epi: this.drugs.cp('epinephrine'), mg: this.crises.mgEffect(this.drugs), t, spo2True: this.resp.sao2, map: this.circ.mapArt });
      if (r === 'ROSC') this._rosc();
      else if (r === 'SELF_TERM') { this.arrest.selfTerminate(t); this.cpr.stop(); this.notes.push({ t, text: 'torsades stopped on its own' }); }
    }
    this.keto.step(dt, this.lytes);
    this.lytes.step(dt, { hco3: this.resp.hco3, caMmolL: this.drugs.cp('calciumChloride') + this.drugs.cp('calciumGluconate'), coreC: this.therm.tc, salbutamol: this.drugs.ce('salbutamol') });
    if (!this.warming) {                                               // severe hyperkalaemia can stop the heart; calcium protects the membrane
      const lam = this.lytes.arrestHazard();                           // per minute (electrolytes.js); random draw only when the hazard exists
      if (lam > 0 && !this.arrest.arrested && this.rng.chance(1 - Math.exp(-lam * dt / 60))) {
        const u = this.rng.next(); this.arrest.arrest(u < 0.25 ? 'VF' : u < 0.65 ? 'PEA' : 'ASYSTOLE', t); this.arrest.causes.hyperkalemia = true;   // REF design: bradycardic PEA / asystole more often than VF
        this.notes.push({ t, text: 'arrest: hyperkalaemia' });
      }
      if (this.arrest.arrested && this.arrest.causes.hyperkalemia && this.lytes.kEff < 6.5) this.arrest.causes.hyperkalemia = false;
      if (cx.hazard > 0 && !this.arrest.arrested && this.rng.chance(1 - Math.exp(-cx.hazard * dt / 60))) {   // toxic arrhythmia (local anaesthetic)
        const u = this.rng.next(); this.arrest.arrest(u < 0.5 ? 'VF' : u < 0.8 ? 'ASYSTOLE' : 'PEA', t); this.arrest.causes[cx.cause] = true; this.notes.push({ t, text: 'arrest: ' + cx.cause });
      }
      if (cx.seStop > 0 && this.rng.chance(1 - Math.exp(-cx.seStop * dt / 60))) { this.crises.se.active = false; this.notes.push({ t, text: 'seizure stopped' }); }   // status epilepticus
      else if (cx.seRecur > 0 && this.rng.chance(1 - Math.exp(-cx.seRecur * dt / 60))) { this.crises.trigger('seizure', t); this.notes.push({ t, text: 'seizure recurred' }); }
      if (cx.naSeizure > 0 && this.rng.chance(1 - Math.exp(-cx.naSeizure * dt / 60))) { this.crises.trigger('seizure', t); this.notes.push({ t, text: 'seizure (hyponatraemia)' }); }
      if (cx.tdp > 0 && !this.arrest.arrested && this.rng.chance(1 - Math.exp(-cx.tdp * dt / 60))) {   // long QT: torsades de pointes
        this.arrest.arrest('TORSADES', t); this.tdpCount = (this.tdpCount || 0) + 1; this.notes.push({ t, text: 'arrest: torsades de pointes' });
      }
      if (this.arrest.arrested && this.arrest.causes.local_anaesthetic && this.crises.laCv < 0.8) this.arrest.causes.local_anaesthetic = false;   // REF ers2021_special (K < 6.5 no longer severe)
    }
    this._monitor();
    if (!this.warming && this.scenario?.track) this.scenario.track(this);
    this.n++;
  }
  _monitor() {
    const m = this.monitor, info = this.arrest.info, dt = this.dt;
    const hrE = info.perfusing ? this.circ.hr : (this.arrest.key === 'VF' ? 300 : this.arrest.key === 'TORSADES' ? 240 : this.arrest.key === 'PEA' ? 55 : 0);
    this.hrSmooth = lag(this.hrSmooth, hrE, dt, 3);
    m.hr = this.flags.ecgLeads ? Math.round(this.hrSmooth) : null;
    m.rhythm = this.flags.ecgLeads ? this.arrest.key : null;
    m.spo2 = this.flags.spo2Probe && this.circ.co > 0.8 ? clamp(Math.round(this.resp.spo2), 0, 100) : null;
    m.sbp = this.flags.aline ? Math.round(this.circ.sbp) : (this.nibp.sbp !== null ? Math.round(this.nibp.sbp) : null);
    m.dbp = this.flags.aline ? Math.round(this.circ.dbp) : (this.nibp.dbp !== null ? Math.round(this.nibp.dbp) : null);
    m.map = m.sbp !== null ? Math.round(m.dbp + (m.sbp - m.dbp) / 3) : null;
    m.etco2 = this.flags.capnography ? Math.round(this.resp.etco2) : null;
    m.rr = this.flags.capnography ? Math.round(this.resp.rr) : null;
    m.temp = this.flags.tempProbe ? +this.therm.tc.toFixed(1) : null;
  }
  /** Laboratory results released by now (the learner sees nothing before the turnaround). */
  labResults() { return this.labs.filter(l => l.readyAt <= this.t + 1e-9); }
  tick(steps = 1) { for (let i = 0; i < steps; i++) this._physio(); return this; }
  run(seconds) { return this.tick(Math.round(seconds / this.dt)); }
  /** pulse presence at carotid (palpable if SBP > ~60) */
  get pulse() { return this.arrest.info.perfusing && this.circ.sbp > 60; }

  // ------------------------------------------------------------------ state export / hash
  snapshot() {
    const c = this.circ, r = this.resp, v = this.vol;
    return {
      t: +this.t.toFixed(1), rhythm: this.arrest.key, arrested: this.arrest.arrested, pulse: this.pulse,
      hr: +c.hr.toFixed(1), sbp: +c.sbp.toFixed(1), dbp: +c.dbp.toFixed(1), map: +c.mapArt.toFixed(1), cvp: +c.rap.toFixed(2), co: +c.co.toFixed(2), svr: +c.svr.toFixed(1), cpp: +c.cpp.toFixed(1),
      spo2True: +(r.sao2 * 100).toFixed(1), spo2: +r.spo2.toFixed(1), pao2: +r.pao2.toFixed(1), paco2: +r.paco2.toFixed(1), etco2: +r.etco2.toFixed(1), ph: +r.pH.toFixed(3), hco3: +r.hco3.toFixed(1), lactate: +r.lactate.toFixed(2),
      rr: +r.rr.toFixed(1), ve: +r.ve.toFixed(2), shunt: +r.shunt.toFixed(3),
      bloodVolume: +v.bloodVolume.toFixed(3), fractionLost: +v.fractionLost.toFixed(4), hct: +v.hct.toFixed(3), hb: +v.hb.toFixed(2),
      inr: +coagStatus(this.vol, this.therm.tc, this.resp.pH).inr.toFixed(2), coagFn: +this.vol.coagFn.toFixed(2),
      k: +this.lytes.k.toFixed(2), na: +this.lytes.na.toFixed(1), ica: +this.lytes.ica.toFixed(2), glucose: +this.lytes.glucose.toFixed(1),
      core: +this.therm.tc.toFixed(2), periph: +this.therm.tp.toFixed(2),
      readiness: +this.arrest.readiness.toFixed(3), vfAmp: +this.arrest.vfAmp.toFixed(3),
      chest: this.chest.snapshot(), fona: this.neck.fona ? this.neck.fona.kind + (this.neck.fona.displaced ? ' (displaced)' : '') : null,
      cprFlow: +this.cpr.flow.toFixed(3), cprRate: +this.cpr.stats.rate.toFixed(0), cprDepth: +this.cpr.stats.depth.toFixed(2), ccf: +this.cpr.stats.ccf.toFixed(2),
    };
  }
  /** FNV-1a over a quantised (6-decimal) state vector; used for replay verification. Coarse enough to tolerate last-ulp differences between JS engines. */
  stateHash() {
    const c = this.circ, r = this.resp, v = this.vol, th = this.therm;
    const vec = [this.n, c.hr, c.sbp, c.dbp, c.mapArt, c.rap, c.co, c.x.hr, c.x.svr, r.sao2, r.paco2, r.pv, r.vO2, r.vN2, r.cv, r.lactate, v.vp, v.rbc, v.vi, v.fAmt, v.fibAmt, v.pltAmt, v.res.f, v.res.fib, v.res.plt, th.tc, th.tp, this.arrest.readiness, this.arrest.vfAmp, this.myoHypox, this.rng.state, this.chest.air, this.chest.pip, this.chest.leak, this.neck.palpable ? 1 : 0, this.neck.marked ? 1 : 0, this.neck.cannulaOk ? 1 : 0, this.rngS.state, this.rngT.state, ...this.tube.hashVec(), this.peri.volume, this.rvLoad, ...(this.ward ? this.ward.hashVec() : []), ...this.drugs.hashVec(), ...this.lytes.hashVec(), ...this.crises.hashVec(), this.flutterBlockUntil ?? -1, ...this.volatile.hashVec(), this.vol.salineLoad, this.bbb === 'L' ? 1 : this.bbb === 'R' ? 2 : 0, this.ecgx.length, this.oedema, this.varix ? (this.varix.controlled ? 2 : 1) : 0, ...(this.niv ? [['cpap', 'bipap', 'hfno'].indexOf(this.niv.mode), this.niv.fio2, this.niv.epap, this.niv.ipap, this.niv.flow] : [-1]), ...this.keto.hashVec(), ...this.neuraxial.hashVec(), ...this.ponv.hashVec(), this.aspShunt, this.hypoxicBrady ? 1 : 0];
    for (const k of Object.keys(this.drugs.pk)) vec.push(...this.drugs.pk[k].a, this.drugs.pk[k].ce);
    // what steers the course before it shows in the vitals: settings, devices, drug loads, arrest timers and the effects
    // scheduled for later (a line or drain that completes in minutes), so a log edited there differs at once, not later
    const A = this.airway, V = this.vent, cp = this.cpr, df = this.defib;
    vec.push(A.patency, A.intubated ? 1 : 0, V.rate, V.vt, V.fio2, V.peep, V.seal, V.efficiency, this.o2 ? this.o2.fio2 : -1, this.o2 ? this.o2.seal : -1,
      this.apOx ? this.apOx.fio2 : -1, this.apOx ? this.apOx.eff : -1, this.headUp ? 1 : 0, this.antiarr, this.bicarbMmol, this.lv, this.postRoscTone, this.arrestTone,
      this.hrSmooth, this.pcwp, this.painIndex, this.stimulus, this.tdpCount ?? 0, this.bleedControlledAt ?? -1, ...Object.values(this.timers),
      cp.flow, cp.amp, cp.totalCompressions, cp.pendingBreaths, df.energy, df.charged ? 1 : 0, df.padsOn ? 1 : 0,
      ...Object.values(this.flags).map(Number), this.pendingEvents.length, ...this.pendingEvents.map(e => e.at));
    let h = 0x811c9dc5;
    const s = vec.map(x => (Number.isFinite(x) ? x.toFixed(6) : 'NaN')).join('|') + '|' + this.arrest.key + '|' + [A.device, V.mode, cp.mode, cp.surface, df.mode, this.rhythmBase].join('|');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
}

/** Replay a recorded session: same spec/seed/scenario + ordered log => same hash. */
export function replay({ spec, seed, scenario, log, until }, scenarios) {
  const sc = scenario ? scenarios[scenario] : null;
  const p = new Patient(spec, { seed, scenario: sc });
  for (const ev of log) {
    const steps = Math.round(ev.t / p.dt) - p.n;
    if (steps > 0) p.tick(steps);
    const { t, ...rest } = ev; p.dispatch(rest);
  }
  const end = Math.round((until ?? (log.length ? log[log.length - 1].t : 0)) / p.dt) - p.n;
  if (end > 0) p.tick(end);
  return p;
}
