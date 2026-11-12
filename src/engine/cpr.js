// Resuscitation mechanics: chest compressions -> flow and pressure; defibrillator; arrest rhythm state machine with
// myocardial readiness, VF coarseness, reversible causes (H's & T's), ROSC and re-arrest.
// Anchors: AHA 2025 Parts 7/9/11 (rate 100-120, depth 5-6 cm, CCF >= 60%, 1 mg epinephrine q3-5 min, single shocks),
// Paradis 1990 (CPP >= 15 mmHg necessary for ROSC), Reynolds 2012 (swine pre-shock CPP 31 vs 14), CARES 2024 outcome rates. (REF reynolds2012)
// Every numeric shape below that is not in those sources is a DESIGN value (REF design) and documented in VALIDATION.md.
import { clamp, lag } from './util.js';
import { RHYTHMS } from './rhythm.js';

export const CPR_LIMITS = { rateLo: 100, rateHi: 120, depthLo: 5.0, depthHi: 6.0, ccfMin: 0.60 };       // REF aha2025_part7

export class CprMechanics {
  constructor(body, rng) {
    this.body = body; this.rng = rng;
    this.mode = 'off';                                         // off | manual | auto
    this.auto = { rate: 110, depth: 5.5, ratio: '30:2', surface: 'hard', next: 0, count: 0, pauseUntil: 0 };
    this.events = [];                                          // recent compressions {t, depth, recoil}
    this.surface = 'hard';                                     // hard | soft (mattress absorbs depth without board)
    this.compressorSince = 0; this.switches = 0;
    this.flow = 0; this.amp = 0; this.stats = this._blank();
    this.totalCompressions = 0; this.totalActiveS = 0; this.totalElapsedS = 0; this.firstCompressionT = null;
    this.windowLog = [];                                       // per-second flags for CCF
    this.lastBreathReq = 0; this.pendingBreaths = 0;
    this.arrestElapsedS = 0; this.arrestActiveS = 0; this.goodRateS = 0; this.goodDepthS = 0; this.goingS = 0; this.maxDepth = 0; this.sinceLast = 0;
  }
  _blank() { return { rate: 0, depth: 0, recoilFrac: 1, ccf: 0, quality: 0, lastAge: 99 }; }
  start(mode, t, opts = {}) { this.mode = mode; Object.assign(this.auto, opts); if (this.firstCompressionT === null) this.firstCompressionT = t; this.auto.next = t; this.compressorSince = t; }
  stop() { this.mode = 'off'; }
  switchCompressor(t) { this.compressorSince = t; this.switches++; }
  compress(t, depthCm, recoil = true) {
    if (this.firstCompressionT === null) this.firstCompressionT = t;
    // human fatigue: depth decays after ~2 min on the same compressor (REF aha2025_part7: swap every 2 min). 'auto' mode already applies it before calling here.
    const fat = this.mode === 'manual' ? clamp((t - this.compressorSince - 120) / 60 * 0.08, 0, 0.5) : 0;
    const eff = depthCm * (1 - fat) * (this.surface === 'soft' ? 0.8 : 1);     // mattress without board absorbs ~20% (design)
    this.events.push({ t, depth: eff, recoil }); this.totalCompressions++;
    if (this.events.length > 40) this.events.shift();
  }
  step(dt, t, active) {
    this.totalElapsedS += dt;
    if (this.mode === 'auto') {
      const a = this.auto;
      while (t >= a.next && t >= a.pauseUntil) {
        const fatigueS = Math.max(0, t - this.compressorSince - 120);        // AHA: switch about every 2 min or sooner if fatigued
        const fat = clamp(fatigueS / 60 * 0.08, 0, 0.5);
        const d = a.depth * (1 - fat) + 0.25 * this.rng.normal();
        this.compress(a.next, clamp(d, 1, 8), this.rng.chance(clamp(0.95 - fat, 0, 1)));
        a.count++; a.next += 60 / a.rate;
        if (a.ratio === '30:2' && a.count % 30 === 0) { a.pauseUntil = a.next + 4.5; a.next = a.pauseUntil; this.pendingBreaths += 2; }
      }
    }
    const ev = this.events.filter(e => e.t > t - 8 && e.t <= t + 1e-9);
    const st = this._blank();
    const age = ev.length ? t - ev[ev.length - 1].t : 99; st.lastAge = age;
    if (ev.length >= 3) {
      st.rate = 60 * (ev.length - 1) / Math.max(ev[ev.length - 1].t - ev[0].t, 0.5);
      st.depth = ev.reduce((s, e) => s + e.depth, 0) / ev.length;
      st.recoilFrac = ev.filter(e => e.recoil).length / ev.length;
    }
    const interval = st.rate > 0 ? 60 / st.rate : 0.6;
    const going = ev.length >= 3 && age < Math.max(1.5, 2.2 * interval);
    this.windowLog.push(going ? 1 : 0); if (this.windowLog.length > 600) this.windowLog.shift();     // 0.1 s per entry, 60 s window
    if (active !== false && this.firstCompressionT !== null) { this.arrestElapsedS += dt; if (going) this.arrestActiveS += dt; }   // CCF clock starts at the first compression; the delay to it is scored by t_first_compression
    if (going && active !== false) { this.totalActiveS += dt; this.goingS += dt; if (st.rate >= 100 && st.rate <= 120) this.goodRateS += dt; if (st.depth >= 5 && st.depth <= 6) this.goodDepthS += dt; if (st.depth > this.maxDepth) this.maxDepth = st.depth; }
    st.ccf = this.windowLog.reduce((s, x) => s + x, 0) / this.windowLog.length;
    // --- quality factors (design shapes anchored to AHA thresholds)
    const Qd = going ? (st.depth < 5 ? clamp((st.depth - 2) / 3, 0, 1) : st.depth > 6 ? clamp(1 - 0.1 * (st.depth - 6), 0.7, 1) : 1) : 0;
    const Qr = !going ? 0 : st.rate < 100 ? clamp(st.rate / 100, 0, 1) : st.rate > 120 ? clamp(1 - 0.012 * (st.rate - 120), 0.6, 1) : 1;
    const Qrec = 1 - 0.4 * (1 - st.recoilFrac);
    const obes = clamp((this.body.bmi - 30) / 20, 0, 1);
    const fMax = 0.30 * (1 - 0.15 * obes);                        // ~25-30% of normal output with perfect CPR (UNVERIFIED, widely quoted)
    let target = going ? fMax * Qd * Qr * Qrec : 0;
    if (active === false) target = 0;
    this.flow = lag(this.flow, target, dt, going ? 0.4 : 1.2);
    const ampT = going ? 85 * Qd * Qrec * clamp(st.rate / 100, 0.4, 1) : 0;
    this.amp = lag(this.amp, ampT, dt, going ? 0.4 : 1.5);
    st.quality = going ? Qd * Qr * Qrec : 0;
    this.stats = st;
  }
  /** chest-compression fraction over the time spent in arrest (AHA definition) */
  get ccf() { return this.arrestElapsedS > 0 ? this.arrestActiveS / this.arrestElapsedS : 0; }
}

