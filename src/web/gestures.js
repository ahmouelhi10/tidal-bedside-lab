// Visible clinical gestures with the real instrument models (assets/instruments.glb): each instrument approaches along a
// realistic angle, enters the skin to its depth, performs the act and withdraws, leaving what really stays (catheter,
// drain, wound, antiseptic stain) to the scene. Purely visual (real time); the physiology is decided by the engine.
// Devices the engine reports as "in place" are held back until the gesture reaches that moment (hold()).

//
// Human motion (visual only, never the engine's clock or random stream):
//  - reaches follow a minimum-jerk profile (Flash & Hogan 1985): smooth start, long gentle deceleration into contact;
//  - a hand does not slide in on a rail: it arrives on a curve from the operator's side, the wrist turning and rolling
//    into the working angle on the way, and leaves the same way;
//  - while it holds, it shows a faint physiological tremor (~9 Hz, 0.2 mm) and a slow postural sway (~0.6 Hz);
//  - for punctures and incisions the other gloved hand arrives first and stretches the skin beside the site;
//  - the fingers work (hands.glb morph targets, opts.act / opts.relax): the thumb pushes the plunger, the index slides the
//    catheter off the needle, fingertips press, grips firm up; an empty hand comes in loosely curled and flattens on the skin;
//  - at intubation the right hand passes the tube while the left holds the laryngoscope.
import { injectionPlan, injectionPhases } from './injection.js';
const ease = (x) => { x = Math.min(1, Math.max(0, x)); return Math.min(1, x * x * x * (x * (6 * x - 15) + 10)); };   // minimum jerk (never past 1 by rounding)
const seg01 = (u, a, b) => ease((u - a) / (b - a));       // 0 before a, 1 after b
const add = (p, v, k = 1) => [p[0] + v[0] * k, p[1] + v[1] * k, p[2] + v[2] * k];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const neg = (v) => [-v[0], -v[1], -v[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const HEAD = [1, 0, 0], FOOT = [-1, 0, 0];
const REACH = 0.15;                                        // m: how far out a hand starts its approach

export class Gestures {
  constructor() { this.list = []; this.hold = {}; this.marks = []; }
  clear() { this.list = []; this.hold = {}; this.marks = []; }
  /** true when device `name` may be drawn (its gesture has reached the right moment). */
  ok(name, t) { return !(this.hold[name] > t); }

  /** Begin a gesture for an engine event. Returns the camera preset the scene should frame, or null. */
  start(scene, ev, res, ctx = {}) {
    const W = scene.world; if (!W || !ev || (res && res.ok === false)) return null;
    const t0 = scene.t, site = (key, fallback) => scene.siteFrame?.(key) || { p: fallback, n: [0, 1, 0] };
    let g = null, cam = null;
    switch (ev.type) {
      case 'drug.bolus': case 'bicarb.bolus': {                 // an injection as it is really given: scrub the port, connect, push over the drug's time, flush, withdraw (injection.js)
        const plan = injectionPlan(ev, ctx.arrested), ph = injectionPhases(plan, ctx.speed || 1);
        if (plan.route === 'neb') { g = { k: 'step_mask', dur: 3.2, f: site('face', W.face) }; cam = 'head'; break; }
        if (plan.route === 'im' || plan.route === 'regional') {
          const R = scene.sideSign || 1, base = plan.route === 'im' ? [W.femoral[0] - 0.2, W.femoral[1] + 0.06, W.femoral[2] + R * 0.07] : [W.femoral[0], W.femoral[1] + 0.04, W.femoral[2] + R * 0.03];
          const f = scene.surfaceAt ? scene.surfaceAt(base) : { p: base, n: [0, 1, 0] };
          g = { k: 'inject_im', dur: ph.dur, phs: ph, plan, f }; cam = 'groin'; break;
        }
        const f = site('rightArmIV', W.rightArmIV); g = { k: 'inject', dur: ph.dur, phs: ph, plan, f, arm: scene.armAxis() }; cam = 'arm'; break;
      }
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
      case 'io.access': g = { k: 'io', dur: 4.2, f: site('ioR', W.femoral) }; cam = 'groin'; this.hold.io = t0 + 4.2 * 0.9; break;
      case 'procedure.arterial_line': { const ax = scene.armAxis(); g = { k: 'cannula', dur: 3.6, f: site('wristR', W.rightArmIV), arm: [-ax[0], -ax[1], -ax[2]], steep: 1.7 }; cam = 'arm'; break; }   // 30 deg, pointing up the forearm
      case 'procedure.central_line': { const key = { ijv: 'ijvR', scv: 'scvR', fem: 'femR' }[ev.site] || 'ijvR'; g = { k: 'cvc', dur: 6.5, f: site(key, W.neck), site: ev.site || 'ijv', R: scene.sideSign || 1, notch: W.neck }; cam = ev.site === 'fem' ? 'groin' : ev.site === 'scv' ? 'chest' : 'neck'; break; }
      case 'procedure.pericardiocentesis': g = { k: 'pericard', dur: 4.8, f: site('subxiph', W.sternum), R: scene.sideSign || 1 }; cam = 'chest'; break;
      case 'procedure.ng_tube': g = { k: 'ng', dur: 4.4, f: site('nostril', W.airway) }; cam = 'head'; this.hold.ng = t0 + 4.4 * 0.95; break;
      default: break;
    }
    if (!g) return cam;
    g.t0 = t0; g.ev = ev;
    const helper = { 'iv.access': 'arm', ...(g.k === 'inject' ? { 'drug.bolus': 'arm', 'bicarb.bolus': 'arm' } : {}), 'procedure.needle_decompression': 'chest', 'procedure.cricothyroidotomy': 'neck', 'procedure.arterial_line': 'pulse', 'io.access': 'leg' }[ev.type]
      || (ev.type === 'procedure.central_line' ? { ijv: 'neck', scv: 'chest', fem: 'groin' }[g.site] : null);
    this._dress(scene, g, helper, ev.type === 'procedure.central_line' && g.site === 'ijv');
    this.list.push(g); return cam;
  }

  /** Motion context of a gesture: the operator's side (where the hand comes from) and, for punctures, the other hand. */
  _dress(scene, g, helper, fromHead = false) {
    const f = g.f; if (!f) return;
    const W = scene.world, atHead = fromHead || (W && f.p[0] > W.neck[0] - 0.03);   // face and neck (and the internal jugular): worked on from the head of the bed
    const toOp = atHead ? HEAD : [0, 0, -1];                                        // otherwise the operator stands at the patient's right
    g.side = norm(add(f.n, this._tan(f, toOp), 1.1));                               // out of the skin and toward the operator
    g.op = atHead ? norm([1, 0.7, 0]) : norm([0, 0.8, -1]);                          // where the operator's shoulder is: forearms come from there
    g.ph = (g.t0 * 7.13) % 6.283;
    if (!helper || !scene.surfaceAt) return;
    // where the other hand rests and where its fingers point, so that its forearm comes from the operator's side and
    // never crosses the working hand: distal on the forearm (fingers toward the patient's hand); caudal on the chest,
    // fingers across it; beside the larynx on the neck, fingers toward the feet (the operator is at the head)
    // radial pulse: two fingers on the artery a few cm up the forearm; shin: the hand steadies the leg beside the site;
    // groin: fingers on the femoral pulse just lateral to the vein
    const ax = scene.armAxis(), lat = [0, 0, Math.sign(f.p[2]) || 1];
    const L = { arm: [ax, 0.08, ax], pulse: [[-ax[0], 0, -ax[2]], 0.05, ax], chest: [this._tan(f, FOOT), 0.07, this._tan(f, [0, 0, 1])], neck: [this._tan(f, [0, 0, 1]), 0.05, this._tan(f, FOOT)],
      leg: [this._tan(f, HEAD), 0.07, this._tan(f, lat)], groin: [this._tan(f, lat), 0.03, this._tan(f, HEAD)] }[helper];
    const s = scene.surfaceAt(add(f.p, L[0], L[1]));
    g.help = { p: s.p, n: s.n, d: this._tan(s, L[2]) };
  }
  /** Small involuntary movement of a hand that is holding still (deterministic per gesture). */
  _tremor(g, t, k = 1) {
    const ph = g.ph || 0, a = 0.00022 * k, b = 0.0007 * k;
    return [a * Math.sin(t * 59.7 + ph) + b * Math.sin(t * 3.9 + ph * 1.7), a * Math.sin(t * 61.3 + ph * 2.1) + 0.5 * b * Math.sin(t * 2.9 + ph), a * Math.sin(t * 57.1 + ph * 0.6) + b * Math.sin(t * 3.4 + ph * 2.9)];
  }
  /** Where a hand is on its way in or out: k = 1 far away .. 0 in contact. Returns the offset of the curve and the wrist tilt. */
  _path(g, k, t) {
    const s = g.side || [0, 1, 0], arc = Math.sin(Math.min(1, k) * Math.PI * 0.5);
    const off = add(this._tremor(g, t, 1 - Math.min(1, k * 4)), s, 0.07 * arc);
    return { off, tilt: 0.6 * arc, roll: 0.55 * arc };
  }
  /** angle about n that turns an instrument frame's +X onto direction d (see scene._instrument) */
  _angleFor(n, d) {
    const ey = norm(n), ref = Math.abs(ey[0]) > 0.9 ? [0, 0, 1] : [1, 0, 0];
    const ex = norm([ref[1] * ey[2] - ref[2] * ey[1], ref[2] * ey[0] - ref[0] * ey[2], ref[0] * ey[1] - ref[1] * ey[0]]);
    const ez = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
    return Math.atan2(dot(d, ez), dot(d, ex));
  }
  /** The other hand: arrives first, rests on the skin beside the site (thumb and index tensing it), leaves last. */
  _helper(c, g, u, t) {
    const h = g.help; if (!h || !c.scene?.hands?.hand_pressL) return;
    const k = 1 - seg01(u, 0, 0.16) + seg01(u, 0.9, 1);
    const p = add(add(add(h.p, h.n, 0.004 + 0.12 * k), g.side || h.n, 0.05 * Math.sin(k * Math.PI * 0.5)), this._tremor(g, t + 1.3, 0.6 * (1 - k)));
    c.inst('pressL', p, h.n, this._angleFor(h.n, h.d), { noShadow: false, relax: k, act: (1 - k) * seg01(u, 0.18, 0.3) });   // fingers loose in the air, flat on the skin, then thumb and index spread it
  }

  /** Generic gesture for a guided-procedure step that has no engine event of its own. site: world point. */
  startStep(scene, kind, site) {
    if (!scene.world || !site) return null;
    const f = { p: site, n: scene.normalAt?.(site) || [0, 1, 0] };
    const dur = { touch: 1.8, swab: 2.6, scalpel: 2.4, mask: 2.6, pads: 2.8, probe: 3.2, steth: 3.6, needle: 3.0, syringe: 2.6, tourniquet: 2.4, scope: 3.2 }[kind]; if (!dur) return null;
    const k = { touch: 'press', probe: 'probe', steth: 'steth', needle: 'needle' }[kind] || 'step_' + kind;
    const g = { k, dur, f, t0: scene.t };
    if (kind === 'pads') g.pads = [scene.siteFrame?.('padRight'), scene.siteFrame?.('padLeft')];
    if (kind === 'needle') { g.depth = 0.025; g.puff = false; }                   // a vascular puncture: shallow, no hiss
    const W = scene.world, onArm = W && Math.hypot(site[0] - W.rightArmIV[0], site[2] - W.rightArmIV[2]) < 0.12;
    this._dress(scene, g, ['needle', 'syringe', 'scalpel'].includes(kind) ? (onArm ? 'arm' : site[0] > W.neck[0] - 0.03 ? 'neck' : 'chest') : null);
    this.list.push(g); return g;
  }

  draw(c, t) {
    this.list = this.list.filter(g => t - g.t0 < g.dur + 0.1);
    for (const m of this.marks) this._mark(c, m, t);
    for (const g of this.list) {
      const u = Math.min(1, (t - g.t0) / g.dur);
      this._helper(c, g, u, t);
      ({ inject: this._inject, inject_im: this._injectIm, syringe: this._syringe, cannula: this._cannula, needle: this._needle, drain: this._drain, fona: this._fona, probe: this._probe, steth: this._steth, laryn: this._laryn,
        press: this._press, step_swab: this._swab, step_scalpel: this._scalpelStep, step_mask: this._mask, step_pads: this._pads,
        step_syringe: this._syringeStep, step_tourniquet: this._tourniquet, step_scope: this._scope, io: this._io, cvc: this._cvc, pericard: this._pericard, ng: this._ng })[g.k]?.call(this, c, g, u, t);
    }
  }

  // ------------------------------------------------------------------ helpers
  /** in-plane tangent of the skin at f, pointing toward `toward` (projected) */
  _tan(f, toward) { const d = toward, k = d[0] * f.n[0] + d[1] * f.n[1] + d[2] * f.n[2]; return norm([d[0] - f.n[0] * k, d[1] - f.n[1] * k, d[2] - f.n[2] * k]); }
  /** instrument with its tip at skin point p moved `inside` metres along `dir` (into the body), approaching from `away` metres out */
  _pose(p, dir, inside, away, roll = 0, g = null, t = 0) {
    let tip = add(p, dir, inside - away), d = dir, r = roll;
    if (g) {                                                                  // curved approach, wrist turning into the working angle, tremor at the skin
      const m = this._path(g, away / REACH, t);
      tip = add(tip, m.off); d = norm(add(dir, g.side, m.tilt)); r = roll + m.roll;
    }
    return { tip, d, r, op: g?.op };
  }
  _insert(c, name, p, dir, inside, away, roll = 0, g = null, t = 0, opts) { const q = this._pose(p, dir, inside, away, roll, g, t); c.inst(name, q.tip, neg(q.d), q.r, { toward: g?.op, ...opts }); }
  /** Syringe with a moving plunger: the hand holds the barrel by its flange and the thumb pushes the plunger `push` metres toward the tip. */
  _syringeAt(c, q, push) {
    c.inst('syringe', q.tip, neg(q.d), q.r, { skip: ['white_plastic', 'black_rubber'], toward: q.op, act: Math.min(1, Math.max(0, push / 0.011)) });   // drawing back (push < 0): the thumb stays
    c.inst('syringe', add(q.tip, q.d, push), neg(q.d), q.r, { noHand: true, only: ['white_plastic', 'black_rubber'], toward: q.op });
  }
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
  _syringe(c, g, u, t) {
    const f = g.f, dir = norm(add(neg(f.n), g.arm, 1.6));                       // shallow, along the forearm, into the cannula port
    const q = this._pose(add(f.p, f.n, 0.02), dir, 0, 0.18 * (1 - seg01(u, 0, 0.3)) + 0.18 * seg01(u, 0.82, 1), 0, g, t);
    this._syringeAt(c, q, 0.011 * seg01(u, 0.36, 0.74));                         // a slow, steady push
  }
  /** IV injection through the cannula port, in phases (seconds, g.ph): the other hand steadies the forearm; an alcohol swab
   *  scrubs the needle-free port; the syringe comes in along the arm and twists on (Luer); the thumb pushes the plunger at an even
   *  rate over the drug's time; that syringe comes off and a saline syringe flushes the line; the hand leaves. A drug given over
   *  many minutes is not pushed by hand: the syringe is connected and the hand lets go (it runs on a syringe driver, syringe.js). */
  _inject(c, g, u, t) {
    const f = g.f, s = u * g.dur, P = g.phs, at = (k) => Math.min(1, Math.max(0, (s - P[k][0]) / Math.max(1e-3, P[k][1] - P[k][0])));
    const port = add(f.p, f.n, 0.02), dir = norm(add(neg(f.n), g.arm, 1.6));
    if (s < P.swab[1]) {                                                       // scrub the hub: small fast circles on the port
      const k = at('swab'), a = this._tan(f, HEAD), b = this._tan(f, [0, 0, 1]), ang = k * Math.PI * 10, lift = 0.1 * (1 - seg01(k, 0, 0.2)) + 0.1 * seg01(k, 0.85, 1), m = this._path(g, lift / REACH, t);
      c.inst('forcepsGauze', add(add(add(add(port, a, 0.005 * Math.cos(ang)), b, 0.005 * Math.sin(ang)), f.n, lift), m.off), norm(add(f.n, a, -0.8)), m.roll, { toward: g.op });
      return;
    }
    const conn = at('connect'), twist = 0.9 * seg01(conn, 0.6, 1);
    if (s < P.flush[0] || !g.plan.flushMl) {                                   // the drug syringe: in, twist on, push (and off when there is no flush)
      const leave = g.plan.flushMl ? 0 : at('leave'), away = 0.18 * (1 - seg01(conn, 0, 0.7)) + 0.18 * seg01(leave, 0, 1);
      const q = this._pose(port, dir, 0, away, twist, g, t), push = g.plan.pump ? 0 : 0.011 * at('push');   // an even rate: linear, not eased
      if (!(g.plan.pump && s > P.connect[1] + 0.4)) this._syringeAt(c, q, push);   // on a driver: the hand lets go once it is connected
      return;
    }
    const fl = at('flush'), lv = at('leave');                                  // saline flush: the drug syringe off, the flush on, a quick push, off
    const away = fl < 0.25 ? 0.18 * seg01(fl, 0, 0.25) : fl < 0.45 ? 0.18 * (1 - seg01(fl, 0.25, 0.45)) : 0.18 * seg01(lv, 0, 1);
    this._syringeAt(c, this._pose(port, dir, 0, away, twist, g, t), fl < 0.25 ? 0.011 : 0.011 * seg01(fl, 0.45, 1));
  }
  /** IM (anterolateral thigh) or a regional block: the needle in at 90 degrees to its depth, a short draw-back, the push, out. */
  _injectIm(c, g, u, t) {
    const f = g.f, s = u * g.dur, P = g.phs, at = (k) => Math.min(1, Math.max(0, (s - P[k][0]) / Math.max(1e-3, P[k][1] - P[k][0])));
    if (s < P.swab[1]) return this._swab(c, g, at('swab') * 0.9 + 0.05, t);
    const inn = at('connect'), out = at('leave'), depth = g.plan.route === 'im' ? 0.025 : 0.03;
    const away = 0.14 * (1 - seg01(inn, 0, 0.6)) + 0.14 * seg01(out, 0.2, 1), inside = depth * seg01(inn, 0.6, 1) * (1 - seg01(out, 0, 0.2));
    this._syringeAt(c, this._pose(f.p, neg(f.n), inside, away, 0, g, t), s < P.push[0] ? -0.002 * seg01(inn, 0.85, 1) : 0.011 * at('push'));
  }
  _cannula(c, g, u, t) {
    const f = g.f, dir = norm(add(neg(f.n), g.arm, g.steep || 2.7));            // IV: 15-20 degrees to the skin; arterial line (steep 1.7): 30 degrees
    const away = 0.16 * (1 - seg01(u, 0, 0.3)), inside = 0.022 * seg01(u, 0.32, 0.55) - 0.03 * seg01(u, 0.75, 0.95);
    if (u < 0.62) this._insert(c, 'ivCannula', f.p, dir, inside, away, 0, g, t, { act: seg01(u, 0.5, 0.6) });   // flashback: the index slides the catheter off the needle
    else if (u < 0.98) { const back = 0.12 * seg01(u, 0.62, 0.95); c.inst('ivCannula', add(add(add(f.p, dir, 0.02), neg(dir), back), this._tremor(g, t, 1 - back * 6)), neg(dir), 0, { only: ['steel'], toward: g.op, act: 1 }); }   // the needle is withdrawn, the catheter stays
  }
  _needle(c, g, u, t) {
    const f = g.f, dir = neg(f.n), away = 0.14 * (1 - seg01(u, 0, 0.3)), inside = g.depth * seg01(u, 0.3, 0.55);
    if (u < 0.72) this._insert(c, 'needle14G', f.p, dir, inside, away, 0, g, t, { act: seg01(u, 0.56, 0.7) });   // the catheter is advanced off the needle
    else { const back = 0.14 * seg01(u, 0.72, 1), m = this._path(g, back / REACH, t); c.inst('needle14G', add(add(add(f.p, dir, g.depth), f.n, back), m.off), norm(add(f.n, g.side || f.n, m.tilt)), m.roll, { only: ['steel', 'orange_14G', 'flash_orange'], toward: g.op, act: 1 }); }
    if (g.puff && u > 0.5 && u < 0.85) {                                         // pressurised air escaping through the catheter
      const k = (u - 0.5) / 0.35;
      for (let i = 0; i < 6; i++) { const ph = (k * 1.8 + i * 0.17) % 1, q = add(add(f.p, f.n, 0.05 + 0.07 * ph), [Math.sin(i * 2.3) * 0.01, 0, Math.cos(i * 1.7) * 0.01]); c.blob(q, 0.004 + 0.012 * ph, 0.004 + 0.012 * ph, 0.004 + 0.012 * ph, [0.95, 0.97, 1.0], { alpha: 0.35 * (1 - ph), noShadow: true }); }
    }
  }
  _drain(c, g, u, t) {
    const f = g.f, along = this._tan(f, HEAD);
    // 1. incision 3 cm along the rib, over the upper border of the rib below
    if (u < 0.32) {
      const s = seg01(u, 0.08, 0.28), away = 0.12 * (1 - seg01(u, 0, 0.08)) + 0.12 * seg01(u, 0.28, 0.32), m = this._path(g, away / REACH, t);
      const tip = add(add(add(f.p, along, (s - 0.5) * 0.03), f.n, away - 0.004), m.off), blade = norm(add(neg(f.n), along, -0.9));
      c.inst('scalpel', tip, norm(add(neg(blade), g.side, m.tilt)), Math.PI / 2 + m.roll, { act: seg01(u, 0.06, 0.1) * (1 - seg01(u, 0.27, 0.3)) });
    }
    if (u >= 0.08 && !g._m) { g._m = { kind: 'cut', p: f.p, n: f.n, tan: along, len: 0.03, t0: g.t0 + g.dur * 0.08, grow: g.dur * 0.2 }; this.marks.push(g._m); }
    // 2. blunt dissection with the forceps: opened and spread twice in the track
    if (u >= 0.32 && u < 0.5) { const k = Math.sin(seg01(u, 0.34, 0.48) * Math.PI), wob = 0.25 * Math.sin(seg01(u, 0.36, 0.46) * Math.PI * 4); this._insert(c, 'forcepsGauze', f.p, neg(f.n), 0.02 * k, 0.1 * (1 - k), wob, g, t); }
    // 3. the drain is fed through, aimed at the apex, with a slight twist as it is advanced
    if (u >= 0.5) { const dir = norm(add(neg(f.n), HEAD, 0.9)); this._insert(c, 'chestDrain', f.p, dir, 0.11 * seg01(u, 0.55, 0.9), 0.2 * (1 - seg01(u, 0.5, 0.6)), 0.35 * Math.sin(seg01(u, 0.55, 0.9) * Math.PI * 2), g, t, { act: seg01(u, 0.53, 0.6) }); }
  }
  _fona(c, g, u, t) {
    const f = g.f, tan = g.vertical ? this._tan(f, HEAD) : this._tan(f, [0, 0, 1]);
    if (u < 0.4) {                                                              // stab, then turn the blade 90 degrees
      const away = 0.12 * (1 - seg01(u, 0, 0.12)) + 0.12 * seg01(u, 0.36, 0.4), slide = g.vertical ? (seg01(u, 0.12, 0.3) - 0.5) * 0.06 : 0, m = this._path(g, away / REACH, t);
      c.inst('scalpel', add(add(add(f.p, tan, slide), f.n, away - 0.008), m.off), norm(add(f.n, g.side, m.tilt)), (Math.PI / 2) * seg01(u, 0.22, 0.32) + m.roll, { act: seg01(u, 0.1, 0.14) * (1 - seg01(u, 0.34, 0.38)) });
    }
    if (u >= 0.12 && !g._m) { g._m = { kind: 'cut', p: f.p, n: f.n, tan, len: g.vertical ? 0.06 : 0.015, t0: g.t0 + g.dur * 0.12, grow: g.dur * 0.15 }; this.marks.push(g._m); }
    if (u >= 0.4 && u < 0.92) { const dir = norm(add(neg(f.n), FOOT, 0.7)); this._insert(c, 'bougie', f.p, dir, 0.08 * seg01(u, 0.45, 0.75), 0.25 * (1 - seg01(u, 0.4, 0.5)), 0, g, t); }
  }
  /** a hand or instrument lowered onto the skin along its normal: `lift` metres above, coming in on the operator's curve */
  _onto(c, g, name, p, n, lift, roll, t, opts) {
    const m = this._path(g, lift / REACH, t);
    c.inst(name, add(add(p, n, lift), m.off), norm(add(n, g.side || n, m.tilt)), roll + m.roll, { toward: g.op, ...opts });
  }
  _press(c, g, u, t) {                                                         // a gloved hand palpates / presses the site: lands, presses three times with the fingertips, lifts off
    const f = g.f, air = 1 - seg01(u, 0, 0.25) + seg01(u, 0.8, 1), push = Math.abs(Math.sin(Math.min(1, Math.max(0, (u - 0.3) / 0.45)) * Math.PI * 3));
    this._onto(c, g, 'press', f.p, f.n, 0.1 * air - 0.004 * push, 0, t, { relax: air, act: push });
  }
  _probe(c, g, u, t) {                                                         // phased-array probe in a palmar grip: lens on the gel, slow sweep and a fanning tilt
    const f = g.f, side = this._tan(f, [0, 0, 1]), sw = Math.sin(seg01(u, 0.2, 0.84) * Math.PI * 2), fan = 0.22 * Math.sin(seg01(u, 0.2, 0.84) * Math.PI * 3);
    const lift = 0.12 * (1 - seg01(u, 0, 0.2)) + 0.12 * seg01(u, 0.86, 1), m = this._path(g, lift / REACH, t);
    const p = add(add(add(f.p, side, 0.035 * sw), f.n, lift + 0.0015), m.off), axis = norm(add(add(f.n, side, fan), g.side || f.n, m.tilt));
    c.disc(add(f.p, f.n, 0.001), f.n, side, 0.032, 0.022, [0.72, 0.86, 0.96], { alpha: 0.4 * (1 - seg01(u, 0.86, 1)), spec: 1, noShadow: true });   // gel
    c.inst('usProbe', p, axis, m.roll, { toward: g.op, act: (1 - lift / 0.12) * (0.4 + 0.6 * Math.abs(fan) / 0.22) });   // grip tightens as the probe is fanned
  }
  _steth(c, g, u, t) {                                                         // stethoscope chest piece under the fingers, lifted and placed on four listening points
    const f = g.f, side = this._tan(f, [0, 0, 1]), along = this._tan(f, HEAD), pts = [[0.07, 0.08], [0.07, -0.08], [-0.05, 0.09], [-0.05, -0.09]];
    const i = Math.min(3, Math.floor(u * 4)), s = u * 4 - i, P = pts[i], prev = pts[Math.max(0, i - 1)];
    const move = ease(Math.min(1, s / 0.25)), arc = i > 0 && s < 0.25 ? 0.03 * Math.sin(move * Math.PI) : 0;   // travel in a small arc from the previous point
    const at = [prev[0] + (P[0] - prev[0]) * move, prev[1] + (P[1] - prev[1]) * move];
    const lead = i === 0 ? 0.12 * (1 - seg01(u, 0, 0.12)) : 0, out = i === 3 ? 0.12 * seg01(s, 0.7, 1) : 0, press = s > 0.3 && s < 0.85 ? -0.0015 : 0;
    this._onto(c, g, 'stethoscope', add(add(f.p, along, at[0]), side, at[1]), f.n, 0.001 + arc + lead + out + press, 0, t, { act: seg01(s, 0.25, 0.35) * (1 - seg01(s, 0.8, 0.9)) });   // fingertips press the diaphragm on while listening
  }
  _laryn(c, g, u, t) {                                                         // Macintosh 3 laryngoscope: blade slid along the tongue, lifted along the handle axis, tube passed, withdrawn
    const sc = c.scene, a = sc.world.airway, mouth = [a[0], a[1] + 0.01, a[2] - 0.006];
    const blade = norm([0.52, 0.85, 0]), handle = norm([-0.85, 0.52, 0]);   // blade axis out of the mouth toward the head; handle up and toward the feet
    const inn = seg01(u, 0.06, 0.32) * (1 - seg01(u, 0.82, 0.97)), lift = 0.012 * seg01(u, 0.32, 0.42) * (1 - seg01(u, 0.78, 0.84));
    const tip = add(add(add(mouth, blade, 0.13 - 0.2 * inn), handle, lift), this._tremor(g, t, inn));
    c.inst('laryngoscope', tip, blade, Math.PI / 2, { act: lift / 0.012 });     // left hand: the grip firms up for the lift
    if (u > 0.38 && u < 0.82) {                                                 // right hand passes the tube like a pen, from the right corner of the mouth
      const s = seg01(u, 0.38, 0.62), away = 0.22 * (1 - s), A = add(mouth, [0.02 + away, 0.01 + away * 0.3, -0.012]), B = add(mouth, [0.16 + away, 0.05 + away * 0.3, -0.012]), d = norm(add(B, A, -1));
      c.seg(A, B, 0.0075, [0.9, 0.95, 0.97], { alpha: 0.8, spec: 0.8 });
      c.inst('ett', add(add(A, d, 0.105), this._tremor(g, t, s)), d, 0, { toward: norm([0.6, 0.5, -1]) });
    }
  }
  _swab(c, g, u, t) {                                                          // sponge forceps with iodine gauze, spiral outwards
    const f = g.f, a = this._tan(f, HEAD), b = this._tan(f, [0, 0, 1]), k = seg01(u, 0.2, 0.85), r = 0.004 + 0.03 * k, ang = u * Math.PI * 9;
    const lift = 0.12 * (1 - seg01(u, 0, 0.18)) + 0.12 * seg01(u, 0.88, 1), m = this._path(g, lift / REACH, t);
    const p = add(add(add(add(f.p, a, r * Math.cos(ang)), b, r * Math.sin(ang)), f.n, lift), m.off);
    c.inst('forcepsGauze', p, norm(add(add(f.n, a, -0.8), g.side || f.n, m.tilt)), m.roll, { toward: g.op });
    if (u > 0.25 && !g._m) { g._m = { kind: 'prep', p: f.p, n: f.n, tan: a, t0: t, grow: g.dur * 0.6 }; this.marks.push(g._m); }
  }
  _scalpelStep(c, g, u, t) {
    const f = g.f, along = this._tan(f, HEAD), s = seg01(u, 0.25, 0.75), away = 0.12 * (1 - seg01(u, 0, 0.25)) + 0.12 * seg01(u, 0.8, 1), m = this._path(g, away / REACH, t);
    c.inst('scalpel', add(add(add(f.p, along, (s - 0.5) * 0.035), f.n, away - 0.004), m.off), norm(add(add(f.n, along, 0.9), g.side || f.n, m.tilt)), Math.PI / 2 + m.roll, { act: seg01(u, 0.2, 0.27) * (1 - seg01(u, 0.75, 0.82)) });
    if (u >= 0.25 && !g._m) { g._m = { kind: 'cut', p: f.p, n: f.n, tan: along, len: 0.035, t0: t, grow: g.dur * 0.5 }; this.marks.push(g._m); }
  }
  _mask(c, g, u, t) {                                                          // anaesthetic face mask lowered over nose and mouth in an E-C grip (the hand turns it: forearm toward the head), seal held
    const f = g.f, sq = u > 0.3 && u < 0.85 ? 0.5 + 0.5 * Math.sin((u - 0.3) * Math.PI * 6) : 0;
    this._onto(c, g, 'faceMask', f.p, f.n, 0.006 + 0.12 * (1 - seg01(u, 0, 0.25)) + 0.12 * seg01(u, 0.85, 1) - 0.002 * sq, 0, t, { act: seg01(u, 0.22, 0.3) * (1 - seg01(u, 0.85, 0.92)) * (0.6 + 0.4 * sq) });   // E-C grip: fingers lift the jaw into the mask
  }
  _syringeStep(c, g, u, t) {                                                   // a syringe at any site: approach at 30 degrees, small injection or aspiration, withdraw
    const f = g.f, dir = norm(add(neg(f.n), this._tan(f, HEAD), 0.6));
    const away = 0.14 * (1 - seg01(u, 0, 0.3)) + 0.14 * seg01(u, 0.8, 1), inside = 0.008 * seg01(u, 0.3, 0.45) * (1 - seg01(u, 0.75, 0.8));
    this._syringeAt(c, this._pose(f.p, dir, inside, away, 0, g, t), 0.009 * seg01(u, 0.45, 0.72));
  }
  _tourniquet(c, g, u, t) {                                                    // the tourniquet is laid round the limb a hand's breadth above the site and stays a moment
    const f = g.f, up = this._tan(f, HEAD);
    this._onto(c, g, 'tourniquet', add(f.p, up, 0.08), f.n, 0.004 + 0.1 * (1 - seg01(u, 0, 0.35)) + 0.1 * seg01(u, 0.85, 1), Math.PI / 2, t);
  }
  _scope(c, g, u, t) {                                                         // fibre-optic scope fed into the mouth / tube connector and drawn back
    const sc = c.scene, a = sc.world?.airway || g.f.p, mouth = [a[0], a[1] + 0.01, a[2] - 0.006], dir = norm([-0.45, -0.89, 0]);
    this._insert(c, 'bronchoscope', mouth, dir, 0.04 * seg01(u, 0.25, 0.6) * (1 - seg01(u, 0.8, 0.95)), 0.18 * (1 - seg01(u, 0, 0.25)) + 0.18 * seg01(u, 0.9, 1), 0, g, t);
  }
  /** Syringe on a needle: the needle tip `inside` metres into the skin along dir; the plunger is drawn back `back` m and the
   *  barrel fills with what is aspirated (blood / effusion), seen through the clear barrel. */
  _aspirate(c, g, u, t, dir, inside, away, back, fill = [0.42, 0.03, 0.05]) {
    const q = this._pose(g.f.p, dir, inside - 0.045, away, 0, g, t), d = q.d;
    c.seg(q.tip, add(q.tip, d, 0.045), 0.0007, [0.8, 0.82, 0.85], { spec: 1 });   // 21 G needle
    this._syringeAt(c, q, -back);
    if (back > 0.0005) c.seg(add(q.tip, d, -0.014), add(q.tip, d, -0.05 - back), 0.0072, fill, { alpha: Math.min(0.9, back / 0.006), spec: 0.8, noShadow: true });
  }
  _io(c, g, u, t) {                                                            // manual intraosseous needle: square to the bone, slightly away from the knee; twisted in, the trocar removed
    const f = g.f, dir = norm(add(neg(f.n), FOOT, 0.15)), away = 0.14 * (1 - seg01(u, 0, 0.28)), inside = 0.014 * seg01(u, 0.3, 0.62);
    const twist = u > 0.3 && u < 0.64 ? 0.7 * Math.sin((u - 0.3) * Math.PI * 9) : 0;   // rotary, back and forth, pressing down
    if (u < 0.72) this._insert(c, 'needle14G', f.p, dir, inside, away, twist, g, t, { act: 0 });
    else { const back = 0.14 * seg01(u, 0.72, 1), m = this._path(g, back / REACH, t); c.inst('needle14G', add(add(add(f.p, dir, 0.014), f.n, back), m.off), norm(add(f.n, g.side || f.n, m.tilt)), m.roll, { only: ['steel'], toward: g.op }); }
  }
  _cvc(c, g, u, t) {                                                           // Seldinger: needle on a syringe aspirating until dark venous blood, wire through the needle, needle out over the wire
    const f = g.f, R = g.R || 1, lat = [0, 0, R];
    const tanToNotch = g.notch ? this._tan(f, add(g.notch, f.p, -1)) : this._tan(f, HEAD);
    const dir = g.site === 'fem' ? norm(add(neg(f.n), HEAD, 1.0))                                   // 45 deg, toward the head
      : g.site === 'scv' ? norm(add(neg(f.n), tanToNotch, 3.7))                                    // ~15 deg under the clavicle, toward the sternal notch
      : norm(add(add(neg(f.n), FOOT, 1.4), lat, 0.45));                                            // ~30 deg, toward the ipsilateral nipple
    const depth = g.site === 'fem' ? 0.035 : 0.03;
    if (u < 0.5) {                                                                                    // 1. find the vein with negative pressure
      const away = 0.15 * (1 - seg01(u, 0, 0.22)), inside = depth * seg01(u, 0.24, 0.42), back = 0.006 * seg01(u, 0.26, 0.36) + 0.003 * seg01(u, 0.4, 0.46);
      this._aspirate(c, g, u, t, dir, inside, away, back, inside > depth * 0.9 ? [0.3, 0.02, 0.05] : [0.75, 0.75, 0.78]);
      return;
    }
    const hub = add(f.p, dir, depth - 0.045), wireIn = seg01(u, 0.55, 0.78), out = 0.16 * (1 - wireIn) + 0.03;   // 2. syringe off, J-wire fed through the needle
    if (u < 0.86) c.seg(add(f.p, dir, depth), hub, 0.0007, [0.8, 0.82, 0.85], { spec: 1 });                    // the needle stays, held at its hub
    const wEnd = add(hub, neg(dir), out); c.seg(add(f.p, dir, depth + 0.05 * wireIn), wEnd, 0.00045, [0.55, 0.57, 0.6], { spec: 1 });
    c.blob(add(wEnd, neg(dir), 0.03), 0.045, 0.006, 0.045, [0.92, 0.94, 0.97], { alpha: 0.6, spec: 0.6, noShadow: true });      // the wire's coiled sheath
    if (u >= 0.86) {                                                                                  // 3. needle withdrawn over the wire
      const back = 0.12 * seg01(u, 0.86, 1); c.seg(add(add(f.p, dir, depth), neg(dir), back), add(hub, neg(dir), back), 0.0007, [0.8, 0.82, 0.85], { spec: 1 });
    }
  }
  _pericard(c, g, u, t) {                                                      // subxiphoid needle at 30-45 deg toward the left shoulder, aspirating as it advances
    const f = g.f, R = g.R || 1, dir = norm(add(add(neg(f.n), HEAD, 0.85), [0, 0, -R], 0.35));
    const away = 0.15 * (1 - seg01(u, 0, 0.25)) + 0.15 * seg01(u, 0.88, 1), inside = 0.05 * seg01(u, 0.28, 0.55) * (1 - seg01(u, 0.82, 0.88));
    this._aspirate(c, g, u, t, dir, inside, away, 0.003 * seg01(u, 0.3, 0.4) + 0.009 * seg01(u, 0.55, 0.8), [0.55, 0.12, 0.1]);   // non-clotting blood-stained effusion
  }
  _ng(c, g, u, t) {                                                            // nasogastric tube fed along the floor of the nose (straight back, i.e. down in a supine patient) in short pushes
    const f = g.f, upN = f.n, k = seg01(u, 0, 0.2) * (1 - seg01(u, 0.9, 1)), push = u > 0.22 && u < 0.88 ? ((u - 0.22) * 9) % 1 : 0;
    const grip = add(f.p, upN, 0.06 - 0.018 * ease(push) + 0.12 * (1 - k));
    const far = add(add(grip, upN, 0.2), [0, 0.1, -0.3]);
    let prev = f.p; for (let i = 1; i <= 10; i++) { const s = i / 10, q = [0, 1, 2].map(j => (1 - s) * (1 - s) * f.p[j] + 2 * (1 - s) * s * add(grip, upN, 0.05)[j] + s * s * far[j]); c.seg(prev, q, 0.0026, [0.93, 0.9, 0.7], { alpha: 0.85, spec: 0.8 }); prev = q; }
    if (k > 0.01) c.inst('bronchoscope', add(grip, upN, -0.1), upN, 0, { only: [], toward: g.op });   // right hand, pencil grip on the tube (bronchoscope frame: grip 10 cm up the axis)
  }
  _pads(c, g, u) {
    for (const [i, pad] of g.pads.entries()) {
      if (!pad) continue; const v = Math.min(1, Math.max(0, u * 2 - i)); if (v <= 0) continue;
      c.inst(i ? 'defibPadLeft' : 'defibPadRight', add(pad.p, pad.n, 0.002 + 0.12 * (1 - seg01(v, 0, 0.6))), pad.n, 0);
    }
  }
}
