// Tracheobronchial tree for the bronchoscope: branch centrelines (lobar and segmental), a smooth lumen surface meshed from a
// signed-distance field (cartilage rings included), the tracheal tube lumen, and scope navigation along the tree.
// Units: centimetres. Axes: x = patient's left, y = cranial, z = anterior. Purely visual: the physiology lives in the engine.
import { surfaceNets, smin, clamp } from './sdf.js';

const V = {
  add: (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k], sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  scale: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
};
export { V };

// [id, label, name {en, fr}, parent, at (fraction along parent), dir, length, r1, r2] - adult male dimensions at 170 cm (approximate anatomy)
const TREE = [
  ['T', 'Trachea', { en: 'Trachea', fr: 'Trachée' }, null, 0, [0, -1, -0.09], 11, 0.9, 0.85],
  ['RMB', 'RMB', { en: 'Right main bronchus', fr: 'Bronche souche droite' }, 'T', 1, [-0.42, -0.9, -0.05], 2.4, 0.75, 0.7],
  ['RUL', 'RUL', { en: 'Right upper lobe', fr: 'Lobe supérieur droit' }, 'RMB', 0.75, [-1, 0.25, -0.15], 1.6, 0.5, 0.45],
  ['RB1', 'B1', { en: 'Apical segment (RB1)', fr: 'Segment apical (B1)' }, 'RUL', 1, [-0.4, 0.9, -0.2], 1.1, 0.3, 0.27],
  ['RB2', 'B2', { en: 'Posterior segment (RB2)', fr: 'Segment postérieur (B2)' }, 'RUL', 1, [-0.5, 0.1, -0.85], 1.1, 0.3, 0.27],
  ['RB3', 'B3', { en: 'Anterior segment (RB3)', fr: 'Segment antérieur (B3)' }, 'RUL', 1, [-0.4, 0, 0.9], 1.1, 0.3, 0.27],
  ['BI', 'BI', { en: 'Bronchus intermedius', fr: 'Tronc intermédiaire' }, 'RMB', 1, [-0.2, -1, 0], 2.4, 0.6, 0.55],
  ['RML', 'RML', { en: 'Middle lobe', fr: 'Lobe moyen' }, 'BI', 1, [-0.25, -0.55, 0.8], 1.7, 0.4, 0.36],
  ['RB4', 'B4', { en: 'Lateral segment (RB4)', fr: 'Segment latéral (B4)' }, 'RML', 1, [-0.8, -0.3, 0.5], 1, 0.25, 0.23],
  ['RB5', 'B5', { en: 'Medial segment (RB5)', fr: 'Segment médial (B5)' }, 'RML', 1, [0.2, -0.4, 0.9], 1, 0.25, 0.23],
  ['RLL', 'RLL', { en: 'Right lower lobe', fr: 'Lobe inférieur droit' }, 'BI', 1, [-0.12, -1, -0.12], 2.6, 0.5, 0.45],
  ['RB6', 'B6', { en: 'Superior segment (RB6)', fr: 'Segment apical du lobe inférieur (B6)' }, 'RLL', 0.15, [-0.1, -0.15, -1], 1.1, 0.3, 0.27],
  ['RB7', 'B7', { en: 'Medial basal (RB7)', fr: 'Basal médial (B7)' }, 'RLL', 1, [0.35, -1, 0.1], 1, 0.25, 0.23],
  ['RB8', 'B8', { en: 'Anterior basal (RB8)', fr: 'Basal antérieur (B8)' }, 'RLL', 1, [-0.2, -1, 0.6], 1, 0.25, 0.23],
  ['RB9', 'B9', { en: 'Lateral basal (RB9)', fr: 'Basal latéral (B9)' }, 'RLL', 1, [-0.7, -1, -0.1], 1, 0.25, 0.23],
  ['RB10', 'B10', { en: 'Posterior basal (RB10)', fr: 'Basal postérieur (B10)' }, 'RLL', 1, [-0.2, -1, -0.7], 1, 0.25, 0.23],
  ['LMB', 'LMB', { en: 'Left main bronchus', fr: 'Bronche souche gauche' }, 'T', 1, [0.75, -0.65, -0.08], 4.8, 0.65, 0.6],
  ['LUL', 'LUL', { en: 'Left upper lobe', fr: 'Lobe supérieur gauche' }, 'LMB', 1, [0.55, 0.35, 0.6], 1.4, 0.5, 0.45],
  ['LB12', 'B1+2', { en: 'Apicoposterior segment (LB1+2)', fr: 'Segment apico-dorsal (B1+2)' }, 'LUL', 1, [0.3, 0.9, -0.3], 1.2, 0.3, 0.27],
  ['LB3', 'B3', { en: 'Anterior segment (LB3)', fr: 'Segment antérieur (B3)' }, 'LUL', 1, [0.4, 0.1, 0.9], 1.1, 0.28, 0.25],
  ['LING', 'Ling', { en: 'Lingula', fr: 'Lingula' }, 'LUL', 0.45, [0.5, -0.6, 0.6], 1.4, 0.32, 0.28],
  ['LLL', 'LLL', { en: 'Left lower lobe', fr: 'Lobe inférieur gauche' }, 'LMB', 1, [0.2, -1, -0.15], 2.6, 0.5, 0.45],
  ['LB6', 'B6', { en: 'Superior segment (LB6)', fr: 'Segment apical du lobe inférieur (B6)' }, 'LLL', 0.15, [0.1, -0.15, -1], 1.1, 0.3, 0.27],
  ['LB8', 'B8', { en: 'Anteromedial basal (LB7+8)', fr: 'Basal antéro-médial (B7+8)' }, 'LLL', 1, [0.2, -1, 0.6], 1, 0.25, 0.23],
  ['LB9', 'B9', { en: 'Lateral basal (LB9)', fr: 'Basal latéral (B9)' }, 'LLL', 1, [0.7, -1, -0.1], 1, 0.25, 0.23],
  ['LB10', 'B10', { en: 'Posterior basal (LB10)', fr: 'Basal postérieur (B10)' }, 'LLL', 1, [0.2, -1, -0.7], 1, 0.25, 0.23],
];
/** engine secretion region of a branch */
export const regionOf = (id) => (id === 'T' ? 'trachea' : id === 'RMB' || id.startsWith('R') || id === 'BI' ? 'R' : 'L');
const RINGED = new Set(['T', 'RMB', 'LMB', 'BI']);

