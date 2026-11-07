// Scripted "learners" used by the tests. They only use the public dispatch() API, exactly like the UI does.
import { Patient } from '../../src/engine/patient.js';
import { SCENARIOS } from '../../src/engine/scenarios.js';

export const mk = (spec = {}, opt = {}) => new Patient({ sex: 'M', age: 50, heightCm: 175, weightKg: 80, ...spec }, { seed: 1, ...opt });
export const scen = (id, seed = 1, specOverride = {}) => new Patient({ ...SCENARIOS[id].spec, ...specOverride }, { seed, scenario: SCENARIOS[id] });

/** run a time-ordered script [[t, event], ...]; ticks the engine between entries */
export function runScript(p, script, endT) {
  for (const [t, e] of script) { const steps = Math.round(t / p.dt) - p.n; if (steps > 0) p.tick(steps); p.dispatch(e); }
  const rest = Math.round(endT / p.dt) - p.n; if (rest > 0) p.tick(rest);
  return p;
}

/**
 * Guideline-following ALS team (closed loop). `skill` degrades timings/quality for sensitivity tests.
 * Returns the log of its decisions in p.log (all through dispatch()).
 */
export function aclsTeam(p, { endT = 1200, reaction = 10, depth = 5.5, rate = 110, delayShockS = 0, noCpr = false, airway = true, epiGapS = 240, rotate = true } = {}) {
  let started = false, tStart = null, lastCycle = 0, lastEpi = -1e9, airwayDone = false, roscCare = false, shocksThisArrest = 0, lastShockAt = -1e9;
  while (p.t < endT) {
    p.tick(10);                                                    // 1 s decision step
    const a = p.arrest;
    if (a.arrested && !started) {
      if (a.arrestStarts && p.t >= a.arrestStarts[0] + reaction) {
        started = true; tStart = p.t; lastCycle = p.t;
        p.dispatch({ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, capnography: true } });
        p.dispatch({ type: 'iv.access' });
        if (!noCpr) p.dispatch({ type: 'cpr.start', mode: 'auto', opts: { rate, depth, ratio: '30:2' }, surface: 'hard' });
        p.dispatch({ type: 'defib.pads' }); p.dispatch({ type: 'defib.setEnergy', energy: 200 });
        if (['VF', 'VT_PULSELESS'].includes(a.key)) p.dispatch({ type: 'defib.charge' });
      }
    }
    if (started && a.arrested) {
      const sinceStart = p.t - tStart;
      if (['VF', 'VT_PULSELESS'].includes(a.key) && p.defib.charged && p.t >= (a.arrestStarts[0] + reaction + delayShockS) && p.t - lastShockAt > 5) {
        p.dispatch({ type: 'note', text: 'guide defib: clear' });             // "stand clear, oxygen away"
        p.dispatch({ type: 'defib.shock' }); lastShockAt = p.t; shocksThisArrest++;
        if (!noCpr && p.arrest.arrested) p.dispatch({ type: 'cpr.start', mode: 'auto', opts: { rate, depth, ratio: '30:2' }, surface: 'hard' });
        lastCycle = p.t;
      }
      if (p.t - lastCycle >= 120) {                                // 2-min rhythm check + compressor swap
        lastCycle = p.t; if (!noCpr && rotate) p.dispatch({ type: 'cpr.switch' });
        if (['VF', 'VT_PULSELESS'].includes(a.key)) p.dispatch({ type: 'defib.charge' });
      }
      const epiDue = ['PEA', 'ASYSTOLE'].includes(a.key) ? sinceStart >= 15 : shocksThisArrest >= 2;
      if (epiDue && p.t - lastEpi >= epiGapS) { p.dispatch({ type: 'drug.bolus', drug: 'epinephrine', amount: 1000 }); lastEpi = p.t; }
      if (shocksThisArrest >= 3 && !p.drugs.log.some(d => d.key === 'amiodarone')) p.dispatch({ type: 'drug.bolus', drug: 'amiodarone', amount: 300 });
      if (airway && !airwayDone && sinceStart >= 90) {
        airwayDone = true;
        const r = p.dispatch({ type: 'airway.intubate' });
        p.pendingEvents.push({ at: p.t + (r.willTakeS || 30) + 1, run: q => { q.dispatch({ type: 'vent.set', settings: { mode: 'ctrl', rate: 10, vt: 6 * (q.body.pbw ?? 70) * 1.0, fio2: 1.0, peep: 5, seal: 0.95 } }); } });
        if (!r.ok) airwayDone = false;
      }
    }
    if (!a.arrested && a.postRosc && !roscCare && started) {
      roscCare = true;
      p.dispatch({ type: 'o2.mask', fio2: 0.5 });
      p.dispatch({ type: 'order', what: 'ecg12' }); p.dispatch({ type: 'order', what: 'temperature_control' });
    }
    if (!a.arrested && roscCare && p.t - (a.tRosc ?? 0) > 600) break;
  }
  return p;
}
