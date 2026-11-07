// Visible clinical gestures: a gloved hand brings a syringe, needle, scalpel, probe or stethoscope to the patient,
// performs the act and withdraws. Purely visual (driven by real time); the physiology is decided by the engine.
// Devices that the engine reports as "in place" are held back until the gesture reaches the matching moment (hold()).

const ease = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const seg01 = (u, a, b) => ease((u - a) / (b - a));       // 0 before a, 1 after b
const add = (p, v, k = 1) => [p[0] + v[0] * k, p[1] + v[1] * k, p[2] + v[2] * k];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

const STEEL = [0.78, 0.8, 0.84], GLOVE = [0.45, 0.66, 0.88], GOWN = [0.86, 0.91, 0.95], BARREL = [0.86, 0.92, 0.97];
const LIQUID = { propofol: [0.97, 0.96, 0.9], epinephrine: [0.96, 0.9, 0.55], amiodarone: [0.95, 0.9, 0.7], atropine: [0.88, 0.94, 1.0], bicarb: [0.9, 0.96, 1.0], rocuronium: [0.9, 0.95, 1.0], succinylcholine: [0.92, 0.96, 1.0], ketamine: [0.9, 0.95, 1.0] };

export class Gestures {
  constructor() { this.list = []; this.hold = {}; this.marks = []; this.wake = 0; }
  clear() { this.list = []; this.hold = {}; this.marks = []; }
  /** true when device `name` may be drawn (its gesture has reached the right moment). */
  ok(name, t) { return !(this.hold[name] > t); }

  /** Begin a gesture for an engine event. Returns the camera preset the scene should frame, or null. */
  start(scene, ev, res) {
    const W = scene.world; if (!W || !ev || (res && res.ok === false)) return null;
    const t0 = scene.t, st = W.sternum, site = scene.chestSites;
    const outZ = (p) => ((p[2] - st[2]) >= 0 ? 1 : -1);
    let g = null, cam = null;
    switch (ev.type) {
      case 'drug.bolus': case 'bicarb.bolus': {
        const s = W.rightArmIV, o = outZ(s);
        g = { k: 'syringe', dur: 3.0, site: [s[0], s[1] + 0.012, s[2]], o, col: LIQUID[ev.drug] || (ev.type === 'bicarb.bolus' ? LIQUID.bicarb : [0.9, 0.95, 1.0]) }; cam = 'arm'; break;
      }
      case 'iv.access': {
        const s = W.rightArmIV, o = outZ(s);
        g = { k: 'cannula', dur: 3.0, site: [s[0], s[1] + 0.012, s[2]], o }; cam = 'arm'; this.hold.iv = t0 + 2.0; break;
      }
      case 'procedure.needle_decompression': {
        const sd = ev.side || 'R', sites = site && site[sd] ? site[sd] : null; if (!sites) break;
        const a = sites[ev.site] || sites.mcl2, o = outZ(a);
        g = { k: 'needle', dur: 3.2, site: [a[0], a[1] + 0.004, a[2]], o, len: Math.min(0.12, Math.max(0.05, (ev.needleMm || 50) / 700)), puff: !res || res.ok !== false }; cam = 'chest'; this.hold.needle = t0 + 3.2 * 0.5; break;
      }
      case 'procedure.chest_tube': {
        const sd = ev.side || 'L', sites = site && site[sd] ? site[sd] : null; if (!sites) break;
        const a = sites.mal5, o = outZ(a);
        g = { k: 'tube', dur: 5.0, site: [a[0], a[1] + 0.004, a[2]], o }; cam = 'chest'; this.hold.tube = t0 + 5.0 * 0.85;
        this.marks = this.marks.filter(m => m.kind !== 'chest'); break;
      }
      case 'procedure.cricothyroidotomy': {
        const n = W.neck;
        g = { k: 'fona', dur: 5.0, site: [n[0], n[1] + 0.012, n[2]], o: 1 }; cam = 'neck'; this.hold.neck = t0 + 5.0 * 0.85;
        this.marks = this.marks.filter(m => m.kind !== 'neck'); break;
      }
      case 'exam.pocus': g = { k: 'probe', dur: 3.2, o: outZ(W.rightArmIV) }; cam = 'chest'; break;
      case 'exam.chest': g = { k: 'steth', dur: 3.6, o: outZ(W.rightArmIV) }; cam = 'chest'; break;
      case 'exam.neck': g = { k: 'palp', dur: 2.2, o: 1 }; cam = 'neck'; break;
      case 'airway.intubate': g = { k: 'laryn', dur: 3.6 }; cam = 'head'; this.hold.ett = t0 + 3.6 * 0.8; break;
      default: break;
    }
    if (!g) return null;
    g.t0 = t0; g.ev = ev; this.list.push(g); return cam;
  }

