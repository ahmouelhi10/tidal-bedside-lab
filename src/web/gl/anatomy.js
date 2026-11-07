// Procedural human body as signed-distance fields, meshed once per patient (see sdf.js).
// Visual only: proportions follow common anthropometric ratios and the circumference tables in body.js; nothing
// here feeds the physiology engine. Local frame: y up along the body (feet at 0), x = patient's left, z = anterior.
import { ell, sph, cone, smin, smax, clamp, spline, surfaceNets } from './sdf.js';
import { loft, merge, sphere } from './geometry.js';
import { mat4 } from './math.js';

const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** Elliptical loft through sections [{y, rx, rz, cx, cz}] as a distance function. */
function makeLoft(secs) {
  const ys = secs.map(s => s.y), RX = secs.map(s => s.rx), RZ = secs.map(s => s.rz), CX = secs.map(s => s.cx || 0), CZ = secs.map(s => s.cz || 0);
  const y0 = ys[0], y1 = ys[ys.length - 1]; let ly = NaN, rx = 0, rz = 0, cx = 0, cz = 0;
  const at = y => { const yc = y < y0 ? y0 : y > y1 ? y1 : y; if (yc !== ly) { ly = yc; rx = spline(ys, RX, yc); rz = spline(ys, RZ, yc); cx = spline(ys, CX, yc); cz = spline(ys, CZ, yc); } };
  const fn = (x, y, z) => {
    at(y); const q = Math.hypot((x - cx) / rx, (z - cz) / rz), d = (q - 1) * Math.min(rx, rz), dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
    return dy > 0 ? (d > 0 ? Math.hypot(d, dy) : dy) : d;
  };
  fn.at = (y) => { at(y); return { rx, rz, cx, cz }; };
  return fn;
}

