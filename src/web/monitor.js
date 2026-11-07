// Patient monitor: synthesises ECG / pleth / arterial / capnography waveforms from engine state and draws them as a sweeping
// bedside monitor. Waveforms run in real time (not sim time) so fast-forward does not turn them into noise.
import { t as tr } from './i18n.js';

const TAU = Math.PI * 2;
// Same vital-sign colours as the --v-* tokens in styles.css. Numerics use the system UI font with tabular figures, like current monitors.
const COL = { hr: '#3ee08f', spo2: '#4cd7ff', abp: '#ff5d6c', nibp: '#f2f5f8', co2: '#ffd23d', temp: '#ff8fd0', off: '#2b3540', bg: '#04070a', grid: 'rgba(120,160,190,0.07)', line: 'rgba(255,255,255,0.07)', text2: '#8c99a6' };
const UI = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const g = (x, c, w) => Math.exp(-((x - c) * (x - c)) / (2 * w * w));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Small deterministic-per-instance PRNG for display noise only (never feeds the engine). */
function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

class EcgGen {
  constructor() { this.rnd = mulberry(7); this.t = 0; this.lastR = -1; this.nextR = 0.3; this.nextP = 0.2; this.vf = [0, 0, 0, 0]; this.vfF = [4.1, 5.3, 6.4, 7.7]; this.rBeat = false; this.pAt = -9; }
  /** returns mV-like value; sets this.rBeat true for the sample at which an R wave occurs */
  step(dt, c) {
    this.t += dt; this.rBeat = false; const rnd = this.rnd; let v = 0;
    const key = c.rhythm, hr = clamp(c.hr || 60, 20, 300), rr = 60 / hr;
    const wide = key === 'VT_PULSE' || key === 'VT_PULSELESS' || key === 'PEA' || key === 'AV_BLOCK3';
    if (key === 'VF') {
      const a = clamp(c.vfAmp ?? 0.8, 0.05, 1.4);
      for (let i = 0; i < 4; i++) { this.vf[i] += TAU * (this.vfF[i] + 0.9 * Math.sin(this.t * (0.7 + i * 0.31))) * dt; v += Math.sin(this.vf[i] + i) * (0.5 - i * 0.08); }
      v *= a * (0.6 + 0.4 * Math.sin(this.t * 1.7 + 1));
    } else if (key === 'ASYSTOLE' || !key) {
      v = 0.02 * Math.sin(this.t * 0.9) + 0.015 * (rnd() - 0.5);
    } else if (key === 'VT_PULSE' || key === 'VT_PULSELESS') {
      const f = hr / 60; v = 0.75 * Math.sin(TAU * f * this.t) + 0.25 * Math.sin(TAU * 2 * f * this.t + 0.8);
      if (!this._vtLast || this.t - this._vtLast > rr) { this._vtLast = this.t; this.rBeat = true; }
    } else {
      if (this.t >= this.nextR) {
        this.lastR = this.nextR; this.rBeat = true;
        const jitter = key === 'AF' ? (rnd() - 0.5) * 0.7 * rr : 0;
        this.nextR = this.lastR + Math.max(0.2, rr + jitter);
      }
      const tau = this.t - this.lastR, tn = this.t - this.nextR;
      if (wide) {
        const amp = key === 'PEA' ? 0.55 : 0.9;
        v = amp * g(tau, 0.03, 0.045) - 0.18 * g(tau, 0.12, 0.05) - 0.35 * amp * g(tau, 0.30, 0.07);
      } else {
        v = 1.0 * g(tau, 0, 0.011) - 0.12 * g(tau, -0.028, 0.008) - 0.26 * g(tau, 0.026, 0.010) + (key === 'SVT' ? 0.10 : 0.28) * g(tau, Math.min(0.24, rr * 0.38), 0.045);
        if (key !== 'AF' && key !== 'SVT') v += 0.12 * g(tn, -0.16, 0.025);
        if (key === 'AF') v += 0.035 * Math.sin(TAU * 7.3 * this.t) + 0.03 * (rnd() - 0.5);
      }
      if (key === 'AV_BLOCK3') { const pr = this.t % 0.8; v += 0.14 * g(pr, 0.2, 0.025); }
    }
    v += 0.012 * (rnd() - 0.5) + 0.02 * Math.sin(TAU * 0.25 * this.t);
    if (c.cprHz > 0) v += c.cprAmp * (Math.sin(TAU * c.cprHz * this.t) + 0.35 * Math.sin(TAU * 2 * c.cprHz * this.t + 1.1));
    if (c.shock > 0) v = c.shock * 3.0 * (c.shock > 0.5 ? 1 : -1) * (this.rnd() > 0.5 ? 1 : 0.4);
    return v;
  }
}

