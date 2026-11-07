// Visible clinical gestures with the real instrument models (assets/instruments.glb): each instrument approaches along a
// realistic angle, enters the skin to its depth, performs the act and withdraws, leaving what really stays (catheter,
// drain, wound, antiseptic stain) to the scene. Purely visual (real time); the physiology is decided by the engine.
// Devices the engine reports as "in place" are held back until the gesture reaches that moment (hold()).

const ease = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const seg01 = (u, a, b) => ease((u - a) / (b - a));       // 0 before a, 1 after b
const add = (p, v, k = 1) => [p[0] + v[0] * k, p[1] + v[1] * k, p[2] + v[2] * k];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const neg = (v) => [-v[0], -v[1], -v[2]];
const HEAD = [1, 0, 0], FOOT = [-1, 0, 0];

export class Gestures {
  constructor() { this.list = []; this.hold = {}; this.marks = []; }
  clear() { this.list = []; this.hold = {}; this.marks = []; }
  /** true when device `name` may be drawn (its gesture has reached the right moment). */
  ok(name, t) { return !(this.hold[name] > t); }

  /** Begin a gesture for an engine event. Returns the camera preset the scene should frame, or null. */
  start(scene, ev, res) {
    const W = scene.world; if (!W || !ev || (res && res.ok === false)) return null;
    const t0 = scene.t, site = (key, fallback) => scene.siteFrame?.(key) || { p: fallback, n: [0, 1, 0] };
    let g = null, cam = null;
    switch (ev.type) {
      case 'drug.bolus': case 'bicarb.bolus': { const f = site('rightArmIV', W.rightArmIV); g = { k: 'syringe', dur: 2.8, f, arm: scene.armAxis() }; cam = 'arm'; break; }
      case 'iv.access': { const f = site('rightArmIV', W.rightArmIV); g = { k: 'cannula', dur: 3.2, f, arm: scene.armAxis() }; cam = 'arm'; this.hold.iv = t0 + 3.2 * 0.62; break; }
      case 'procedure.needle_decompression': {
        const f = site(`${ev.side || 'R'}_${ev.site || 'mcl2'}`, W.sternum);
        g = { k: 'needle', dur: 3.4, f, depth: Math.min(0.09, Math.max(0.04, (ev.needleMm || 50) / 1000)), puff: !res || res.ok !== false }; cam = 'chest'; this.hold.needle = t0 + 3.4 * 0.72; break;
      }
      case 'procedure.chest_tube': { const f = site(`${ev.side || 'R'}_mal5`, W.sternum); g = { k: 'drain', dur: 5.5, f }; cam = 'chest'; this.hold.tube = t0 + 5.5 * 0.9; break; }
      case 'procedure.cricothyroidotomy': { const f = site('neck', W.neck); g = { k: 'fona', dur: 5.5, f, vertical: ev.approach === 'vertical' }; cam = 'neck'; this.hold.neck = t0 + 5.5 * 0.9; break; }
      case 'exam.pocus': g = { k: 'probe', dur: 3.2, f: site('sternum', W.sternum) }; cam = 'chest'; break;
      case 'exam.chest': g = { k: 'steth', dur: 3.6, f: site('sternum', W.sternum) }; cam = 'chest'; break;
      case 'exam.neck': g = { k: 'press', dur: 2.2, f: site('neck', W.neck) }; cam = 'neck'; break;
      case 'airway.intubate': g = { k: 'laryn', dur: 3.6 }; cam = 'head'; this.hold.ett = t0 + 3.6 * 0.8; break;
      default: break;
    }
    if (!g) return cam;
    g.t0 = t0; g.ev = ev; this.list.push(g); return cam;
  }

  /** Generic gesture for a guided-procedure step that has no engine event of its own. site: world point. */
  startStep(scene, kind, site) {
    if (!scene.world || !site) return null;
    const f = { p: site, n: scene.normalAt?.(site) || [0, 1, 0] };
    const dur = { touch: 1.8, swab: 2.6, scalpel: 2.4, mask: 2.6, pads: 2.8 }[kind]; if (!dur) return null;
    const g = { k: kind === 'touch' ? 'press' : 'step_' + kind, dur, f, t0: scene.t };
    if (kind === 'pads') g.pads = [scene.siteFrame?.('padRight'), scene.siteFrame?.('padLeft')];
    this.list.push(g); return g;
  }