export function buildBody(m) {
  const H = m.H, k = H / 1.75, fem = m.fem, u = m.u, thin = m.thin, sx = m.spreadX, sz = m.spreadZ;
  const belly = m.u * 0.07 * H * (fem ? 0.8 : 1.0);
  const mus = clamp((fem ? 0.35 : 0.8) - 0.55 * u - 0.15 * thin, 0.12, 0.9);          // muscle definition 0..1 (lean and male = more)
  const fat = clamp(u + (fem ? 0.12 : 0), 0, 1);
  const sec = (yf, a, b, cz = 0, cx = 0) => ({ y: yf * H, rx: a * sx, rz: b * sz, cz, cx });
  const shX = Math.min(m.shoulderHalf * 0.93, m.chest.a * 1.12) + m.arm.a * 0.55;      // shoulder joint x
  const shY = 0.800 * H, shZ = -m.chest.b * 0.10;

  // ------------------------------------------------------------------ torso + neck
  const torsoSecs = [
    sec(0.440, m.hip.a * 0.74, m.hip.b * 0.74, 0),
    sec(0.455, m.hip.a * 0.78, m.hip.b * 0.78, 0), sec(0.500, m.hip.a * 0.95, m.hip.b * 0.95, belly * 0.15), sec(0.540, m.hip.a, m.hip.b, belly * 0.40),
    sec(0.585, m.hip.a * 0.2 + m.waist.a * 0.8, m.hip.b * 0.2 + m.waist.b * 0.8, belly * 0.85), sec(0.625, m.waist.a, m.waist.b, belly),
    sec(0.665, m.waist.a * 0.4 + m.chest.a * 0.6, m.waist.b * 0.4 + m.chest.b * 0.6, belly * 0.55), sec(0.715, m.chest.a, m.chest.b, 0),
    sec(0.765, m.chest.a * 1.01, m.chest.b * 0.96, -m.chest.b * 0.03), sec(0.800, Math.min(m.shoulderHalf * 0.93, m.chest.a * 1.12), m.chest.b * 0.78, -m.chest.b * 0.10),
    sec(0.822, m.neck.a * 1.45, m.neck.b * 1.35, -m.chest.b * 0.08), sec(0.846, m.neck.a * 1.04, m.neck.b * 1.04, -0.004), sec(0.890, m.neck.a * 0.95, m.neck.b * 0.95, 0.004),
  ];
  const base = makeLoft(torsoSecs);
  const frontZ = y => { const s = base.at(y); return s.cz + s.rz; };
  const chA = m.chest.a;
  const torsoF = (x, y, z) => {
    let d = base(x, y, z); if (d > 0.09 || d < -0.075) return d;
    const ax = Math.abs(x);
    const sh = ax > shX - 0.12;
    if (sh && y > 0.74 * H) d = smin(d, ell(ax, y, z, shX, shY - 0.012, shZ - 0.004, m.arm.a * 1.30, 0.075 * k, m.arm.a * 1.22), 0.035);      // deltoid cap
    if (y > 0.775 * H) d = smin(d, cone(ax, y, z, 0.01, 0.836 * H, -m.chest.b * 0.16, shX * 0.9, 0.806 * H, -m.chest.b * 0.16, 0.034 * k, 0.026 * k), 0.045);   // trapezius slope
    const zf = frontZ(0.735 * H);
    if (z > -0.02 && y > 0.64 * H && y < 0.80 * H) {
      if (fem) {                                                                         // breasts, growing with BMI
        const r = 0.042 * H * (1 + 0.9 * u) * 0.95;
        d = smin(d, ell(ax, y, z, chA * 0.46, 0.708 * H - r * 0.15, zf - r * 0.18, r, r * 0.98, r * 0.62), 0.05);
      } else {                                                                           // pectorals
        const mo = 0.4 + mus * 0.9;
        d = smin(d, ell(ax, y, z, chA * 0.46, 0.742 * H, zf - 0.012, chA * 0.50, 0.050 * H, 0.020 + 0.016 * mo), 0.04 * (1 + u));
      }
    }
    if (y > 0.785 * H && y < 0.86 * H) {                                                // collar bones (visible on lean patients), sterno-cleido-mastoid, notch
      const cl = 1 - 0.75 * u, zc = frontZ(0.812 * H) - 0.004;
      d = smin(d, cone(ax, y, z, 0.014, 0.8165 * H, zc, shX * 0.88, 0.806 * H, zc - 0.012, 0.0072 * k * cl + 0.004, 0.0075 * k * cl + 0.004), 0.012);
      d = smin(d, cone(ax, y, z, 0.050 * k, 0.848 * H, -0.020, 0.013, 0.820 * H, frontZ(0.822 * H) - 0.012, 0.0085 * k * (0.5 + 0.5 * cl), 0.0105 * k * (0.5 + 0.5 * cl)), 0.014);
      d = smax(d, -sph(x, y, z, 0, 0.8245 * H, frontZ(0.8245 * H) + 0.001, 0.010), 0.01);
    }
    if (y > 0.58 * H && y < 0.62 * H && z > 0) d = smax(d, -sph(x, y, z, 0, 0.600 * H, frontZ(0.600 * H) + 0.004, 0.011), 0.008);   // navel
    // lower abdomen / mons fullness under the sheet
    return d;
  };
  const torsoBound = (x, y, z) => ell(x, y, z, 0, 0.665 * H, -0.01, shX + 0.2, 0.26 * H, 0.26);
  const torsoW = (x, y, z, nx, ny, nz) => {
    const f = Math.max(0, nz), yb = sstep(0.49 * H, 0.60 * H, y) * (1 - sstep(0.76 * H, 0.82 * H, y)), yc = sstep(0.64 * H, 0.70 * H, y) * (1 - sstep(0.78 * H, 0.80 * H, y));
    return [yb * (0.35 + 0.65 * f), yc * f * f * (1 - sstep(chA * 0.7, chA * 1.1, Math.abs(x)))];
  };
  const torsoTint = (x, y, z, nx, ny, nz) => {
    let r = 1, g = 1, b = 1;
    const ax = Math.abs(x), zf = frontZ(0.735 * H);
    // nipples / areolae
    if (nz > 0.3) { const dd = Math.hypot(ax - chA * 0.46 * (fem ? 1.0 : 1.02), y - (fem ? 0.700 : 0.722) * H); const a = (fem ? 0.022 : 0.016) * k; if (dd < a) { const t = 1 - sstep(a * 0.6, a, dd); r *= 1 - 0.14 * t; g *= 1 - 0.42 * t; b *= 1 - 0.40 * t; } }
    if (nz > 0.5 && y > 0.598 * H && y < 0.602 * H && ax < 0.012) { r *= 0.9; g *= 0.72; b *= 0.72; }
    return [r, g, b];
  };
  const torso = surfaceNets(torsoF, [-(shX + 0.16), 0.435 * H, -0.2 - belly * 0.2], [shX + 0.16, 0.895 * H, 0.2 + belly], 0.006, { bound: torsoBound, wfn: torsoW, tint: torsoTint });

  // ------------------------------------------------------------------ head
  const hy = 0.925 * H, hw = 1 + 0.12 * u - 0.05 * thin, mk = fem ? 0.85 : 1.0;        // head centre height, width factor, masculine-ness of the jaw/brow
  const F = {
    eyeX: 0.031 * k, eyeY: 0.020 * k, eyeZ: 0.0745 * k, eyeR: 0.0118 * k,
  };
  const headF = (X, Y, Z) => {
    const x = X, y = Y - hy, z = Z, ax = Math.abs(x), K = 1 / k, xx = ax * K, yy = y * K, zz = z * K;   // head space in "175 cm metres"
    let d = ell(xx, yy, zz, 0, 0.026, -0.010, 0.078 * hw, 0.098, 0.098);                                // cranium
    { const dj = ell(xx, yy, zz, 0, -0.062, 0.026, 0.058 * hw, 0.062, 0.074), dm = Math.min(d, dj); if (dm > 0.045 || (dm < -0.05 && yy > -0.12)) return dm * k; }
    d = smin(d, ell(xx, yy, zz, 0, -0.062, 0.026, 0.058 * hw * (0.95 + 0.08 * mk), 0.062, 0.074), 0.05);  // jaw / lower face
    d = smin(d, ell(xx, yy, zz, 0, -0.080, 0.048, 0.050 * hw, 0.045, 0.060), 0.04);
    d = smin(d, sph(xx, yy, zz, 0, -0.104, 0.060 + 0.005 * mk, 0.021 + 0.004 * mk), 0.02);              // chin
    d = smin(d, ell(xx, yy, zz, 0.055 * hw, -0.062, 0.004, 0.026, 0.034, 0.034), 0.03);                 // mandible angle / masseter
    d = smin(d, ell(xx, yy, zz, 0.050 * hw, -0.008, 0.058, 0.026, 0.020, 0.026), 0.03);                 // cheekbone
    d = smin(d, ell(xx, yy, zz, 0.042 * hw, -0.040, 0.062, 0.028 + 0.02 * u, 0.030, 0.028), 0.04);     // cheek
    d = smin(d, ell(xx, yy, zz, 0, 0.034, 0.080, 0.070 * hw, 0.010 + 0.006 * mk, 0.016 + 0.006 * mk), 0.03);  // brow ridge
    if (u > 0.2) d = smin(d, ell(xx, yy, zz, 0, -0.100, 0.034, 0.046, 0.026, 0.046), 0.04);              // double chin
    if (thin > 0.2) d = smax(d, -ell(xx, yy, zz, 0.040, -0.030, 0.052, 0.022, 0.028, 0.016) * 0.9, 0.02 * thin); // hollow cheeks
    // nose
    d = smin(d, cone(xx, yy, zz, 0, 0.018, 0.082, 0, -0.026, 0.104, 0.0085, 0.0135), 0.012);
    d = smin(d, sph(xx, yy, zz, 0, -0.027, 0.105, 0.0125), 0.01);
    d = smin(d, sph(xx, yy, zz, 0.014, -0.027, 0.095, 0.0095), 0.01);
    d = smax(d, -sph(xx, yy, zz, 0.0075, -0.036, 0.101, 0.0042), 0.003);                                // nostrils
    // eye sockets, eyelids
    const ex = F.eyeX * K, ey = F.eyeY * K, ez = F.eyeZ * K;
    d = smax(d, -sph(xx, yy, zz, ex, ey, ez + 0.011, 0.0145), 0.007);
    d = smin(d, ell(xx, yy, zz, ex, ey + 0.0095, ez + 0.006, 0.0140, 0.0085, 0.0125), 0.004);           // upper lid
    d = smin(d, ell(xx, yy, zz, ex, ey - 0.0105, ez + 0.007, 0.0128, 0.0052, 0.0115), 0.004);           // lower lid
    // mouth: lips and the line between them
    d = smin(d, ell(xx, yy, zz, 0, -0.0585, 0.0885, 0.0245, 0.0062, 0.0092), 0.004);                    // upper lip
    d = smin(d, ell(xx, yy, zz, 0, -0.0725, 0.0865, 0.0215 + 0.002 * (fem ? 1 : 0), 0.0085, 0.0105), 0.004); // lower lip
    d = smax(d, -ell(xx, yy, zz, 0, -0.0652, 0.0925, 0.021, 0.0014, 0.007), 0.0018);
    // ears
    d = smin(d, ell(xx, yy, zz, 0.077 * hw, -0.004, -0.014, 0.0095, 0.032, 0.021), 0.006);
    // neck stub
    d = smin(d, cone(xx, yy, zz, 0, -0.085, -0.010, 0, -0.18, -0.012, 0.050 * (m.neck.a / 0.058), 0.052 * (m.neck.a / 0.058)), 0.03);
    return d * k;
  };
  const headBound = (x, y, z) => ell(x, y, z, 0, hy - 0.02 * k, 0, 0.13 * k, 0.17 * k, 0.15 * k);
  const headTint = (X, Y, Z, nx, ny, nz) => {
    const K = 1 / k, x = Math.abs(X) * K, y = (Y - hy) * K, z = Z * K; let r = 1, g = 1, b = 1;
    const mul = (c, t) => { r *= 1 + (c[0] - 1) * t; g *= 1 + (c[1] - 1) * t; b *= 1 + (c[2] - 1) * t; };
    if (z > 0.04) {
      // eyebrows
      const bx = x - 0.034, by = y - (0.042 + 0.012 * Math.max(0, 1 - Math.abs(bx) / 0.03) * (bx > 0 ? 0.6 : 0)), bt = (1 - sstep(0.006, 0.012, Math.hypot(bx * 0.45, by))) * (x > 0.01 && x < 0.062 ? 1 : 0);
      if (bt > 0) mul([0.34, 0.29, 0.27], bt * 0.9);
      // lips (inner red), mouth line
      const lt = (1 - sstep(0.7, 1, Math.hypot(x / 0.0245, (y + 0.0645) / 0.0125)));
      if (lt > 0) mul([0.96, 0.66, 0.66], lt);
      if (Math.abs(y + 0.0652) < 0.0013 && x < 0.021) mul([0.55, 0.38, 0.38], 0.7);
      // cheeks flush, nose tip slightly warmer
      mul([1.0, 0.93, 0.93], (1 - sstep(0.02, 0.05, Math.hypot(x - 0.045, y + 0.02))) * 0.5);
      mul([1.0, 0.9, 0.9], (1 - sstep(0.005, 0.016, Math.hypot(x, y + 0.027, z - 0.105))) * 0.5);
      // stubble / beard shadow (men)
      if (!fem && y < -0.045 && y > -0.12) { const side = 1 - sstep(0.04, 0.075, x), up = sstep(-0.06, -0.075, y) + (1 - sstep(-0.058, -0.052, y)) * 0.0; const st = clamp(0.55 * side * (sstep(-0.045, -0.06, y)) + 0.3 * (y < -0.064 ? 1 : 0) * (x < 0.04 ? 1 : 0), 0, 0.7); mul([0.78, 0.76, 0.76], st * 0.9); }
      if (!fem && y < -0.05 && y > -0.075 && x > 0.01 && x < 0.04 && z > 0.08) mul([0.8, 0.77, 0.77], 0.5);
      // nostril darkness
      if (Math.hypot(x - 0.0075, y + 0.036, z - 0.101) < 0.007) mul([0.55, 0.4, 0.4], 0.8);
    }
    if (x > 0.07 && Math.abs(y) < 0.04) mul([1.0, 0.86, 0.86], 0.45);               // ears are warmer
    return [r, g, b];
  };
  const head = surfaceNets(headF, [-0.13 * k, hy - 0.2 * k, -0.15 * k], [0.13 * k, hy + 0.14 * k, 0.15 * k], 0.0029, { bound: headBound, tint: headTint });

  // hair (own mesh, own material)
  const hairF = (X, Y, Z) => {
    const K = 1 / k, x = Math.abs(X) * K, y = (Y - hy) * K, z = Z * K;
    let d = ell(x, y, z, 0, 0.028, -0.014, 0.086 * hw, 0.103, 0.103);
    const line = 0.064 + (z - 0.085) * 0.52 - 0.034 * sstep(0.05, 0.085, x);        // forehead hairline, temples, nape
    d = smax(d, line - y, 0.01);
    if (fem) {                                                                           // long hair spread on the pillow
      d = smin(d, ell(x, y, z, 0, -0.07, -0.125, 0.105, 0.10, 0.06), 0.05);
      d = smin(d, cone(x, y, z, 0.055, -0.03, -0.09, 0.105, -0.17, -0.135, 0.05, 0.042), 0.05);
      d = smax(d, -(y + 0.2), 0.02) * 1;
    }
    return d * k;
  };
  const hair = surfaceNets(hairF, [-0.14 * k, hy - 0.22 * k, -0.2 * k], [0.14 * k, hy + 0.15 * k, 0.12 * k], 0.0036, { bound: (x, y, z) => ell(x, y, z, 0, hy - 0.03 * k, -0.04 * k, 0.15 * k, 0.2 * k, 0.17 * k) });

  // eyes: sclera with an iris and pupil painted through the per-vertex tint
  const eyeBall = sphere(F.eyeR, F.eyeR, F.eyeR, 18, 12), et = new Float32Array((eyeBall.pos.length / 3) * 3);
  for (let i = 0; i < eyeBall.pos.length / 3; i++) {
    const nzv = eyeBall.nrm[i * 3 + 2]; let r = 1, g = 0.97, b = 0.95;
    if (nzv > 0.80) { const t = sstep(0.80, 0.84, nzv); r = 1 - 0.58 * t; g = 0.97 - 0.70 * t; b = 0.95 - 0.78 * t; }
    if (nzv > 0.955) { r = g = b = 0.05; }
    et[i * 3] = r; et[i * 3 + 1] = g; et[i * 3 + 2] = b;
  }
  eyeBall.tint = et;
  const eyes = merge([+1, -1].map(sd => ({ mesh: eyeBall, tp: p => [p[0] + sd * F.eyeX, p[1] + hy + F.eyeY, p[2] + F.eyeZ] })));
  const pupils = merge([{ mesh: sphere(0.0001, 0.0001, 0.0001, 4, 3), tp: p => [p[0], p[1] + hy, p[2]] }]);
  const lips = merge([
    { mesh: sphere(0.0243 * k, 0.0066 * k, 0.0094 * k, 14, 6), tp: p => [p[0], p[1] + hy - 0.0585 * k, p[2] + 0.0885 * k + 0.0008] },
    { mesh: sphere(0.0213 * k, 0.0089 * k, 0.0107 * k, 14, 6), tp: p => [p[0], p[1] + hy - 0.0725 * k, p[2] + 0.0865 * k + 0.0008] },
  ]);

  // ------------------------------------------------------------------ arms (built hanging from the shoulder joint, then posed)
  const A = m.arm.a, up = 0.190 * H, fo = 0.150 * H, wristY = -(up + fo);
  const armF = side => (X, Y, Z) => {
    const x = X, y = Y, z = Z;
    let d = cone(x, y, z, 0, 0, 0, 0, -up, 0, A * 1.06, A * 0.74);
    d = smin(d, cone(x, y, z, 0, -up, 0, 0, wristY, 0, A * 0.80, A * 0.50), 0.035);
    d = smin(d, ell(x, y, z, 0, -up * 0.45, A * 0.14 * (0.5 + mus), A * 0.92, up * 0.30, A * (0.86 + 0.1 * mus)), 0.03);        // biceps / brachialis
    d = smin(d, ell(x, y, z, 0, -up * 0.40, -A * 0.18, A * 0.80, up * 0.28, A * 0.78), 0.03);                                      // triceps
    d = smin(d, ell(x, y, z, 0, -up - fo * 0.22, A * 0.06, A * 0.82, fo * 0.28, A * 0.74), 0.03);                                  // forearm flexors
    d = smin(d, sph(x, y, z, 0, -up - 0.004, -A * 0.66, 0.0135 * k), 0.012);                                                       // olecranon
    d = smin(d, sph(x, y, z, side * A * 0.55, wristY + 0.004, 0, 0.0125 * k), 0.01);                                                // ulnar head
    return d;
  };
  const handF = side => (X, Y, Z) => {
    const x = X, y = Y - wristY, z = Z;                                                                                              // origin at the wrist
    let d = ell(x, y, z, 0, -0.050 * k, 0, 0.040 * k, 0.050 * k, 0.0105 * k);
    d = smin(d, cone(x, y, z, 0, 0.012, 0, 0, -0.012, 0, 0.026 * k, 0.034 * k), 0.012);
    const fx = [-0.027, -0.009, 0.009, 0.027].map(v => v * k * side), len = [0.080, 0.088, 0.082, 0.066].map(v => v * k);
    for (let i = 0; i < 4; i++) {
      const kn = -0.095 * k, tipY = kn - len[i] * 0.9, curl = len[i] * 0.34;
      d = Math.min(d, cone(x, y, z, fx[i], kn, 0.002 * k, fx[i], kn - len[i] * 0.55, curl * 0.35, 0.0086 * k, 0.0078 * k), cone(x, y, z, fx[i], kn - len[i] * 0.55, curl * 0.35, fx[i], tipY, curl, 0.0078 * k, 0.0065 * k));
    }
    d = smin(d, cone(x, y, z, side * 0.030 * k, -0.030 * k, 0.012 * k, side * 0.056 * k, -0.082 * k, 0.020 * k, 0.0120 * k, 0.0088 * k), 0.012);   // thumb
    return d;
  };
  const armTint = (x, y, z, nx, ny, nz) => { let r = 1, g = 1, b = 1; if (y < wristY - 0.1 * k && nz < -0.3) { /* nails on the back of the fingers */ const t = sstep(wristY - 0.16 * k, wristY - 0.19 * k, y) * 0.5; r *= 1.0; g *= 1 - 0.1 * t; b *= 1 - 0.1 * t; } return [r, g, b]; };
  const armMesh = (side, abductDeg, flexDeg) => {
    const a = surfaceNets(armF(side), [-A * 1.6, wristY - 0.03, -A * 1.6], [A * 1.6, 0.1, A * 1.6], 0.005, { bound: (x, y, z) => cone(x, y, z, 0, 0.0, 0, 0, wristY, 0, A * 1.5, A * 1.0) });
    const hd = surfaceNets(handF(side), [-0.06 * k, wristY - 0.21 * k, -0.04 * k], [0.07 * k, wristY + 0.03 * k, 0.05 * k], 0.003, { tint: armTint });
    const th = abductDeg * Math.PI / 180, ph = flexDeg * Math.PI / 180, R = mat4.multiply(mat4.rotationZ(-side * th), mat4.rotationX(ph));
    const piv = [side * shX, shY, shZ];
    const rot = p => { const q = mat4.transformDir(R, p); return [q[0] + piv[0], q[1] + piv[1], q[2] + piv[2]]; };
    const rotN = n => mat4.transformDir(R, n);
    return merge([{ mesh: a, tp: rot, tn: rotN }, { mesh: hd, tp: rot, tn: rotN }]);
  };
  // left arm (+x) alongside the body, right arm abducted for IV access (positions kept from the previous model)
  const armsMesh = merge([{ mesh: armMesh(+1, 12, 0) }, { mesh: armMesh(-1, 32, 0) }]);

  // ------------------------------------------------------------------ legs and feet
  const calfA = m.calf.a, calfB = m.calf.b, thA = m.thigh.a, thB = m.thigh.b, cxs = m.hip.a * 0.42;
  const legSecs = sd => [
    { y: 0.040 * H, rx: calfA * 0.46, rz: calfB * 0.50, cx: sd * cxs }, { y: 0.085 * H, rx: calfA * 0.55, rz: calfB * 0.60, cx: sd * cxs },
    { y: 0.19 * H, rx: calfA, rz: calfB, cx: sd * cxs, cz: -0.004 }, { y: 0.285 * H, rx: calfA * 0.78, rz: calfB * 0.78, cx: sd * cxs },
    { y: 0.36 * H, rx: thA * 0.80, rz: thB * 0.82, cx: sd * cxs }, { y: 0.44 * H, rx: thA * 1.0, rz: thB * 1.0, cx: sd * cxs }, { y: 0.50 * H, rx: thA * 1.06, rz: thB * 1.04, cx: sd * cxs },
  ];
  const lL = makeLoft(legSecs(+1)), lR = makeLoft(legSecs(-1)), ankleY = 0.040 * H, footYaw = 0.22, plantar = 0.30;
  const footF = (x, y, z, sd) => {                                    // foot in a frame rotated about the ankle (toes out and pointing slightly away)
    const px = x - sd * cxs, py = y - ankleY, pz = z, cy = Math.cos(footYaw * sd), sy = Math.sin(footYaw * sd), cp = Math.cos(plantar), sp = Math.sin(plantar);
    const ax = px * cy - pz * sy, az = px * sy + pz * cy, by = py * cp - az * sp, bz = py * sp + az * cp, bx = ax * sd;     // bx: lateral(+)/medial(-) after mirroring
    let d = ell(bx, by, bz, 0, -0.046 * k, 0.050 * k, 0.040 * k, 0.030 * k, 0.118 * k);                                   // foot body
    d = smin(d, ell(bx, by, bz, 0, -0.016 * k, 0.028 * k, 0.034 * k, 0.034 * k, 0.078 * k), 0.03);                         // instep
    d = smin(d, sph(bx, by, bz, 0, -0.042 * k, -0.040 * k, 0.034 * k), 0.02);                                              // heel
    for (let i = 0; i < 5; i++) { const tx = (-0.020 + i * 0.0105) * k * -1, big = i === 0, len = (big ? 0.050 : 0.040 - i * 0.0035) * k, r = (big ? 0.0125 : 0.0078 - i * 0.0004) * k; d = smin(d, cone(bx, by, bz, tx, -0.055 * k, 0.150 * k, tx * 0.9, -0.052 * k, 0.150 * k + len, r, r * 0.8), 0.006); }
    d = smin(d, sph(bx, by, bz, 0.034 * k, -0.002 * k, 0.0, 0.0125 * k), 0.012);                                           // lateral malleolus
    d = smin(d, sph(bx, by, bz, -0.032 * k, 0.0, 0.0, 0.0115 * k), 0.012);                                                  // medial malleolus
    return d;
  };
  const legF = (x, y, z) => {
    let dl = lL(x, y, z), dr = lR(x, y, z);
    if (Math.min(dl, dr) < 0.09) {
      for (const sd of [1, -1]) {
        const cx = sd * cxs, ax = (x - cx) * sd; let d = sd > 0 ? dl : dr;
        d = smin(d, ell(ax, y, z, 0.006, 0.395 * H, thB * 0.35, thA * 0.78, 0.075 * H, thB * 0.62 * (0.8 + 0.3 * mus)), 0.04);        // quadriceps
        d = smin(d, sph(ax, y, z, 0, 0.288 * H, thB * 0.60, 0.021 * k), 0.015);                                                      // patella
        d = smin(d, ell(ax, y, z, -0.004, 0.215 * H, -calfB * 0.25, calfA * 0.62, 0.080 * H, calfB * 0.62), 0.03);                   // gastrocnemius
        d = smin(d, ell(ax, y, z, 0.002, 0.185 * H, calfB * 0.30, calfA * 0.38, 0.085 * H, calfB * 0.52), 0.03);                      // tibialis / shin
        if (sd > 0) dl = d; else dr = d;
      }
    }
    return Math.min(Math.min(dl, dr), footF(x, y, z, +1), footF(x, y, z, -1));
  };
  const legBound = (x, y, z) => Math.min(ell(x, y, z, cxs, 0.25 * H, 0.04, thA * 1.5, 0.3 * H, 0.2), ell(x, y, z, -cxs, 0.25 * H, 0.04, thA * 1.5, 0.3 * H, 0.2));
  const legs = surfaceNets(legF, [-(cxs + thA * 1.2 + 0.03), 0.0, -0.14], [cxs + thA * 1.2 + 0.03, 0.51 * H, 0.31], 0.0075, { bound: legBound });

  const skin = merge([{ mesh: torso }, { mesh: head }, { mesh: armsMesh }, { mesh: legs }]);

  // ------------------------------------------------------------------ sheet, landmarks (as before)
  const ls = legSecs(1);
  const sheetSecs = ls.map(s => ({ y: s.y, rx: Math.abs(s.cx) + s.rx + 0.012, rz: s.rz + 0.016, cz: (s.cz || 0) + 0.008 }));
  sheetSecs[0].rx += 0.01;
  sheetSecs.push({ y: 0.535 * H, rx: m.hip.a * 1.04 * sx, rz: m.hip.b * 1.04 * sz + belly * 0.45, cz: belly * 0.3 });
  sheetSecs.push({ y: 0.575 * H, rx: m.hip.a * 1.0 * sx, rz: m.hip.b * 1.02 * sz + belly * 0.35, cz: belly * 0.4 });
  const sheet = loft(sheetSecs, 36);

  const chestFront = m.chest.b;
  const headD = 0.098 * k, headW = 0.078 * k, headY = hy;
  const landmarks = {
    sternum: [0, 0.725 * H, chestFront + (fem ? 0.005 : 0.012)],
    padRight: [-m.chest.a * 0.35, 0.765 * H, chestFront * 0.85], padLeft: [m.chest.a * 0.90, 0.69 * H, chestFront * 0.45],
    face: [0, hy - 0.035 * k, 0.098 * k], airway: [0, hy - 0.065 * k, 0.092 * k],
    rightArmIV: [-(shX) - Math.sin(32 * Math.PI / 180) * 0.19 * H, 0.60 * H, 0.0], leftArm: [shX + Math.sin(12 * Math.PI / 180) * 0.19 * H, 0.60 * H, 0.0],
    neck: [0, 0.848 * H, m.neck.b], abdomen: [0, 0.60 * H, m.waist.b + belly], femoral: [m.hip.a * 0.45, 0.47 * H, m.hip.b * 0.6],
    headCenter: [0, hy, 0], headRadius: Math.max(headW, headD),
  };
  const zBack = Math.min(...torsoSecs.map(s => (s.cz || 0) - s.rz), -headD);
  return { skin, hair, eyes, pupils, lips, sheet, landmarks, zBack, H, morph: m };
}