  /** Generic gesture for a guided-procedure step that has no engine event of its own. site: world point. */
  startStep(scene, kind, site) {
    const W = scene.world; if (!W || !site) return null;
    const o = (site[2] - W.sternum[2]) >= 0 ? 1 : -1;
    const dur = { touch: 2.0, swab: 2.6, scalpel: 2.4, mask: 2.6, pads: 2.8 }[kind]; if (!dur) return null;
    const g = { k: 'step_' + kind, dur, site: [site[0], site[1] + 0.008, site[2]], o, t0: scene.t };
    if (kind === 'pads') g.pads = [W.padRight, W.padLeft];
    this.list.push(g); return g;
  }

  draw(c, t) {
    this.list = this.list.filter(g => t - g.t0 < g.dur + 0.1);
    for (const m of this.marks) this._mark(c, m, t);
    for (const g of this.list) {
      const u = Math.min(1, (t - g.t0) / g.dur);
      ({ syringe: this._syringe, cannula: this._cannula, needle: this._needle, tube: this._tube, fona: this._fona, probe: this._probe, steth: this._steth, palp: this._palp, laryn: this._laryn,
        step_touch: this._sTouch, step_swab: this._sSwab, step_scalpel: this._sScalpel, step_mask: this._sMask, step_pads: this._sPads })[g.k]?.call(this, c, g, u, t);
    }
  }

  // ------------------------------------------------------------------ guided-procedure step gestures
  _lift(u, a = 0.22, b = 0.8) { return 0.13 * (1 - seg01(u, 0, a)) + 0.13 * seg01(u, b, 1); }
  _sTouch(c, g, u) {
    const press = 0.004 * Math.sin(Math.min(1, Math.max(0, (u - 0.25) / 0.5)) * Math.PI * 3), p = [g.site[0], g.site[1] + 0.012 + this._lift(u) - press, g.site[2]];
    for (const dx of [-0.014, 0, 0.014]) c.blob([p[0] + dx, p[1] - 0.004, p[2] + g.o * 0.012], 0.007, 0.006, 0.012, GLOVE, { spec: 0.5 });   // fingertips
    this._hand(c, add(p, [0, 0.012, g.o * 0.03]), g.o);
  }
  _sSwab(c, g, u, t) {
    const k = seg01(u, 0.2, 0.85), r = 0.006 + 0.03 * k, a = u * Math.PI * 9;               // spiral outwards from the site, as taught for skin antisepsis
    const p = [g.site[0] + r * Math.cos(a), g.site[1] + 0.008 + this._lift(u), g.site[2] + r * Math.sin(a)];
    c.blob(p, 0.014, 0.006, 0.014, [0.95, 0.95, 0.93]);                                       // gauze held in forceps
    c.seg(add(p, [0, 0.004, 0]), add(p, [-0.03, 0.09, g.o * 0.06]), 0.0025, STEEL, { spec: 0.9 });
    this._hand(c, add(p, [-0.03, 0.09, g.o * 0.06]), g.o);
    if (u > 0.25 && !g._m) { g._m = { kind: 'prep', p: [...g.site], t0: t, grow: g.dur * 0.6 }; this.marks.push(g._m); }
  }
  _sScalpel(c, g, u, t) {
    const slash = seg01(u, 0.3, 0.7), dir = norm([0.1, -0.9, g.o * 0.3]);
    this._scalpel(c, [g.site[0], g.site[1] + this._lift(u, 0.3, 0.75), g.site[2] + g.o * (slash - 0.5) * 0.03], dir, g.o);
    if (u >= 0.3 && !g._m) { g._m = { kind: 'cut', p: [...g.site], o: g.o, len: 0.035, t0: t, grow: g.dur * 0.4 }; this.marks.push(g._m); }
  }
  _sMask(c, g, u) {
    const p = [g.site[0] + 0.02, g.site[1] + 0.04 + this._lift(u, 0.25, 0.85) * 0.8, g.site[2]];
    c.blob(p, 0.07, 0.045, 0.062, [0.78, 0.88, 0.92], { alpha: 0.6, spec: 0.6 });            // anaesthetic face mask, C-E grip
    c.seg(add(p, [0.02, 0.04, 0]), add(p, [0.09, 0.08, 0]), 0.012, [0.3, 0.32, 0.36]);
    for (const s of [-1, 1]) this._hand(c, add(p, [0.04, 0.035, s * 0.05]), s, [0.2, 0.2, 0.3]);
  }
  _sPads(c, g, u) {
    const i = u < 0.5 ? 0 : 1, v = (u - i * 0.5) * 2, pad = g.pads[i], lift = 0.12 * (1 - seg01(v, 0, 0.4)) + 0.12 * seg01(v, 0.75, 1);
    const p = [pad[0], pad[1] + 0.012 + lift, pad[2]];
    c.blob(p, 0.075, 0.004, 0.095, [0.95, 0.95, 0.4], { spec: 0.1 });
    this._hand(c, add(p, [0, 0.012, 0]), g.o);
  }

