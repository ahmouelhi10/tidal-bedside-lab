// Debrief timeline: replays a recorded session exactly as replay() does (same spec, seed, scenario and ordered log) and
// samples the true physiology every few seconds, so the debrief curves are what actually happened. Sampling only reads
// the state, so the final hash equals the session's.
import { Patient } from './patient.js';

const SKIP = new Set(['note', 'nibp.cycle']);          // instructor changes stay in the events (drawn in their own colour)          // not shown as learner actions (notes are guided-step declarations; the cuff cycles automatically)

/** @returns {{t:number[], hr:number[], map:number[], spo2:number[], etco2:number[], rr:number[], arrested:number[], events:object[], hash:string, end:number}} */
export function buildTimeline({ spec, seed, scenario, log, until }, scenarios, stepS = 5) {
  const sc = scenario ? scenarios[scenario] : null;
  const p = new Patient(spec, { seed, scenario: sc });
  const out = { t: [], hr: [], map: [], spo2: [], etco2: [], rr: [], arrested: [], events: [] };
  const every = Math.max(1, Math.round(stepS / p.dt));
  let next = 0;
  const sample = () => { const s = p.snapshot(); out.t.push(s.t); out.hr.push(s.hr); out.map.push(s.map); out.spo2.push(s.spo2True); out.etco2.push(s.etco2); out.rr.push(s.rr); out.arrested.push(s.arrested ? 1 : 0); };
  const tickTo = (n) => { while (p.n < n) { if (p.n >= next) { sample(); next += every; } p.tick(1); } };
  for (const ev of log) {
    tickTo(Math.round(ev.t / p.dt));
    const { t, ...rest } = ev;
    const r = p.dispatch(rest);
    if (!SKIP.has(rest.type)) out.events.push({ t, type: rest.type, ok: !(r && r.ok === false), ev: rest });
  }
  const endT = until ?? (log.length ? log[log.length - 1].t : 0);
  tickTo(Math.round(endT / p.dt)); sample();
  out.hash = p.stateHash(); out.end = p.t;
  return out;
}

/** First time each key action happened (seconds), for the competency record. */
export function keyActionTimes(events) {
  const first = (pred) => { const e = events.find(x => x.ok && pred(x.ev)); return e ? e.t : null; };
  return {
    monitoring: first(e => e.type === 'monitor.attach'),
    ivAccess: first(e => e.type === 'iv.access' || e.type === 'io.access'),
    oxygen: first(e => e.type === 'o2.mask' || (e.type === 'vent.set' && e.settings?.mode === 'ctrl') || e.type === 'apox.set'),
    firstDrug: first(e => e.type === 'drug.bolus' || e.type === 'drug.infusion'),
    airwaySecured: first(e => e.type === 'airway.intubate' || e.type === 'procedure.cricothyroidotomy'),
    cprStart: first(e => e.type === 'cpr.start'),
    firstShock: first(e => e.type === 'defib.shock'),
    firstLab: first(e => e.type === 'lab.order'),
  };
}