export class Defibrillator {
  constructor(body) {
    this.body = body; this.padsOn = false; this.mode = 'async'; this.energy = 150; this.charged = false; this.chargeAt = null;
    this.impedance = clamp(70 + 1.5 * (body.bmi - 25), 50, 150);              // ohms (design: higher in obesity)
    this.shocks = []; this.syncArmed = false;
  }
  setEnergy(e) { this.energy = clamp(e, 1, 360); this.charged = false; this.chargeAt = null; }
  charge(t) { this.chargeAt = t + 4 + this.energy / 120; this.charged = false; }      // seconds to charge (design)
  tick(t) { if (this.chargeAt !== null && t >= this.chargeAt) { this.charged = true; } }
}

// Base probability that a biphasic shock terminates VF/pVT (REF pocock2022: 150 J -> ~90%, 200 J -> ~93%)
export const baseTermination = e => 0.95 * (1 - Math.exp(-e / 62));

export const CAUSES = {
  hypoxia:       { label: 'Hypoxia', fixedBy: 'Oxygenation/ventilation' },
  hypovolemia:   { label: 'Hypovolemia', fixedBy: 'Hemorrhage control + volume' },
  hyperkalemia:  { label: 'Hyperkalemia', fixedBy: 'Calcium, insulin/glucose, bicarbonate' },
  local_anaesthetic: { label: 'Local anaesthetic toxicity', fixedBy: 'Lipid emulsion 20 %' },
  acidosis:      { label: 'Acidosis', fixedBy: 'Ventilation' },
  hypothermia:   { label: 'Hypothermia', fixedBy: 'Rewarming' },
  tension_ptx:   { label: 'Tension pneumothorax', fixedBy: 'Needle decompression' },
  tamponade:     { label: 'Cardiac tamponade', fixedBy: 'Pericardiocentesis' },
  toxins:        { label: 'Toxins (opioid)', fixedBy: 'Naloxone + ventilation' },
  coronary_thrombosis: { label: 'Coronary thrombosis (STEMI)', fixedBy: 'PCI / reperfusion' },
  pulmonary_embolism: { label: 'Pulmonary embolism', fixedBy: 'Thrombolysis' },
};