  // ------------------------------------------------------------------ building blocks
  _hand(c, p, o, back = [-0.08, 0.20, 0.34]) {
    const e = add(p, [back[0], back[1], back[2] * o]), cuff = add(p, [back[0] * 0.18, back[1] * 0.18 + 0.01, back[2] * o * 0.18]);
    c.blob(p, 0.026, 0.016, 0.022, GLOVE, { spec: 0.5 });
    c.seg(add(p, [0, 0.01, 0]), cuff, 0.024, GLOVE, { spec: 0.4 });
    c.seg(cuff, e, 0.029, GOWN, { spec: 0.1 });
  }
  _syringe(c, g, u, t, o = {}) { return this._syringeAt(c, g, u, t, o); }
  /** Barrel + plunger + needle along `dir` (pointing into the patient), tip at `tip`. */
  _syr(c, tip, dir, plunge, liquid, needleLen = 0.03, hand = true, handO = 1) {
    const hub = add(tip, dir, -needleLen), back = (d) => add(hub, dir, -d), L = 0.07;
    c.seg(tip, hub, 0.0022, STEEL, { spec: 0.9 });
    c.seg(hub, back(0.008), 0.0055, BARREL, { alpha: 0.7 });
    c.seg(back(0.008), back(L), 0.0085, BARREL, { alpha: 0.45, spec: 0.8 });
    const ds = 0.008 + (L - 0.012) * (1 - plunge) + 0.004;
    if (liquid && ds > 0.012) c.seg(back(0.008), back(ds), 0.0068, liquid, { alpha: 0.92 });
    c.blob(back(ds), 0.0075, 0.0075, 0.0075, [0.12, 0.12, 0.14]);
    c.seg(back(ds), back(ds + 0.07), 0.0028, [0.94, 0.94, 0.96]);
    c.blob(back(ds + 0.072), 0.011, 0.011, 0.011, [0.94, 0.94, 0.96]);
    c.seg(add(back(L), [0, 0, 0], 1), back(L + 0.002), 0.0135, [0.94, 0.94, 0.96]);
    if (hand) this._hand(c, add(back(L * 0.55), [0, 0.016, 0]), handO);
  }