/** Branch list scaled to the patient (lengths with height, calibre with height and sex). */
export function buildTree({ heightCm = 170, sex = 'M' } = {}) {
  const kl = heightCm / 170, kr = kl * (sex === 'F' ? 0.88 : 1), by = {};
  const out = TREE.map(([id, label, name, parent, at, dir, len, r1, r2]) => {
    const p = parent ? by[parent] : null, d = V.norm(dir), L = len * kl;
    const a = p ? V.add(p.a, p.d, p.len * at) : [0, 0, 0];
    const b = { id, label, name, parent, at, a, d, len: L, b: V.add(a, d, L), r1: r1 * kr, r2: r2 * kr, children: [], ringed: RINGED.has(id) };
    if (p) p.children.push(b);
    by[id] = b; return b;
  });
  return { list: out, by, root: by.T };
}

/** lumen signed distance (negative inside the airway), with C-shaped cartilage rings on the trachea and main bronchi */
function branchDist(b, x, y, z) {
  const px = x - b.a[0], py = y - b.a[1], pz = z - b.a[2];
  let s = px * b.d[0] + py * b.d[1] + pz * b.d[2]; const sc = clamp(s, 0, b.len);
  const qx = px - b.d[0] * sc, qy = py - b.d[1] * sc, qz = pz - b.d[2] * sc, rho = Math.hypot(qx, qy, qz);
  let d = rho - (b.r1 + (b.r2 - b.r1) * (sc / b.len));
  if (b.ringed && s > 0.4 && s < b.len - 0.3 && rho > 1e-4) {
    const ant = qz / rho;                                                       // +1 anterior, -1 posterior (membranous wall)
    const ring = Math.pow(Math.max(0, Math.cos((s / 0.42) * Math.PI * 2)), 4) * clamp((ant + 0.45) / 0.5, 0, 1);
    d += 0.05 * ring * (b.r1 / 0.9);
  }
  return d;
}
export function lumenSdf(tree) {
  const L = tree.list, k = 0.22;
  return (x, y, z) => { let d = 1e9; for (const b of L) { const e = branchDist(b, x, y, z); d = d === 1e9 ? e : smin(d, e, k); } return d; };
}

