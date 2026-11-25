// The sheet over the patient, draped on this patient's own body (display only). Built once per patient from the morphed body
// mesh, in the body's local space (+x head, +y up from the mattress, +z the patient's left), so it breathes, bends with the bed
// and follows the legs like the old sheet did:
//  - a height map of the body seen from above (each triangle rasterised onto the grid; the arms are left out: they lie on top);
//  - cloth tension: the sheet spans hollows (between the thighs, beside the waist) instead of clinging into them, sagging a
//    little like real fabric (an iterated "cannot be lower than its neighbours' mean minus the sag" relaxation);
//  - soft folds where it spans free, a turned hem at the top and bottom edges;
//  - the sides go over the mattress edge with a rounded fall and hang down in vertical folds.
// All lengths are given in metres and divided by the body scale. Shapes are design values tuned by eye.

const M = 1;                                    // metres (readability)
export const DRAPE = Object.freeze({
  cell: 0.012 * M,          // grid step
  topAboveNavel: 0.06,      // upper edge: a hand's breadth above the abdomen landmark (the chest stays free for monitoring)
  belowGroin: 0.36,         // lower edge: a hand's breadth above the knee (the outer lower thigh stays free for an IM injection)
  halfWidth: 0.40,          // the mattress (scene.js: 0.8 m wide)
  hang: 0.11,               // how far the sides fall: tucked down the mattress side, inside the bed rails
  clear: 0.014,             // gap above the skin (breathing and a big belly never push through)
  sag: 0.00035,             // sag per relaxation step (how much it droops between supports)
  steps: 90,
});

/** body: the morphed body mesh { pos, idx, region }; ls: its landmarks (local); scale: body scale (world m per local unit).
 *  Returns a mesh like the asset's { pos, nrm, uv, idx, w (2 per vertex), region }. */
