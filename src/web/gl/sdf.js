// Signed-distance modelling + naive surface nets, so the patient is one smooth organic surface instead of stacked tubes.
// Pure functions, no dependencies. Distances are in metres; negative = inside.

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
/** polynomial smooth minimum (k = blend radius) */
export const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
/** smooth maximum, used for smooth subtraction/intersection */
export const smax = (a, b, k) => -smin(-a, -b, k);

/** Approximate ellipsoid distance (Inigo Quilez bound), centre c, radii r. */
export function ell(x, y, z, cx, cy, cz, rx, ry, rz) {
  const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
  const k0 = Math.sqrt(px * px + py * py + pz * pz);
  if (k0 < 1e-6) return -Math.min(rx, ry, rz);
  const qx = px / rx, qy = py / ry, qz = pz / rz, k1 = Math.sqrt(qx * qx + qy * qy + qz * qz);
  return k1 < 1e-9 ? (k0 - 1) * Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}
export const sph = (x, y, z, cx, cy, cz, r) => Math.hypot(x - cx, y - cy, z - cz) - r;
/** Round cone: sphere r1 at a, sphere r2 at b (tapered capsule). */
export function cone(x, y, z, ax, ay, az, bx, by, bz, r1, r2) {
  const bax = bx - ax, bay = by - ay, baz = bz - az, pax = x - ax, pay = y - ay, paz = z - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  let t = (pax * bax + pay * bay + paz * baz) / (l2 || 1e-9); t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = pax - bax * t, dy = pay - bay * t, dz = paz - baz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - (r1 + (r2 - r1) * t);
}
/** Catmull-Rom through values v at knots ys (ascending), clamped at the ends. */
export function spline(ys, v, y) {
  const n = ys.length; if (y <= ys[0]) return v[0]; if (y >= ys[n - 1]) return v[n - 1];
  let i = 1; while (ys[i] < y) i++;
  const i0 = i - 1, t = (y - ys[i0]) / (ys[i] - ys[i0]);
  const p0 = v[Math.max(0, i0 - 1)], p1 = v[i0], p2 = v[i], p3 = v[Math.min(n - 1, i + 1)];
  // non-uniform knot spacing: scale tangents by the interval ratio
  const h = ys[i] - ys[i0], hm = i0 > 0 ? ys[i0] - ys[i0 - 1] : h, hp = i < n - 1 ? ys[i + 1] - ys[i] : h;
  const m1 = ((p2 - p0) / (h + hm)) * h, m2 = ((p3 - p1) / (h + hp)) * h, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2;
}

/**
 * Mesh an implicit surface with naive surface nets.
 * f(x,y,z) -> distance; bound(x,y,z) -> cheap lower bound used to skip far nodes (optional).
 * tint(x,y,z,nx,ny,nz) -> [r,g,b] multiplier (optional); wfn(x,y,z) -> [breath, compress] (optional).
 */
export function surfaceNets(f, min, max, h, { bound, tint, wfn } = {}) {
  const T0 = globalThis.__SDF_PROF ? performance.now() : 0;
  const nx = Math.ceil((max[0] - min[0]) / h) + 1, ny = Math.ceil((max[1] - min[1]) / h) + 1, nz = Math.ceil((max[2] - min[2]) / h) + 1;
  const val = new Float32Array(nx * ny * nz), sx = 1, sy = nx, sz = nx * ny, far = 6 * h;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = min[0] + i * h, y = min[1] + j * h, z = min[2] + k * h;
    let d = bound ? bound(x, y, z) : -1;
    val[i * sx + j * sy + k * sz] = d > far ? d : f(x, y, z);
  }
  const vid = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1), cx = nx - 1, cy = ny - 1;
  const pos = [], cornerOff = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const c = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let q = 0; q < 8; q++) { const o = cornerOff[q]; const v = val[(i + o[0]) * sx + (j + o[1]) * sy + (k + o[2]) * sz]; c[q] = v; if (v < 0) mask |= 1 << q; }
    if (mask === 0 || mask === 255) continue;
    let ax = 0, ay = 0, az = 0, cnt = 0;
    for (const [a, b] of edges) {
      const va = c[a], vb = c[b]; if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb), oa = cornerOff[a], ob = cornerOff[b];
      ax += oa[0] + (ob[0] - oa[0]) * t; ay += oa[1] + (ob[1] - oa[1]) * t; az += oa[2] + (ob[2] - oa[2]) * t; cnt++;
    }
    vid[i + j * cx + k * cx * cy] = pos.length / 3;
    pos.push(min[0] + (i + ax / cnt) * h, min[1] + (j + ay / cnt) * h, min[2] + (k + az / cnt) * h);
  }
  const idx = [], cell = (i, j, k) => vid[i + j * cx + k * cx * cy];
  const quad = (a, b, c2, d, flip) => { if (a < 0 || b < 0 || c2 < 0 || d < 0) return; if (flip) idx.push(a, c2, b, a, d, c2); else idx.push(a, b, c2, a, c2, d); };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const v0 = val[i * sx + j * sy + k * sz] < 0;
    if (i < nx - 1 && v0 !== (val[(i + 1) * sx + j * sy + k * sz] < 0)) quad(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), v0);
    if (j < ny - 1 && v0 !== (val[i * sx + (j + 1) * sy + k * sz] < 0)) quad(cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), v0);
    if (k < nz - 1 && v0 !== (val[i * sx + j * sy + (k + 1) * sz] < 0)) quad(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), v0);
  }
  // normals from the field gradient, one Newton step to land exactly on the surface
  const n = pos.length / 3, nrm = new Float32Array(n * 3), P = new Float32Array(pos), w = new Float32Array(n * 2), tn = tint ? new Float32Array(n * 3) : null, e = h * 0.5;
  for (let v = 0; v < n; v++) {
    let x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    // tetrahedral gradient: 4 evaluations instead of 6
    const a0 = f(x + e, y - e, z - e), a1 = f(x - e, y - e, z + e), a2 = f(x - e, y + e, z - e), a3 = f(x + e, y + e, z + e);
    let gx = a0 - a1 - a2 + a3, gy = -a0 - a1 + a2 + a3, gz = -a0 + a1 - a2 + a3; const l = Math.hypot(gx, gy, gz) || 1; gx /= l; gy /= l; gz /= l;
    const step = clamp((a0 + a1 + a2 + a3) * 0.25, -h * 0.6, h * 0.6);       // field value near the vertex: one Newton step onto the surface
    x -= gx * step; y -= gy * step; z -= gz * step;
    P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z;
    nrm[v * 3] = gx; nrm[v * 3 + 1] = gy; nrm[v * 3 + 2] = gz;
    if (wfn) { const q = wfn(x, y, z, gx, gy, gz); w[v * 2] = q[0]; w[v * 2 + 1] = q[1]; }
    if (tint) { const q = tint(x, y, z, gx, gy, gz); tn[v * 3] = q[0]; tn[v * 3 + 1] = q[1]; tn[v * 3 + 2] = q[2]; }
  }
  if (T0) console.log('  nets', ((max[0]-min[0])/h|0)+'x'+((max[1]-min[1])/h|0)+'x'+((max[2]-min[2])/h|0), 'nodes', val.length, 'verts', n, 'ms', (performance.now() - T0).toFixed(0));
  return { pos: P, nrm, w, idx: new Uint32Array(idx), tint: tn };
}