/** Mesh of the airway wall (seen from inside). tint.r = cartilage, tint.g = depth into the tree (0 trachea .. 1 segments). */
export function buildAirwayMesh(tree, h = 0.13) {
  const f = lumenSdf(tree), L = tree.list;
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const b of L) for (const p of [b.a, b.b]) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i] - b.r1 - 0.4); mx[i] = Math.max(mx[i], p[i] + b.r1 + 0.4); }
  mx[1] = Math.min(mx[1], 0.25);                                                 // left open just above the cords: the tube comes from there
  const bound = (x, y, z) => { let d = 1e9; for (const b of L) { const m = V.add(b.a, b.d, b.len / 2); d = Math.min(d, Math.hypot(x - m[0], y - m[1], z - m[2]) - b.len / 2 - b.r1); } return d; };
  const gen = (id) => (id === 'T' ? 0 : ['RMB', 'LMB'].includes(id) ? 0.25 : ['RUL', 'BI', 'RML', 'RLL', 'LUL', 'LLL', 'LING'].includes(id) ? 0.55 : 1);
  const tint = (x, y, z) => {
    let best = null, bd = 1e9;
    for (const b of L) { const e = branchDist(b, x, y, z); if (e < bd) { bd = e; best = b; } }
    let cart = 0;
    if (best.ringed) {
      const p = V.sub([x, y, z], best.a), s = V.dot(p, best.d), q = V.add(p, best.d, -s), rho = V.len(q) || 1, ant = q[2] / rho;
      cart = Math.pow(Math.max(0, Math.cos((s / 0.42) * Math.PI * 2)), 3) * clamp((ant + 0.45) / 0.5, 0, 1);
    }
    return [cart, gen(best.id), 0];
  };
  return surfaceNets(f, mn, mx, h, { bound, tint });
}

/** Inner surface of the tracheal tube from above the cords to its tip (path: trachea, then the right main bronchus if too deep). */
export function buildTubeMesh(tree, tipAboveCarinaCm, rIn = 0.38) {
  const T = tree.by.T, R = tree.by.RMB, pts = [];
  const sTip = T.len - tipAboveCarinaCm;
  if (sTip <= T.len) pts.push(V.add(T.a, T.d, -3), V.add(T.a, T.d, Math.max(0.5, sTip)));
  else { pts.push(V.add(T.a, T.d, -3), T.b, V.add(R.a, R.d, Math.min(R.len - 0.3, sTip - T.len))); }
  const pos = [], nrm = [], w = [], tint = [], idx = [], seg = 28;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], d = V.norm(V.sub(b, a)), L = V.len(V.sub(b, a)), up = Math.abs(d[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
    const u = V.norm(V.cross(up, d)), v = V.cross(d, u), rows = Math.max(2, Math.ceil(L / 0.25));
    for (let r = 0; r <= rows; r++) {
      const s = (r / rows) * L, c = V.add(a, d, s), base = pos.length / 3, along = acc + s;
      for (let j = 0; j <= seg; j++) {
        const th = (j / seg) * Math.PI * 2, rad = V.add(V.scale(u, Math.cos(th)), v, Math.sin(th));
        pos.push(...V.add(c, rad, rIn)); nrm.push(...rad); w.push(0, 0);
        const mark = Math.abs(((along + 100) % 1) - 0.5) > 0.47 ? 1 : 0, line = Math.abs(th - Math.PI * 1.5) < 0.12 ? 1 : 0;   // 1-cm depth marks, radio-opaque line
        tint.push(mark, line, 0);
      }
      if (r < rows) for (let j = 0; j < seg; j++) { const q = base + j; idx.push(q, q + seg + 1, q + 1, q + 1, q + seg + 1, q + seg + 2); }
    }
    acc += L;
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), w: new Float32Array(w), tint: new Float32Array(tint), idx: new Uint32Array(idx), tip: pts[pts.length - 1], path: pts };
}