export function buildDrape(body, ls, scale = 1) {
  const s = scale || 1, L = (m) => m / s, D = DRAPE;
  const x0 = ls.abdomen[0] + L(D.topAboveNavel), x1 = ls.femoral[0] - L(D.belowGroin), E = L(D.halfWidth), c = L(D.cell);
  const nx = Math.max(8, Math.ceil((x0 - x1) / c) + 1), nz = Math.max(8, Math.ceil((2 * E) / c) + 1);
  const X = (i) => x0 - (x0 - x1) * i / (nx - 1), Z = (k) => -E + 2 * E * k / (nz - 1);
  // 1. height of the body under each grid point (top surface), arms left out
  const h = new Float32Array(nx * nz), aLo = new Float32Array(nx * nz).fill(Infinity), pos = body.pos, idx = body.idx, reg = body.region;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], d = idx[t + 2], arm = reg && (reg[a] === 5 || reg[b] === 5 || reg[d] === 5);
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2], bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2], dx = pos[d * 3], dy = pos[d * 3 + 1], dz = pos[d * 3 + 2];
    const mnx = Math.min(ax, bx, dx), mxx = Math.max(ax, bx, dx), mnz = Math.min(az, bz, dz), mxz = Math.max(az, bz, dz);
    if (mxx < x1 || mnx > x0 || mxz < -E || mnz > E) continue;
    const i0 = Math.max(0, Math.floor((x0 - mxx) / (x0 - x1) * (nx - 1))), i1 = Math.min(nx - 1, Math.ceil((x0 - mnx) / (x0 - x1) * (nx - 1)));
    const k0 = Math.max(0, Math.floor((mnz + E) / (2 * E) * (nz - 1))), k1 = Math.min(nz - 1, Math.ceil((mxz + E) / (2 * E) * (nz - 1)));
    const det = (bz - dz) * (ax - dx) + (dx - bx) * (az - dz); if (Math.abs(det) < 1e-12) continue;
    for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) {
      const px = X(i), pz = Z(k), l1 = ((bz - dz) * (px - dx) + (dx - bx) * (pz - dz)) / det, l2 = ((dz - az) * (px - dx) + (ax - dx) * (pz - dz)) / det, l3 = 1 - l1 - l2;
      if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
      const y = l1 * ay + l2 * by + l3 * dy, j = i * nz + k;
      if (arm) { if (y < aLo[j]) aLo[j] = y; } else if (y > h[j]) h[j] = y;
    }
  }
  // 2. the cloth: on the body or the mattress, spanning hollows with a slight sag. The height map is first spread to its
  //    neighbours (within 2 cm, falling off by half the distance): sampled from above, a steep flank would otherwise rise
  //    between two samples and cut through the cloth (and breathing moves a flank sideways)
  const r = Math.max(1, Math.round(L(0.02) / c)), hd = new Float32Array(nx * nz);
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    let m = h[i * nz + k];
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      const ii = i + a, kk = k + b; if (ii < 0 || kk < 0 || ii >= nx || kk >= nz || a * a + b * b > r * r) continue;
      const v = h[ii * nz + kk] - 0.5 * c * Math.hypot(a, b); if (v > m) m = v;
    }
    hd[i * nz + k] = m;
  }
  h.set(hd);
  const base = Float32Array.from(h, (v) => v > L(0.004) ? v + L(D.clear) : L(0.003)), H = Float32Array.from(base), sag = L(D.sag);   // on the bare mattress it lies flat
  for (let it = 0; it < D.steps; it++) for (let i = 0; i < nx; i++) for (let k = 1; k < nz - 1; k++) {
    const j = i * nz + k, up = H[(i > 0 ? i - 1 : i + 1) * nz + k], dn = H[(i < nx - 1 ? i + 1 : i - 1) * nz + k];
    H[j] = Math.max(base[j], (up + dn + H[j - 1] + H[j + 1]) / 4 - sag);
  }
  // the edges carry no tension: the last hand's breadth of cloth settles onto the skin (no gap to see under at the top edge)
  const T = Math.max(2, Math.round(L(0.09) / c)), Tb = Math.max(2, Math.round(L(0.05) / c));
  for (let i = 0; i < nx; i++) {
    const e = i < T ? i / T : nx - 1 - i < Tb ? (nx - 1 - i) / Tb : 1; if (e >= 1) continue;
    const f = e * e * (3 - 2 * e);
    for (let k = 0; k < nz; k++) { const j = i * nz + k; H[j] = base[j] + (H[j] - base[j]) * f; }
  }
  // 3. folds where the cloth spans free, a hem at the ends
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const j = i * nz + k, free = Math.min(1, Math.max(0, (H[j] - base[j]) / L(0.03))), x = X(i) * s, z = Z(k) * s;
    H[j] += L(0.0045) * free * Math.sin(z * 2 * Math.PI / 0.075 + 1.3 * Math.sin(x * 9)) + L(0.0012) * Math.sin(x * 23 + z * 7) * Math.sin(z * 17 - x * 5);
    const end = Math.min(i, nx - 1 - i); if (end < 2) H[j] += L(0.004) * (2 - end) / 2;   // the hem is a double layer, slightly raised
  }
  // the arms lie on top: under a hand or forearm resting on the bare mattress, or clear of the body, the cloth runs just below
  // it (an arm resting on or pressed into the body leaves the cloth over the body: the skin under it moves as it breathes).
  // "Bare mattress" and "clear" are judged on the spread height map: right beside a big flank the cloth is not pulled down,
  // or the cloth between that sample and the flank would cut through the hip and show it in a hole
  const held = new Uint8Array(nx * nz);
  for (let j = 0; j < H.length; j++) {
    if (aLo[j] === Infinity) continue;
    if (h[j] < L(0.004)) H[j] = Math.min(H[j], Math.max(L(0.002), aLo[j] - L(0.003)));
    else if (aLo[j] - L(0.003) > h[j] + L(D.clear)) H[j] = Math.min(H[j], aLo[j] - L(0.003));
    else continue;
    held[j] = 1;
  }
  // ...and the cloth around a resting hand is drawn down with it (no tent wall beside the hand): a slope limit, never below the body
  const rise = L(0.007), near = Uint8Array.from(held);
  for (let p = 0, R = Math.round(L(0.08) / c); p < R; p++) {                          // within 8 cm of the hand
    const prev = Uint8Array.from(near);
    for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) { const j = i * nz + k; if (!prev[j] && ((i > 0 && prev[j - nz]) || (i < nx - 1 && prev[j + nz]) || (k > 0 && prev[j - 1]) || (k < nz - 1 && prev[j + 1]))) near[j] = 1; }
  }
  for (let it = 0; it < 30; it++) for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const j = i * nz + k; if (held[j] || !near[j]) continue;
    let m = Infinity; if (i > 0) m = Math.min(m, H[j - nz]); if (i < nx - 1) m = Math.min(m, H[j + nz]); if (k > 0) m = Math.min(m, H[j - 1]); if (k < nz - 1) m = Math.min(m, H[j + 1]);
    if (H[j] > m + rise) H[j] = Math.max(base[j], m + rise);
  }
  // 4. vertices: the top over the mattress, then each side falling over the edge in K rows
  const K = 12, cols = nz + 2 * K, P = [], UV = [], R = [];
  const legs = ls.femoral[0] - L(0.05);
  for (let i = 0; i < nx; i++) {
    const x = X(i), row = [];
    const edge = (side) => H[i * nz + (side > 0 ? nz - 1 : 0)];
    for (let q = 0; q < cols; q++) {
      let y, z, xx = x;
      if (q >= K && q < K + nz) { z = Z(q - K); y = H[i * nz + q - K]; }
      else {
        const side = q < K ? -1 : 1, kk = q < K ? K - q : q - (K + nz - 1), u = kk / K;             // 0 at the edge .. 1 at the bottom of the fall
        const round = Math.sin(Math.min(1, u * 2.2) * Math.PI / 2);                                    // over the edge: a rounded turn, then straight down
        z = side * (E + L(0.008) * round - L(0.004) * u);                                             // hugging the mattress side, inside the rail (z 0.41-0.45)
        y = edge(side) - L(D.hang) * u * u * 0.35 - L(D.hang) * Math.max(0, u - 0.15) * 0.75;
        z += side * L(0.005) * u * (0.5 + 0.5 * Math.sin(x * s * 2 * Math.PI / 0.11 + side * 0.8));    // soft vertical folds where it is tucked
        xx = x + L(0.004) * u * Math.sin(x * s * 31);
      }
      P.push(xx, y, z); UV.push(x * s * 1.6, z * s * 1.6 + (q < K ? -(K - q) : q >= K + nz ? q - K - nz : 0) * 0.02); R.push(x < legs ? 8 : 7);
    }
  }
  const n = P.length / 3, I = [];
  for (let i = 0; i < nx - 1; i++) for (let q = 0; q < cols - 1; q++) { const a = i * cols + q, b = a + cols; I.push(a, b, a + 1, a + 1, b, b + 1); }
  // normals (accumulated, then oriented up / outward)
  const N = new Float32Array(n * 3);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, d = I[t + 2] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[d] - P[a], P[d + 1] - P[a + 1], P[d + 2] - P[a + 2]];
    const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, d]) for (let m = 0; m < 3; m++) N[v + m] += nn[m];
  }
  for (let v = 0; v < n; v++) {
    let x = N[v * 3], y = N[v * 3 + 1], z = N[v * 3 + 2]; const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
    const out = [0, 1, 0], q = v % cols; if (q < K) out[2] = -1; else if (q >= K + nz) out[2] = 1;            // up on top, outward on the falls
    if (x * out[0] + y * out[1] + z * out[2] < 0) { x = -x; y = -y; z = -z; }
    N[v * 3] = x; N[v * 3 + 1] = y; N[v * 3 + 2] = z;
  }
  return { pos: Float32Array.from(P), nrm: N, uv: Float32Array.from(UV), idx: Uint32Array.from(I), w: new Float32Array(n * 2), region: Uint8Array.from(R), grid: { nx, nz, cols, K } };
}