export class ArrestState {
  constructor(rng, causes = []) {
    this.rng = rng; this.key = 'NSR'; this.tArrest = 0; this.tInRhythm = 0; this.arrested = false;
    this.readiness = 1; this.vfAmp = 1; this.cppGoodS = 0; this.roscCount = 0; this.rearrests = 0; this.shocksGiven = 0;
    this.causes = Object.fromEntries(causes.map(c => [c, true]));
    this.postRosc = false; this.tRosc = null; this.lvStun = 0; this.events = [];
    this.refibHazard = 0;
  }
  get info() { return RHYTHMS[this.key]; }
  setRhythm(key, t) { if (this.key !== key) { this.events.push({ t, type: 'rhythm', from: this.key, to: key }); this.key = key; this.tInRhythm = 0; } }
  /** a self-terminating run (torsades) gives back the rhythm it interrupted, without the post-arrest state */
  selfTerminate(t) { this.arrested = false; this.tArrest = 0; this.setRhythm(this.preKey && RHYTHMS[this.preKey].perfusing ? this.preKey : 'NSR', t); }
  arrest(key, t) { if (!this.arrested) this.preKey = this.key; this.startedAt = this.startedAt ?? t; this.arrestStarts = (this.arrestStarts || []).concat([t]); this.arrested = true; this.postRosc = false; this.tArrest = 0; this.setRhythm(key, t); this.cppGoodS = 0; if (key === 'VF' || key === 'TORSADES') this.vfAmp = 1; }
  fixCause(c) { if (this.causes[c]) this.causes[c] = false; }
  blocking() { return Object.entries(this.causes).filter(([k, v]) => v && k !== 'coronary_thrombosis').map(([k]) => k); }
  /** one step; ctx: {cpp, cprGoodFlow, epi (ng/mL), antiarr (0..1), t, spo2True, map} */
  step(dt, ctx) {
    this.tInRhythm += dt;
    const r = this.rng;
    if (!this.arrested) return null;
    this.tArrest += dt;
    this.cppAvg = this.cppAvg === undefined ? ctx.cpp : lag(this.cppAvg, ctx.cpp, dt, 12);   // coronary perfusion builds over many compressions; brief dips do not reset it (design)
    const goodCpp = this.cppAvg >= 15;                                  // REF paradis1990
    this.cppGoodS = goodCpp ? this.cppGoodS + dt : 0;
    const target = goodCpp ? clamp((this.cppAvg - 10) / 20, 0.2, 1) : 0;
    const tau = target > this.readiness ? 90 : 240;                     // improves in ~1.5 min of good CPP, decays over ~4 min without (design)
    this.readiness = lag(this.readiness, target, dt, tau);
    if (this.key === 'TORSADES') {                                      // most episodes stop on their own within a minute; the rest degenerate to VF; magnesium helps it stop (REF drew2010; rates REF design)
      const stop = (0.6 + 0.8 * (ctx.mg || 0)) / 60, decay = 0.5 / 60;
      if (this.tInRhythm > 8 && r.chance(1 - Math.exp(-stop * dt))) return 'SELF_TERM';
      if (this.tInRhythm > 30 && r.chance(1 - Math.exp(-decay * dt))) { this.setRhythm('VF', ctx.t); this.vfAmp = 1; }
      return null;
    }
    if (this.key === 'VF' || this.key === 'VT_PULSELESS') {
      this.vfAmp = clamp(this.vfAmp + (goodCpp ? 0.0006 : -1 / 480) * dt * 1.0, 0, 1);          // coarse VF fades to fine VF over ~8 min without flow (AMSA-type, UNVERIFIED) (REF amsa)
      if (this.vfAmp < 0.08 && this.tInRhythm > 60) this.setRhythm('ASYSTOLE', ctx.t);
      return null;
    }
    // non-shockable: spontaneous ROSC hazard when reversible causes are resolved and CPP is adequate
    if (this.key === 'PEA' || this.key === 'ASYSTOLE') {
      if (this.blocking().length === 0 && this.cppGoodS > 30) {
        // spontaneous-ROSC hazard per minute: higher when an identified reversible cause has been treated (design, calibrated to CARES/GWTG non-shockable ROSC ~25-60%)
        const causeTreated = Object.keys(this.causes).length > 0;
        let lam = (this.key === 'PEA' ? (causeTreated ? 0.07 : 0.03) : (causeTreated ? 0.02 : 0.008)) / 60 * (0.3 + 0.7 * this.readiness);   // per second
        if (ctx.epi > 0.5) lam *= 1.6;                                                       // REF aha2025_part9 (epinephrine increases ROSC; modest)
        if (r.chance(1 - Math.exp(-lam * dt))) return 'ROSC';
      }
      if (this.key === 'ASYSTOLE' && this.tArrest > 1500) this.events.push({ t: ctx.t, type: 'termination_futility' });
    }
    return null;
  }
  /** shock outcome */
  shock(energy, impedance, ctx) {
    this.shocksGiven++;
    if (!RHYTHMS[this.key].shockable) return { delivered: true, terminated: false, rosc: false, note: 'non-shockable rhythm' };
    let p = baseTermination(energy) * (1 - 0.15 * clamp((impedance - 75) / 60, 0, 1)) * (0.45 + 0.55 * this.readiness) * (0.5 + 0.5 * this.vfAmp);
    if (this.causes.coronary_thrombosis) p *= 0.92;
    p *= 1 + 0.06 * (ctx.antiarr || 0);
    const terminated = this.rng.chance(clamp(p, 0, 0.98));
    if (!terminated) return { delivered: true, terminated: false, rosc: false, p };
    // post-shock organized rhythm: ROSC vs PEA/asystole (REF cares2024: shockable arrests have ROSC 43.7% overall)
    const block = this.blocking().length > 0;
    let pr = clamp(0.20 + 0.78 * Math.pow(this.readiness, 1.2), 0, 0.95) * (block ? 0.25 : 1);
    const rosc = this.key === 'TORSADES' && this.tArrest < 120 ? true : this.rng.chance(pr);   // a brief torsades run on a healthy heart: the shock gives back the underlying rhythm (REF drew2010; REF design)
    return { delivered: true, terminated: true, rosc, p, pRosc: pr };
  }
  rosc(t) {
    this.arrested = false; this.postRosc = true; this.tRosc = t; this.roscCount++; this.lvStun = 0.4; this.tArrest = 0;
    this.setRhythm('SINUS_TACH', t);
  }
}
