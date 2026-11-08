// Drug timing for the drug panel, for the patient being treated:
//  - "visible on the monitor": a throw-away copy of the patient (same body, fully monitored with an arterial line) gets the
//    panel's default bolus; the first monitored sign that changes beyond the effect-tracker thresholds, and when.
//  - "peak at the site of action": time to the peak effect-site concentration of that drug's published PK model
//    (ke0 / compartments in /engine/drugs.js), the classical t_peak of pharmacology.
// Reading only: the live session is never touched. Results are cached per body.
import { Patient } from '/engine/patient.js';
import { PKModel } from '/engine/pk.js';
import { DRUGS, IV_TRANSIT_S } from '/engine/drugs.js';
import { readVitals, diffVitals } from './effects.js';

const HORIZON_S = 300;       // look for a visible change over 5 minutes
const cache = new Map();     // key = body + drug + dose -> result

const bodyKey = (s) => `${s.sex}|${s.age}|${s.heightCm}|${s.weightKg}`;

/** Time (s) to the peak effect-site concentration after a bolus, from the drug's PK model for this body. */
export function peakEffectS(patient, drug) {
  const params = patient.drugs._params(drug); if (!params) return null;
  const m = new PKModel(params, 1); m.bolus(1);
  let best = 0, at = 0;
  for (let s = 1; s <= 1800; s++) { m.step(); if (m.ce > best) { best = m.ce; at = s; } else if (m.ce < best * 0.98) break; }
  return at + (DRUGS[drug]?.transit ? IV_TRANSIT_S : 0);           // drugs given peripherally first travel arm -> heart
}

/** First visible change on a fully monitored copy of the patient after the default bolus. */
export function monitorOnset(spec, drug, dose) {
  const key = `${bodyKey(spec)}|${drug}|${dose}`;
  if (cache.has(key)) return cache.get(key);
  const p = new Patient({ sex: spec.sex, age: spec.age, heightCm: spec.heightCm, weightKg: spec.weightKg }, { seed: 1 });
  p.dispatch({ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, capnography: true, aline: true } });
  p.dispatch({ type: 'iv.access' });
  p.tick(50);
  const base = readVitals(p), t0 = p.t;
  const r = p.dispatch({ type: 'drug.bolus', drug, amount: dose });
  let out = { onsetS: null, sign: null };
  if (!(r && r.ok === false)) {
    for (let s = 1; s <= HORIZON_S; s++) {
      p.tick(10);
      const ch = diffVitals(base, readVitals(p));
      if (ch.length) { out = { onsetS: Math.round(p.t - t0), sign: ch[0] }; break; }
    }
  }
  out.peakS = peakEffectS(p, drug);
  cache.set(key, out);
  return out;
}
