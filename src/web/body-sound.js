// What the learner hears from the patient (display only): the spoken lines (the browser's own speech synthesis, no network)
// and the stethoscope (synthesised with WebAudio from voice.js auscultation(): no audio files). Both follow the monitor's
// sound switch, and share its AudioContext.
//  - auscultate(): two breaths over the right lung, then two over the left (7-16 s) (so a silent side stands out), each breath a filtered noise, louder
//    breathing in than out; wheeze = high tones while breathing out; crackles = short clicks at the end of breathing in; the heart
//    sounds (lub-dub) underneath at the patient's rate, quieter when muffled.
//  - speak(): a short line, slower and breathier when the patient is short of breath; a higher voice for a woman.
// Sound shapes (frequencies, gains, durations) are design values tuned by ear.

export class BodySound {
  constructor(sound) { this.sound = sound; this.noise = null; this.busyUntil = 0; }
  get ctx() { return this.sound?.on ? this.sound.ctx : null; }
  _noise(a) {
    if (this.noise) return this.noise;
    const n = a.sampleRate * 2, b = a.createBuffer(1, n, a.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;     // white noise (display only: not the engine's random stream)
    return (this.noise = b);
  }
  _burst(a, out, t0, dur, { gain, lo, hi, attack = 0.25 }) {         // a breath: band-passed noise, smooth rise and fall
    const s = a.createBufferSource(); s.buffer = this._noise(a); s.loop = true;
    const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = Math.sqrt(lo * hi); bp.Q.value = Math.sqrt(lo * hi) / (hi - lo);
    const g = a.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + dur * attack); g.gain.linearRampToValueAtTime(0, t0 + dur);
    s.connect(bp).connect(g).connect(out); s.start(t0, Math.random()); s.stop(t0 + dur + 0.05);
  }
  _tone(a, out, t0, dur, f0, f1, gain, type = 'sine') {
    const o = a.createOscillator(), g = a.createGain(); o.type = type; o.frequency.setValueAtTime(f0, t0); o.frequency.linearRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.02, dur / 4)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  /** a: voice.js auscultation(). Returns the seconds it lasts (0 when the sound is off). */
  auscultate(a) {
    const ac = this.ctx; if (!ac || !a) return 0;
    if (ac.state === 'suspended') ac.resume();
    const now = ac.currentTime + 0.05, PART = a.rr > 0 ? Math.min(8, Math.max(3.4, 2 * 60 / a.rr + 0.3)) : 3.4, out = ac.createGain();   // two full breaths on each side out.gain.value = 0.9;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400; out.connect(lp).connect(ac.destination);   // the stethoscope cuts the highs
    ['R', 'L'].forEach((side, k) => {
      const t0 = now + k * (PART + 0.3), amp = a.breath[side];
      if (a.rr > 0) {
        const T = 60 / a.rr;
        for (let tb = t0 + 0.1; tb < t0 + PART - 0.3; tb += T) {
          const ti = Math.min(a.ti, T * 0.45), te = Math.min(T - ti, ti * 1.3);
          if (amp > 0) { this._burst(ac, out, tb, ti, { gain: 0.22 * amp, lo: 180, hi: 650 }); this._burst(ac, out, tb + ti, te, { gain: 0.08 * amp, lo: 150, hi: 450, attack: 0.1 }); }
          if (a.wheeze > 0.05 && amp > 0) [430, 610].forEach((f, j) => this._tone(ac, out, tb + ti + 0.05, te * 0.9, f, f * 0.93, 0.03 * a.wheeze * amp / (j + 1), 'triangle'));
          if (a.crackles > 0.05 && amp > 0 && (a.crackleSide?.[side] ?? 1) > 0) for (let c = 0; c < Math.round(3 + 7 * a.crackles); c++) {
            const tc = tb + ti * (0.55 + 0.45 * Math.random()); this._burst(ac, out, tc, 0.012, { gain: 0.35 * a.crackles * amp, lo: 500, hi: 1300, attack: 0.1 });
          }
        }
      }
    });
    if (a.heart) {                                                   // lub-dub under the breath sounds, all the way through
      const T = 60 / a.heart.hr, s2 = Math.min(0.32, T * 0.42), g = 0.5 * a.heart.amp;
      for (let tb = now + 0.2; tb < now + 2 * PART + 0.2; tb += T) { this._tone(ac, out, tb, 0.11, 62, 44, g); this._tone(ac, out, tb + s2, 0.08, 80, 60, g * 0.7); }
    }
    const dur = 2 * PART + 0.4; this.busyUntil = performance.now() + dur * 1000;
    return dur;
  }
  /** Say a line aloud (browser speech synthesis). lang 'en' | 'fr'; breathless: slower, in pieces; female: a higher voice. */
  speak(text, { lang = 'en', breathless = false, female = false } = {}) {
    if (!this.sound?.on || typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return false;
    try {
      const u = new SpeechSynthesisUtterance(text), code = lang === 'fr' ? 'fr' : 'en';
      u.lang = code === 'fr' ? 'fr-FR' : 'en-GB'; u.rate = breathless ? 0.8 : 0.95; u.pitch = female ? 1.25 : 0.85; u.volume = 0.9;
      const v = speechSynthesis.getVoices().find(x => x.lang?.toLowerCase().startsWith(code)); if (v) u.voice = v;
      speechSynthesis.cancel(); speechSynthesis.speak(u); return true;
    } catch { return false; }
  }
  stop() { try { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); } catch { /* not available */ } }
}