/** arterial / pleth pulse shape on a 0..1 scale as a function of time since beat onset (s) */
function pulseShape(tau, rr) {
  if (tau < 0) return 0;
  const up = 1 - Math.exp(-tau / 0.045), dn = Math.exp(-tau / (0.22 + 0.12 * Math.min(rr, 1.2)));
  return clamp(up * dn * 1.35 + 0.16 * g(tau, 0.34, 0.05), 0, 1.1);
}

export class Monitor {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.ecg = new EcgGen(); this.t = 0; this.trace = { x: [0, 0, 0, 0], y: [null, null, null, null] };
    this.beats = []; this.compBeats = []; this.lastRT = -9; this.breathPhase = 0; this.lastComp = -1; this.shock = 0;
    this.pxPerSec = 90; this.sound = null; this.flash = 0; this.lastBeepR = -1; this.alarmT = 0; this.nibpAt = null;
    this.onBeat = null;
  }
  setSound(s) { this.sound = s; }
  shockFlash() { this.shock = 0.18; }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), c = this.cv, w = Math.max(200, Math.floor(c.clientWidth * dpr)), h = Math.max(120, Math.floor(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; this.trace.x = [0, 0, 0, 0]; this.trace.y = [null, null, null, null]; this.ctx.fillStyle = COL.bg; this.ctx.fillRect(0, 0, w, h); this.dpr = dpr; this._layout = null; }
    this.dpr = dpr;
  }

  /** Advance waveform time by realDt (s) and draw. sim: Sim; p: Patient. */
  update(realDt, p) {
    this.resize(); const ctx = this.ctx, W = this.cv.width, H = this.cv.height, d = this.dpr;
    const m = p.monitor, f = p.flags, arrested = p.arrest.arrested, key = f.ecgLeads ? p.arrest.key : null;
    const numW = Math.floor(W * 0.3), trW = W - numW - Math.round(2 * d), rowH = H / 4, gridStep = 20 * d;
    const dt = clamp(realDt, 0, 0.1), step = 1 / 240; let rem = dt;
    const cprHz = p.cpr.stats && p.cpr.stats.lastAge < 1.5 && p.cpr.stats.rate > 0 && arrested ? p.cpr.stats.rate / 60 : 0;
    const perf = p.arrest.info.perfusing && p.circ.sbp > 40;
    const sbp = p.circ.sbp, dbp = p.circ.dbp, rr = 60 / clamp(p.circ.hr || 70, 30, 250);
    const respRR = p.resp.rr, etco2 = p.resp.etco2;
    // capnography breath rate: controlled ventilation during 30:2 CPR arrives as discrete breaths (display at the engine's effective rate)
    const capRR = respRR > 0.5 ? respRR : 0;
    // detect new compression events to draw CPR pulses on the pressure/pleth traces
    const evs = p.cpr.events; const newest = evs.length ? evs[evs.length - 1].t : -1;
    if (arrested && newest > this.lastComp && cprHz > 0) { this.compBeats.push(this.t); this.lastComp = newest; }
    if (!arrested) this.lastComp = newest;
    if (p.shockLog.length && p.shockLog[p.shockLog.length - 1].t !== this._lastShockT) { this._lastShockT = p.shockLog[p.shockLog.length - 1].t; this.shock = 0.18; }

    const rows = [
      { name: 'II', color: COL.hr, on: f.ecgLeads, probe: f.ecgLeads, label: tr('mon_ii'), scale: 'x1' },
      { name: 'PLETH', color: COL.spo2, on: f.spo2Probe && (perf || cprHz > 0), probe: f.spo2Probe, label: tr('mon_pleth'), scale: '' },
      { name: 'ABP', color: COL.abp, on: f.aline, probe: f.aline, label: tr('mon_abp'), scale: '0-160' },
      { name: 'CO2', color: COL.co2, on: f.capnography, probe: f.capnography, label: tr('mon_co2'), scale: '0-60' },
    ];
    // clear + draw
    while (rem > 1e-6) {
      const h = Math.min(step, rem); rem -= h; this.t += h;
      this.shock = Math.max(0, this.shock - h);
      const ctxE = { rhythm: key, hr: m.hr || p.circ.hr, vfAmp: p.arrest.vfAmp, cprHz, cprAmp: 0.55, shock: this.shock };
      const e = this.ecg.step(h, ctxE);
      if (this.ecg.rBeat && f.ecgLeads) { this.beats.push(this.t); this.flash = 1; if (this.onBeat && (perf || key === 'PEA')) this.onBeat(m.spo2); }
      this.beats = this.beats.filter(b => this.t - b < 2.5); this.compBeats = this.compBeats.filter(b => this.t - b < 2);
      // pleth / ABP from last pulse-onset (delay 0.18 s after R)
      let tauP = 99; for (const b of this.beats) tauP = Math.min(tauP, this.t - b - 0.18);
      let pulse = perf && tauP >= 0 ? pulseShape(tauP, rr) : 0;
      let tauC = 99; for (const b of this.compBeats) tauC = Math.min(tauC, this.t - b - 0.02);
      const cprFlow = p.cpr.flow;
      const cprPulse = arrested && cprHz > 0 && tauC >= 0 ? pulseShape(tauC, 0.55) * clamp(cprFlow * 2.2, 0.15, 1) : 0;
      const amp = perf ? clamp((sbp - dbp) / 40, 0.25, 1.4) : 0;
      const plethV = perf ? pulse * amp : cprPulse * 0.5;
      const abpV = perf ? dbp + pulse * (sbp - dbp) : (arrested ? Math.max(5, p.circ.dbp) + cprPulse * Math.max(0, (p.circ.sbp - p.circ.dbp)) : 0);
      // capnogram
      let co2V = 0;
      if (capRR > 0) {
        this.breathPhase = (this.breathPhase + h * capRR / 60) % 1; const ph = this.breathPhase;
        co2V = ph < 0.38 ? 0 : ph < 0.44 ? (ph - 0.38) / 0.06 * 0.92 : 0.92 + (ph - 0.44) / 0.56 * 0.10;
        co2V *= etco2;
      }
      const vals = [e, plethV, abpV, co2V];
      const scales = [(v) => -v * 0.30, (v) => -(v - 0.0) * 0.5 + 0.18, (v) => -((v - 0) / 140) * 0.8 + 0.4, (v) => -(v / 60) * 0.8 + 0.4];
      for (let i = 0; i < 4; i++) {
        const row = rows[i]; const x0 = this.trace.x[i], x1 = (x0 + h * this.pxPerSec * d) % trW;
        const y0 = this.trace.y[i];
        const y = i === 0 ? rowH * (0.52 + scales[0](vals[0])) : rowH * (0.14 + 0.76 * (i === 1 ? clamp(0.88 - vals[1] * 0.62, 0.06, 0.92) : i === 2 ? clamp(0.9 - vals[2] / 190 * 0.8, 0.05, 0.95) : clamp(0.9 - vals[3] / 60 * 0.8, 0.05, 0.95)));
        const yy = i * rowH + (row.on ? y : rowH * 0.5);
        // erase ahead of the sweep, then put the faint grid back in the cleared strip
        const eraseW = 16 * d, top = i * rowH, strip = (x) => {
          ctx.fillStyle = COL.bg; ctx.fillRect(x, top, eraseW, rowH);
          ctx.fillStyle = COL.grid;
          for (let gx = Math.ceil(x / gridStep) * gridStep; gx < x + eraseW; gx += gridStep) ctx.fillRect(gx, top + 2 * d, 1, rowH - 4 * d);
          for (let k = 1; k < 4; k++) ctx.fillRect(x, top + (rowH * k) / 4, eraseW, 1);
        };
        if (x1 >= x0) strip(x1); else { strip(x1); strip(0); }
        ctx.strokeStyle = row.on ? row.color : COL.off; ctx.lineWidth = (row.on ? 2.2 : 1.4) * d; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        if (row.on) { ctx.shadowColor = row.color; ctx.shadowBlur = 6 * d; }
        if (y0 !== null && x1 >= x0) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, yy); ctx.stroke(); }
        ctx.shadowBlur = 0;
        this.trace.x[i] = x1; this.trace.y[i] = (x1 >= x0) ? yy : null;
      }
    }
    // static labels + numerics (redrawn each frame on a clean panel)
    ctx.fillStyle = COL.bg; ctx.fillRect(trW, 0, W - trW, H);
    for (let i = 0; i < 4; i++) {
      const row = rows[i], y = i * rowH;
      // label chip: lead / channel name in its colour, scale in grey; status message when the sensor is off
      ctx.fillStyle = COL.bg; ctx.fillRect(0, y + 2 * d, 112 * d, 34 * d);
      ctx.font = `700 ${11 * d}px ${UI}`; ctx.textBaseline = 'top'; ctx.fillStyle = row.on || row.probe ? row.color : COL.text2;
      ctx.fillText(row.label, 8 * d, y + 6 * d);
      const lw = ctx.measureText(row.label).width;
      if (row.scale) { ctx.font = `500 ${10 * d}px ${UI}`; ctx.fillStyle = COL.text2; ctx.fillText(row.scale, 8 * d + lw + 7 * d, y + 7 * d); }
      ctx.font = `600 ${10.5 * d}px ${UI}`;
      if (!row.probe) { ctx.fillStyle = COL.text2; ctx.fillText(tr('mon_off'), 8 * d, y + 21 * d); }
      else if (i === 0 && key) { ctx.fillStyle = key === 'NSR' || key === 'SINUS' ? '#c9d6e2' : '#ff8b95'; ctx.fillText(key.replace(/_/g, ' '), 8 * d, y + 21 * d); }
      else if (i === 3 && capRR === 0) { ctx.fillStyle = '#ffb35c'; ctx.fillText('APNEA', 8 * d, y + 21 * d); }
      if (i < 3) { ctx.fillStyle = COL.line; ctx.fillRect(0, y + rowH - 1, trW, 1); }
    }
    ctx.fillStyle = COL.line; ctx.fillRect(trW, 0, 1, H);
    this._numerics(ctx, trW, numW, H, d, m, p, rows);
    if (this.shock > 0.02) { ctx.fillStyle = `rgba(255,255,255,${Math.min(0.5, this.shock * 3)})`; ctx.fillRect(0, 0, trW, H); }
  }

  _numerics(ctx, x0, w, H, d, m, p, rows) {
    x0 += 1 * d; w -= 1 * d;
    const alarm = {
      hr: m.hr !== null && (m.hr < 50 || m.hr > 120), spo2: m.spo2 !== null && m.spo2 < 90, map: m.map !== null && m.map < 65,
      etco2: m.etco2 !== null && (m.etco2 > 50 || (m.etco2 < 25 && !p.arrest.arrested)),
    };
    const blink = Math.floor(this.t * 2) % 2 === 0, gap = 2 * d, pad = 9 * d;
    const tiles = [1.25, 1.05, 1.05, 1.05, 0.8], sum = tiles.reduce((a, b) => a + b, 0);
    let y = 0;
    const tile = (k, { label, unit, color, big, sub, lim, isAlarm, dim }) => {
      const hgt = (H * tiles[k]) / sum - gap;
      ctx.fillStyle = isAlarm ? (blink ? 'rgba(255,60,75,0.32)' : 'rgba(255,60,75,0.14)') : 'rgba(255,255,255,0.025)';
      ctx.fillRect(x0 + gap, y + gap, w - 2 * gap, hgt);
      if (isAlarm) { ctx.fillStyle = '#ff5d6c'; ctx.fillRect(x0 + gap, y + gap, 3 * d, hgt); }
      ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      ctx.font = `700 ${10.5 * d}px ${UI}`; ctx.fillStyle = dim ? COL.text2 : color; ctx.fillText(label, x0 + pad, y + gap + 6 * d);
      const roomy = w > 118 * d;                                               // small monitor: no unit / limits, the number keeps its room
      if (unit && roomy) { ctx.font = `500 ${10 * d}px ${UI}`; ctx.fillStyle = COL.text2; ctx.textAlign = 'right'; ctx.fillText(unit, x0 + w - pad, y + gap + 6 * d); ctx.textAlign = 'left'; }
      if (lim && roomy) { ctx.font = `500 ${9 * d}px ${UI}`; ctx.fillStyle = COL.text2; ctx.fillText(lim[0], x0 + pad, y + gap + 21 * d); ctx.fillText(lim[1], x0 + pad, y + gap + 31 * d); }
      // the big number fills the tile, right aligned, tabular figures
      // the digits must sit below the label row and above the sub line: cap height is about 0.72 of the font size
      const room = hgt - 22 * d - (sub ? 17 * d : 7 * d);
      let fs = Math.max(10 * d, Math.min(room / 0.74, 54 * d)); const maxW = w - 2 * pad - (lim && roomy ? 26 * d : 0);
      const setF = () => { ctx.font = `600 ${fs}px ${UI}`; };
      setF(); while (ctx.measureText(big).width > maxW && fs > 10 * d) { fs -= 2 * d; setF(); }
      ctx.fillStyle = dim ? '#3c4752' : color; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(big, x0 + w - pad, y + gap + hgt - (sub ? 18 * d : 8 * d));
      if (sub) { ctx.font = `600 ${11 * d}px ${UI}`; ctx.fillStyle = dim ? '#3c4752' : COL.text2; ctx.fillText(sub, x0 + w - pad, y + gap + hgt - 5 * d); }
      ctx.textAlign = 'left'; y += hgt + gap;
    };
    const dash = '--', ibp = p.flags.aline;
    const nibpAge = p.nibp.t !== null && p.nibp.t !== undefined ? Math.max(0, Math.floor(p.t - p.nibp.t)) : null;
    tile(0, { label: tr('mon_hr'), unit: 'bpm', color: COL.hr, big: m.hr === null ? dash : String(m.hr), lim: ['120', '50'], isAlarm: alarm.hr, dim: m.hr === null });
    tile(1, { label: tr('mon_spo2'), unit: '%', color: COL.spo2, big: m.spo2 === null ? dash : String(m.spo2), lim: ['100', '90'], isAlarm: alarm.spo2, dim: m.spo2 === null });
    tile(2, { label: ibp ? tr('mon_abp') : tr('mon_nibp'), unit: 'mmHg', color: ibp ? COL.abp : COL.nibp, big: m.sbp === null ? dash : `${m.sbp}/${m.dbp}`,
      sub: m.map !== null ? `(${m.map})${!ibp && nibpAge !== null ? '  ' + Math.floor(nibpAge / 60) + ':' + String(nibpAge % 60).padStart(2, '0') : ''}` : '', isAlarm: alarm.map, dim: m.sbp === null });
    tile(3, { label: tr('mon_etco2'), unit: 'mmHg', color: COL.co2, big: m.etco2 === null ? dash : String(m.etco2), sub: m.rr !== null ? `${tr('mon_rr')} ${m.rr}` : '', lim: ['50', '25'], isAlarm: alarm.etco2, dim: m.etco2 === null });
    tile(4, { label: tr('mon_temp'), unit: '°C', color: COL.temp, big: m.temp === null ? dash : m.temp.toFixed(1), dim: m.temp === null });
  }
}

/** Tiny WebAudio sound: pulse-oximeter beep (pitch follows SpO2) and a rhythm alarm. Created on first user gesture. */
export class MonitorSound {
  constructor() { this.ctx = null; this.on = false; this.lastAlarm = 0; }
  enable(v) { this.on = v; if (v && !this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ctx = null; this.on = false; } } if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  beep(spo2) { if (!this.on || !this.ctx) return; this.tone(spo2 == null ? 760 : 560 + clamp(spo2 - 70, 0, 30) * 12, 0.06, 0.05); }
  alarm(now) { if (!this.on || !this.ctx || now - this.lastAlarm < 2.0) return; this.lastAlarm = now; [0, 0.16, 0.32].forEach(dl => this.tone(1000, 0.1, 0.06, dl)); }
  tone(freq, dur, gain, delay = 0) {
    const a = this.ctx, o = a.createOscillator(), gnode = a.createGain(), t0 = a.currentTime + delay;
    o.type = 'sine'; o.frequency.value = freq; gnode.gain.setValueAtTime(0, t0); gnode.gain.linearRampToValueAtTime(gain, t0 + 0.005); gnode.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(gnode).connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  }
}
