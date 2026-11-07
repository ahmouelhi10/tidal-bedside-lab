// 3D clinical scene: an emergency bay (room, bed, equipment, staff), the procedural patient, camera orbit, hotspot picking and
// world-to-screen projection for the floating markers. Read-only view of engine state.
import { Gestures } from './gestures.js';
import { Renderer, mat4, vec3 } from './gl/renderer.js';
import { box, sphere, cylinder } from './gl/geometry.js';
import { morphology, buildBody, supineMatrix, SKIN_TONES, skinColor, localToWorld } from './gl/body.js';
import { raySphere } from './gl/math.js';
import { parseGlb, decodeImages } from './gl/gltf.js';
import { buildGlbBody } from './gl/patient-glb.js';
import { prepare as preparePick, rayMesh } from './gl/pick.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const HOTSPOTS = [
  ['head', 'airway', 0.17, 'hs_head'], ['chest', 'sternum', 0.17, 'hs_chest'], ['rarm', 'rightArmIV', 0.11, 'hs_rarm'], ['larm', 'leftArm', 0.11, 'hs_larm'],
  ['groin', 'femoral', 0.13, 'hs_groin'], ['abdomen', 'abdomen', 0.15, 'hs_abdomen'], ['neck', 'neck', 0.08, 'hs_neck'],
];
const PIN_PATIENT = new Set(['head', 'chest', 'rarm', 'larm', 'groin', 'neck', 'flank']);
// realistic patient (assets/patient.glb): crown position on the mattress and mattress top; asset axes already match the bay (+x head, +y up, +z patient's left)
const CROWN_X = 0.93, BED_TOP = 0.86, TONE_REF = [0.80, 0.60, 0.44];

// Room and equipment layout (metres; the bed is centred on x = -0.1, the patient's head points to +x). The IV pole stands on the far side, by the IV arm, out of the overview's line of sight.
const ROOM = { x0: -3.0, x1: 1.95, z0: -2.6, z1: 3.7, h: 3.0 };
const POLE = [0.0, 0, -0.8], CART = [-1.7, 0, -1.4], STAND = [1.55, -0.95], VENT = [1.45, 0, 0.95];
const EQUIP = [
  { id: 'defib', label: 'hs_defib', c: [CART[0], 1.15, CART[2]], rad: 0.45, pin: [CART[0], 1.5, CART[2]] },
  { id: 'ivpole', label: 'hs_iv', c: [POLE[0], 1.55, POLE[2]], rad: 0.42, pin: [POLE[0], 2.25, POLE[2]] },
  { id: 'monitor', label: 'hs_monitor', c: [STAND[0], 1.55, STAND[1]], rad: 0.5, pin: [STAND[0], 2.05, STAND[1]] },
  { id: 'vent', label: 'hs_vent', c: [VENT[0], 0.95, VENT[2]], rad: 0.45, pin: [VENT[0], 1.5, VENT[2]] },
  { id: 'meds', label: 'hs_meds', c: [-0.55, 1.5, ROOM.z0 + 0.15], rad: 0.7, pin: [-0.55, 2.2, ROOM.z0 + 0.2] },
  { id: 'o2', label: 'hs_o2', c: [ROOM.x1 - 0.1, 1.4, 0], rad: 0.42, pin: [ROOM.x1 - 0.12, 1.85, 0] },
];
// Camera presets. Every eye position stays inside the bay (x -3..1.95, z -2.6..3.7, y < 3): eye = target + dist * (cos p sin y, sin p, cos p cos y).
export const CAMERAS = {
  default: { yaw: -0.5, pitch: 0.40, dist: 3.1, target: [0.05, 0.9, 0] },
  head: { yaw: 0.35, pitch: 0.52, dist: 1.45, target: [0.82, 0.95, 0] },
  chest: { yaw: 0.15, pitch: 0.62, dist: 1.8, target: [0.3, 0.95, 0] },
  neck: { yaw: 0.3, pitch: 0.5, dist: 1.3, target: [0.7, 0.95, 0] },
  arm: { yaw: 0.0, pitch: 0.55, dist: 1.5, target: [0.2, 0.9, 0.35] },
  groin: { yaw: -0.2, pitch: 0.55, dist: 1.8, target: [-0.45, 0.9, 0] },
  side: { yaw: 0, pitch: 0.24, dist: 2.7, target: [0.05, 0.95, 0] },
  top: { yaw: 0, pitch: 1.45, dist: 2.7, target: [0.05, 0.9, 0] },
  foot: { yaw: -1.5, pitch: 0.3, dist: 2.7, target: [0.0, 0.95, 0] },
};

/** Single-sided quad in the XY plane, normal +Z: culled when seen from behind, so room walls vanish when the camera is outside. */
function plane(w, h) {
  return { pos: new Float32Array([-w / 2, -h / 2, 0, w / 2, -h / 2, 0, w / 2, h / 2, 0, -w / 2, h / 2, 0]), nrm: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), w: new Float32Array(8), idx: new Uint32Array([0, 1, 2, 0, 2, 3]) };
}
/** translate * rotY * rotX * rotZ * scale */
function TRS(x, y, z, sx = 1, sy = 1, sz = 1, ry = 0, rx = 0, rz = 0) {
  let m = mat4.translation(x, y, z);
  if (ry) m = mat4.multiply(m, mat4.rotationY(ry));
  if (rx) m = mat4.multiply(m, mat4.rotationX(rx));
  if (rz) m = mat4.multiply(m, mat4.rotationZ(rz));
  return mat4.multiply(m, mat4.scaling(sx, sy, sz));
}

export class Scene {
  constructor(canvas, monitorCanvas) {
    this.r = new Renderer(canvas); this.canvas = canvas; this.monitorCanvas = monitorCanvas;
    const r = this.r; r.clear = [0.12, 0.13, 0.14]; r.lightPos = [0.1, 2.7, 0.4]; r.lightTarget = [-0.05, 0.85, 0.05]; r.lightK = 1.05;
    this.g = {
      ub: r.upload(box(1, 1, 1)), cyl: r.upload(cylinder(1, 1, 18)), sph: r.upload(sphere(1, 1, 1, 16, 10)),
      bedFrame: r.upload(box(2.25, 0.08, 0.86)), mattress: r.upload(box(2.1, 0.12, 0.8)), rail: r.upload(box(2.0, 0.05, 0.04)),
      leg: r.upload(cylinder(0.04, 0.8, 12)), monitorBody: r.upload(box(1.0, 0.56, 0.08)),
      pad: r.upload(cylinder(1, 0.02, 20)), bag: r.upload(sphere(1, 1.25, 0.5, 14, 10)),
      wallW: r.upload(plane(ROOM.x1 - ROOM.x0, ROOM.h)), wallD: r.upload(plane(ROOM.z1 - ROOM.z0, ROOM.h)), floor: r.upload(plane(ROOM.x1 - ROOM.x0, ROOM.z1 - ROOM.z0)),
    };
    this.monTex = r.createTexture(monitorCanvas);
    this.yaw = CAMERAS.default.yaw; this.pitch = CAMERAS.default.pitch; this.dist = CAMERAS.default.dist; this.target = [...CAMERAS.default.target];
    this.goal = null; this.off = { yaw: 0, pitch: 0 }; this.hover = null; this.t = 0; this.breathPh = 0; this.compAmt = 0; this.shockT = 0; this.tone = 2; this.body = null;
    this.auto = false;            // slow cinematic orbit (case menu)
    this.inset = { l: 0, r: 0 }; this.shift = 0;   // screen px covered by panels on the left / right (ui.updateInsets)
    this.gest = new Gestures(); this.rescuerHands = true; this.pins = []; this._bindInput(canvas);
  }

