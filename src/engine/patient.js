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
import { LAB_KINDS, TURNAROUND_S, sampleValues, flags as labFlags } from './labs.js';

export const DT = 0.1;
const AIRWAYS = { none: 1.0, chin_lift: 0.8, jaw_thrust: 0.9, opa: 0.9, sga: 0.95, ett: 1.0 };

/** Every intervention accepted by Patient.dispatch(); the server validates replay logs against this list. */
export const EVENT_TYPES = Object.freeze(['drug.bolus', 'bicarb.bolus', 'drug.infusion', 'drug.stop', 'fluid.bolus', 'blood.transfuse', 'bleed.set', 'bleed.control', 'order', 'airway.set', 'position.set', 'airway.intubate', 'vent.set', 'o2.mask', 'apox.set', 'monitor.attach', 'iv.access', 'nibp.cycle', 'cpr.start', 'cpr.stop', 'cpr.compress', 'cpr.switch', 'cpr.surface', 'defib.pads', 'defib.setEnergy', 'defib.mode', 'defib.charge', 'defib.shock', 'procedure.needle_decompression', 'procedure.chest_tube', 'procedure.cricothyroidotomy', 'exam.chest', 'exam.pocus', 'exam.neck', 'procedure.pericardiocentesis', 'procedure.pci', 'procedure.thrombolysis', 'procedure.treat_hyperkalemia', 'airway.tube_adjust', 'bronch.insert', 'bronch.suction', 'bronch.remove', 'thermal.device', 'thermal.cover', 'thermal.ambient', 'echo.view', 'echo.measure', 'echo.report', 'ward.advance', 'ward.sample', 'ward.rx.start', 'ward.rx.stop', 'ward.order', 'lab.order', 'note']);

const NUMERIC_EVENT_PARAMS = ['amount', 'rate', 'volumeL', 'minutes', 'mlPerMin', 'c', 'factor', 'energy', 'mEq', 'target', 'maxWatts', 'fio2', 'seal', 'eff', 'depth', 'needleMm', 'fr', 'depthCm', 'cm', 'quality', 'value', 'hours'];