  _syringeAt(c, g, u) {
    const dir = norm([0.82, -0.52, 0]), away = 0.16 * (1 - seg01(u, 0.0, 0.30)) + 0.16 * seg01(u, 0.86, 1.0) - 0.007 * seg01(u, 0.30, 0.40) * (1 - seg01(u, 0.84, 0.88));
    const tip = add(g.site, dir, -away), plunge = seg01(u, 0.42, 0.82);
    this._syr(c, tip, dir, plunge, g.col, 0.032, true, g.o);
    if (u > 0.42 && u < 0.9) { const k = Math.sin(Math.min(1, (u - 0.42) / 0.4) * Math.PI); c.blob(add(g.site, [0.0, 0.004, 0]), 0.012 + 0.012 * k, 0.003, 0.012 + 0.012 * k, [0.9, 0.55, 0.5], { alpha: 0.35 * k }); }
  }
  _cannula(c, g, u) {
    const dir = norm([0.82, -0.52, 0]), away = 0.16 * (1 - seg01(u, 0.0, 0.32)) + 0.12 * seg01(u, 0.7, 1.0) - 0.008 * seg01(u, 0.32, 0.42);
    const tip = add(g.site, dir, -away), flash = seg01(u, 0.42, 0.5) * 0.012;
    const hub = add(tip, dir, -0.032);
    c.seg(tip, hub, 0.0024, STEEL, { spec: 0.9 });
    c.seg(hub, add(hub, dir, -0.03), 0.0075, [0.96, 0.7, 0.2], { alpha: 0.9 });                // 20G-style wing hub
    if (flash > 0) c.seg(hub, add(hub, dir, -0.003 - flash * 1.5), 0.0045, [0.7, 0.05, 0.08], { alpha: 0.95 });
    c.seg(add(hub, dir, -0.03), add(hub, dir, -0.045), 0.006, [0.95, 0.95, 0.98]);
    this._hand(c, add(hub, dir, -0.03), g.o);
  }
  _needle(c, g, u, t) {
    const dir = [0, -1, 0], len = g.len, lift = 0.15 * (1 - seg01(u, 0.0, 0.34)) + 0.15 * seg01(u, 0.74, 1.0), depth = 0.028 * seg01(u, 0.34, 0.5) * (1 - seg01(u, 0.7, 0.8));
    const tip = [g.site[0], g.site[1] + lift - depth, g.site[2]];
    this._syr(c, tip, dir, 0.0, [0.9, 0.95, 1.0], len, false);
    // plunger drawn back (air aspirated) as the pleura is entered
    const hub = add(tip, dir, -len);
    this._hand(c, add(hub, [0, 0.045, 0]), g.o, [-0.1, 0.25, 0.4]);
    if (g.puff && u > 0.46 && u < 0.78) {                                                  // pressurised air escaping
      const k = (u - 0.46) / 0.32;
      for (let i = 0; i < 5; i++) { const ph = (k * 1.6 + i * 0.21) % 1; c.blob([g.site[0] + 0.012 * Math.sin(i * 2.3), g.site[1] + 0.02 + 0.09 * ph, g.site[2] + 0.012 * Math.cos(i * 1.7)], 0.006 + 0.014 * ph, 0.006 + 0.014 * ph, 0.006 + 0.014 * ph, [0.95, 0.97, 1.0], { alpha: 0.5 * (1 - ph) }); }
    }
  }
  _scalpel(c, tip, dir, o) {
    const back = (d) => add(tip, dir, -d);
    c.seg(tip, back(0.03), 0.0045, STEEL, { spec: 1.0 });
    c.seg(back(0.03), back(0.15), 0.0065, [0.3, 0.32, 0.36], { spec: 0.4 });
    this._hand(c, back(0.095), o, [-0.12, 0.28, 0.5]);
  }
  _addMark(m) { this.marks.push(m); }
  _tube(c, g, u, t) {
    const a = g.site, dir = norm([-0.12, -0.9, g.o * 0.35]);
    const slash = seg01(u, 0.18, 0.40), pass = seg01(u, 0.10, 0.18) * (1 - seg01(u, 0.40, 0.5));
    if (u < 0.5) {
      const z0 = a[2] - g.o * 0.0, tip = [a[0], a[1] - 0.002 * pass, a[2] + g.o * (slash - 0.5) * 0.04 + g.o * 0.02 * (1 - seg01(u, 0, 0.1))];
      const lift = 0.14 * (1 - seg01(u, 0.0, 0.14)) + 0.14 * seg01(u, 0.42, 0.5);
      this._scalpel(c, [tip[0], tip[1] + lift, tip[2]], dir, g.o);
    }
    if (u >= 0.18 && !g._m) { g._m = { kind: 'chest', p: [a[0], a[1], a[2]], o: g.o, len: 0.04, t0: g.t0 + g.dur * 0.18, grow: g.dur * 0.22 }; this.marks.push(g._m); }
    if (u > 0.5 && u < 0.92) {                                                              // the drain is fed through the incision
      const s = seg01(u, 0.5, 0.82), away = 0.20 * (1 - s), d2 = norm([-0.1, -0.5, g.o * 0.85]);
      const tip = add(a, d2, -away * 0.2), tail = add(tip, d2, -(0.14 + away));
      c.seg(tip, tail, 0.0095, [0.85, 0.9, 0.95], { alpha: 0.9 });
      this._hand(c, add(tip, d2, -0.07 - away * 0.5), g.o);
    }
  }
  _fona(c, g, u, t) {
    const a = g.site;
    if (u < 0.5) {
      const slash = seg01(u, 0.2, 0.4), lift = 0.14 * (1 - seg01(u, 0.0, 0.16)) + 0.14 * seg01(u, 0.42, 0.5);
      const dir = norm([0.15, -0.9, 0.35]);
      this._scalpel(c, [a[0], a[1] + lift, a[2] + (slash - 0.5) * 0.03], dir, 1);
    }
    if (u >= 0.2 && !g._m) { g._m = { kind: 'neck', p: [a[0], a[1], a[2]], o: 1, len: 0.03, t0: g.t0 + g.dur * 0.2, grow: g.dur * 0.2 }; this.marks.push(g._m); }
    if (u > 0.5 && u < 0.92) {                                                              // tube or cannula passed through the membrane
      const s = seg01(u, 0.5, 0.8), away = 0.2 * (1 - s), tip = [a[0] + 0.0, a[1] - 0.004 + 0.0, a[2]], dd = norm([0.1, -0.92, 0.1]);
      c.seg(add(tip, dd, -away), add(tip, dd, -(0.1 + away)), 0.0085, [0.95, 0.9, 0.5]);
      this._hand(c, add(tip, dd, -(0.07 + away)), 1, [-0.12, 0.28, 0.5]);
    }
  }
  _mark(c, m, t) {
    const k = Math.min(1, Math.max(0, (t - m.t0) / m.grow)), c2 = [m.p[0], m.p[1] + 0.0025, m.p[2]];
    if (k <= 0) return;
    if (m.kind === 'prep') { c.blob([c2[0], c2[1] - 0.001, c2[2]], 0.036 * k, 0.0012, 0.036 * k, [0.55, 0.32, 0.12], { alpha: 0.45, spec: 0.5 }); return; }   // antiseptic stain
    c.blob(c2, 0.0028, 0.0016, m.len * 0.5 * k, [0.45, 0.02, 0.03], { spec: 0.6 });
    const pool = Math.min(1, Math.max(0, (t - m.t0 - m.grow) / 6));
    if (pool > 0) c.blob([c2[0], c2[1] - 0.0005, c2[2] + m.o * 0.004 * pool], 0.006 + 0.010 * pool, 0.0012, 0.006 + 0.012 * pool, [0.4, 0.015, 0.02], { spec: 0.7, alpha: 0.9 });
  }
  _probe(c, g, u, t) {
    const sc = c.scene, st = sc.world.sternum, sw = Math.sin(u * Math.PI * 2 * 1.2);
    const p = [st[0] - 0.02 + 0.07 * Math.sin(u * Math.PI * 2.4), st[1] + 0.018, st[2] + g.o * (0.07 + 0.05 * Math.cos(u * Math.PI * 1.7))];
    const lift = 0.12 * (1 - seg01(u, 0, 0.18)) + 0.12 * seg01(u, 0.88, 1);
    const q = [p[0], p[1] + lift, p[2]];
    c.blob(add(p, [0, -0.012, 0]), 0.045, 0.0025, 0.04, [0.65, 0.85, 0.95], { alpha: 0.35 * (1 - lift * 6 > 0 ? 1 : 0) });   // coupling gel
    c.seg(q, add(q, [0, 0.07, g.o * 0.025 * (1 + sw * 0.3)], 1), 0.012, [0.15, 0.16, 0.2], { spec: 0.4 });
    c.blob(add(q, [0, 0.0, 0]), 0.021, 0.006, 0.012, [0.55, 0.62, 0.68], { spec: 0.6 });
    this._hand(c, add(q, [0, 0.06, g.o * 0.02]), g.o);
  }
  _steth(c, g, u, t) {
    const sc = c.scene, st = sc.world.sternum, pts = [[0.10, 0.10], [0.10, -0.10], [-0.06, 0.10], [-0.06, -0.10]];
    const f = Math.min(3.999, u * 4), i = Math.floor(f), s = f - i, A = pts[i], B = pts[Math.min(3, i + 1)], m = ease(Math.min(1, s * 1.6));
    const x = A[0] + (B[0] - A[0]) * m * 0, lift = 0.05 * Math.sin(Math.min(1, s * 1.1) * Math.PI) * (s < 0.25 ? 0 : 1) + 0.035 * Math.max(0, 1 - s * 4);
    const base = [st[0] + A[0], st[1] + 0.012, st[2] + g.o * A[1]];
    const p = [base[0], base[1] + (s > 0.75 ? 0.04 * ease((s - 0.75) / 0.25) : 0), base[2]];
    c.seg(p, add(p, [0, 0.006, 0]), 0.021, [0.7, 0.72, 0.76], { spec: 0.8 });
    c.seg(add(p, [0, 0.006, 0]), add(p, [-0.05, 0.12, g.o * 0.1]), 0.004, [0.1, 0.1, 0.12]);
    this._hand(c, add(p, [0, 0.03, 0]), g.o);
  }
  _palp(c, g, u, t) {
    const sc = c.scene, n = sc.world.neck, lift = 0.1 * (1 - seg01(u, 0, 0.25)) + 0.1 * seg01(u, 0.8, 1) + 0.006 * Math.sin(u * 40) * seg01(u, 0.3, 0.4) * (1 - seg01(u, 0.7, 0.8));
    for (const dz of [-0.012, 0.012]) c.blob([n[0], n[1] + 0.012 + lift, n[2] + dz], 0.009, 0.007, 0.009, GLOVE, { spec: 0.5 });
    this._hand(c, [n[0] - 0.01, n[1] + 0.03 + lift, n[2]], 1, [-0.2, 0.3, 0.45]);
  }
  _laryn(c, g, u, t) {
    const sc = c.scene, f = sc.world.face, a = sc.world.airway, inn = seg01(u, 0.08, 0.35) * (1 - seg01(u, 0.78, 0.95));
    const mouth = [a[0] + 0.0, a[1] + 0.02, a[2]];
    const tipB = add(mouth, [0.0, 0.0, 0], 1), root = add(tipB, [0.26 - 0.18 * inn, 0.1 - 0.05 * inn, 0.05], 1);
    c.seg(add(tipB, [0.02, 0.01, 0]), add(root, [0, 0, 0], 1), 0.007, STEEL, { spec: 0.9 });                  // blade
    c.seg(root, add(root, [0.1, 0.14, 0.02]), 0.015, [0.18, 0.2, 0.24], { spec: 0.4 });                        // handle
    c.blob(add(root, [0.06, 0.08, 0.01]), 0.03, 0.02, 0.025, GLOVE, { spec: 0.5 });
    if (u > 0.3 && u < 0.85) { const s = seg01(u, 0.3, 0.6), away = 0.22 * (1 - s); c.seg(add(mouth, [0.02 + away, 0.01 + away * 0.3, 0.0]), add(mouth, [0.14 + away, 0.05 + away * 0.3, 0.0]), 0.009, [0.95, 0.9, 0.5]); }
  }
}
