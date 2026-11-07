// Ray picking on a triangle mesh (Moller-Trumbore), used to drop instruments on the actual skin of the patient.
// Brute force with a per-mesh triangle bounding-box prefilter: about 27k triangles, well under a millisecond per test.

/** Precompute per-triangle bounding boxes for a mesh { pos, idx }. */
export function prepare(mesh) {
  const { pos, idx } = mesh, nt = idx.length / 3, box = new Float32Array(nt * 6);
  for (let t = 0; t < nt; t++) {
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k] * 3, x = pos[v], y = pos[v + 1], z = pos[v + 2]; if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; if (z < mnz) mnz = z; if (z > mxz) mxz = z; }
    box.set([mnx, mny, mnz, mxx, mxy, mxz], t * 6);
  }
  return { ...mesh, box };
}

/** Nearest hit of ray { o, d } (same space as the mesh). Returns { t, p, n, tri, vert } or null. vert = closest corner. */
export function rayMesh(ray, m) {
  const { pos, idx, box } = m, o = ray.o, d = ray.d, inv = [1 / d[0], 1 / d[1], 1 / d[2]];
  let best = null, bt = Infinity;
  for (let t = 0, nt = idx.length / 3; t < nt; t++) {
    // slab test against the triangle's box
    const b = t * 6;
    let t0 = -Infinity, t1 = Infinity;
    for (let a = 0; a < 3; a++) {
      let u = (box[b + a] - o[a]) * inv[a], v = (box[b + 3 + a] - o[a]) * inv[a];
      if (u > v) { const w = u; u = v; v = w; }
      if (u > t0) t0 = u; if (v < t1) t1 = v;
    }
    if (t1 < Math.max(0, t0) || t0 > bt) continue;
    const i0 = idx[t * 3] * 3, i1 = idx[t * 3 + 1] * 3, i2 = idx[t * 3 + 2] * 3;
    const e1x = pos[i1] - pos[i0], e1y = pos[i1 + 1] - pos[i0 + 1], e1z = pos[i1 + 2] - pos[i0 + 2];
    const e2x = pos[i2] - pos[i0], e2y = pos[i2 + 1] - pos[i0 + 1], e2z = pos[i2 + 2] - pos[i0 + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-12) continue;
    const id = 1 / det, sx = o[0] - pos[i0], sy = o[1] - pos[i0 + 1], sz = o[2] - pos[i0 + 2];
    const u = (sx * px + sy * py + sz * pz) * id; if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * id; if (v < 0 || u + v > 1) continue;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * id; if (tt <= 1e-6 || tt >= bt) continue;
    bt = tt;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x; const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    if (nx * d[0] + ny * d[1] + nz * d[2] > 0) { nx = -nx; ny = -ny; nz = -nz; }          // facing the viewer
    const w = 1 - u - v, vert = w >= u && w >= v ? idx[t * 3] : u >= v ? idx[t * 3 + 1] : idx[t * 3 + 2];
    best = { t: tt, p: [o[0] + d[0] * tt, o[1] + d[1] * tt, o[2] + d[2] * tt], n: [nx, ny, nz], tri: t, vert };
  }
  return best;
}