/** Points on the airway wall where secretions sit, by engine region; amount 0..1 sets how many and how big. */
export function secretionSpots(tree, region, amount) {
  const by = tree.by, n = Math.round(clamp(amount, 0, 1) * 6), out = [];
  const where = region === 'trachea' ? [[by.T, 0.75], [by.T, 0.88], [by.T, 0.95]] : region === 'R' ? [[by.BI, 0.5], [by.RLL, 0.3], [by.RMB, 0.6], [by.RML, 0.3]] : [[by.LMB, 0.7], [by.LLL, 0.35], [by.LUL, 0.4]];
  for (let i = 0; i < n; i++) {
    const [b, t] = where[i % where.length], c = V.add(b.a, b.d, b.len * clamp(t + 0.07 * Math.floor(i / where.length), 0, 0.95));
    const ang = 2.4 + i * 1.7, up = Math.abs(b.d[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1], u = V.norm(V.cross(up, b.d)), v = V.cross(b.d, u);
    const rad = V.add(V.scale(u, Math.cos(ang)), v, Math.sin(ang)), r = b.r1 + (b.r2 - b.r1) * t;
    out.push({ p: V.add(c, rad, r * 0.9), n: rad, size: (0.06 + 0.13 * amount) * (b.r1 / 0.8) });
  }
  return out;
}

/** Scope state on the tree: branch, distance s along it, tip bend and a continuously transported camera frame. */
export class Scope {
  constructor(tree, startS = 0.6) {
    this.tree = tree; this.b = tree.root; this.s = startS; this.bend = 0; this.fwd = [...tree.root.d]; this.up = [0, 0, 1]; this.msg = null;
  }
  get pos() { return V.add(this.b.a, this.b.d, this.s); }
  /** current viewing direction: the scope axis bent toward the frame's up vector */
  get view() { return V.norm(V.add(V.scale(this.fwd, Math.cos(this.bend)), this.up, Math.sin(this.bend))); }
  get camUp() { return V.norm(V.add(V.scale(this.up, Math.cos(this.bend)), this.fwd, -Math.sin(this.bend))); }
  roll(a) { const f = this.fwd, u = this.up, s = V.cross(f, u); this.up = V.norm(V.add(V.scale(u, Math.cos(a)), s, Math.sin(a))); }
  bendBy(a) { this.bend = clamp(this.bend + a, -1.3, 1.3); }                  // about 75 degrees of tip deflection each way
  straighten() { this.bend = 0; }
  /** move along the tree; ds > 0 advances (entering the branch the tip points at), ds < 0 withdraws */
  move(ds, minS = 0.4) {
    this.msg = null;
    if (ds > 0) {
      const view = this.view, own = V.dot(view, this.b.d);
      let best = null, bs = -1;
      for (const c of this.b.children) {
        const atEnd = c.at >= 0.99;                                              // a fork at the end of the branch, or a side orifice along it
        const sN = this.s + ds, near = atEnd ? sN >= this.b.len - 0.6 : Math.abs(sN - c.at * this.b.len) < 0.5;
        const thr = atEnd ? 0.72 : Math.max(0.72, own + 0.04), sc = V.dot(view, c.d);
        if (near && sc > thr && sc > bs) { bs = sc; best = c; }
      }
      if (best) { if (best.r1 < 0.18) { this.msg = 'narrow'; return; } this.b = best; this.s = 0.05; return; }
      if (this.s + ds > this.b.len - 0.35) { this.s = this.b.len - 0.35; this.msg = this.b.children.some(c => c.at >= 0.99) ? 'aim' : 'end'; return; }
      this.s += ds;
    } else {
      this.s += ds;
      if (this.s < (this.b.parent ? 0 : minS)) {
        if (!this.b.parent) { this.s = minS; this.msg = 'top'; return; }
        const p = this.tree.by[this.b.parent]; this.s = p.len * this.b.at + this.s; this.b = p; this.s = clamp(this.s, 0.05, p.len);
      }
    }
  }
  /** per-frame: the frame follows the branch axis smoothly (parallel transport of the up vector) */
  update(dt) {
    const k = 1 - Math.exp(-dt * 6);
    this.fwd = V.norm(V.add(V.scale(this.fwd, 1 - k), this.b.d, k));
    this.up = V.norm(V.add(this.up, this.fwd, -V.dot(this.up, this.fwd)));
  }
  /** name of where the tip is (the main carina when at the bottom of the trachea) */
  where(lang = 'en') {
    if (this.b.id === 'T' && this.s > this.b.len - 1.0) return lang === 'fr' ? 'Carène principale' : 'Main carina';
    return this.b.name[lang] || this.b.name.en;
  }
  /** path from the trachea to the current branch (for the map) */
  path() { const out = []; let b = this.b; while (b) { out.unshift(b.id); b = b.parent ? this.tree.by[b.parent] : null; } return out; }
}
