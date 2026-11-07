// Pure evaluation of hands-on gestures (no DOM): how well an instrument was placed and moved on the patient.
// Inputs are world-space points in metres. Every function returns { ok, quality 0..1, ... } plus the facts used for feedback.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Nearest named site to a point: { key, dist } among sites { key: [x,y,z] }. */
export function nearestSite(p, sites) {
  let key = null, dist = Infinity;
  for (const [k, s] of Object.entries(sites)) { const d = len(sub(p, s)); if (d < dist) { dist = d; key = k; } }
  return { key, dist };
}

/** place: dropped within radius of the target. Quality falls linearly to 0 at 2.5 x radius. */
export function evalPlace(p, target, radius) {
  const dist = len(sub(p, target));
  return { ok: dist <= radius, quality: clamp01(1 - Math.max(0, dist - radius * 0.4) / (radius * 2.1)), distCm: +(dist * 100).toFixed(1) };
}

/** stroke (incision): start near the target, length within [minCm, maxCm], optional direction (unit vector) within maxAngleDeg. */
export function evalStroke(a, b, target, radius, { minCm = 2, maxCm = 5, dir = null, maxAngleDeg = 35 } = {}) {
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], v = sub(b, a), L = len(v), lengthCm = L * 100;
  const place = evalPlace(mid, target, radius);
  let angleDeg = null, dirOk = true;
  if (dir && L > 1e-6) { const c = Math.abs(dot(v, dir)) / (L * (len(dir) || 1)); angleDeg = +(Math.acos(Math.min(1, c)) * 180 / Math.PI).toFixed(0); dirOk = angleDeg <= maxAngleDeg; }
  const lenOk = lengthCm >= minCm && lengthCm <= maxCm;
  const lenQ = lenOk ? 1 : clamp01(1 - Math.min(Math.abs(lengthCm - minCm), Math.abs(lengthCm - maxCm)) / Math.max(1, minCm));
  return { ok: place.ok && lenOk && dirOk, quality: +(place.quality * 0.5 + lenQ * 0.3 + (dirOk ? 0.2 : 0)).toFixed(2), distCm: place.distCm, lengthCm: +lengthCm.toFixed(1), angleDeg };
}

/** push: advance to a depth (cm) within [minCm, maxCm]. */
export function evalPush(depthCm, { minCm = 1, maxCm = 6 } = {}) {
  const ok = depthCm >= minCm && depthCm <= maxCm;
  return { ok, quality: ok ? 1 : clamp01(1 - (depthCm < minCm ? (minCm - depthCm) / minCm : (depthCm - maxCm) / maxCm)), depthCm: +depthCm.toFixed(1), tooDeep: depthCm > maxCm, tooShallow: depthCm < minCm };
}

/** rotate: turned by angleDeg, target 90 deg +/- tolerance. */
export function evalRotate(angleDeg, { target = 90, tol = 25 } = {}) {
  const err = Math.abs(Math.abs(angleDeg) - target);
  return { ok: err <= tol, quality: clamp01(1 - err / (target)), angleDeg: Math.round(angleDeg) };
}

/** hold: kept in place for seconds >= needS. */
export function evalHold(seconds, needS = 2) {
  return { ok: seconds >= needS, quality: clamp01(seconds / needS), seconds: +seconds.toFixed(1) };
}

/** One line for the event log: "dist 1.2 cm, length 3.1 cm, angle 12 deg, depth 3 cm, 2.4 s" (only what applies). */
export function describe(r) {
  const bits = [];
  if (r.distCm != null) bits.push(`dist ${r.distCm} cm`);
  if (r.lengthCm != null) bits.push(`length ${r.lengthCm} cm`);
  if (r.angleDeg != null) bits.push(`angle ${r.angleDeg} deg`);
  if (r.depthCm != null) bits.push(`depth ${r.depthCm} cm`);
  if (r.seconds != null) bits.push(`${r.seconds} s`);
  return bits.join(', ');
}