  draw(c, t) {
    this.list = this.list.filter(g => t - g.t0 < g.dur + 0.1);
    for (const m of this.marks) this._mark(c, m, t);
    for (const g of this.list) {
      const u = Math.min(1, (t - g.t0) / g.dur);
      ({ syringe: this._syringe, cannula: this._cannula, needle: this._needle, drain: this._drain, fona: this._fona, probe: this._probe, steth: this._steth, laryn: this._laryn,
        press: this._press, step_swab: this._swab, step_scalpel: this._scalpelStep, step_mask: this._mask, step_pads: this._pads })[g.k]?.call(this, c, g, u, t);
    }
  }

  // ------------------------------------------------------------------ helpers
  /** in-plane tangent of the skin at f, pointing toward `toward` (projected) */
  _tan(f, toward) { const d = toward, k = d[0] * f.n[0] + d[1] * f.n[1] + d[2] * f.n[2]; return norm([d[0] - f.n[0] * k, d[1] - f.n[1] * k, d[2] - f.n[2] * k]); }
  /** instrument with its tip at skin point p moved `inside` metres along `dir` (into the body), approaching from `away` metres out */
  _insert(c, name, p, dir, inside, away, roll = 0) { const tip = add(p, dir, inside - away); c.inst(name, tip, neg(dir), roll); }
  _mark(c, m, t) {
    const k = Math.min(1, Math.max(0, (t - m.t0) / m.grow)); if (k <= 0) return;
    if (m.kind === 'prep') { c.disc(add(m.p, m.n, 0.0012), m.n, m.tan, 0.04 * k, 0.03 * k, [0.48, 0.26, 0.08], { alpha: 0.5, spec: 0.7 }); return; }   // povidone-iodine, wet
    // incision: dark wound line with pinker everted edges, a little blood running downhill
    const L = m.len * k;
    c.disc(add(m.p, m.n, 0.0009), m.n, m.tan, L / 2 + 0.002, 0.0028, [0.78, 0.38, 0.36], { spec: 0.4 });
    c.disc(add(m.p, m.n, 0.0014), m.n, m.tan, L / 2, 0.0012, [0.32, 0.02, 0.03], { spec: 0.9 });
    const run = Math.min(1, Math.max(0, (t - m.t0 - m.grow) / 8));
    if (run > 0) { const down = this._tan(m, [0, -1, 0]); c.disc(add(add(m.p, down, 0.006 + 0.012 * run), m.n, 0.0012), m.n, down, 0.004 + 0.012 * run, 0.0025, [0.4, 0.01, 0.02], { spec: 0.9, alpha: 0.92 }); }
  }

