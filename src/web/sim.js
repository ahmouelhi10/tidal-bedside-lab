// Simulation runtime: owns the Patient, the fixed-step clock (with fast-forward), the event log and the server session.
import { Patient, DT } from '/engine/patient.js';
import { SCENARIOS, scoreSession } from '/engine/scenarios.js';
import { sendWithRetry } from './retry.js';

export const SPEEDS = [0, 1, 2, 5, 10, 30];

export class Sim extends EventTarget {
  constructor() {
    super();
    this.patient = null; this.scenarioId = null; this.session = null; this.speed = 1; this.acc = 0;
    this.online = null; this.previewPatient = null; this.feed = []; this.trend = []; this._trendT = -1; this.finished = false; this.maxStepsPerFrame = 600;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async probeServer() {
    try { const r = await fetch('/api/health', { cache: 'no-store' }); this.online = r.ok; } catch { this.online = false; }
    return this.online;
  }
  async scenarios() {
    if (this.online) { try { const r = await fetch('/api/scenarios'); if (r.ok) return await r.json(); } catch { /* fall through */ } }
    return Object.values(SCENARIOS).map(({ id, title, difficulty, durationS, kind, summary, spec, learning }) => ({ id, title, difficulty, durationS, kind, summary, spec, learning }));
  }

  /** Start a session. The server issues the seed when reachable; offline it is drawn locally. */
  async start({ scenarioId = null, spec = {}, learner = '' } = {}) {
    let seed, bodySpec, sessionId = null;
    const base = scenarioId ? SCENARIOS[scenarioId].spec : { sex: 'M', age: 45, heightCm: 175, weightKg: 80 };
    if (this.online) {
      try {
        const r = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: scenarioId, spec, learner }) });
        if (r.ok) { const s = await r.json(); seed = s.seed; bodySpec = s.spec; sessionId = s.id; }
      } catch { this.online = false; }
    }
    if (seed === undefined) { seed = (crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646) + 1; bodySpec = { ...base, ...spec }; }
    this.scenarioId = scenarioId; this.session = { id: sessionId, seed, spec: bodySpec };
    this.patient = new Patient(bodySpec, { seed, scenario: scenarioId ? SCENARIOS[scenarioId] : null });
    this.acc = 0; this.feed = []; this.trend = []; this._trendT = -1; this.finished = false; this.speed = 1; this.lastNoteIdx = 0; this._seenEvents = 0;
    this.emit('started', { scenarioId });
    return this.patient;
  }

  /** Throw-away resting patient used only to show the body being built in the case menu (never scored, never sent to the server). */
  setPreview(spec) {
    try { const q = new Patient({ sex: 'M', age: 45, heightCm: 175, weightKg: 80, ...spec }, { seed: 1 }); q.run(8); this.previewPatient = q; return q; }
    catch { return this.previewPatient; }
  }
  get t() { return this.patient ? this.patient.t : 0; }
  setSpeed(i) { this.speed = SPEEDS.includes(i) ? i : 1; this.emit('speed', this.speed); }

  /** Advance by a real elapsed time (s). */
  frame(realDt) {
    const p = this.patient; if (!p || this.finished || this.speed === 0) return 0;
    this.acc += Math.min(realDt, 0.25) * this.speed;
    let steps = Math.floor(this.acc / DT); if (steps > this.maxStepsPerFrame) { steps = this.maxStepsPerFrame; this.acc = steps * DT; }
    if (steps > 0) { p.tick(steps); this.acc -= steps * DT; this._afterTicks(); }
    return steps;
  }
  _afterTicks() {
    const p = this.patient;
    if (p.t - this._trendT >= 2) {
      this._trendT = p.t;
      this.trend.push({ t: p.t, hr: p.circ.hr, map: p.circ.mapArt, spo2: p.resp.spo2, etco2: p.resp.etco2, ce: p.drugs.ce('propofol') });
      if (this.trend.length > 400) this.trend.shift();
    }
    // surface engine notes and arrest events once
    while (this.lastNoteIdx < p.notes.length) { const n = p.notes[this.lastNoteIdx++]; if (!n.text.startsWith('instructor:')) this.emit('note', n); }   // the instructor's changes and markers stay hidden from the learner
    const ev = p.arrest.events;
    while (this._seenEvents < ev.length) { const e = ev[this._seenEvents++]; this.emit('engineEvent', e); }
  }

  /** The only way the UI changes the patient. */
  act(event) {
    const p = this.patient; if (!p || this.finished) return { ok: false, error: 'no active session' };
    const r = p.dispatch(event);
    if (event.type !== 'instructor.inject') this.emit('action', { event, result: r, t: p.t });   // not announced to the learner: the patient simply changes
    return r;
  }

  score() { return this.patient && this.patient.scenario ? scoreSession(this.patient) : null; }

  /** End the session; submit the log for authoritative verification if a server session exists. */
  async finish() {
    const p = this.patient; if (!p) return null;
    this.finished = true;
    const local = this.score(); const out = { local, server: null, online: Boolean(this.session.id) };
    if (this.session.id) {
      try {
        const body = JSON.stringify({ log: p.log, until: +p.t.toFixed(3), hash: p.stateHash() });
        const r = await sendWithRetry(() => fetch(`/api/sessions/${this.session.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }));   // a busy server (a whole class finishing at once): try again
        if (r.ok) out.server = (await r.json()).result; else out.error = (await r.json().catch(() => ({}))).error || String(r.status);
      } catch (e) { out.error = String(e && e.message || e); out.online = false; }
    }
    this.emit('finished', out);
    return out;
  }
}