  /** Frame a named view. Close-ups follow the real landmarks of this patient (head, sternum, neck, IV arm, groin) so they stay centred for any body. */
  setCamera(name) {
    const c = { ...(CAMERAS[name] || CAMERAS.default), target: [...(CAMERAS[name] || CAMERAS.default).target] }, w = this.world;
    if (w) {
      const at = (p, dy = 0) => [p[0], p[1] + dy, p[2]];
      if (name === 'head') c.target = at(w.face, -0.02);
      else if (name === 'chest') c.target = at(w.sternum, 0.02);
      else if (name === 'neck') c.target = at(w.neck, 0);
      else if (name === 'arm') { c.target = at(w.rightArmIV, 0); c.yaw = (w.rightArmIV[2] - w.sternum[2]) >= 0 ? 0.05 : Math.PI - 0.05; }
      else if (name === 'groin') { c.target = at(w.femoral, 0); }
    }
    this.auto = false; this.returnAt = null; this.view = name;
    const to = { yaw: c.yaw, pitch: c.pitch, dist: c.dist, target: c.target };
    // smooth camera move: eased tween on the orbit (shortest way round), swinging slightly out mid-way so it travels around the bed, not through it
    const from = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: [...this.target] };
    const dYaw = Math.atan2(Math.sin(to.yaw - from.yaw), Math.cos(to.yaw - from.yaw));
    const span = Math.abs(dYaw) + Math.abs(to.pitch - from.pitch) + Math.abs(to.dist - from.dist) * 0.6 + Math.hypot(...to.target.map((v, i) => v - from.target[i]));
    this.tw = { t0: this.t, dur: clamp(0.9 + span * 0.55, 0.9, 2.2), from, to: { ...to, yaw: from.yaw + dYaw }, lift: clamp(span * 0.18, 0, 0.45) };
    this.goal = to;
  }
  /** Frame a world point seen from direction `dir` (unit vector from the point toward the eye) at distance `dist`, and stay there. */
  frameSite(p, dir, dist = 0.62) {
    const d = vec3.norm(dir), pitch = clamp(Math.asin(d[1]), 0.35, 1.45), yaw = Math.atan2(d[0], d[2]);
    const from = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: [...this.target] }, dYaw = Math.atan2(Math.sin(yaw - from.yaw), Math.cos(yaw - from.yaw));
    this.auto = false; this.returnAt = null; this.view = 'site';
    this.tw = { t0: this.t, dur: 1.4, from, to: { yaw: from.yaw + dYaw, pitch, dist, target: [...p] }, lift: 0.15 };
    this.goal = { yaw, pitch, dist, target: [...p] };
  }
  /** World position and outward skin normal of a named site (landmark or chest site 'R_mal5'), realistic body only. */
  siteFrame(key) {
    const B = this.body; if (!B) return null;
    if (B.b.glb) {
      const lm = this.asset.meta.landmarks[key]; if (!lm) return null;
      const m = B.b.meshes.body, v = lm.anchorVertex, s = B.b.scale;
      return { p: [CROWN_X + m.pos[v * 3] * s, BED_TOP + m.pos[v * 3 + 1] * s, m.pos[v * 3 + 2] * s], n: [m.nrm[v * 3], m.nrm[v * 3 + 1], m.nrm[v * 3 + 2]] };
    }
    const p = this.world[key] || (key.length > 2 && this.chestSites?.[key[0]]?.[key.slice(2)]); return p ? { p, n: [0, 1, 0] } : null;
  }
  /** Outward skin normal at a world point (nearest vertex of the realistic body; straight up otherwise). */
  normalAt(p) {
    const B = this.body; if (!B?.b?.glb) return [0, 1, 0];
    const m = B.b.meshes.body, s = B.b.scale, q = [(p[0] - CROWN_X) / s, (p[1] - BED_TOP) / s, p[2] / s];
    let best = 0, bd = Infinity;
    for (let v = 0, n = m.pos.length / 3; v < n; v++) { const dx = m.pos[v * 3] - q[0], dy = m.pos[v * 3 + 1] - q[1], dz = m.pos[v * 3 + 2] - q[2], d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = v; } }
    return [m.nrm[best * 3], m.nrm[best * 3 + 1], m.nrm[best * 3 + 2]];
  }
  /** Direction of the right forearm on its board, from the antecubital fossa toward the hand. */
  armAxis() { const a = this.world.rightArmIV, b = this.world.padRight, d = [a[0] - b[0], 0, a[2] - b[2]], l = Math.hypot(d[0], d[2]) || 1; return [d[0] / l, 0, d[2] / l]; }
  /** Frame the site of an upcoming procedure step: a little above the skin normal, tilted toward the foot of the bed. */
  frameStepSite(key, dist = 0.62) {
    const f = this.siteFrame(key); if (!f) return false;
    const dir = vec3.norm([f.n[0] * 0.8 - 0.35, f.n[1] * 0.8 + 0.75, f.n[2] * 0.8]);
    this.frameSite(f.p, dir, dist); return true;
  }
  /** Frame a site for an action, then glide back to the overview of the patient after holdS seconds. */
  focus(name, holdS = 2.5) { this.setCamera(name); this.returnAt = this.t + (this.tw ? this.tw.dur : 0) + holdS; }

  /** An engine action happened: play the matching hand gesture, frame it, then return to the overview. */
  gesture(ev, res) {
    const cam = this.gest.start(this, ev, res); if (!cam) return;
    const g = this.gest.list[this.gest.list.length - 1]; this.focus(cam, (g ? g.dur : 2) + 1.2);
  }
  /** A guided-procedure step without an engine gesture of its own: frame the site and play a generic hand gesture. */
  stepGesture(kind, cam, site) { const g = kind ? this.gest.startStep(this, kind, site) : null; this.focus(cam || 'default', (g ? g.dur : 1.5) + 1.2); }
  /** World point of a named site for guided steps: face, chest, neck, arm, or chestSite (needle/drain site from side + site). */
  siteOf(at, prm = {}) {
    const W = this.world; if (!W) return null;
    if (at === 'chestSite') { const s = this.chestSites?.[prm.side || 'R']; return s ? (s[prm.site] || s.mal5) : W.sternum; }
    return { face: W.face, chest: W.sternum, neck: W.neck, arm: W.rightArmIV }[at] || null;
  }

  /** (Re)build the patient mesh for a body spec. */
  /** Load the realistic patient once; until it arrives (or if it fails) the procedural body is used. */
  async loadPatientAsset(base = '/assets/') {
    try {
      const [buf, meta] = await Promise.all([fetch(base + 'patient.glb').then(r => { if (!r.ok) throw new Error('patient.glb ' + r.status); return r.arrayBuffer(); }), fetch(base + 'patient.json').then(r => r.json())]);
      const glb = parseGlb(buf), imgs = await decodeImages(glb), r = this.r, tex = {};
      const texFor = (mat, key) => { const i = glb.texImage(mat?.[key]?.index ?? mat?.pbrMetallicRoughness?.[key]?.index); return i != null && imgs[i] ? r.imageTexture(imgs[i]) : null; };
      for (const [name, m] of Object.entries(glb.meshes)) tex[name] = { albedo: texFor(m.material, 'baseColorTexture'), normal: m.material?.normalTexture ? texFor(m.material, 'normalTexture') : null };
      this.asset = { glb, meta, tex };
      if (this.body) this.setPatient(this.body.spec, this.tone);
      this.onAsset?.();
    } catch (e) { console.warn('realistic patient unavailable, using the procedural body:', e && e.message); }
  }

  /** Instrument meshes for the hands-on procedures (assets/instruments.glb): name -> [{ g, color, alpha }]. */
  async loadInstruments(base = '/assets/') {
    try {
      const buf = await fetch(base + 'instruments.glb').then(r => { if (!r.ok) throw new Error('instruments.glb ' + r.status); return r.arrayBuffer(); });
      const glb = parseGlb(buf), out = {};
      for (const [name, m] of Object.entries(glb.meshes)) out[name] = m.prims.map(pr => { const f = pr.material?.pbrMetallicRoughness?.baseColorFactor || [0.8, 0.8, 0.8, 1]; return { g: this.r.upload({ pos: pr.pos, nrm: pr.nrm, w: new Float32Array(pr.pos.length / 3 * 2), idx: pr.idx }), color: f.slice(0, 3), alpha: f[3], metal: pr.material?.pbrMetallicRoughness?.metallicFactor ?? 0, mat: pr.material?.name || '' }; });
      this.instruments = out;
    } catch (e) { console.warn('instruments unavailable:', e && e.message); }
  }
  /** Ray-pick the realistic body's skin: { p, n, region } in world space, or null (also null with the procedural body). */
  pickBody(cx, cy) {
    const B = this.body; if (!B?.b?.glb || !this.r.invVP) return null;
    if (!B.pick) B.pick = preparePick(B.b.meshes.body);
    const ray = this.r.rayFromClient(cx, cy), s = B.b.scale, T = [CROWN_X, BED_TOP, 0];
    const ro = ray.origin, o = [(ro[0] - T[0]) / s, (ro[1] - T[1]) / s, (ro[2] - T[2]) / s];
    const h = rayMesh({ o, d: ray.dir }, B.pick); if (!h) return null;
    return { p: [T[0] + h.p[0] * s, T[1] + h.p[1] * s, T[2] + h.p[2] * s], n: h.n, region: B.b.meshes.body.region[h.vert] };
  }
  /** Draw one instrument with its working point at p, long axis along n, turned by angle about n. */
  _instrument(name, p, n, angle = 0, opts = {}) {
    const parts = this.instruments?.[name]; if (!parts) return;
    const ey = vec3.norm(n), ref = Math.abs(ey[0]) > 0.9 ? [0, 0, 1] : [1, 0, 0];
    let ex = vec3.norm(vec3.cross(ref, ey)); const ez0 = vec3.cross(ex, ey);
    ex = vec3.norm(vec3.add(vec3.scale(ex, Math.cos(angle)), vec3.scale(ez0, Math.sin(angle)))); const ez = vec3.cross(ex, ey);
    const M = mat4.fromBasis(ex, ey, ez, p);
    for (const pt of parts) { if (opts.only && !opts.only.includes(pt.mat)) continue; if (opts.skip && opts.skip.includes(pt.mat)) continue; this.r.draw(pt.g, M, { color: pt.color, alpha: pt.alpha, spec: pt.metal > 0.5 ? 0.95 : 0.4, noShadow: pt.alpha < 0.9 }); }
  }

  setPatient(spec, tone = this.tone) {
    const r = this.r;
    if (this.body) for (const g of Object.values(this.body.g)) r.release(g);
    const morph = morphology({ sex: spec.sex, age: spec.age, heightCm: spec.heightCm, weightKg: spec.weightKg });
    let b, g, M;
    if (this.asset) {
      b = buildGlbBody(this.asset.glb, this.asset.meta, spec, morph);
      g = Object.fromEntries(Object.entries(b.meshes).map(([k, m]) => [k, r.upload(m)]));
      M = mat4.multiply(mat4.translation(CROWN_X, BED_TOP, 0), mat4.scaling(b.scale, b.scale, b.scale));
    } else {
      b = buildBody(morph);
      g = { skin: r.upload(b.skin), hair: r.upload(b.hair), eyes: r.upload(b.eyes), pupils: r.upload(b.pupils), lips: r.upload(b.lips), sheet: r.upload(b.sheet) };
      M = supineMatrix(b);
    }
    this.body = { b, g, M, spec }; this.cut = null;
    this.tone = tone; this.gest.clear();
    const ls = b.landmarks;
    this.hot = HOTSPOTS.map(([id, lm, rad, label]) => ({ id, label, c: localToWorld(this.body.M, ls[lm]), rad: rad * (0.8 + 0.5 * Math.min(1, morph.bmi / 40)) }));
    // lateral chest wall (needle / drain sites) and the two sides, derived from the sternum and the right arm
    { const st = this.hot.find(h => h.id === 'chest').c, ra = localToWorld(this.body.M, ls.rightArmIV), sgn = Math.sign(ra[2] - st[2]) || 1, hw = Math.min(0.3, Math.abs(ra[2] - st[2]) * 0.55), k = 0.8 + 0.5 * Math.min(1, morph.bmi / 40);
      this.sideSign = sgn;
      this.chestSites = b.glb ? Object.fromEntries(['R', 'L'].map(sd => [sd, Object.fromEntries(['mcl2', 'mal5', 'aal5'].map(k => [k, localToWorld(this.body.M, ls[`${sd}_${k}`])]))]))
        : Object.fromEntries(['R', 'L'].map(sd => { const z = sd === 'R' ? sgn : -sgn; return [sd, { mcl2: [st[0] + 0.1, st[1] - 0.01, st[2] + z * hw * 0.5], mal5: [st[0] - 0.07, st[1] - 0.045, st[2] + z * hw * 0.95], aal5: [st[0] - 0.05, st[1] - 0.03, st[2] + z * hw * 0.8] }]; }));
      this.hot.push({ id: 'flank', label: 'hs_flank', c: this.chestSites[this.sideSign > 0 ? 'R' : 'L'].mal5, rad: 0.11 * k }); }
    this.equip = EQUIP.map(e => ({ id: e.id, label: e.label, c: e.c, rad: e.rad, equip: true }));
    this.world = Object.fromEntries(['sternum', 'padRight', 'padLeft', 'face', 'airway', 'rightArmIV', 'leftArm', 'neck', 'abdomen', 'femoral'].map(k => [k, localToWorld(this.body.M, ls[k])]));
    // floating markers: the parts of the patient you act on, and the equipment in the bay
    this.pins = [
      ...this.hot.filter(h => PIN_PATIENT.has(h.id)).map(h => ({ id: h.id, label: h.label, pos: [h.c[0], h.c[1] + 0.14, h.c[2]], h })),
      ...EQUIP.map((e, i) => ({ id: e.id, label: e.label, pos: e.pin, h: this.equip[i] })),
    ];
  }

  _bindInput(c) {
    // The camera is driven by the game (setCamera / focus / frameSite); the pointer only hovers and clicks.
    c.addEventListener('pointermove', e => { this.hover = this.pick(e.clientX, e.clientY); });
    c.addEventListener('pointerup', e => { if (this.onHotspot) { const h = this.pick(e.clientX, e.clientY); if (h) this.onHotspot(h); } });
    c.addEventListener('pointerleave', () => { this.hover = null; });
    c.addEventListener('wheel', e => { e.preventDefault(); }, { passive: false });
  }
  pick(cx, cy) {
    if (!this.hot || !this.r.invVP) return null;
    const ray = this.r.rayFromClient(cx, cy);
    for (const list of [this.hot, this.equip]) {              // the patient wins over equipment standing behind or in front of it
      let best = null, bt = 1e9;
      for (const h of list) { const t = raySphere(ray, h.c, h.rad); if (t !== null && t < bt) { bt = t; best = h; } }
      if (best) return best;
    }
    return null;
  }
  /** World point -> CSS pixels on the canvas (null when behind the camera). */
  project(p) {
    const m = this.r.vp, x = p[0], y = p[1], z = p[2];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15]; if (cw < 0.05) return null;
    const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw, ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return { x: (nx * 0.5 + 0.5) * w, y: (0.5 - ny * 0.5) * h, visible: Math.abs(nx) < 1.05 && Math.abs(ny) < 1.05 };
  }

  // ---------------------------------------------------------------- the bay
  _room(p) {
    const r = this.r, g = this.g, P = this._P || (this._P = {
      b: (x, y, z, sx, sy, sz, o = {}, ry = 0) => r.draw(g.ub, TRS(x, y, z, sx, sy, sz, ry), o),
      c: (x, y, z, rx, h, o = {}, rot = {}) => r.draw(g.cyl, TRS(x, y, z, rx, h, rx, rot.y || 0, rot.x || 0, rot.z || 0), o),
      s: (x, y, z, rx, ry, rz, o = {}) => r.draw(g.sph, TRS(x, y, z, rx, ry, rz), o),
    });
    const { x0, x1, z0, z1, h } = ROOM, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    // shell: floor, ceiling and four inward-facing walls (none of them is drawn when seen from outside)
    r.draw(g.floor, mat4.multiply(mat4.translation(cx, 0, cz), mat4.rotationX(-Math.PI / 2)), { color: [0.64, 0.64, 0.61], pattern: 1, spec: 0.14 });
    r.draw(g.floor, mat4.multiply(mat4.translation(cx, h, cz), mat4.rotationX(Math.PI / 2)), { color: [0.88, 0.88, 0.87] });
    r.draw(g.wallW, mat4.translation(cx, h / 2, z0), { color: [0.82, 0.81, 0.78], pattern: 2 });
    r.draw(g.wallW, mat4.multiply(mat4.translation(cx, h / 2, z1), mat4.rotationY(Math.PI)), { color: [0.82, 0.81, 0.78], pattern: 2 });
    r.draw(g.wallD, mat4.multiply(mat4.translation(x0, h / 2, cz), mat4.rotationY(Math.PI / 2)), { color: [0.79, 0.80, 0.77], pattern: 2 });
    r.draw(g.wallD, mat4.multiply(mat4.translation(x1, h / 2, cz), mat4.rotationY(-Math.PI / 2)), { color: [0.79, 0.80, 0.77], pattern: 2 });
    P.b(cx, 0.06, z0 + 0.02, x1 - x0, 0.12, 0.04, { color: [0.40, 0.43, 0.44] });                       // skirting, back wall
    P.b(x1 - 0.02, 0.06, cz, 0.04, 0.12, z1 - z0, { color: [0.40, 0.43, 0.44] });
    P.b(x0 + 0.02, 0.06, cz, 0.04, 0.12, z1 - z0, { color: [0.40, 0.43, 0.44] });
    // ceiling lights
    for (const [lx, lz] of [[-1.5, -0.8], [0.1, 0.4], [-1.2, 1.7]]) P.b(lx, h - 0.03, lz, 0.9, 0.05, 0.5, { color: [1, 1, 1], emissive: [0.95, 0.95, 0.9] });
    // wall clock (shows the simulated time), back wall
    const T = p.t, ckx = 0.95, cky = 2.3, ckz = z0 + 0.04;
    P.c(ckx, cky, ckz + 0.01, 0.2, 0.03, { color: [0.96, 0.96, 0.96], spec: 0.3 }, { x: Math.PI / 2 });
    P.c(ckx, cky, ckz, 0.215, 0.025, { color: [0.15, 0.17, 0.2] }, { x: Math.PI / 2 });
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; P.b(ckx + Math.sin(a) * 0.17, cky + Math.cos(a) * 0.17, ckz + 0.035, 0.012, 0.03, 0.006, { color: [0.1, 0.1, 0.1] }); }
    const hand = (len, a, w, col) => r.draw(g.ub, mat4.multiply(mat4.multiply(mat4.translation(ckx, cky, ckz + 0.045), mat4.rotationZ(-a)), TRS(0, len / 2, 0, w, len, 0.006)), { color: col });
    hand(0.1, 0.35 + (T / 43200) * Math.PI * 2, 0.014, [0.08, 0.08, 0.1]); hand(0.15, 0.8 + (T / 3600) * Math.PI * 2, 0.01, [0.08, 0.08, 0.1]); hand(0.17, (T / 60) * Math.PI * 2, 0.004, [0.85, 0.1, 0.1]);
    // medication cabinet (back wall)
    const mx = -0.55, my = 1.55, mz = z0 + 0.18;
    P.b(mx, my, mz, 1.3, 1.1, 0.3, { color: [0.86, 0.88, 0.9], spec: 0.3 });
    for (let sh = 0; sh < 3; sh++) {
      const sy = my - 0.33 + sh * 0.33; P.b(mx, sy, mz + 0.05, 1.18, 0.02, 0.22, { color: [0.7, 0.72, 0.75] });
      for (let k = 0; k < 9; k++) { const hue = (sh * 9 + k) % 6, col = [[0.78, 0.42, 0.38], [0.86, 0.78, 0.52], [0.48, 0.62, 0.74], [0.52, 0.70, 0.58], [0.90, 0.90, 0.90], [0.66, 0.58, 0.74]][hue]; P.b(mx - 0.5 + k * 0.125, sy + 0.07, mz + 0.05, 0.08, 0.12 + ((k * 7 + sh) % 3) * 0.02, 0.07, { color: col }); }
    }
    P.b(mx, my + 0.57, mz + 0.15, 1.2, 0.015, 0.015, { color: [0.4, 0.9, 0.7], emissive: [0.2, 0.6, 0.45] });
    P.b(mx, my, mz + 0.152, 1.22, 1.02, 0.01, { color: [0.35, 0.5, 0.58], alpha: 0.55, spec: 0.6 });
    // first-aid sign and protocol poster
    P.b(-2.05, 1.8, z0 + 0.012, 0.42, 0.42, 0.012, { color: [0.1, 0.55, 0.3] }); P.b(-2.05, 1.8, z0 + 0.022, 0.26, 0.08, 0.008, { color: [1, 1, 1] }); P.b(-2.05, 1.8, z0 + 0.022, 0.08, 0.26, 0.008, { color: [1, 1, 1] });
    P.b(x0 + 0.015, 1.7, -0.45, 0.012, 0.95, 0.7, { color: [0.97, 0.97, 0.95] }); P.b(x0 + 0.022, 2.12, -0.45, 0.008, 0.1, 0.7, { color: [0.25, 0.55, 0.75] });
    for (let k = 0; k < 6; k++) P.b(x0 + 0.022, 1.95 - k * 0.12, -0.45 + (k % 2 ? 0.05 : -0.05), 0.008, 0.035, 0.5 - (k % 3) * 0.08, { color: [0.62, 0.66, 0.7] });
    // curtain in the back-left corner
    P.b(-2.45, 2.62, z0 + 0.12, 1.1, 0.03, 0.03, { color: [0.7, 0.72, 0.75], spec: 0.4 });
    for (let k = 0; k < 11; k++) P.b(-2.95 + k * 0.1, 1.38, z0 + 0.14 + (k % 2) * 0.03, 0.1, 2.3, 0.025, { color: k % 2 ? [0.52, 0.60, 0.63] : [0.57, 0.65, 0.68] });
    // door (left wall) with exit sign
    const dz = 1.55; P.b(x0 + 0.03, 1.05, dz, 0.05, 2.1, 1.05, { color: [0.45, 0.4, 0.36] }); P.b(x0 + 0.06, 1.03, dz, 0.04, 2.0, 0.92, { color: [0.66, 0.54, 0.4], spec: 0.1 });
    P.b(x0 + 0.09, 1.5, dz, 0.02, 0.5, 0.3, { color: [0.62, 0.8, 0.9], emissive: [0.05, 0.1, 0.12], alpha: 0.8 }); P.s(x0 + 0.1, 1.0, dz + 0.38, 0.03, 0.03, 0.03, { color: [0.8, 0.8, 0.82], spec: 0.6 });
    P.b(x0 + 0.04, 2.35, dz, 0.04, 0.16, 0.5, { color: [0.1, 0.8, 0.4], emissive: [0.05, 0.5, 0.2] });
    // headwall gas outlets (right wall, behind the head of the bed)
    const hx = x1 - 0.04; P.b(hx, 1.35, 0, 0.08, 0.55, 1.25, { color: [0.82, 0.84, 0.86], spec: 0.3 });
    for (const [oz, col] of [[-0.35, [0.1, 0.65, 0.3]], [0, [0.9, 0.78, 0.2]], [0.35, [0.95, 0.95, 0.95]]]) { P.c(hx - 0.06, 1.38, oz, 0.05, 0.06, { color: col, spec: 0.4 }, { z: Math.PI / 2 }); P.c(hx - 0.07, 1.38, oz, 0.025, 0.07, { color: [0.15, 0.15, 0.15] }, { z: Math.PI / 2 }); }
    // oxygen flowmeter: the ball rises with the delivered flow
    const o2 = p.o2 ? 1 : 0; P.b(hx - 0.07, 1.62, -0.35, 0.03, 0.22, 0.03, { color: [0.8, 0.9, 0.95], alpha: 0.5 }); P.s(hx - 0.075, 1.53 + o2 * 0.1, -0.35, 0.012, 0.012, 0.012, { color: [0.95, 0.9, 0.2], emissive: [0.3, 0.25, 0] });
  }

  _equipment(p) {
    const r = this.r, g = this.g, P = this._P, T = this.t, fl = p.flags;
    // crash cart + defibrillator
    const [cx, , cz] = CART;
    P.b(cx, 0.45, cz, 0.7, 0.9, 0.5, { color: [0.58, 0.17, 0.16], spec: 0.3 }); P.b(cx, 0.92, cz, 0.74, 0.04, 0.54, { color: [0.85, 0.86, 0.88], spec: 0.3 });
    for (let k = 0; k < 4; k++) { P.b(cx, 0.22 + k * 0.2, cz + 0.255, 0.64, 0.012, 0.01, { color: [0.35, 0.07, 0.07] }); P.b(cx, 0.31 + k * 0.2, cz + 0.262, 0.2, 0.018, 0.02, { color: [0.85, 0.85, 0.88], spec: 0.5 }); }
    for (const [wx, wz] of [[-0.3, -0.2], [0.3, -0.2], [-0.3, 0.2], [0.3, 0.2]]) P.c(cx + wx, 0.04, cz + wz, 0.04, 0.05, { color: [0.12, 0.12, 0.13] });
    const charged = p.defib.charged, charging = p.defib.chargeAt !== null && p.defib.chargeAt > p.t, pulse = 0.5 + 0.5 * Math.sin(T * 9);
    P.b(cx, 1.06, cz, 0.38, 0.22, 0.28, { color: [0.22, 0.24, 0.27], spec: 0.3 }); P.b(cx, 1.19, cz, 0.2, 0.025, 0.2, { color: [0.15, 0.16, 0.18] });
    const scr = charged ? [0.1 + 0.8 * pulse, 0.9 * pulse + 0.1, 0.15] : charging ? [0.9, 0.7, 0.1] : [0.1, 0.5, 0.55];
    P.b(cx - 0.05, 1.08, cz + 0.145, 0.19, 0.11, 0.012, { color: [0.03, 0.05, 0.06], emissive: scr.map(v => v * 0.55) });
    P.c(cx + 0.12, 1.06, cz + 0.15, 0.03, 0.025, { color: charged ? [1, 0.4 + 0.5 * pulse, 0.1] : [0.9, 0.45, 0.1], emissive: charged ? [0.8, 0.3, 0] : [0, 0, 0] }, { x: Math.PI / 2 });
    P.c(cx + 0.22, 1.1, cz, 0.04, 0.13, { color: [0.75, 0.75, 0.78], spec: 0.3 }); P.c(cx - 0.22, 1.1, cz, 0.04, 0.13, { color: [0.75, 0.75, 0.78], spec: 0.3 });
    // IV pole (stand, pump, bags) and drip
    const px = POLE[0], pz = POLE[2];
    P.c(px, 0.02, pz, 0.26, 0.04, { color: [0.6, 0.62, 0.66], spec: 0.3 });
    P.c(px, 1.05, pz, 0.015, 2.1, { color: [0.7, 0.72, 0.75], spec: 0.4 });
    P.b(px + 0.07, 1.25, pz, 0.14, 0.2, 0.1, { color: [0.85, 0.87, 0.9], spec: 0.3 });
    const running = p.vol.infusions && p.vol.infusions.length > 0;
    P.b(px + 0.07, 1.3, pz + 0.052, 0.09, 0.05, 0.008, { color: [0.05, 0.08, 0.08], emissive: running ? [0.1, 0.8, 0.4] : [0.05, 0.2, 0.2] });
    const bagFill = fl.ivAccess ? 1 : 0.6;
    for (const [dx, col, fill] of [[0, [0.86, 0.94, 0.98], bagFill], [0.15, [0.62, 0.06, 0.1], 0.9]]) {     // crystalloid bag and a unit of blood: flat PVC bags with a port
      P.b(px + dx, 1.86, pz, 0.11, 0.2, 0.012, { color: [0.92, 0.95, 0.97], alpha: 0.35, spec: 0.9 });
      P.b(px + dx, 1.86 - 0.1 * (1 - fill), pz, 0.1, 0.19 * fill, 0.016, { color: col, alpha: 0.72, spec: 0.8 });
      P.c(px + dx, 1.74, pz, 0.006, 0.035, { color: [0.9, 0.9, 0.9], spec: 0.5 }); P.b(px + dx, 1.97, pz, 0.03, 0.01, 0.012, { color: [0.85, 0.85, 0.85] });
    }
    // patient monitor stand
    P.c(STAND[0], 0.015, STAND[1], 0.27, 0.03, { color: [0.3, 0.3, 0.33], spec: 0.3 });
    // anaesthesia machine / ventilator at the head of the bed
    const [vx, , vz] = VENT, ventOn = p.vent.mode === 'ctrl' && (p.airway.device === 'ett' || p.airway.device === 'bvm' || p.o2);
    P.b(vx, 0.62, vz, 0.55, 1.2, 0.5, { color: [0.86, 0.88, 0.9], spec: 0.3 }); P.b(vx, 1.24, vz, 0.6, 0.04, 0.55, { color: [0.7, 0.73, 0.77], spec: 0.3 });
    P.b(vx - 0.12, 1.12, vz - 0.05, 0.3, 0.22, 0.015, { color: [0.03, 0.06, 0.07], emissive: ventOn ? [0.05, 0.45, 0.5] : [0.02, 0.1, 0.12] }, -0.5);
    for (const dy of [0.3, 0.5, 0.7]) P.b(vx, dy, vz + 0.255, 0.48, 0.012, 0.01, { color: [0.55, 0.58, 0.62] });
    const bell = ventOn ? 0.5 + 0.5 * Math.sin(this.breathPh) : 0.5;
    P.c(vx + 0.12, 1.42, vz, 0.07, 0.32, { color: [0.8, 0.9, 0.95], alpha: 0.4, spec: 0.5 }); P.c(vx + 0.12, 1.27 + 0.28 * (1 - bell * 0.6) * 0.5 + 0.02, vz, 0.065, 0.03, { color: [0.2, 0.25, 0.3] });
    for (const [wx, wz] of [[-0.24, -0.2], [0.24, -0.2], [-0.24, 0.2], [0.24, 0.2]]) P.c(vx + wx, 0.04, vz + wz, 0.04, 0.05, { color: [0.12, 0.12, 0.13] });
  }

  /** Draw one frame. p: Patient (or the preview patient behind the menu). */
  draw(realDt, p) {
    const r = this.r, B = this.body; if (!B) return; this.t += realDt;
    // camera rig: presets are reached by an eased tween (setCamera), an action frames its site and then glides back to the overview (focus),
    // a drag orbits the view and it drifts back to the framing a few seconds after release
    if (this.returnAt != null && this.t >= this.returnAt && !this.dragging) this.setCamera('default');
    let lift = 0;
    if (this.auto) {
      this.tw = null; const G = { yaw: -0.62 + 0.6 * Math.sin(this.t * 0.14), pitch: 0.34, dist: 3.6, target: [0.1, 0.92, 0] }, k = 1 - Math.exp(-realDt * 3);
      this.yaw += (G.yaw - this.yaw) * k; this.pitch += (G.pitch - this.pitch) * k; this.dist += (G.dist - this.dist) * k; this.target = this.target.map((v, i) => v + (G.target[i] - v) * k);
      this.off.yaw = 0; this.off.pitch = 0;
    } else if (this.tw) {
      const w = this.tw, u = clamp((this.t - w.t0) / w.dur, 0, 1), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2, L = (a, b) => a + (b - a) * e;
      this.yaw = L(w.from.yaw, w.to.yaw); this.pitch = L(w.from.pitch, w.to.pitch); this.dist = L(w.from.dist, w.to.dist); this.target = w.from.target.map((v, i) => L(v, w.to.target[i]));
      lift = w.lift * Math.sin(Math.PI * u);
      if (u >= 1) this.tw = null;
    }
    if (!this.dragging && this.releasedAt != null && this.t - this.releasedAt > 3) { const k = 1 - Math.exp(-realDt * 1.6); this.off.yaw *= 1 - k; this.off.pitch *= 1 - k; }
    const yawV = this.yaw + this.off.yaw + 0.004 * Math.sin(this.t * 0.31), pitchV = clamp(this.pitch + this.off.pitch + 0.003 * Math.sin(this.t * 0.23 + 1), 0.08, 1.52);
    const asp = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight), D = (this.dist + lift) * (asp < 1.25 ? Math.min(2.1, 1.25 / asp) : 1);   // portrait screens: pull back so the whole bay still fits
    const eye = [this.target[0] + D * Math.cos(pitchV) * Math.sin(yawV), this.target[1] + D * Math.sin(pitchV), this.target[2] + D * Math.cos(pitchV) * Math.cos(yawV)];
    eye[0] = clamp(eye[0], ROOM.x0 + 0.15, ROOM.x1 - 0.15); eye[2] = clamp(eye[2], ROOM.z0 + 0.15, ROOM.z1 - 0.15); eye[1] = clamp(eye[1], 0.4, ROOM.h - 0.12);   // never leave the bay
    const cam = { eye, target: this.target, fov: 0.85 };
    { const W = Math.max(1, this.canvas.clientWidth), goal = clamp((this.inset.l - this.inset.r) / W, -0.5, 0.5); this.shift += (goal - this.shift) * (1 - Math.exp(-realDt * 5)); r.shiftX = this.shift; }

    // ---------------- physiology -> appearance
    const sao2 = p.resp.sao2, arrested = p.arrest.arrested, perf = p.circ.mapArt;
    const cyan = clamp((0.93 - sao2) / 0.35, 0, 1), pallor = clamp((p.vol.fractionLost - 0.1) / 0.3, 0, 1) * 0.9 + (perf < 55 ? 0.3 : 0) + (arrested ? 0.4 : 0);
    const skin = skinColor(SKIN_TONES[this.tone] || SKIN_TONES[2], { cyanosis: cyan, pallor: clamp(pallor, 0, 1), flush: clamp((p.therm.tc - 37.8) / 2, 0, 1) });
    // breathing: from the engine respiratory rate and tidal volume; ventilated chest rise during BVM / vent
    const rrNow = p.resp.rr, vt = p.resp.vt || 0;
    this.breathPh += realDt * (rrNow / 60) * Math.PI * 2;
    const sign = Math.sin(this.breathPh) * 0.5 + 0.5;
    const breath = rrNow > 0.5 ? clamp(vt / 600, 0.1, 1.4) * 0.022 * sign : 0;
    // compressions: animate each engine compression event
    let comp = 0; const ev = p.cpr.events;
    if (arrested && ev.length) { const age = p.t - ev[ev.length - 1].t, d = ev[ev.length - 1].depth / 100; if (age >= 0 && age < 0.28) comp = d * Math.sin(Math.PI * age / 0.28); }
    this.compAmt += (comp - this.compAmt) * (1 - Math.exp(-realDt * 40));
    if (p.shockLog.length && p.shockLog[p.shockLog.length - 1].t !== this._shockSeen) { this._shockSeen = p.shockLog[p.shockLog.length - 1].t; this.shockT = 0.35; }
    this.shockT = Math.max(0, this.shockT - realDt);
    const jerk = this.shockT > 0 ? Math.sin(this.shockT * 60) * 0.004 : 0;

    const frame = () => {
    // ---------------- room and equipment
    const fr = this.g;
    this._room(p); this._equipment(p);
    const face = this.world.face;
    // bed
    r.draw(fr.bedFrame, mat4.translation(-0.1, 0.74, 0), { color: [0.55, 0.58, 0.62], spec: 0.3 });
    for (const [x, z] of [[-1.0, -0.35], [-1.0, 0.35], [0.8, -0.35], [0.8, 0.35]]) r.draw(fr.leg, mat4.translation(x, 0.36, z), { color: [0.4, 0.42, 0.45], spec: 0.3 });
    r.draw(fr.mattress, mat4.translation(-0.1, 0.80, 0), { color: [0.19, 0.23, 0.28], spec: 0.15 });
    r.draw(fr.rail, mat4.translation(-0.1, 0.98, 0.43), { color: [0.7, 0.72, 0.75], spec: 0.4 });
    // monitor on its stand: the screen shows the very same canvas as the HUD monitor
    const [standX, standZ] = STAND;
    r.draw(fr.cyl, mat4.multiply(mat4.translation(standX, 0.7, standZ), mat4.scaling(0.025, 1.4, 0.025)), { color: [0.3, 0.3, 0.32] });
    r.draw(fr.monitorBody, mat4.multiply(mat4.translation(standX, 1.55, standZ), mat4.rotationY(-0.55)), { color: [0.12, 0.13, 0.15], spec: 0.2 });
    r.updateTexture(this.monTex, this.monitorCanvas);
    r.drawQuad(this.monTex, mat4.multiply(mat4.multiply(mat4.translation(standX, 1.55, standZ), mat4.rotationY(-0.55)), mat4.multiply(mat4.translation(0, 0, 0.05), mat4.scaling(0.94, 0.5, 1))), 1.15);   // screen decal 1 cm in front of the bezel

    // ---------------- patient
    const M = mat4.multiply(mat4.translation(0, jerk, 0), B.M);
    const o = { breath, compress: this.compAmt };
    const sheetCol = p.therm.cover < 1 ? [0.74, 0.58, 0.40] : [0.72, 0.79, 0.84];
    if (B.b.glb) {
      const T = this.asset.tex, tint = skin.map((v, i) => v / TONE_REF[i]), A = (k) => T['patient_' + k] || {};
      o.compDir = [0, 1, 0];                                   // the asset's anterior axis is +y (procedural body: +z)
      // the chest is exposed for anything done on it: pads, leads, CPR, chest procedures and examinations in progress
      const exposed = p.flags.padsOn || p.flags.ecgLeads || arrested || !!(p.chest && (p.chest.needle || p.chest.tube)) || this.gest.list.some(g => ['needle', 'tube', 'steth', 'probe', 'step_pads'].includes(g.k));
      r.draw(B.g.body, M, { color: tint, spec: 0.3, pattern: 7, albedo: A('body').albedo, normalMap: A('body').normal, ...o });
      r.draw(B.g.eyes, M, { color: [1, 1, 1], spec: 0.9, pattern: 6, albedo: A('eyes').albedo, ...o });
      r.draw(B.g.eyebrows, M, { color: [1, 1, 1], spec: 0.05, albedo: A('eyebrows').albedo, alphaCut: -1, cull: false, depthWrite: false, noShadow: true, ...o });
      const grey = Math.min(1, Math.max(0, (B.spec.age - 45) / 35));
      r.draw(B.g.hair, M, { color: [1 + grey * 1.6, 1 + grey * 1.55, 1 + grey * 1.5], spec: 0.2, pattern: 4, albedo: A('hair').albedo, alphaCut: 0.5, cull: false, noShadow: true, ...o });
      const infl = 0.004 + 0.016 * Math.min(1, B.b.weights.heavy + 0.5 * B.b.weights.female_heavy);   // heavier morphs need more clearance
      if (!exposed) r.draw(B.g.gown, M, { color: [0.36, 0.55, 0.66], spec: 0.05, pattern: 5, cull: false, inflate: infl, ...o });
      r.draw(B.g.sheet, M, { color: sheetCol, spec: 0.05, pattern: 5, cull: false, ...o });   // the draped sheet's normals are not consistently outward: no inflate
      // arm board under the abducted right arm
      const ra = this.world.rightArmIV, sh = [this.world.padRight[0] + 0.07, BED_TOP, this.world.padRight[2] - 0.12], d = [ra[0] - sh[0], 0, ra[2] - sh[2]], dl = Math.hypot(d[0], d[2]) || 1, ex = [d[0] / dl, 0, d[2] / dl], ez = [-ex[2], 0, ex[0]];
      const c = [ra[0] + ex[0] * 0.08, BED_TOP - 0.025, ra[2] + ex[2] * 0.08];
      r.draw(fr.ub, mat4.multiply(mat4.fromBasis(ex, [0, 1, 0], ez, c), mat4.scaling(0.62, 0.035, 0.15)), { color: [0.20, 0.24, 0.29], spec: 0.15 });
      r.draw(fr.cyl, mat4.multiply(mat4.translation(c[0] + ex[0] * 0.12, BED_TOP - 0.33, c[2] + ex[2] * 0.12), mat4.scaling(0.018, 0.6, 0.018)), { color: [0.62, 0.64, 0.68], spec: 0.4 });
    } else {
      r.draw(B.g.skin, M, { color: skin, spec: 0.3, pattern: 3, ...o });
      r.draw(B.g.hair, M, { color: B.b.morph.fem ? [0.24, 0.14, 0.08] : [0.17, 0.115, 0.075], spec: 0.2, pattern: 4 });
      r.draw(B.g.eyes, M, { color: [0.93, 0.93, 0.93], spec: 0.9, pattern: 6 });
      r.draw(B.g.pupils, M, { color: arrested ? [0.02, 0.02, 0.02] : [0.05, 0.05, 0.05] });
      r.draw(B.g.lips, M, { color: [0.62 - cyan * 0.25, 0.28, 0.28 + cyan * 0.2] });
      r.draw(B.g.sheet, M, { color: sheetCol, spec: 0.05, pattern: 5, ...{ breath: breath * 0.2 } });
    }
    // bleeding
    const bleeding = p.vol.rates.bleed > 0, lost = p.vol.fractionLost;
    if (bleeding || (lost > 0.03 && (p.bleedControlledAt === null))) {
      const s = clamp(0.05 + lost * 0.8, 0.05, 0.4), f = this.world.femoral;
      r.draw(fr.sph, mat4.multiply(mat4.translation(f[0] + 0.03, 0.935 + 0.0, f[2] + 0.02), mat4.scaling(s * 1.0, 0.012, s * 0.8)), { color: [0.55, 0.02, 0.03], spec: 0.5 });
    }
    // devices
    const W = this.world, fl = p.flags;
    const seg = (A, Bp, rad, col, extra = {}) => {
      const d = vec3.sub(Bp, A), len = Math.hypot(...d) || 1e-6, ey = d.map(x => x / len); const up = Math.abs(ey[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
      const ex = vec3.norm(vec3.cross(up, ey)), ez = vec3.cross(ey, ex);
      const m = mat4.fromBasis(ex, ey, ez, A.map((v, i) => (v + Bp[i]) / 2));
      r.draw(fr.cyl, mat4.multiply(m, mat4.scaling(rad, len, rad)), { color: col, ...extra });
    };
    const blob = (c, sx, sy, sz, col, extra = {}) => r.draw(fr.sph, mat4.multiply(mat4.translation(c[0], c[1], c[2]), mat4.scaling(sx, sy, sz)), { color: col, ...extra });
    const up = (v, dy) => [v[0], v[1] + dy, v[2]];
    // helpers: an instrument from the asset, a disc lying on the skin, a flexible tube along a quadratic curve
    const inst = (name, tip, axis, roll = 0, opts = {}) => this._instrument(name, tip, axis, roll, opts);
    const disc = (c, n, tan, rx, rz, col, extra = {}) => { const ey = vec3.norm(n); let ex = vec3.sub(tan, vec3.scale(ey, vec3.dot(tan, ey))); ex = vec3.norm(ex); const ez = vec3.cross(ex, ey); r.draw(fr.sph, mat4.multiply(mat4.fromBasis(ex, ey, ez, c), mat4.scaling(rx, 0.0015, rz)), { color: col, ...extra }); };
    const hose = (a, ctrl, b, rad, col, extra = {}) => { let prev = a; for (let i = 1; i <= 12; i++) { const k = i / 12, q = [0, 1, 2].map(j => (1 - k) * (1 - k) * a[j] + 2 * (1 - k) * k * ctrl[j] + k * k * b[j]); seg(prev, q, rad, col, extra); prev = q; } };
    const SF = (k) => this.siteFrame?.(k);
    const onSkin = (f, h = 0.002) => [f.p[0] + f.n[0] * h, f.p[1] + f.n[1] * h, f.p[2] + f.n[2] * h];
    if (fl.padsOn) {                                            // multifunction pads stuck on the skin, red leads to the defibrillator
      for (const [k, nm] of [['padRight', 'defibPadRight'], ['padLeft', 'defibPadLeft']]) { const f = SF(k) || { p: W[k], n: [0, 1, 0] }; inst(nm, onSkin(f, 0.003), f.n, 0); }
      const pr = W.padRight; hose(up(pr, 0.02), [pr[0] + 0.3, 1.05, pr[2] - 0.35], [CART[0] + 0.19, 1.0, CART[2] + 0.17], 0.004, [0.72, 0.07, 0.06], { spec: 0.5 });
    }
    if (fl.ecgLeads) {                                          // three foam electrodes with snaps, leads gathered toward the monitor
      const st = SF('sternum') || { p: W.sternum, n: [0, 1, 0] }, lead = [[0.12, -0.09, [0.95, 0.95, 0.95]], [0.12, 0.09, [0.9, 0.2, 0.2]], [-0.1, 0.1, [0.2, 0.8, 0.3]]];
      for (const [dx, dz, col] of lead) {
        const q = [st.p[0] + dx, st.p[1], st.p[2] + dz], n = this.normalAt(q), base = [q[0] + n[0] * 0.012, q[1] + n[1] * 0.012 - 0.008, q[2] + n[2] * 0.012];
        disc(base, n, [1, 0, 0], 0.02, 0.02, [0.96, 0.96, 0.94], { spec: 0.2 }); blob([base[0] + n[0] * 0.004, base[1] + n[1] * 0.004, base[2] + n[2] * 0.004], 0.005, 0.004, 0.005, [0.75, 0.77, 0.8], { spec: 0.9 });
        hose([base[0] + n[0] * 0.006, base[1] + n[1] * 0.006, base[2] + n[2] * 0.006], [base[0] + 0.12, base[1] + 0.02, -0.45], [STAND[0] - 0.25, 0.95, STAND[1] + 0.35], 0.0018, col, { spec: 0.4 });
      }
    }
    if (fl.spo2Probe) { const f = SF('leftArm') || { p: W.leftArm, n: [0, 1, 0] }; blob(up([f.p[0] - 0.24, f.p[1], f.p[2] + 0.03], 0.015), 0.022, 0.012, 0.014, [0.18, 0.22, 0.28], { spec: 0.5 }); }
    if (fl.nibp) { const a = W.leftArm; seg(up([a[0] + 0.03, a[1] - 0.02, a[2]], 0.0), up([a[0] + 0.15, a[1] - 0.02, a[2]], 0.0), 0.05, [0.2, 0.22, 0.28], { spec: 0.15 }); }
    if (fl.ivAccess && this.gest.ok('iv', this.t)) {            // 18 G cannula taped under a clear dressing, giving set to the IV pole
      const f = SF('rightArmIV') || { p: W.rightArmIV, n: [0, 1, 0] }, ax = this.armAxis(), dir = vec3.norm(vec3.add(vec3.scale(f.n, -1), vec3.scale(ax, 2.7)));
      const tip = vec3.add(f.p, vec3.scale(dir, 0.02)); inst('ivCannula', tip, vec3.scale(dir, -1), 0, { skip: ['steel'] });
      disc(onSkin(f, 0.003), f.n, ax, 0.022, 0.018, [0.92, 0.96, 1.0], { alpha: 0.18, spec: 1, noShadow: true });
      const hub = vec3.add(f.p, vec3.add(vec3.scale(dir, -0.05), vec3.scale(f.n, 0.012)));
      hose(hub, [hub[0] + 0.05, hub[1] + 0.25, hub[2] - 0.2], [POLE[0] + 0.07, 1.25, POLE[2]], 0.0025, [0.86, 0.93, 0.97], { alpha: 0.75, spec: 0.9 });
    }
    // airway devices
    const dev = p.airway.device;
    if (p.o2 && dev !== 'ett') blob([face[0] + 0.02, face[1] + 0.035, face[2]], 0.075, 0.05, 0.065, [0.7, 0.85, 0.9], { alpha: 0.55, spec: 0.5 });
    if ((dev === 'ett' || p.airway.intubated) && dev !== 'fona' && this.gest.ok('ett', this.t)) {   // clear PVC tube with its blue line, taped at the corner of the mouth, 15 mm connector
      const m0 = up(W.airway, 0.006), m1 = up([W.airway[0] + 0.07, W.airway[1], W.airway[2] + 0.01], 0.05), m2 = up([W.airway[0] + 0.17, W.airway[1], W.airway[2] + 0.01], 0.075);
      hose(m0, m1, m2, 0.0058, [0.88, 0.94, 0.96], { alpha: 0.8, spec: 1 }); seg(m2, [m2[0] + 0.025, m2[1] + 0.004, m2[2]], 0.0085, [0.95, 0.95, 0.93], { spec: 0.5 });
      seg(up([W.airway[0] - 0.005, W.airway[1], W.airway[2] - 0.035], 0.004), up([W.airway[0] + 0.01, W.airway[1], W.airway[2] + 0.04], 0.004), 0.004, [0.93, 0.92, 0.86], { spec: 0.1 });   // tape
    }
    if (p.tube?.scopeIn) {                                     // bronchoscope: insertion cord into the tube connector, control body held above the head, light cable
      const port = up([W.airway[0] + 0.2, W.airway[1], W.airway[2]], 0.075), body = [port[0] + 0.02, port[1] + 0.34, port[2] + 0.16], top = [body[0] + 0.03, body[1] + 0.13, body[2]];
      seg(port, [port[0] + 0.03, port[1] + 0.06, port[2]], 0.012, [0.85, 0.87, 0.9], { spec: 0.6 });   // swivel adaptor
      seg([port[0] + 0.03, port[1] + 0.06, port[2]], body, 0.0035, [0.08, 0.08, 0.09], { spec: 0.5 });
      seg(body, top, 0.018, [0.12, 0.13, 0.15], { spec: 0.5 }); blob(top, 0.022, 0.016, 0.022, [0.15, 0.16, 0.18], { spec: 0.6 });
      seg([body[0], body[1] + 0.05, body[2] - 0.02], [body[0] + 0.25, body[1] - 0.05, body[2] - 0.35], 0.006, [0.1, 0.1, 0.11]);   // light cable, routed behind the head
    }
    if (p.vent.mode === 'ctrl' && (dev === 'ett' || dev === 'bvm' || p.o2)) {
      const y0 = up([face[0] + 0.21, face[1] + 0.07, face[2]], 0.03), y1 = [y0[0] + 0.06, y0[1] + 0.02, y0[2]];
      seg(y0, y1, 0.009, [0.9, 0.92, 0.93], { spec: 0.6 });                                                  // catheter mount + Y-piece
      for (const k of [-1, 1]) {                                                                            // inspiratory and expiratory limbs, corrugated
        const a = [y1[0], y1[1], y1[2] + k * 0.012], ctrl = [y1[0] + 0.25, y1[1] + 0.25, y1[2] + k * 0.08 + 0.1], b = [VENT[0] - 0.2, 1.08, VENT[2] - 0.12 + k * 0.05];
        let prev = a; for (let i = 1; i <= 16; i++) { const t = i / 16, q = [0, 1, 2].map(j => (1 - t) * (1 - t) * a[j] + 2 * (1 - t) * t * ctrl[j] + t * t * b[j]); seg(prev, q, i % 2 ? 0.0105 : 0.0115, k < 0 ? [0.55, 0.68, 0.8] : [0.82, 0.86, 0.9], { alpha: 0.85, spec: 0.7 }); prev = q; }
      }
    }
    // chest compressions are shown by the chest itself (compression weights) and the monitor's CPR artefact
    // surgical gestures: catheter, chest drain, surgical airway, ultrasound mark
    const ch = p.chest, nk = p.neck;
    if (ch) {
      if (ch.needle && ch.side && this.gest.ok('needle', this.t)) {           // 14 G catheter left in the chest wall, perpendicular to the skin
        const f = SF(`${ch.side}_${ch.needle.site || 'mcl2'}`) || { p: this.chestSites[ch.side].mal5, n: [0, 1, 0] };
        inst('needle14G', vec3.add(f.p, vec3.scale(f.n, -0.045)), f.n, 0, { skip: ['steel', 'flash_orange'] });
        if (!ch.needle.patent) disc(onSkin(f, 0.003), f.n, [1, 0, 0], 0.006, 0.006, [0.6, 0.05, 0.05], { spec: 0.8 });
      }
      if (ch.tube && ch.tube.side && this.gest.ok('tube', this.t)) {         // drain aimed at the apex, sutured, tubing to an underwater-seal bottle on the floor
        const f = SF(`${ch.tube.side}_mal5`) || { p: this.chestSites[ch.tube.side].mal5, n: [0, 1, 0] };
        const dir = vec3.norm(vec3.add(vec3.scale(f.n, -1), vec3.scale([1, 0, 0], 0.9)));
        inst('chestDrain', vec3.add(f.p, vec3.scale(dir, 0.11)), vec3.scale(dir, -1), 0);
        const out = vec3.add(f.p, vec3.scale(dir, -0.35)), lat = ch.tube.side === 'R' ? -1 : 1, bottle = [f.p[0] - 0.35, 0.16, lat * 0.62];
        hose(out, [out[0] - 0.05, 0.75, lat * 0.6], [bottle[0], 0.33, bottle[2]], 0.006, [0.85, 0.92, 0.95], { alpha: 0.65, spec: 1 });
        r.draw(fr.cyl, mat4.multiply(mat4.translation(...bottle), mat4.scaling(0.075, 0.32, 0.075)), { color: [0.82, 0.92, 0.96], alpha: 0.35, spec: 1, noShadow: true });
        const lvl = 0.1 + 0.05 * Math.min(1, ch.tube.drained || 0), swing = 0.006 * Math.sin(this.breathPh);
        r.draw(fr.cyl, mat4.multiply(mat4.translation(bottle[0], bottle[1] - 0.16 + lvl / 2 + swing, bottle[2]), mat4.scaling(0.07, lvl, 0.07)), { color: [0.62, 0.12, 0.12], alpha: 0.75, spec: 0.8, noShadow: true });
        r.draw(fr.cyl, mat4.multiply(mat4.translation(bottle[0], bottle[1] + 0.17, bottle[2]), mat4.scaling(0.078, 0.02, 0.078)), { color: [0.2, 0.45, 0.8], spec: 0.4 });
        if (ch.air > 0.02) for (let i = 0; i < 4; i++) { const ph = ((this.t * 0.9 + i * 0.25) % 1); blob([bottle[0] + 0.02 * Math.sin(i * 2), bottle[1] - 0.12 + ph * 0.1, bottle[2] + 0.02 * Math.cos(i * 3)], 0.006, 0.006, 0.006, [0.95, 0.97, 1], { alpha: 0.6 * (1 - ph), noShadow: true }); }
        disc(onSkin(f, 0.003), f.n, [1, 0, 0], 0.03, 0.025, [0.95, 0.95, 0.93], { spec: 0.2 });   // dressing around the drain
      }
    }
    if (nk && this.gest.ok('neck', this.t)) {
      const f = SF('neck') || { p: W.neck, n: [0, 1, 0] };
      if (nk.marked && !nk.fona) { disc(onSkin(f, 0.0015), f.n, [0, 0, 1], 0.012, 0.0012, [0.15, 0.2, 0.75], { spec: 0.3 }); }   // skin marker line over the membrane
      if (nk.fona?.kind === 'tube') {                                           // 6.0 cuffed tube through the membrane, connector up, ties around the neck
        const dir = vec3.norm(vec3.add(vec3.scale(f.n, -1), [-0.7, 0, 0]));
        hose(vec3.add(f.p, vec3.scale(dir, 0.05)), f.p, vec3.add(f.p, vec3.scale(f.n, 0.07)), 0.0052, [0.88, 0.94, 0.96], { alpha: 0.85, spec: 1 });
        const top = vec3.add(f.p, vec3.scale(f.n, 0.07)); seg(top, vec3.add(top, vec3.scale(f.n, 0.025)), 0.0085, [0.95, 0.95, 0.93], { spec: 0.5 });
      } else if (nk.fona?.kind === 'cannula') { inst('needle14G', vec3.add(f.p, vec3.scale(f.n, -0.03)), f.n, 0, { skip: ['steel', 'flash_orange'] }); }
    }
    this.gest.draw({ r, fr, seg, blob, scene: this, inst, disc }, this.t);
    // hands-on: the instrument in the hand, the incision being drawn
    const gh = this.ghost || (this.afterGhost && this.t < this.afterGhost.until ? this.afterGhost : null);
    if (gh) { const n = gh.n, q = [gh.p[0] + n[0] * ((gh.lift || 0) - (gh.depth || 0)), gh.p[1] + n[1] * ((gh.lift || 0) - (gh.depth || 0)), gh.p[2] + n[2] * ((gh.lift || 0) - (gh.depth || 0))]; this._instrument(gh.tool, q, n, gh.angle || 0); }
    if (this.cut) { const c = this.cut, mid = c.a.map((v, i) => (v + c.b[i]) / 2), d = vec3.sub(c.b, c.a), L = Math.hypot(...d); if (L > 0.002) { const n = this.normalAt(mid); disc(vec3.add(mid, vec3.scale(n, 0.0014)), n, vec3.scale(d, 1 / L), L / 2, 0.0012, [0.32, 0.02, 0.03], { spec: 0.9 }); } }   // the incision opening as it is drawn
    // hotspot highlight
    if (this.hover && this.hover.equip) { const h = this.hover; r.draw(fr.sph, mat4.multiply(mat4.translation(h.c[0], h.c[1], h.c[2]), mat4.scaling(h.rad, h.rad, h.rad)), { color: [0.2, 0.8, 1.0], alpha: 0.1, emissive: [0.0, 0.12, 0.16], noShadow: true }); }
    // defibrillation flash
    if (this.shockT > 0.25) { r.draw(fr.sph, mat4.multiply(mat4.translation(W.sternum[0], W.sternum[1], W.sternum[2]), mat4.scaling(0.3, 0.3, 0.3)), { color: [1, 1, 1], emissive: [1, 1, 1], alpha: 0.6 }); }
    };
    r.beginShadow(); frame(); r.endShadow();
    r.begin(cam); frame(); r.end();
  }
}