/** Structural validation of nested event payloads (settings/opts/items) so a malformed browser payload cannot inject NaN, strings or unknown flags. */
const VENT_NUM = { rate: [0, 60], vt: [0, 1500], fio2: [0.21, 1], peep: [0, 25], seal: [0, 1] };
const CPR_NUM = { rate: [40, 200], depth: [0, 10] };
const FLAG_KEYS = ['ecgLeads', 'spo2Probe', 'nibp', 'aline', 'capnography', 'tempProbe'];
function validateEventShape(ev) {
  const isNum = x => typeof x === 'number' && Number.isFinite(x);
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
    case 'blood.transfuse': return ['prbc', 'whole', 'ffp'].includes(ev.kind) ? null : 'invalid blood product';
    case 'position.set': return typeof ev.headUp === 'boolean' ? null : 'headUp must be boolean';
    case 'apox.set': return typeof ev.on === 'boolean' ? null : 'on must be boolean';
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
    this.drugs = new DrugSystem(this.body, { dtSec: dt, propofolModel: this.spec.propofolModel, remiModel: this.spec.remiModel, pseudocholinesterase: this.spec.pseudocholinesterase ?? 1 });
    this.cpr = new CprMechanics(this.body, this.rng);
    this.defib = new Defibrillator(this.body);
    this.arrest = new ArrestState(this.rng, spec?.causes || []);
    this.rhythmBase = this.spec.rhythm || 'NSR';
    this.arrest.key = this.rhythmBase;
    this.airway = { device: 'none', patency: 1, intubated: false };
    this.rngS = new Rng(((seed ^ 0x9e3779b9) >>> 0) || 7);   // separate stream for surgical gestures: never perturbs the main random sequence
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
    this.flags = { padsOn: false, ivAccess: false, ecgLeads: false, spo2Probe: false, nibp: false, aline: false, capnography: false, tempProbe: false };
    this.timers = { hypoxic: 0, lowMap: 0, hypotensionPostRosc: 0 };
    this.arrestTone = 1; this.postRoscTone = 1;
    this.log = []; this.timeline = []; this.scenario = scenario;
    this.stimulus = 0; this.nibp = { sbp: null, dbp: null, t: null }; this.antiarr = 0;
    this.monitor = { hr: 72, spo2: 97, sbp: 114, dbp: 74, map: 87, etco2: 38, rr: 12, temp: 37, rhythm: 'NSR' };
    this.shockLog = []; this.pendingEvents = []; this.notes = []; this.orders = []; this.labs = []; this.bleedControlledAt = null;
    this.bicarbMmol = 0; this.painIndex = 0; this.hrSmooth = 72; this.myoHypox = 0;   // progressive hypoxic myocardial depression 0..1 (design)
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
    return this._apply(ev);
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
        if (ev.drug === 'naloxone' && ev.amount >= 200) this.arrest.fixCause('toxins');        // opioid reversal is effective at >= 0.2 mg IV (design)
        if (ev.drug === 'amiodarone' || ev.drug === 'lidocaine') this.antiarr = Math.min(1, this.antiarr + (ev.drug === 'amiodarone' ? 0.5 : 0.35));
        if (ev.drug === 'succinylcholine') this.lytes.succinylcholine(ev.amount / this.body.weightKg);
        this.drugs.bolus(ev.drug, ev.amount, t); return { ok: true };
      }
      case 'bicarb.bolus': this.bicarbMmol += ev.mEq / (0.5 * this.body.weightKg); this.drugs.log.push({ t, key: 'sodiumBicarbonate', amount: ev.mEq }); return { ok: true };
      case 'drug.infusion': this.drugs.infusion(ev.drug, ev.rate); return { ok: true };
      case 'drug.stop': this.drugs.stop(ev.drug); return { ok: true };
      case 'fluid.bolus': this.vol.startInfusion(ev.volumeL, ev.minutes ?? 15, 'crystalloid'); return { ok: true };
      case 'blood.transfuse': this.vol.transfuse(ev.kind); this.lytes.transfuse(); return { ok: true };
      case 'bleed.set': this.vol.setBleed(ev.mlPerMin); return { ok: true };
      case 'bleed.control': this.vol.setBleed(0); this.bleedControlledAt = t; this.notes.push({ t, text: 'haemorrhage source controlled' }); return { ok: true };
      case 'lab.order': {                              // the sample freezes the values now; the result is released after the turnaround
        const rec = { id: this.labs.length + 1, kind: ev.kind, t, readyAt: +(t + TURNAROUND_S[ev.kind]).toFixed(1), values: sampleValues(ev.kind, this) };
        rec.flags = labFlags(rec.values, this.spec.sex); this.labs.push(rec);
        return { ok: true, id: rec.id, readyAt: rec.readyAt, willTakeS: TURNAROUND_S[ev.kind] };
      }
      case 'order': { const rec = { t, what: ev.what, ...(ev.mg != null ? { mg: ev.mg } : {}) }; this.orders.push(rec); return { ok: true, result: this.scenario?.orderResult?.(ev.what, this) ?? null }; }
      case 'airway.set': {
        const d = ev.device; if (!(d in AIRWAYS)) return { ok: false };
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
      case 'defib.setEnergy': this.defib.setEnergy(ev.energy); return { ok: true };
      case 'defib.mode': this.defib.mode = ev.mode; return { ok: true };
      case 'defib.charge': this.defib.charge(t); return { ok: true, readyAt: this.defib.chargeAt };
      case 'defib.shock': return this._shock();
      case 'procedure.needle_decompression': return this._needle(ev);
      case 'procedure.chest_tube': return this._chestTube(ev);
      case 'procedure.cricothyroidotomy': return this._fona(ev);
      case 'exam.chest': return { ok: true, findings: this.chest.findings({ ppv: this._ppv(), rap: this.circ.rap }) };
      case 'exam.pocus': return { ok: true, ...this.chest.pocus() };
      case 'exam.neck': return this._examNeck(ev);
      case 'procedure.pericardiocentesis': { this.arrest.fixCause('tamponade'); const ml = this.peri.drain(); if (ml > 1) this.notes.push({ t, text: `pericardiocentesis: ${Math.round(ml)} mL drained` }); return { ok: true, drainedMl: Math.round(ml) }; }
      case 'echo.view': { const s = echoState(this); this.echo.views.push({ t, view: ev.view, quality: ev.quality }); return { ok: true, findings: s }; }
      case 'echo.measure': { const s = echoState(this); this.echo.measures.push({ t, what: ev.what, value: ev.value, truth: measureTruth(s, ev.what) }); return { ok: true }; }
      case 'echo.report': { const { type, ...r } = ev; this.echo.reports.push({ t, ...r, state: echoState(this) }); return { ok: true }; }
      case 'procedure.pci': this.arrest.fixCause('coronary_thrombosis'); this.notes.push({ t, text: 'reperfusion' }); return { ok: true };
      case 'procedure.thrombolysis': this.arrest.fixCause('pulmonary_embolism'); this.arrest.fixCause('coronary_thrombosis'); return { ok: true };
      case 'procedure.treat_hyperkalemia': this.arrest.fixCause('hyperkalemia'); this.lytes.insulinGlucose(); return { ok: true };
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
    if (!relaxed) { this.notes.push({ t, text: 'intubation attempted on a patient who is not paralysed/unconscious' }); this.failedAttempts = (this.failedAttempts || 0) + 1; return { ok: false, error: 'patient not relaxed: laryngospasm / bucking' }; }
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
    } else if (this.arrest.info.perfusing && ['VT_PULSE', 'SVT', 'AF'].includes(this.arrest.key) && d.mode === 'sync') {
      const p = this.arrest.key === 'AF' ? (d.energy >= 200 ? 0.85 : 0.6) : (d.energy >= 100 ? 0.85 : 0.6);   // REF aha2025_part9 (AF >= 200 J)
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
    const anesth = eff.loc;
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
      case 'SVT': rate = 178; break; case 'VT_PULSE': rate = 168; break; case 'AF': rate = 125 + hrAdd * 0.3; break;
      case 'AV_BLOCK3': rate = 34; break;
    }
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
    this.vol.step(dt, { map: this.circ.mapArt, anesthetized: anesth });
    // ventilation configuration
    let vent = { mode: 'none' };
    if (arrested || paralyzed || (this.vent.mode === 'ctrl')) {
      if (this.vent.mode === 'ctrl') {
        let rr = this.vent.rate, eff2 = this.vent.efficiency;
        if (arrested && this.cpr.mode === 'auto' && this.cpr.auto.ratio === '30:2' && !this.airway.intubated) rr = 5.9;      // 2 breaths per 30:2 cycle
        const secured = this.airway.intubated, cannula = this.neck.cannulaOk, cap = this.hard?.cap ?? 1;
        const efficiency = secured ? 1 : cannula ? 0.5 : (this.airway.device === 'sga' ? 1 : 0.75 * eff2) * cap;   // a cannula ventilates at about half the efficiency (design); a difficult upper airway caps mask / supraglottic ventilation
        vent = { mode: 'ctrl', rate: rr, vt: this.vent.vt, fio2: this.vent.fio2, peep: this.vent.peep, seal: this.vent.seal, efficiency };
      }
    } else vent = { mode: 'spont' };
    const sedPatency0 = anesth && !this.airway.intubated && this.airway.device === 'none' ? 0.35 : this.airway.patency;
    const sedPatency = this.airway.intubated || !(anesth || paralyzed) ? sedPatency0 : Math.min(sedPatency0, this.hard?.cap ?? 1);   // the difficult-airway cap only bites once the airway muscles are relaxed
    const rctx = {
      co: this.circ.co, hb: this.vol.hb, tempC: this.therm.tc, anesthetized: anesth || paralyzed, paralyzed: paralyzed || arrested,
      shuntExtra: this.chest.shuntExtra + this.tube.shuntExtra, vaMult: this.chest.vaMult * this.tube.vaMult,
      dep: eff.dep, vent, airwayPatency: sedPatency, o2: this.o2, apOx: this.apOx, bicarbMmol: this.bicarbMmol, bloodVolume: this.vol.bloodVolume,
    };
    if (vent.mode === 'none' && arrested) rctx.vent = { mode: 'none' };
    if (this.airway.intubating) rctx.vent = { mode: 'none' };
    rctx.frcMult = this.headUp ? 1.15 : 1;
    this.resp.step(dt, rctx);
    this.neck.step(dt, { ventilating: vent.mode === 'ctrl', cap: this.hard?.cap ?? 1 }, this.chest);
    this.tube.step(dt, { intubated: this.airway.device === 'ett' });
    this.bicarbMmol = Math.max(0, this.bicarbMmol - this.bicarbMmol * dt / 1800);
    this.therm.step(dt, { vo2: this.resp.vo2Eff, paralyzed, anesthetized: anesth || paralyzed, vasodilation: clamp(1 - eff.fx.svr, 0, 1), perfusion: clamp(this.circ.co / this.circ.CO0, 0.05, 1.2) });
    // ---- pre-arrest degeneration (deterministic timers) and arrest dynamics
    if (!arrested && info.perfusing) {
      this.timers.hypoxic = this.resp.sao2 < 0.50 ? this.timers.hypoxic + dt : Math.max(0, this.timers.hypoxic - dt);
      this.timers.lowMap = this.circ.mapArt < 35 ? this.timers.lowMap + dt : Math.max(0, this.timers.lowMap - dt);
      if (this.timers.hypoxic > 45 && this.arrest.key !== 'SINUS_BRADY') this.arrest.setRhythm('SINUS_BRADY', t);
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
      const r = this.arrest.step(dt, { cpp: this.circ.cpp, epi: this.drugs.cp('epinephrine'), t, spo2True: this.resp.sao2, map: this.circ.mapArt });
      if (r === 'ROSC') this._rosc();
    }
    this.lytes.step(dt, { hco3: this.resp.hco3, cacl2: this.drugs.cp('calciumChloride'), coreC: this.therm.tc });
    this._monitor();
    if (!this.warming && this.scenario?.track) this.scenario.track(this);
    this.n++;
  }
  _monitor() {
    const m = this.monitor, info = this.arrest.info, dt = this.dt;
    const hrE = info.perfusing ? this.circ.hr : (this.arrest.key === 'VF' ? 300 : this.arrest.key === 'PEA' ? 55 : 0);
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
    const vec = [this.n, c.hr, c.sbp, c.dbp, c.mapArt, c.rap, c.co, c.x.hr, c.x.svr, r.sao2, r.paco2, r.pv, r.vO2, r.vN2, r.cv, r.lactate, v.vp, v.rbc, v.vi, th.tc, th.tp, this.arrest.readiness, this.arrest.vfAmp, this.myoHypox, this.rng.state, this.chest.air, this.chest.pip, this.chest.leak, this.neck.palpable ? 1 : 0, this.neck.marked ? 1 : 0, this.neck.cannulaOk ? 1 : 0, this.rngS.state, ...this.tube.hashVec(), this.peri.volume, this.rvLoad, ...(this.ward ? this.ward.hashVec() : []), ...this.drugs.hashVec(), ...this.lytes.hashVec()];
    for (const k of Object.keys(this.drugs.pk)) vec.push(...this.drugs.pk[k].a, this.drugs.pk[k].ce);
    let h = 0x811c9dc5;
    const s = vec.map(x => (Number.isFinite(x) ? x.toFixed(6) : 'NaN')).join('|') + '|' + this.arrest.key;
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
