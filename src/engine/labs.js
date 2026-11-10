// Point-of-care and laboratory tests: a sample freezes the patient's values at the moment it is drawn, and the result is
// released after a turnaround time. Only quantities the engine actually models are reported (electrolytes and glucose come
// from electrolytes.js; a blood gas analyser reports them with the gas, as point-of-care analysers do).
// Reading only: ordering a test never changes the physiology, so it cannot shift a trajectory or a replay hash.

export const LAB_KINDS = Object.freeze(['abg', 'lactate', 'chem', 'cbc']);

/** Turnaround from sampling to result, seconds. Point-of-care blood gas analysers report in about 1-2 min of analysis plus
 *  handling (REF design); a stat blood count or chemistry panel from the central laboratory within an hour (REF design; stat targets <= 60 min). */
export const TURNAROUND_S = Object.freeze({ abg: 180, lactate: 180, chem: 2700, cbc: 2700 });

/** Adult reference intervals used to flag results (REF textbook). */
export const RANGES = Object.freeze({
  ph: [7.35, 7.45], paco2: [35, 45], pao2: [80, 100], hco3: [22, 26], be: [-2, 2], sao2: [95, 100], lactate: [0.5, 2.0],
  na: [135, 145], k: [3.5, 5.0], ica: [1.15, 1.33], glucose: [3.9, 7.8],
  hb_M: [13.0, 17.0], hb_F: [12.0, 15.5], hct_M: [0.40, 0.50], hct_F: [0.36, 0.46],
});

/** Standard base excess (Van Slyke form, REF textbook) from HCO3- (mmol/L) and pH. */
export const baseExcess = (hco3, ph) => 0.93 * (hco3 - 24.4 + 14.83 * (ph - 7.40));

/** Values of a sample drawn now from the patient p. */
export function sampleValues(kind, p) {
  const r = p.resp, v = p.vol, e = p.lytes;
  const lytes = () => ({ na: +e.na.toFixed(0), k: +e.k.toFixed(1), glucose: +e.glucose.toFixed(1) });
  if (kind === 'abg') {
    const ph = +r.pH.toFixed(2), hco3 = +r.hco3.toFixed(1);
    return { ph, paco2: +r.paco2.toFixed(0), pao2: +r.pao2.toFixed(0), hco3, be: +baseExcess(r.hco3, r.pH).toFixed(1), sao2: +(r.sao2 * 100).toFixed(0), lactate: +r.lactate.toFixed(1), ...lytes(), ica: +e.ica.toFixed(2), fio2: +(r.fio2Eff ?? 0.21).toFixed(2) };
  }
  if (kind === 'lactate') return { lactate: +r.lactate.toFixed(1) };
  if (kind === 'chem') return lytes();                     // central laboratory: Na+, K+, glucose
  if (kind === 'cbc') return { hb: +v.hb.toFixed(1), hct: +v.hct.toFixed(2) };
  return null;
}

/** Flag each value against its reference interval: 'L', 'H' or ''. */
export function flags(values, sex) {
  const out = {};
  for (const [k, x] of Object.entries(values)) {
    const rk = RANGES[k] ? k : RANGES[`${k}_${sex === 'F' ? 'F' : 'M'}`] ? `${k}_${sex === 'F' ? 'F' : 'M'}` : null;
    if (!rk || k === 'fio2') { out[k] = ''; continue; }
    const [lo, hi] = RANGES[rk];
    out[k] = x < lo ? 'L' : x > hi ? 'H' : '';
  }
  return out;
}
