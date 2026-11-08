// Effect tracker: after an intervention, report what the monitor shows changing at +30 s, +1, +3 and +5 min of simulated
// time. It only reads displayed (monitored) values, so it never reveals more than the bedside monitor would; with nothing
// connected it says so. Reading only: it never changes the engine.
const WATCH = new Set(['drug.bolus', 'drug.infusion', 'drug.stop', 'bicarb.bolus', 'fluid.bolus', 'blood.transfuse', 'bleed.set', 'bleed.control',
  'o2.mask', 'apox.set', 'vent.set', 'airway.intubate', 'airway.set', 'position.set', 'defib.shock', 'procedure.needle_decompression',
  'procedure.chest_tube', 'procedure.pericardiocentesis', 'procedure.cricothyroidotomy', 'procedure.treat_hyperkalemia', 'procedure.thrombolysis', 'procedure.pci', 'thermal.device']);
export const CHECKS = [30, 60, 180, 300];
/** [key, minimum change worth reporting] */
const VITALS = [['hr', 8], ['map', 8], ['spo2', 3], ['etco2', 5], ['rr', 4]];

export function readVitals(p) {
  const m = p.monitor || {};
  return { hr: m.hr ?? null, map: m.map ?? null, spo2: m.spo2 ?? null, etco2: m.etco2 ?? null, rr: m.rr ?? null, rhythm: p.flags?.ecgLeads ? p.arrest?.key : null };
}

/** Significant changes between two readings: [{ k, from, to, dir }] plus rhythm changes and apnoea. */
export function diffVitals(a, b) {
  const out = [];
  for (const [k, min] of VITALS) {
    if (a[k] == null || b[k] == null) continue;
    const d = b[k] - a[k];
    if (k === 'rr' && a.rr > 0 && b.rr === 0) { out.push({ k: 'apnoea', from: a.rr, to: 0, dir: -1 }); continue; }
    if (Math.abs(d) >= min) out.push({ k, from: Math.round(a[k]), to: Math.round(b[k]), dir: Math.sign(d) });
  }
  if (a.rhythm && b.rhythm && a.rhythm !== b.rhythm) out.push({ k: 'rhythm', from: a.rhythm, to: b.rhythm, dir: 0 });
  return out;
}
const anyMonitored = (v) => VITALS.some(([k]) => v[k] != null);

export class EffectWatcher {
  constructor(report) { this.report = report; this.items = []; }
  reset() { this.items = []; }
  watch(ev, result, p, label) {
    if (!WATCH.has(ev.type) || (result && result.ok === false) || !p) return;
    this.items.push({ label, t0: p.t, base: readVitals(p), i: 0, said: false });
    if (this.items.length > 6) this.items.shift();
  }
  tick(p) {
    if (!p) return;
    for (const w of this.items) {
      while (w.i < CHECKS.length && p.t - w.t0 >= CHECKS[w.i]) {
        const now = readVitals(p), at = CHECKS[w.i], last = w.i === CHECKS.length - 1;
        if (!anyMonitored(now)) { if (!w.unmon) { w.unmon = true; this.report({ label: w.label, at, unmonitored: true }); } }
        else {
          const ch = diffVitals(w.base, now), key = ch.map(c => `${c.k}${c.to}`).join(',');
          if (ch.length && key !== w.lastKey) { this.report({ label: w.label, at, changes: ch }); w.said = true; w.lastKey = key; }
          else if (last && !w.said) this.report({ label: w.label, at, changes: [] });
        }
        w.i++;
      }
    }
    this.items = this.items.filter(w => w.i < CHECKS.length);
  }
}
