// Procedural mesh builders. A mesh is {pos:Float32Array, nrm:Float32Array, w:Float32Array(2 per vertex), idx:Uint32Array}.
// "w" carries per-vertex region weights used by the vertex shader: w[0] = breathing, w[1] = chest-compression.
function finish(pos, nrm, w, idx) {
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), w: new Float32Array(w), idx: new Uint32Array(idx) };
}

export function box(sx = 1, sy = 1, sz = 1) {
  const pos = [], nrm = [], w = [], idx = [];
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = pos.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push((n[0] + u[0] * a + v[0] * b) * sx / 2, (n[1] + u[1] * a + v[1] * b) * sy / 2, (n[2] + u[2] * a + v[2] * b) * sz / 2);
      nrm.push(...n); w.push(0, 0);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return finish(pos, nrm, w, idx);
}

export function sphere(rx = 1, ry = rx, rz = rx, seg = 24, rings = 16) {
  const pos = [], nrm = [], w = [], idx = [];
  for (let i = 0; i <= rings; i++) {
    const th = (i / rings) * Math.PI;
    for (let j = 0; j <= seg; j++) {
      const ph = (j / seg) * Math.PI * 2;
      const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
      pos.push(x * rx, y * ry, z * rz);
      const n = [x / rx, y / ry, z / rz], l = Math.hypot(...n) || 1;
      nrm.push(n[0] / l, n[1] / l, n[2] / l); w.push(0, 0);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
    const a = i * (seg + 1) + j, b = a + seg + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  return finish(pos, nrm, w, idx);
}

export function cylinder(r = 0.5, h = 1, seg = 20, rTop = r) {
  const pos = [], nrm = [], w = [], idx = [];
  const slope = (r - rTop) / h;
  for (let j = 0; j <= seg; j++) {
    const a = (j / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const l = Math.hypot(1, slope);
    pos.push(c * r, -h / 2, s * r); nrm.push(c / l, slope / l, s / l); w.push(0, 0);
    pos.push(c * rTop, h / 2, s * rTop); nrm.push(c / l, slope / l, s / l); w.push(0, 0);
  }
  for (let j = 0; j < seg; j++) { const a = j * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
  for (const [y, rr, ny] of [[-h / 2, r, -1], [h / 2, rTop, 1]]) {
    const ci = pos.length / 3; pos.push(0, y, 0); nrm.push(0, ny, 0); w.push(0, 0);
    for (let j = 0; j <= seg; j++) { const a = (j / seg) * Math.PI * 2; pos.push(Math.cos(a) * rr, y, Math.sin(a) * rr); nrm.push(0, ny, 0); w.push(0, 0); }
    for (let j = 0; j < seg; j++) { if (ny > 0) idx.push(ci, ci + 1 + j + 1, ci + 1 + j); else idx.push(ci, ci + 1 + j, ci + 1 + j + 1); }
  }
  return finish(pos, nrm, w, idx);
}

/**
 * Loft along the +y axis through elliptical cross-sections.
 * sections: [{y, rx, rz, cx=0, cz=0, wb=0, wc=0}]  (rx lateral half-width, rz anterior/posterior half-depth,
 * cx/cz centre offsets, wb breathing weight, wc compression weight). Ends are capped.
 */
export function loft(sections, seg = 28) {
  const pos = [], nrm = [], w = [], idx = [];
  const n = sections.length;
  for (let i = 0; i < n; i++) {
    const s = sections[i];
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      pos.push((s.cx || 0) + c * s.rx, s.y, (s.cz || 0) + sn * s.rz);
      // ellipse normal (ignores slope; corrected below by smoothing with neighbours)
      let nx = c / Math.max(s.rx, 1e-4), nz = sn / Math.max(s.rz, 1e-4);
      const prev = sections[Math.max(0, i - 1)], next = sections[Math.min(n - 1, i + 1)];
      const dy = next.y - prev.y || 1e-3;
      const drx = (next.rx - prev.rx) / dy, drz = (next.rz - prev.rz) / dy;
      const ny = -(c * drx * 1 + sn * drz * 1);
      const l = Math.hypot(nx, nz) || 1;
      nx /= l; nz /= l;
      const l2 = Math.hypot(nx, ny, nz) || 1;
      nrm.push(nx / l2, ny / l2, nz / l2);
      const front = Math.max(0, sn); // anterior half moves more with respiration/compression
      w.push((s.wb || 0) * (0.35 + 0.65 * front), (s.wc || 0) * front);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg; j++) {
    const a = i * (seg + 1) + j, b = a + seg + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  for (const [si, dirn] of [[0, -1], [n - 1, 1]]) {
    const s = sections[si], ci = pos.length / 3;
    pos.push(s.cx || 0, s.y, s.cz || 0); nrm.push(0, dirn, 0); w.push(0, 0);
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      pos.push((s.cx || 0) + Math.cos(a) * s.rx, s.y, (s.cz || 0) + Math.sin(a) * s.rz); nrm.push(0, dirn, 0); w.push(0, 0);
    }
    for (let j = 0; j < seg; j++) { if (dirn > 0) idx.push(ci, ci + 2 + j, ci + 1 + j); else idx.push(ci, ci + 1 + j, ci + 2 + j); }
  }
  return finish(pos, nrm, w, idx);
}

/** Merge meshes after applying a per-mesh transform function to positions (p)=>[x,y,z] and directions (n)=>[x,y,z]. */
export function merge(list) {
  const pos = [], nrm = [], w = [], idx = [], tint = [], anyTint = list.some(l => l.mesh.tint);
  for (const { mesh, tp, tn } of list) {
    const base = pos.length / 3;
    for (let i = 0; i < mesh.pos.length; i += 3) {
      const p = tp ? tp([mesh.pos[i], mesh.pos[i + 1], mesh.pos[i + 2]]) : [mesh.pos[i], mesh.pos[i + 1], mesh.pos[i + 2]];
      const n = tn ? tn([mesh.nrm[i], mesh.nrm[i + 1], mesh.nrm[i + 2]]) : [mesh.nrm[i], mesh.nrm[i + 1], mesh.nrm[i + 2]];
      pos.push(...p); nrm.push(...n);
    }
    for (let i = 0; i < mesh.w.length; i++) w.push(mesh.w[i]);
    if (anyTint) { if (mesh.tint) for (let i = 0; i < mesh.tint.length; i++) tint.push(mesh.tint[i]); else for (let i = 0; i < mesh.pos.length; i++) tint.push(1); }
    for (let i = 0; i < mesh.idx.length; i++) idx.push(base + mesh.idx[i]);
  }
  const out = finish(pos, nrm, w, idx); if (anyTint) out.tint = new Float32Array(tint);
  return out;
}