  // ------------------------------------------------------------------ gestures
  _syringe(c, g, u) {
    const f = g.f, dir = norm(add(neg(f.n), g.arm, 1.6));                       // shallow, along the forearm, into the cannula port
    this._insert(c, 'syringe', add(f.p, f.n, 0.02), dir, 0, 0.18 * (1 - seg01(u, 0, 0.3)) + 0.18 * seg01(u, 0.82, 1));
  }
  _cannula(c, g, u) {
    const f = g.f, dir = norm(add(neg(f.n), g.arm, 2.7));                       // 15-20 degrees to the skin, toward the hand... the vein runs proximally
    const away = 0.16 * (1 - seg01(u, 0, 0.3)), inside = 0.022 * seg01(u, 0.32, 0.55) - 0.03 * seg01(u, 0.75, 0.95);
    if (u < 0.62) this._insert(c, 'ivCannula', f.p, dir, inside, away);
    else if (u < 0.98) { const back = 0.12 * seg01(u, 0.62, 0.95); c.inst('ivCannula', add(add(f.p, dir, 0.02), neg(dir), back), neg(dir), 0, { only: ['steel'] }); }   // the needle is withdrawn, the catheter stays
  }
  _needle(c, g, u, t) {
    const f = g.f, dir = neg(f.n), away = 0.14 * (1 - seg01(u, 0, 0.3)), inside = g.depth * seg01(u, 0.3, 0.55);
    if (u < 0.72) this._insert(c, 'needle14G', f.p, dir, inside, away);
    else { const back = 0.14 * seg01(u, 0.72, 1); c.inst('needle14G', add(add(f.p, dir, g.depth), f.n, back), f.n, 0, { only: ['steel', 'orange_14G', 'flash_orange'] }); }
    if (g.puff && u > 0.5 && u < 0.85) {                                         // pressurised air escaping through the catheter
      const k = (u - 0.5) / 0.35;
      for (let i = 0; i < 6; i++) { const ph = (k * 1.8 + i * 0.17) % 1, q = add(add(f.p, f.n, 0.05 + 0.07 * ph), [Math.sin(i * 2.3) * 0.01, 0, Math.cos(i * 1.7) * 0.01]); c.blob(q, 0.004 + 0.012 * ph, 0.004 + 0.012 * ph, 0.004 + 0.012 * ph, [0.95, 0.97, 1.0], { alpha: 0.35 * (1 - ph), noShadow: true }); }
    }
  }
  _drain(c, g, u, t) {
    const f = g.f, along = this._tan(f, HEAD);
    // 1. incision 3 cm along the rib, over the upper border of the rib below
    if (u < 0.32) {
      const s = seg01(u, 0.08, 0.28), away = 0.12 * (1 - seg01(u, 0, 0.08)) + 0.12 * seg01(u, 0.28, 0.32);
      const tip = add(add(f.p, along, (s - 0.5) * 0.03), f.n, away - 0.004), blade = norm(add(neg(f.n), along, -0.9));
      c.inst('scalpel', tip, neg(blade), Math.PI / 2);
    }
    if (u >= 0.08 && !g._m) { g._m = { kind: 'cut', p: f.p, n: f.n, tan: along, len: 0.03, t0: g.t0 + g.dur * 0.08, grow: g.dur * 0.2 }; this.marks.push(g._m); }
    // 2. blunt dissection with the forceps
    if (u >= 0.32 && u < 0.5) { const k = Math.sin(seg01(u, 0.34, 0.48) * Math.PI); this._insert(c, 'forcepsGauze', f.p, neg(f.n), 0.02 * k, 0.1 * (1 - k)); }
    // 3. the drain is fed through, aimed at the apex
    if (u >= 0.5) { const dir = norm(add(neg(f.n), HEAD, 0.9)); this._insert(c, 'chestDrain', f.p, dir, 0.11 * seg01(u, 0.55, 0.9), 0.2 * (1 - seg01(u, 0.5, 0.6))); }
  }
  _fona(c, g, u) {
    const f = g.f, tan = g.vertical ? this._tan(f, HEAD) : this._tan(f, [0, 0, 1]);
    if (u < 0.4) {                                                              // stab, then turn the blade 90 degrees
      const away = 0.12 * (1 - seg01(u, 0, 0.12)) + 0.12 * seg01(u, 0.36, 0.4), slide = g.vertical ? (seg01(u, 0.12, 0.3) - 0.5) * 0.06 : 0;
      c.inst('scalpel', add(add(f.p, tan, slide), f.n, away - 0.008), f.n, (Math.PI / 2) * seg01(u, 0.22, 0.32));
    }
    if (u >= 0.12 && !g._m) { g._m = { kind: 'cut', p: f.p, n: f.n, tan, len: g.vertical ? 0.06 : 0.015, t0: g.t0 + g.dur * 0.12, grow: g.dur * 0.15 }; this.marks.push(g._m); }
    if (u >= 0.4 && u < 0.92) { const dir = norm(add(neg(f.n), FOOT, 0.7)); this._insert(c, 'bougie', f.p, dir, 0.08 * seg01(u, 0.45, 0.75), 0.25 * (1 - seg01(u, 0.4, 0.5))); }
  }
  _press(c, g, u) {                                                            // a gloved hand palpates / presses the site (drawn only when hands.glb is present)
    const f = g.f, lift = 0.1 * (1 - seg01(u, 0, 0.25)) + 0.1 * seg01(u, 0.8, 1) - 0.004 * Math.sin(Math.min(1, Math.max(0, (u - 0.3) / 0.45)) * Math.PI * 3);
    c.inst('press', add(f.p, f.n, lift), f.n, 0);
  }
  _probe(c, g, u) {                                                            // ultrasound probe: dark rounded body, lens on the skin, sweeping
    const f = g.f, side = this._tan(f, [0, 0, 1]), sw = Math.sin(u * Math.PI * 2.4);
    const p = add(add(f.p, side, 0.06 * sw), f.n, 0.12 * (1 - seg01(u, 0, 0.18)) + 0.12 * seg01(u, 0.86, 1));
    c.disc(add(f.p, f.n, 0.001), f.n, side, 0.03, 0.02, [0.7, 0.85, 0.95], { alpha: 0.35 * (1 - seg01(u, 0.86, 1)), spec: 1, noShadow: true });   // gel
    c.seg(add(p, f.n, 0.004), add(p, f.n, 0.095), 0.016, [0.14, 0.15, 0.18], { spec: 0.5 }); c.seg(add(p, f.n, 0.095), add(add(p, f.n, 0.2), side, 0.05), 0.004, [0.1, 0.1, 0.12]);
  }
  _steth(c, g, u) {                                                            // stethoscope chest piece moved between four listening points
    const f = g.f, side = this._tan(f, [0, 0, 1]), along = this._tan(f, HEAD), pts = [[0.07, 0.08], [0.07, -0.08], [-0.05, 0.09], [-0.05, -0.09]];
    const i = Math.min(3, Math.floor(u * 4)), s = u * 4 - i, P = pts[i], lift = s > 0.75 ? 0.04 * ease((s - 0.75) / 0.25) : 0;
    const p = add(add(add(f.p, along, P[0]), side, P[1]), f.n, 0.004 + lift);
    c.disc(p, f.n, along, 0.021, 0.006, [0.78, 0.8, 0.84], { spec: 1 }); c.seg(add(p, f.n, 0.006), add(add(p, f.n, 0.13), along, -0.06), 0.004, [0.1, 0.1, 0.12]);
  }
  _laryn(c, g, u, t) {                                                         // Macintosh laryngoscope: steel blade, knurled handle, tube passed alongside
    const sc = c.scene, a = sc.world.airway, inn = seg01(u, 0.08, 0.35) * (1 - seg01(u, 0.78, 0.95)), mouth = [a[0], a[1] + 0.02, a[2]];
    const root = add(mouth, [0.24 - 0.17 * inn, 0.1 - 0.05 * inn, 0.04], 1);
    c.seg(add(mouth, [0.02, 0.01, 0]), root, 0.006, [0.82, 0.84, 0.88], { spec: 1 }); c.seg(root, add(root, [0.1, 0.14, 0.02]), 0.014, [0.3, 0.32, 0.36], { spec: 0.6 });
    if (u > 0.3 && u < 0.85) { const s = seg01(u, 0.3, 0.6), away = 0.22 * (1 - s); c.seg(add(mouth, [0.02 + away, 0.01 + away * 0.3, -0.01]), add(mouth, [0.16 + away, 0.05 + away * 0.3, -0.01]), 0.0075, [0.9, 0.95, 0.97], { alpha: 0.8, spec: 0.8 }); }
  }
  _swab(c, g, u, t) {                                                          // sponge forceps with iodine gauze, spiral outwards
    const f = g.f, a = this._tan(f, HEAD), b = this._tan(f, [0, 0, 1]), k = seg01(u, 0.2, 0.85), r = 0.004 + 0.03 * k, ang = u * Math.PI * 9;
    const p = add(add(add(f.p, a, r * Math.cos(ang)), b, r * Math.sin(ang)), f.n, 0.12 * (1 - seg01(u, 0, 0.18)) + 0.12 * seg01(u, 0.88, 1));
    c.inst('forcepsGauze', p, norm(add(f.n, a, -0.8)), 0);
    if (u > 0.25 && !g._m) { g._m = { kind: 'prep', p: f.p, n: f.n, tan: a, t0: t, grow: g.dur * 0.6 }; this.marks.push(g._m); }
  }
  _scalpelStep(c, g, u, t) {
    const f = g.f, along = this._tan(f, HEAD), s = seg01(u, 0.25, 0.75), away = 0.12 * (1 - seg01(u, 0, 0.25)) + 0.12 * seg01(u, 0.8, 1);
    c.inst('scalpel', add(add(f.p, along, (s - 0.5) * 0.035), f.n, away - 0.004), norm(add(f.n, along, 0.9)), Math.PI / 2);
    if (u >= 0.25 && !g._m) { g._m = { kind: 'cut', p: f.p, n: f.n, tan: along, len: 0.035, t0: t, grow: g.dur * 0.5 }; this.marks.push(g._m); }
  }
  _mask(c, g, u) {                                                             // anaesthetic face mask, seal held
    const f = g.f, p = add(f.p, f.n, 0.04 + 0.12 * (1 - seg01(u, 0, 0.25)) + 0.12 * seg01(u, 0.85, 1));
    c.blob(p, 0.07, 0.045, 0.062, [0.82, 0.9, 0.94], { alpha: 0.55, spec: 0.9, noShadow: true }); c.seg(add(p, [0.02, 0.04, 0]), add(p, [0.09, 0.08, 0]), 0.012, [0.32, 0.35, 0.4]);
  }
  _pads(c, g, u) {
    for (const [i, pad] of g.pads.entries()) {
      if (!pad) continue; const v = Math.min(1, Math.max(0, u * 2 - i)); if (v <= 0) continue;
      c.inst(i ? 'defibPadLeft' : 'defibPadRight', add(pad.p, pad.n, 0.002 + 0.12 * (1 - seg01(v, 0, 0.6))), pad.n, 0);
    }
  }
}
