// 3D clinical scene: an emergency bay (room, bed, equipment, staff), the procedural patient, camera orbit, hotspot picking and
// world-to-screen projection for the floating markers. Read-only view of engine state.
import { Gestures } from './gestures.js';
import { breathPose, breathFrame, drapeWeights } from './breathing.js';
import { FaceAnim } from './face.js';
import { CprAnim } from './cpr-anim.js';
import { BodyAnim } from './body-anim.js';
import { SkinAnim } from './skin.js';
import { PupilAnim } from './pupils.js';
import { bloodState } from './blood.js';
import { WakeAnim, movePoint } from './wake-anim.js';
import { BedAnim, bendPoint, bendWeight, turnDir } from './bed.js';
import { RescuerAnim, posture, rescuerFlex, bagger } from './rescuer-anim.js';
import { DripAnim, dropAt } from './drip.js';
import { syringePumps, pumpScreen, SYRINGE_ML } from './syringe.js';
import { t as tr, drugName } from './i18n.js';
import { CamMove, moveDuration, handheld, handheldAmp } from './camera-rig.js';
import { Renderer, mat4, vec3 } from './gl/renderer.js';
import { box, sphere, cylinder } from './gl/geometry.js';
import { morphology, buildBody, supineMatrix, SKIN_TONES, skinColor, localToWorld } from './gl/body.js';
import { raySphere } from './gl/math.js';
import { parseGlb, decodeImages } from './gl/gltf.js';
import { buildGlbBody } from './gl/patient-glb.js';
import { prepare as preparePick, rayMesh } from './gl/pick.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/** End of a gown sleeve up the forearm (hands.glb, in the hand's frame): centre of the ring of vertices farthest from the hand, and its radius. */
function sleeveEnd(arrs) {
  let n = 0, c = [0, 0, 0]; for (const P of arrs) for (let i = 0; i < P.length; i += 3) { c[0] += P[i]; c[1] += P[i + 1]; c[2] += P[i + 2]; n++; }
  if (!n) return null; c = c.map(v => v / n); const d = vec3.norm(c);                       // from the hand toward the elbow
  let hi = -Infinity; for (const P of arrs) for (let i = 0; i < P.length; i += 3) hi = Math.max(hi, P[i] * d[0] + P[i + 1] * d[1] + P[i + 2] * d[2]);
  const ring = []; for (const P of arrs) for (let i = 0; i < P.length; i += 3) if (P[i] * d[0] + P[i + 1] * d[1] + P[i + 2] * d[2] > hi - 0.012) ring.push([P[i], P[i + 1], P[i + 2]]);
  const e = [0, 1, 2].map(j => ring.reduce((a, q) => a + q[j], 0) / ring.length), r = ring.reduce((a, q) => a + Math.hypot(q[0] - e[0], q[1] - e[1], q[2] - e[2]), 0) / ring.length;
  return { c: e, r, d };
}
/** How each part of a rescuer is shaded (textures come from rescuer.glb). */
const RESCUER_LOOK = {
  skin: { color: [1, 1, 1], spec: 0.3, pattern: 7, cull: false }, scrubs: { color: [1, 1, 1], spec: 0.06, cull: false },   // double-sided: the arm cuts are closed with patches shoes: { color: [1, 1, 1], spec: 0.2 },
  eyes: { color: [1, 1, 1], spec: 0.9 }, gloves: { color: [0.23, 0.44, 0.85], spec: 0.32, pattern: 8 },
  hair: { color: [1, 1, 1], spec: 0.2, pattern: 4, alphaCut: 0.5, cull: false, noShadow: true },
  brows: { color: [1, 1, 1], spec: 0.05, alphaCut: -1, cull: false, depthWrite: false, noShadow: true },
  lashes: { color: [1, 1, 1], spec: 0.05, alphaCut: -1, cull: false, depthWrite: false, noShadow: true },
};
const BAGGER_GOWN = [0.36, 0.62, 0.46];
const BAGGER_TINT = { scrubs: [0.62, 0.95, 0.72], skin: [0.74, 0.58, 0.47], hair: [2.4, 2.3, 2.15], brows: [2.0, 1.9, 1.8] };   // the third rescuer reuses a compressor's model: another skin tone and grey hair so they are not twins   // the third rescuer's gown sleeves (hands.glb), matching the tinted scrubs
const smooth01 = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const HAND_KEYS = ['act', 'relax'];
/** Joint weights for the waking movements (wake-anim.js, shader moveP): per vertex [left arm, left leg, right leg] from the body
 *  regions (5 arms, 8 legs; the patient's left is +z), smoothed four times along the mesh edges so the shoulder and hip bend
 *  softly while a hand resting against the thigh (no shared edges) stays separate. The sheet follows the legs, never the arm. */
function jointWeights(m, sheet) {
  const n = m.pos.length / 3, w = new Float32Array(n * 3), I = m.idx;
  for (let i = 0; i < n; i++) { const r = m.region[i], left = m.pos[i * 3 + 2] > 0; w[i * 3] = !sheet && r === 5 && left ? 1 : 0; w[i * 3 + 1] = r === 8 && left ? 1 : 0; w[i * 3 + 2] = r === 8 && !left ? 1 : 0; }
  const sum = new Float32Array(n * 3), cnt = new Uint16Array(n);
  for (let it = 0; it < 4; it++) {
    sum.fill(0); cnt.fill(0);
    for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) { const a = I[t + e], b = I[t + (e + 1) % 3]; for (let c = 0; c < 3; c++) { sum[a * 3 + c] += w[b * 3 + c]; sum[b * 3 + c] += w[a * 3 + c]; } cnt[a]++; cnt[b]++; }
    for (let i = 0; i < n; i++) if (cnt[i]) for (let c = 0; c < 3; c++) w[i * 3 + c] = 0.5 * w[i * 3 + c] + 0.5 * sum[i * 3 + c] / cnt[i];
  }
  return w;
}                                             // hands.glb finger morph targets, weights in opts.act / opts.relax
const HOTSPOTS = [
  ['head', 'airway', 0.17, 'hs_head'], ['chest', 'sternum', 0.17, 'hs_chest'], ['rarm', 'rightArmIV', 0.11, 'hs_rarm'], ['larm', 'leftArm', 0.11, 'hs_larm'],
  ['groin', 'femoral', 0.13, 'hs_groin'], ['abdomen', 'abdomen', 0.15, 'hs_abdomen'], ['neck', 'neck', 0.08, 'hs_neck'],
];
const PIN_PATIENT = new Set(['head', 'chest', 'rarm', 'larm', 'groin', 'neck', 'flank']);
// realistic patient (assets/patient.glb): crown position on the mattress and mattress top; asset axes already match the bay (+x head, +y up, +z patient's left)
const MAT_N = 28;   // the mattress in slices, so it bends with the back section of the bed
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
      bedFrame: r.upload(box(2.25, 0.08, 0.86)), mattress: r.upload(box(2.1 / MAT_N, 0.12, 0.8)), rail: r.upload(box(2.0, 0.05, 0.04)),
      leg: r.upload(cylinder(0.04, 0.8, 12)), monitorBody: r.upload(box(1.0, 0.56, 0.08)),
      pad: r.upload(cylinder(1, 0.02, 20)), bag: r.upload(sphere(1, 1.25, 0.5, 14, 10)),
      wallW: r.upload(plane(ROOM.x1 - ROOM.x0, ROOM.h)), wallD: r.upload(plane(ROOM.z1 - ROOM.z0, ROOM.h)), floor: r.upload(plane(ROOM.x1 - ROOM.x0, ROOM.z1 - ROOM.z0)),
    };
    this.monTex = r.createTexture(monitorCanvas);
    this.yaw = CAMERAS.default.yaw; this.pitch = CAMERAS.default.pitch; this.dist = CAMERAS.default.dist; this.target = [...CAMERAS.default.target];
    this.goal = null; this.off = { yaw: 0, pitch: 0 }; this.hover = null; this.t = 0; this.breathPh = 0; this.compAmt = 0; this.shockT = 0; this.tone = 2; this.body = null;
    this.auto = false;            // slow cinematic orbit (case menu)
    this.inset = { l: 0, r: 0, t: 0, b: 0 }; this.shift = 0; this.shiftY = 0;   // screen px covered by panels on each side (ui.updateInsets)
    this.faceAnim = new FaceAnim(); this.wakeAnim = new WakeAnim(); this.bedAnim = new BedAnim(); this._bedT = null; this.pupilAnim = new PupilAnim(); this.cprAnim = new CprAnim(); this.bodyAnim = new BodyAnim(); this.skinAnim = new SkinAnim();
    this.camVel = { yaw: 0, pitch: 0, dist: 0, target: [0, 0, 0] }; this.hh = 0;   // camera velocity (per s) and hand-held strength (camera-rig.js)
    this.reduceMotion = typeof matchMedia === 'function' && !!matchMedia('(prefers-reduced-motion: reduce)')?.matches;
    this.gest = new Gestures(); this.rescuerHands = true; this.rescuerAnim = new RescuerAnim(); this.drip = new DripAnim(); this.pins = []; this._bindInput(canvas);
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
    // smooth camera move on the orbit (shortest way round), carrying on from the current motion, swinging slightly out mid-way so it travels around the bed, not through it
    const from = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: [...this.target] };
    const dYaw = Math.atan2(Math.sin(to.yaw - from.yaw), Math.cos(to.yaw - from.yaw)), { span, dur } = moveDuration(from, to);
    this.tw = new CamMove(from, this.camVel, { ...to, yaw: from.yaw + dYaw }, dur, clamp(span * 0.18, 0, 0.45)); this.tw.t0 = this.t;
    this.goal = to;
  }
  /** Frame a world point seen from direction `dir` (unit vector from the point toward the eye) at distance `dist`, and stay there. */
  frameSite(p, dir, dist = 0.62) {
    const d = vec3.norm(dir), pitch = clamp(Math.asin(d[1]), 0.35, 1.45), yaw = Math.atan2(d[0], d[2]);
    const from = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: [...this.target] }, dYaw = Math.atan2(Math.sin(yaw - from.yaw), Math.cos(yaw - from.yaw));
    this.auto = false; this.returnAt = null; this.view = 'site';
    const to = { yaw: from.yaw + dYaw, pitch, dist, target: [...p] };
    this.tw = new CamMove(from, this.camVel, to, Math.max(1.2, moveDuration(from, to).dur), 0.15); this.tw.t0 = this.t;
    this.goal = { yaw, pitch, dist, target: [...p] };
  }
  /** World position and outward skin normal of a named site (landmark or chest site 'R_mal5'), realistic body only. */
  siteFrame(key) {
    const B = this.body; if (!B) return null;
    if (this.procSites?.[key]) return this.procSites[key];
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
  /** Nearest point of the skin to a world point, with its outward normal (realistic body; the point itself otherwise). */
  surfaceAt(p) {
    const B = this.body; if (!B?.b?.glb) return { p, n: [0, 1, 0] };
    const m = B.b.meshes.body, s = B.b.scale, q = [(p[0] - CROWN_X) / s, (p[1] - BED_TOP) / s, p[2] / s];
    let best = 0, bd = Infinity;
    for (let v = 0, n = m.pos.length / 3; v < n; v++) { const dx = m.pos[v * 3] - q[0], dy = m.pos[v * 3 + 1] - q[1], dz = m.pos[v * 3 + 2] - q[2], d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = v; } }
    return { p: [CROWN_X + m.pos[best * 3] * s, BED_TOP + m.pos[best * 3 + 1] * s, m.pos[best * 3 + 2] * s], n: [m.nrm[best * 3], m.nrm[best * 3 + 1], m.nrm[best * 3 + 2]] };
  }
  /** Sites of the procedures that have no landmark of their own, found on this patient's skin (right side unless stated):
   *  ioR - proximal tibia, 1-2 cm medial to the shin crest, about a quarter of the stature above the sole;
   *  wristR - radial artery at the wrist, thumb side (the arm lies palm up, so the thumb points to the head);
   *  ijvR - internal jugular, apex of the sternocleidomastoid triangle; scvR - subclavian, below the clavicle at mid-clavicle;
   *  femR - femoral vein, just medial to the artery; subxiph - just below and left of the xiphoid; nostril - right nostril.
   *  Proportions are anatomical rules of thumb (design values). */
  _procSites() {
    const B = this.body, W = this.world, R = this.sideSign || 1, glb = !!B.b.glb, sk = (p, above = 0.03) => glb ? this.surfaceAt([p[0], p[1] + above, p[2]]) : { p, n: [0, 1, 0] };
    const s = B.b.scale || 1, sole = glb ? CROWN_X + B.bFrame.cprRef[3] * s : W.femoral[0] - 0.85, H = CROWN_X - sole;
    const out = {};
    { const x = sole + 0.25 * H; let best = null;                                        // shin crest: highest skin point of the right leg at that level
      const P = glb ? B.b.meshes.body.pos : null;
      if (P) for (let i = 0; i < P.length; i += 3) { const w = [CROWN_X + P[i] * s, BED_TOP + P[i + 1] * s, P[i + 2] * s]; if (Math.abs(w[0] - x) < 0.012 && w[2] * R > 0.03 && (!best || w[1] > best[1])) best = w; }
      const c = best || [x, BED_TOP + 0.1, R * 0.1]; out.ioR = sk([c[0], c[1], c[2] - Math.sign(c[2]) * 0.014], 0.02); }
    { const ax = this.armAxis(), perp = [-ax[2], 0, ax[0]], k = perp[0] >= 0 ? 1 : -1, w = vec3.add(W.rightArmIV, vec3.scale(ax, 0.146 * H));
      out.wristR = sk(vec3.add(w, vec3.scale(perp, k * 0.012)), 0.04); }
    out.ijvR = sk([W.neck[0] - 0.025, W.neck[1], W.neck[2] + R * 0.035]);
    { const c = this.chestSites.R.mcl2; out.scvR = sk([c[0] + 0.035, c[1], c[2] - R * 0.01]); }
    out.femR = sk([W.femoral[0], W.femoral[1], W.femoral[2] - Math.sign(W.femoral[2] || R) * 0.01]);
    { const xx = glb ? CROWN_X + B.bFrame.ref[0] * s : W.sternum[0] - 0.08; out.subxiph = sk([xx - 0.025, W.sternum[1], W.sternum[2] - R * 0.008]); }
    out.nostril = sk([W.airway[0] + 0.025, W.airway[1] + 0.01, W.airway[2] + R * 0.007], 0.02);
    return out;
  }
  /** Direction of the right forearm on its board, from the antecubital fossa toward the hand. */
  armAxis() { const a = this.world.rightArmIV, b = this.world.padRight, d = [a[0] - b[0], 0, a[2] - b[2]], l = Math.hypot(d[0], d[2]) || 1; return [d[0] / l, 0, d[2] / l]; }
  /** The operator's eye for a site: at the head of the bed for the face, neck and airway, otherwise standing at the patient's
   *  side nearest the site (the right side, by the IV arm, for midline sites), eyes about 1.55 m high, looking down at it. */
  operatorEye(key, p) {
    if (['face', 'airway', 'nostril'].includes(key)) return [p[0] + 0.5, 1.48, p[2] + 0.05];
    if (key === 'ijvR') return [p[0] + 0.12, p[1] + 0.5, p[2] + (this.sideSign || 1) * 0.38];   // the operator works from the head: watch from beside the right shoulder, clear of their forearm
    if (key === 'neck') return [p[0] - 0.04, p[1] + 0.55, p[2] - 0.22];          // from the right shoulder, looking down at the front of the neck: from the head the chin, a face mask and the sheet hide it
    const side = key.startsWith('L_') || key === 'padLeft' || key === 'leftArm' ? 1 : key.startsWith('R_') || key === 'rightArmIV' || key === 'padRight' || key === 'femoral' ? -1 : (p[2] > 0.03 ? 1 : -1);
    const reach = key === 'rightArmIV' ? 0.32 : 0.5;                          // the arm board already brings the forearm out to the operator
    return [p[0] - 0.12, 1.55, p[2] + side * reach];
  }
  /** Frame the site of an upcoming procedure step from the operator's viewpoint, close enough for the hand and instrument to fill the view. */
  frameStepSite(key, dist = 0.62) {
    const f = this.siteFrame(key); if (!f) return false;
    const eye = this.operatorEye(key, f.p), d = vec3.sub(eye, f.p), L = Math.hypot(...d);
    const narrow = this.canvas.clientWidth < 600 ? 1.3 : 1;                    // phones: the free band is narrow, step back so the site keeps some context
    this.frameSite(f.p, vec3.scale(d, 1 / L), Math.min(dist * narrow, L)); return true;
  }
  /** Site key of an engine event, for the operator's viewpoint during its gesture. */
  _eventSite(ev) {
    switch (ev.type) {
      case 'drug.bolus': case 'bicarb.bolus': case 'iv.access': return 'rightArmIV';
      case 'procedure.needle_decompression': return `${ev.side || 'R'}_${ev.site || 'mcl2'}`;
      case 'procedure.chest_tube': return `${ev.side || 'R'}_mal5`;
      case 'procedure.cricothyroidotomy': case 'exam.neck': return 'neck';
      case 'airway.intubate': return 'airway';
      case 'io.access': return 'ioR';
      case 'procedure.arterial_line': return 'wristR';
      case 'procedure.central_line': return { ijv: 'ijvR', scv: 'scvR', fem: 'femR' }[ev.site] || 'ijvR';
      case 'procedure.pericardiocentesis': return 'subxiph';
      case 'procedure.ng_tube': return 'nostril';
      case 'exam.chest': case 'exam.pocus': return 'sternum';
      default: return null;
    }
  }
  /** Frame a site for an action, then glide back to the overview of the patient after holdS seconds. */
  focus(name, holdS = 2.5) { this.setCamera(name); this.returnAt = this.t + (this.tw ? this.tw.dur : 0) + holdS; }

  /** Joints for the waking movements (wake-anim.js), from this patient's mesh: the left shoulder pivot and the arm's direction
   *  (upper arm ~42 % of shoulder-to-fingertip), the hip at the groin crease and the knee a femur below it (~24.5 % of stature). */
  _jointFrame(F, P, ls) {
    const cr = F.axes.slice(0, 3), an = F.axes.slice(3, 6), lf = F.axes.slice(6, 9), d3 = (a, i) => a[0] * P[i] + a[1] * P[i + 1] + a[2] * P[i + 2];
    const hwid = F.cprRef[2], mid = F.ref[2]; let top = -Infinity, tip = null;
    for (let i = 0; i < P.length; i += 3) { const lat = d3(lf, i) - mid; if (lat < hwid + 0.03) continue; const c = d3(cr, i); if (c > top) top = c; if (!tip || c < tip[0]) tip = [c, d3(an, i), lat]; }
    if (!tip) return;
    let n = 0, sa = 0, sl = 0; for (let i = 0; i < P.length; i += 3) { const lat = d3(lf, i) - mid; if (lat < hwid + 0.03 || d3(cr, i) < top - 0.05) continue; n++; sa += d3(an, i); sl += lat; }
    const S = [top - 0.035, sa / n, sl / n], toMesh = (c, a, l) => [0, 1, 2].map(j => cr[j] * c + an[j] * a + lf[j] * (l + mid));
    const s0 = toMesh(...S), t0 = toMesh(...tip), D = vec3.sub(t0, s0), L = Math.hypot(...D);
    F.arm = [...s0, 0.42 * L]; F.armD = [...vec3.scale(D, 1 / L), 0];
    const hip = ls.femoral[0] * cr[0] + ls.femoral[1] * cr[1] + ls.femoral[2] * cr[2], knee = hip - 0.245 * -F.cprRef[3];
    const depth = (lvl) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < P.length; i += 3) { if (Math.abs(d3(cr, i) - lvl) > 0.02 || Math.abs(d3(lf, i) - mid) > hwid - 0.02) continue; const a = d3(an, i); lo = Math.min(lo, a); hi = Math.max(hi, a); } return lo < hi ? (lo + hi) / 2 : 0.08; };
    F.leg = [hip, knee, depth(hip), depth(knee)];
  }
  /** A world point on the body, carried by the waking movements (things attached to the head, the left arm or a leg).
   *  j: [left arm, left leg, right leg] membership; the head moves by position. */
  moved(w, j) {
    const B = this.body, U = this._moveU; if (!B?.b?.glb || !U) return w;
    const s = B.b.scale, q = movePoint([(w[0] - CROWN_X) / s, (w[1] - BED_TOP) / s, w[2] / s], U, j);
    return [CROWN_X + q[0] * s, BED_TOP + q[1] * s, q[2] * s];
  }
  /** Pupil examination: hold the lids open and shine a penlight (display only; the UI logs it as a note and reports the finding). */
  checkPupils() {
    this.pupilCheck = { t0: this.t, dur: 3.4 };
    if (this.eyeC) { this.frameSite(this.eyeC, [-0.3, 0.95, 0], 0.3); this.returnAt = this.t + (this.tw ? this.tw.dur : 1.4) + 3.6; } else this.focus('head', 3.6);   // close over the face, upright
  }
  /** An engine action happened: play the matching hand gesture, frame it, then return to the overview. */
  gesture(ev, res) {
    const cam = this.gest.start(this, ev, res); if (!cam) return;
    const g = this.gest.list[this.gest.list.length - 1], hold = (g ? g.dur : 2) + 1.2, key = this._eventSite(ev);
    if (key && this.frameStepSite(key, ev.type === 'airway.intubate' ? 0.7 : 0.58)) this.returnAt = this.t + 1.4 + hold; else this.focus(cam, hold);
  }
  /** A guided-procedure step without an engine gesture of its own: frame the site and play a generic hand gesture. */
  stepGesture(kind, cam, site) {
    const g = kind ? this.gest.startStep(this, kind, site) : null, hold = (g ? g.dur : 1.5) + 1.2;
    const chest = Object.entries(this.chestSites || {}).flatMap(([sd, o]) => Object.entries(o).map(([k, v]) => [`${sd}_${k}`, v]));
    const key = site && [...Object.entries(this.world || {}), ...chest].find(([, v]) => v === site)?.[0];
    if (key && this.frameStepSite(key, 0.58)) this.returnAt = this.t + 1.4 + hold; else this.focus(cam || 'default', hold);
  }
  /** World point of a named site for guided steps: face, chest, neck, arm, or chestSite (needle/drain site from side + site). */
  siteOf(at, prm = {}) {
    const W = this.world; if (!W) return null;
    if (at === 'chestSite') { const s = this.chestSites?.[prm.side || 'R']; return s ? (s[prm.site] || s.mal5) : W.sternum; }
    return { face: W.face, chest: W.sternum, neck: W.neck, arm: W.rightArmIV, groin: W.femoral, abdomen: W.abdomen }[at] || null;
  }

  /** (Re)build the patient mesh for a body spec. */
  /** Load the realistic patient once; until it arrives (or if it fails) the procedural body is used. */
  async loadPatientAsset(base = '/assets/') {
    try {
      const [buf, meta] = await Promise.all([fetch(base + 'patient.glb').then(r => { if (!r.ok) throw new Error('patient.glb ' + r.status); return r.arrayBuffer(); }), fetch(base + 'patient.json').then(r => r.json())]);
      const glb = parseGlb(buf), imgs = await decodeImages(glb), r = this.r, tex = {};
      const texFor = (mat, key) => { const i = glb.texImage(mat?.[key]?.index ?? mat?.pbrMetallicRoughness?.[key]?.index); return i != null && imgs[i] ? r.imageTexture(imgs[i]) : null; };
      for (const [name, m] of Object.entries(glb.meshes)) tex[name] = { albedo: texFor(m.material, 'baseColorTexture'), normal: m.material?.normalTexture ? texFor(m.material, 'normalTexture') : null };
      // female skin (finer brows and lips on the same UVs), baked by assets-src/build_patient.py; optional
      const fb = await fetch(base + 'patient_albedo_female.jpg').then(x => (x.ok ? x.blob() : null)).catch(() => null);
      const fimg = fb && typeof createImageBitmap === 'function' ? await createImageBitmap(fb).catch(() => null) : null;
      if (fimg) tex.patient_body_female = { albedo: r.imageTexture(fimg), normal: tex.patient_body?.normal };
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
      // gloved hands posed in each instrument's frame (assets/hands.glb, optional)
      const hb = await fetch(base + 'hands.glb').then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
      if (hb) { const hg = parseGlb(hb), hands = {}; for (const [name, m] of Object.entries(hg.meshes)) hands[name] = m.prims.map(pr => { const f = pr.material?.pbrMetallicRoughness?.baseColorFactor || [0.23, 0.44, 0.85, 1], sleeve = /sleeve/i.test(pr.material?.name || '');
          const key = (k) => { const i = pr.targetNames.indexOf(k); return i >= 0 ? pr.targets[i]?.pos || null : null; }, face = HAND_KEYS.map(key);   // finger movements (act, relax)
          return { g: this.r.upload({ pos: pr.pos, nrm: pr.nrm, w: new Float32Array(pr.pos.length / 3 * 2), idx: pr.idx, face: face.some(Boolean) ? [...face, null, null] : null }), color: f.slice(0, 3), sleeve, pos: sleeve ? pr.pos : null }; });
        for (const h of Object.values(hands)) {                                   // which way the forearm leaves the hand, across the instrument axis (+Y): lets a gesture bring the arm from the operator
          let x = 0, z = 0; for (const pt of h) if (pt.pos) for (let i = 0; i < pt.pos.length; i += 3) { x += pt.pos[i]; z += pt.pos[i + 2]; }
          const l = Math.hypot(x, z); h.fa = l > 1e-6 ? Math.atan2(z / l, x / l) : null;
          h.cuff = sleeveEnd(h.filter(pt => pt.pos).map(pt => pt.pos)); for (const pt of h) delete pt.pos;   // where the sleeve ends up the forearm (a CPR rescuer's arm carries on from there)
        }
        this.hands = hands; }
      // the two CPR rescuers (assets/rescuer.glb, optional): textured like the patient, two arm poses each ('cpr': down to the hands,
      // 'idle': at the sides), COLOR_0 = how much each vertex follows the trunk and the head when they bend (rescuer.json: joints)
      const [rb, rj] = await Promise.all([fetch(base + 'rescuer.glb').then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null), fetch(base + 'rescuer.json').then(r => (r.ok ? r.json() : null)).catch(() => null)]);
      if (rb && rj?.people) {
        const rg = parseGlb(rb), rimgs = await decodeImages(rg), cache = new Map(), people = {};
        const texOf = (info) => { const i = info ? rg.texImage(info.index) : null; if (i == null || !rimgs[i]) return null; if (!cache.has(i)) cache.set(i, this.r.imageTexture(rimgs[i])); return cache.get(i); };
        for (const [name, m] of Object.entries(rg.meshes)) {
          const [, who, variant, part] = name.split('_'); if (!rj.people[who] || !m.pos?.length) continue;
          const n = m.pos.length / 3, jw = new Float32Array(n * 3).fill(1);
          if (m.color) for (let i = 0; i < n; i++) { jw[i * 3] = m.color.data[i * m.color.size]; jw[i * 3 + 1] = m.color.data[i * m.color.size + 1]; jw[i * 3 + 2] = 0; }
          const mat = m.material, P = (people[who] ||= { meta: rj.people[who], cpr: [], idle: [] });
          (P[variant] || (P[variant] = [])).push({ part, g: this.r.upload({ pos: m.pos, nrm: m.nrm, uv: m.uv, w: new Float32Array(n * 2), idx: m.idx, jw }),
            color: (mat?.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1]).slice(0, 3), albedo: texOf(mat?.pbrMetallicRoughness?.baseColorTexture), normal: texOf(mat?.normalTexture) });
        }
        this.rescuers = ['m', 'f'].map(k => people[k]).filter(Boolean);
      }
    } catch (e) { console.warn('instruments unavailable:', e && e.message); }
  }
  /** Ray-pick the realistic body's skin: { p, n, region } in world space, or null (also null with the procedural body). */
  pickBody(cx, cy) {
    const B = this.body; if (!B?.b?.glb || !this.r.invVP) return null;
    if (!B.pick) B.pick = preparePick(B.b.meshes.body);
    const ray = this.r.rayFromClient(cx, cy), s = B.b.scale, T = [CROWN_X, BED_TOP, 0], U = this.bendU, m = B.b.meshes.body;
    const ro = ray.origin, o = [(ro[0] - T[0]) / s, (ro[1] - T[1]) / s, (ro[2] - T[2]) / s];
    if (!(U && U[2])) {
      const h = rayMesh({ o, d: ray.dir }, B.pick); if (!h) return null;
      return { p: [T[0] + h.p[0] * s, T[1] + h.p[1] * s, T[2] + h.p[2] * s], n: h.n, region: m.region[h.vert] };
    }
    // head of the bed raised: pick on the body as drawn (bent), then give back the same point of the flat body, like every other site
    if (B.pickBentKey !== U.join()) {
      const P = m.pos, Q = new Float32Array(P.length);
      for (let i = 0; i < P.length; i += 3) { const w = bendPoint([T[0] + P[i] * s, T[1] + P[i + 1] * s, T[2] + P[i + 2] * s], U); Q[i] = (w[0] - T[0]) / s; Q[i + 1] = (w[1] - T[1]) / s; Q[i + 2] = (w[2] - T[2]) / s; }
      B.pickBent = preparePick({ ...m, pos: Q }); B.pickBentKey = U.join();
    }
    const h = rayMesh({ o, d: ray.dir }, B.pickBent); if (!h) return null;
    const Q = B.pickBent.pos, P = m.pos, ix = [0, 1, 2].map(k => m.idx[h.tri * 3 + k] * 3), V = (A, i) => [A[i], A[i + 1], A[i + 2]];
    const [a, b, c] = ix.map(i => V(Q, i)), v0 = vec3.sub(b, a), v1 = vec3.sub(c, a), v2 = vec3.sub(h.p, a);   // barycentric coordinates on the bent triangle
    const d00 = vec3.dot(v0, v0), d01 = vec3.dot(v0, v1), d11 = vec3.dot(v1, v1), d20 = vec3.dot(v2, v0), d21 = vec3.dot(v2, v1), den = d00 * d11 - d01 * d01 || 1;
    const bv = (d11 * d20 - d01 * d21) / den, bw = (d00 * d21 - d01 * d20) / den, bu = 1 - bv - bw;
    const q = [0, 1, 2].map(j => bu * P[ix[0] + j] + bv * P[ix[1] + j] + bw * P[ix[2] + j]), p = [T[0] + q[0] * s, T[1] + q[1] * s, T[2] + q[2] * s];
    return { p, n: turnDir(h.n, -U[2] * bendWeight(p, U)), region: m.region[h.vert] };
  }
  /** Pump screen i as a texture (a small canvas redrawn only when what it shows changes): drug, rate in mL/h, volume left;
   *  green on black while running, flashing amber near the end of the syringe, grey when stopped. */
  _pumpScreen(i, s, T) {
    if (typeof document === 'undefined') return null;
    const slot = (this._pumpScr ||= [])[i] || (this._pumpScr[i] = (() => { const c = document.createElement('canvas'); c.width = 256; c.height = 128; return { c, tex: null, key: '' }; })());
    const flash = s.tone === 'end' && (T % 1) < 0.5, key = s.lines.join('|') + s.tone + flash;
    if (key !== slot.key) {
      const g = slot.c.getContext('2d'); slot.key = key;
      g.fillStyle = flash ? '#5a3400' : '#030806'; g.fillRect(0, 0, 256, 128);
      const fg = s.tone === 'stop' ? '#7d8a86' : s.tone === 'end' ? '#ffb020' : '#36e08a';
      g.fillStyle = fg; g.textBaseline = 'middle'; g.textAlign = 'left';
      g.font = 'bold 24px system-ui, sans-serif'; g.fillText(s.lines[0], 12, 22);
      g.font = 'bold 46px system-ui, sans-serif'; g.fillText(s.lines[1], 12, 68);
      g.font = '22px system-ui, sans-serif'; g.fillText(s.lines[2], 12, 109);
      if (!slot.tex) slot.tex = this.r.createTexture(slot.c); else this.r.updateTexture(slot.tex, slot.c);
    }
    return slot.tex;
  }
  /** The CPR rescuers (rescuer-anim.js): the compressor on a step stool with straight arms down to the gloved hands on the chest,
   *  the next one ready beside the bed, and the walk when they switch. R: { ra, cp, eB, eT, rB, rT, sleeve, glove } from draw(). */
  _drawRescuers(R) {
    const r = this.r, fr = this.g, people = this.rescuers, { ra, cp } = R, mid = (a, b) => a.map((v, i) => (v + b[i]) / 2);
    // the compressor's elbows go where the gown sleeves of the gloved hands end (arm and hand join); the feet then stand on a step stool
    this._em = this._em || {};                                                    // each one's hands-on elbow point, kept for the frames their hands are off
    for (const [i, e] of Object.entries(R.em || {})) this._em[i] = e;
    const emOf = (i) => R.em?.[i] || this._em[i] || this._em[ra.who] || [cp[0], cp[1] + 0.38, cp[2] - 0.23];
    const atC = (m, i = ra.who) => { const em = emOf(i), e = mid(m.elbowL, m.elbowR); return [em[0] - e[0], clamp(em[1] - e[1], 0, 0.55), em[2] - e[2]]; };
    const C0 = atC(people[ra.who % people.length].meta);
    this._stool = this._stool == null ? C0[1] : this._stool + (C0[1] - this._stool) * 0.08;   // one stool: its height follows whoever is on it
    const Rz = Math.min(C0[2], -0.55) - 0.35, spot = (k, m, i) => (k === 'C' ? atC(m, i) : k === 'R0' ? [cp[0] - 0.8, 0, Rz] : [Math.min(cp[0] + 0.8, 1.2), 0, Rz]);
    const face = (k, m) => (k === 'C' ? 0 : Math.atan2(cp[0] - spot(k, m)[0], cp[2] - spot(k, m)[2]) * 0.8);   // (the waiting places do not depend on who)
    const H = this._stool;
    if (H > 0.04) {                                                               // step stool: grey top, dark feet
      r.draw(fr.ub, mat4.multiply(mat4.translation(C0[0], H - 0.015, C0[2] + 0.02), mat4.scaling(0.5, 0.03, 0.36)), { color: [0.55, 0.58, 0.62], spec: 0.3 });
      r.draw(fr.ub, mat4.multiply(mat4.translation(C0[0], (H - 0.03) / 2, C0[2] + 0.02), mat4.scaling(0.46, H - 0.03, 0.32)), { color: [0.3, 0.32, 0.35], spec: 0.2 });
    }
    ra.people.forEach((q, i) => {
      const who = people[i % people.length], m = who.meta, A = spot(q.from, m, i), Bq = spot(q.to, m, i), u = q.u;
      const pos = [A[0] + (Bq[0] - A[0]) * u, 0, A[2] + (Bq[2] - A[2]) * u];
      pos[1] = q.from === 'C' && q.to !== 'C' ? A[1] * (1 - smooth01(0, 0.35, u)) : q.to === 'C' && q.from !== 'C' ? Bq[1] * smooth01(0.65, 1, u) : A[1];
      pos[1] += 0.025 * Math.abs(Math.sin(u * Math.PI * 3)) * (q.from !== q.to ? 1 : 0);     // steps
      // a person, not a statue: the trunk tips with each push (the elbows following the hands), breathing, effort, weight shifts
      const pushing = q.role === 'push' && q.hands > 0, el = mid(m.elbowL, m.elbowR);   // the arms on the chest for as long as the hands are
      const pose = posture(q, R.drops?.[i] ?? 0, el[2] - m.hip[2], ra.t, i * 1.7), F = rescuerFlex(m, pose);
      const yaw = face(q.from, m) + (face(q.to, m) - face(q.from, m)) * u, M = mat4.multiply(mat4.translation(...pos), mat4.multiply(mat4.rotationY(yaw), mat4.rotationZ(pose.sway)));
      // arms on the chest (the 'cpr' model) or down (the 'idle' one): the two models cross-fade over 0.3 s instead of swapping in one frame
      this._armMix ??= []; this._armT ??= ra.t; const want = pushing ? 1 : 0, dtm = Math.max(0, Math.min(0.1, ra.t - this._armT));
      const mix = this._armMix[i] = this._armMix[i] == null ? want : this._armMix[i] + Math.sign(want - this._armMix[i]) * Math.min(Math.abs(want - this._armMix[i]), dtm / 0.3);
      const look = (pt, a) => ({ flex: F, ...RESCUER_LOOK[pt.part], ...(pt.part === 'skin' && m.skinTint ? { color: m.skinTint } : {}), ...(pt.albedo ? { albedo: pt.albedo } : {}), ...(pt.normal ? { normalMap: pt.normal } : {}), ...(a < 1 ? { alpha: a, noShadow: true } : {}) });
      // the new pose is drawn solid and the old one fades over it: where the two bodies overlap the old one is hidden behind the
      // solid surface, so only its arms are seen fading (a whole translucent body looked like a ghost)
      const [now, old, left] = want ? [who.cpr, who.idle, 1 - mix] : [who.idle, who.cpr, mix];
      for (const pt of now) r.draw(pt.g, M, look(pt, 1));
      if (left > 0.001) for (const pt of old) r.draw(pt.g, M, look(pt, left));
    });
    this._armT = ra.t;
  }
  /** The third rescuer (rescuer-anim.js bagger): standing at the head of the bed facing the feet, the elbows where the sleeves of
   *  the two gloved hands end (mask and bag), looking down at the chest, a green gown so the team can be told apart. */
  _drawBagger(B, t) {
    const r = this.r, who = this.rescuers[0], m = who.meta, el = [(m.elbowL[0] + m.elbowR[0]) / 2, (m.elbowL[1] + m.elbowR[1]) / 2, (m.elbowL[2] + m.elbowR[2]) / 2];
    const pos = [B.e[0] + el[2], clamp(B.e[1] - el[1], 0, 0.3), B.e[2] - el[0]];   // turned to face the feet (-x): the local front (+z) becomes -x
    const q = { role: 'push', hands: 1, lift: 0, base: [0.06, 0.2], fatigue: 0, effort: 0.15 + 0.2 * B.sq };
    const pose = posture(q, 0, el[2] - m.hip[2], t, 4.1), F = rescuerFlex(m, pose);
    if (pos[1] > 0.04) r.draw(this.g.ub, mat4.multiply(mat4.translation(pos[0], pos[1] / 2, pos[2]), mat4.scaling(0.36, pos[1], 0.5)), { color: [0.3, 0.32, 0.35], spec: 0.2 });   // a step if the bed is high
    const M = mat4.multiply(mat4.translation(...pos), mat4.multiply(mat4.rotationY(-Math.PI / 2), mat4.rotationZ(pose.sway)));
    for (const pt of who.cpr) r.draw(pt.g, M, { flex: F, ...RESCUER_LOOK[pt.part], ...(BAGGER_TINT[pt.part] ? { color: BAGGER_TINT[pt.part] } : {}), ...(pt.albedo ? { albedo: pt.albedo } : {}), ...(pt.normal ? { normalMap: pt.normal } : {}) });
  }
  /** Draw one instrument with its working point at p, long axis along n, turned by angle about n. */
  _instrument(name, p, n, angle = 0, opts = {}) {
    const parts = this.instruments?.[name] || []; if (!parts.length && !this.hands?.['hand_' + name]) return;   // a hand alone ('press') is fine
    const ey = vec3.norm(n), ref = Math.abs(ey[0]) > 0.9 ? [0, 0, 1] : [1, 0, 0];
    let ex = vec3.norm(vec3.cross(ref, ey)); const ez0 = vec3.cross(ex, ey);
    const hand = opts.noHand ? null : this.hands?.['hand_' + name];             // the gloved hand holding it, same frame
    const hf = this.hands?.['hand_' + name]?.fa;
    if (opts.toward && hf != null) {                                             // turn about the axis so the forearm points toward the operator (angle adds the wrist roll)
      const t = opts.toward, k = vec3.dot(t, ey), tp = [t[0] - ey[0] * k, t[1] - ey[1] * k, t[2] - ey[2] * k];
      if (Math.hypot(...tp) > 0.2) angle += Math.atan2(vec3.dot(tp, ez0), vec3.dot(tp, ex)) - hf;
    }
    ex = vec3.norm(vec3.add(vec3.scale(ex, Math.cos(angle)), vec3.scale(ez0, Math.sin(angle)))); const ez = vec3.cross(ex, ey);
    const M = mat4.fromBasis(ex, ey, ez, p);
    // nitrile glove (satin rubber, textured fingertips, a little translucent) and the cotton gown sleeve
    const fw = opts.act || opts.relax ? [opts.act || 0, opts.relax || 0, 0, 0] : undefined;   // finger movements (hands.glb morph targets)
    if (hand) for (const pt of hand) this.r.draw(pt.g, M, pt.sleeve ? { color: opts.sleeve || pt.color, spec: 0.05, pattern: 5, face: fw } : { color: pt.color, spec: 0.32, pattern: 8, face: fw });
    for (const pt of parts) { if (opts.only && !opts.only.includes(pt.mat)) continue; if (opts.skip && opts.skip.includes(pt.mat)) continue; this.r.draw(pt.g, M, { color: pt.color, alpha: pt.alpha, spec: pt.metal > 0.5 ? 0.95 : 0.4, noShadow: pt.alpha < 0.9 }); }
    return M;
  }

  setPatient(spec, tone = this.tone) {
    const r = this.r;
    if (this.body) for (const g of Object.values(this.body.g)) r.release(g);
    const morph = morphology({ sex: spec.sex, age: spec.age, heightCm: spec.heightCm, weightKg: spec.weightKg });
    let b, g, M;
    if (this.asset) {
      b = buildGlbBody(this.asset.glb, this.asset.meta, spec, morph);
      if (b.meshes.sheet) b.meshes.sheet = drapeWeights(b.meshes.sheet, b.meshes.body);   // the sheet rises with the belly under it
      for (const [k, m] of Object.entries(b.meshes)) if (m.region && m.idx) m.jw = jointWeights(m, k === 'sheet');   // waking movements: which limb each vertex follows
      g = Object.fromEntries(Object.entries(b.meshes).map(([k, m]) => [k, r.upload(m)]));
      M = mat4.multiply(mat4.translation(CROWN_X, BED_TOP, 0), mat4.scaling(b.scale, b.scale, b.scale));
    } else {
      b = buildBody(morph);
      g = { skin: r.upload(b.skin), hair: r.upload(b.hair), eyes: r.upload(b.eyes), pupils: r.upload(b.pupils), lips: r.upload(b.lips), sheet: r.upload(b.sheet) };
      M = supineMatrix(b);
    }
    this.body = { b, g, M, spec, bFrame: breathFrame(b.landmarks, b.glb ? [0, 1, 0] : [0, 0, 1]) }; this.cut = null; this.skinAnim = new SkinAnim(); this._skinT = null; this.pupilAnim = new PupilAnim(); this._pupT = null; this.pupilCheck = null; this.wakeAnim = new WakeAnim(); this.bedAnim = new BedAnim(); this._bedT = null;
    { const F = this.body.bFrame, P = b.meshes?.body?.pos; if (P) { let lo = Infinity; for (let i = 0; i < P.length; i += 3) lo = Math.min(lo, P[i] * F.axes[0] + P[i + 1] * F.axes[1] + P[i + 2] * F.axes[2]); F.cprRef[3] = lo; } }   // soles level (skin: feet, knees)
    if (b.glb) this._jointFrame(this.body.bFrame, b.meshes.body.pos, b.landmarks);
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
    this.procSites = this._procSites();
    { const R = this.sideSign || 1, s = b.scale || 1, toL = (w) => [(w[0] - CROWN_X) / s, (w[1] - BED_TOP) / s, w[2] / s];   // where blood comes from (blood.js)
      const th = b.glb ? this.surfaceAt([this.world.femoral[0] - 0.14, this.world.femoral[1] + 0.03, this.world.femoral[2] + R * 0.02]) : null;
      this.bloodSites = th ? { thighW: th.p, thighN: th.n, thighL: toL(th.p), sheetL: toL([th.p[0], th.p[1] + 0.035, th.p[2]]), mouthL: ls.airway, mouthW: this.world.airway, s } : null; }
    { const E = b.meshes?.eyes?.pos; if (E) { let c = [0, 0, 0]; for (let i = 0; i < E.length; i += 3) for (let j = 0; j < 3; j++) c[j] += E[i + j]; this.eyeC = localToWorld(this.body.M, c.map(v => v / (E.length / 3))); } else this.eyeC = this.world.face; }
    // floating markers: the parts of the patient you act on, and the equipment in the bay
    this.pins = [
      ...this.hot.filter(h => PIN_PATIENT.has(h.id)).map(h => ({ id: h.id, label: h.label, pos: [h.c[0], h.c[1] + 0.14, h.c[2]], h })),
      ...EQUIP.map((e, i) => ({ id: e.id, label: e.label, pos: e.pin, h: this.equip[i] })),
    ];
  }

  _bindInput(c) {
    // The camera is driven by the game (setCamera / focus / frameSite); the pointer only hovers and clicks.
    c.addEventListener('pointermove', e => { this.hover = this.pick(e.clientX, e.clientY); });
    c.addEventListener('pointerup', e => { if (this.onHotspot) { const h = this.pick(e.clientX, e.clientY); if (h) this.onHotspot(h, e); } });
    c.addEventListener('pointerleave', () => { this.hover = null; });
    c.addEventListener('wheel', e => { e.preventDefault(); }, { passive: false });
  }
  pick(cx, cy) {
    if (!this.hot || !this.r.invVP) return null;
    const ray = this.r.rayFromClient(cx, cy);
    for (const list of [this.hot, this.equip]) {              // the patient wins over equipment standing behind or in front of it
      let best = null, bt = 1e9;
      for (const h of list) { const t = raySphere(ray, h.equip ? h.c : this.bent(h.c), h.rad); if (t !== null && t < bt) { bt = t; best = h; } }
      if (best) return best;
    }
    return null;
  }
  /** Where a point on the bed or the patient is drawn now (head of the bed raised: bed.js); off the bed, unchanged. */
  bent(p) { const U = this.bendU; return U && p[0] < 1.2 ? bendPoint(p, U) : p; }
  /** World point -> CSS pixels on the canvas (null when behind the camera). */
  project(p) {
    const m = this.r.vp, [x, y, z] = this.bent(p);
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
    // bags on the pole and their drip (drip.js): each bag empties as the engine runs it in, drops fall in the drip chamber
    const dr = this.drip.update(p); this._dripNow = dr;
    P.b(px + 0.07, 1.3, pz + 0.052, 0.09, 0.05, 0.008, { color: [0.05, 0.08, 0.08], emissive: dr.fluid || dr.blood ? [0.1, 0.8, 0.4] : [0.05, 0.2, 0.2] });   // pump display
    const tube = (a, c, b, rad, col, o = {}) => { let prev = a; for (let i = 1; i <= 10; i++) { const k = i / 10, q = [0, 1, 2].map(j => (1 - k) * (1 - k) * a[j] + 2 * (1 - k) * k * c[j] + k * k * b[j]), d = vec3.sub(q, prev), L = Math.hypot(...d) || 1e-6, ey = d.map(x => x / L), up = Math.abs(ey[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0], ex = vec3.norm(vec3.cross(up, ey));
      r.draw(g.cyl, mat4.multiply(mat4.fromBasis(ex, ey, vec3.cross(ey, ex), prev.map((v, j) => (v + q[j]) / 2)), mat4.scaling(rad, L, rad)), { color: col, ...o }); prev = q; } };
    const pumpIn = [px + 0.07, 1.35, pz], clear = { alpha: 0.16, spec: 0.9, noShadow: true };
    P.b(px + 0.07, 1.985, pz, 0.42, 0.012, 0.012, { color: [0.7, 0.72, 0.75], spec: 0.4 });                                // hook bar across the top of the pole
    dr.bags.forEach((bg, i) => {
      const x = px + [0.1, -0.1, 0.24][i], k = Math.sqrt(bg.totalMl / 1000), hgt = 0.12 + 0.12 * k, w = 0.075 + 0.045 * k, top = 1.97, bot = top - hgt, fill = clamp(bg.leftMl / bg.totalMl, 0, 1), blood = bg.set === 'blood';
      if (fill > 0.004) { const lh = (hgt - 0.012) * fill; P.b(x, bot + 0.006 + lh / 2, pz, w - 0.012, lh, 0.006 + 0.012 * fill, { color: bg.color, alpha: blood ? 1 : 0.45, spec: blood ? 0.3 : 0.8, noShadow: !blood }); }
      P.b(x, top - hgt / 2, pz, w, hgt, 0.01 + 0.008 * fill, { color: [0.85, 0.9, 0.94], ...clear, alpha: 0.1, spec: 0.5 });                        // the PVC bag, flatter as it empties (after its contents: it is see-through)
      P.b(x, top + 0.004, pz, 0.03, 0.01, 0.012, { color: [0.85, 0.85, 0.85] });                                              // hanger
      P.c(x, bot - 0.014, pz, 0.006, 0.028, { color: [0.9, 0.9, 0.9], spec: 0.5 });                                           // port
      if (bg.set === 'spare') return;
      // drip chamber: a clear cylinder, fluid in its lower part, a drop forming at the nozzle and falling, or a stream
      const chT = bot - 0.03, chB = chT - 0.07, pool = chB + 0.026, nz = chT - 0.008;
      P.c(x, (chB + pool) / 2 + 0.001, pz, 0.0098, pool - chB, { color: bg.color, alpha: blood ? 0.9 : 0.5, spec: blood ? 0.3 : 0.8, noShadow: true });
      const d = bg.running ? dropAt(bg.dropsPerS, p.t) : null, dc = { color: bg.color, alpha: blood ? 0.95 : 0.7, spec: blood ? 0.3 : 1, noShadow: true };
      if (d?.stream) P.c(x, (nz + pool) / 2, pz, 0.0011, nz - pool, dc);
      else if (d) { const y = nz - d.y * (nz - pool), rd = 0.0024 * (d.y > 0 ? 1 : 0.4 + 0.6 * d.grow); r.draw(g.sph, mat4.multiply(mat4.translation(x, y - rd * 0.6, pz), mat4.scaling(rd, rd * 1.25, rd)), dc); }
      P.c(x, (chT + chB) / 2, pz, 0.011, 0.07, { color: [0.93, 0.96, 0.98], ...clear });                                     // the chamber itself, after what is inside
      // giving set down to the pump (bags beside the first join it through a Y-connector)
      tube([x, chB, pz], [x, chB - 0.18, pz + 0.04], i === 0 ? pumpIn : [pumpIn[0] + 0.01, pumpIn[1] + 0.08, pumpIn[2] + 0.005], 0.0022, ...(blood && fill > 0 ? [[0.42, 0.0, 0.02], { alpha: 0.95, spec: 0.3, noShadow: true }] : [[0.86, 0.93, 0.97], { alpha: 0.75, spec: 0.9, noShadow: true }]));
    });
    // syringe pumps clamped to the pole under the fluid pump (syringe.js): a 50 mL syringe each, the plunger pushed as the drug goes in
    const hc = (x0, x1, y, z, rad, o) => r.draw(g.cyl, mat4.multiply(mat4.translation((x0 + x1) / 2, y, z), mat4.multiply(mat4.rotationZ(Math.PI / 2), mat4.scaling(rad, Math.max(1e-4, x1 - x0), rad))), o);
    syringePumps(p).forEach((q, i) => {
      const cx = px + 0.15, y = 1.06 - i * 0.14, zf = pz + 0.035, ys = y + 0.04 + 0.017, L = 0.11, x0 = cx - 0.1, lf = L * q.ml / SYRINGE_ML, seal = x0 + lf;
      P.b(cx, y, pz, 0.26, 0.08, 0.12, { color: [0.88, 0.89, 0.9], spec: 0.3 });                                                                          // pump body
      P.b(cx - 0.02, ys - 0.006, zf, 0.2, 0.01, 0.04, { color: [0.7, 0.72, 0.75], spec: 0.3 });                                                            // syringe cradle
      P.b(cx + 0.065, y - 0.004, pz + 0.0605, 0.106, 0.056, 0.003, { color: [0.05, 0.06, 0.07], spec: 0.5 });                                         // screen bezel
      const sc = this._pumpScreen(i, pumpScreen(q, drugName(q.drug, q.drug[0].toUpperCase() + q.drug.slice(1)), { left: tr('pump_left'), end: tr('pump_end'), stop: tr('pump_stop') }), T);
      if (sc) r.drawQuad(sc, mat4.multiply(mat4.translation(cx + 0.065, y - 0.004, pz + 0.0625), mat4.scaling(0.096, 0.048, 1)), 1);                      // the rate, as the pump shows it
      if (lf > 0.0005) hc(x0, seal, ys, zf, 0.0135, { color: q.milky ? [0.95, 0.95, 0.92] : [0.84, 0.91, 0.95], alpha: q.milky ? 0.95 : 0.4, spec: 0.8, noShadow: !q.milky });   // the drug
      hc(seal, seal + 0.006, ys, zf, 0.0138, { color: [0.12, 0.12, 0.13], spec: 0.4 });                                                                   // rubber seal
      hc(seal + 0.006, seal + 0.12, ys, zf, 0.004, { color: [0.93, 0.94, 0.95], spec: 0.4 });                                                             // plunger rod
      hc(seal + 0.12, seal + 0.124, ys, zf, 0.017, { color: [0.93, 0.94, 0.95], spec: 0.4 });                                                             // thumb plate
      P.b(seal + 0.134, ys, zf, 0.018, 0.045, 0.04, { color: [0.55, 0.58, 0.62], spec: 0.3 });                                                            // the pump's driver pushing it
      hc(x0 + 0.035, x0 + 0.075, ys, zf, 0.0147, { color: q.rgb, spec: 0.2 });                                                                  // drug label (ISO colour)
      hc(x0, x0 + L, ys, zf, 0.0145, { color: [0.92, 0.95, 0.97], alpha: 0.22, spec: 0.9, noShadow: true });                                             // the barrel, see-through (after its contents)
      hc(x0 - 0.014, x0, ys, zf, 0.004, { color: [0.92, 0.95, 0.97], alpha: 0.5, spec: 0.9 });                                                            // luer tip
      tube([x0 - 0.014, ys, zf], [x0 - 0.08, ys - 0.02, zf + 0.04], [px + 0.07, 1.155, pz + 0.03], 0.0017, [0.86, 0.93, 0.97], { alpha: 0.75, spec: 0.9, noShadow: true });   // extension line into the IV line
    });
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
    { const a = this.bedAnim.update(Math.max(realDt, this._bedT == null ? 0 : p.t - this._bedT), p); this._bedT = p.t;   // head of the bed (bed.js)
      this.bendU = a && this.world ? [this.world.femoral[0] + 0.04, BED_TOP, a, 0] : null; }
    // camera rig (camera-rig.js): presets are reached by a velocity-matched minimum-jerk move (setCamera), an action frames its site and then glides back to the overview (focus),
    // a drag orbits the view and it drifts back to the framing a few seconds after release
    if (this.returnAt != null && this.t >= this.returnAt && !this.dragging) this.setCamera('default');
    let lift = 0;
    if (this.auto) {
      this.tw = null; const G = { yaw: -0.62 + 0.6 * Math.sin(this.t * 0.14), pitch: 0.34, dist: 3.6, target: [0.1, 0.92, 0] }, k = 1 - Math.exp(-realDt * 3);
      this.yaw += (G.yaw - this.yaw) * k; this.pitch += (G.pitch - this.pitch) * k; this.dist += (G.dist - this.dist) * k; this.target = this.target.map((v, i) => v + (G.target[i] - v) * k);
      this.off.yaw = 0; this.off.pitch = 0;
    } else if (this.tw) {
      const o = this.tw.at(this.t - this.tw.t0);
      this.yaw = o.yaw; this.pitch = o.pitch; this.dist = o.dist; this.target = o.target; lift = o.lift;
      if (o.done) this.tw = null;
    }
    { const pc = this._camPrev, h = Math.max(realDt, 1e-3);                     // camera velocity, so the next move starts from it
      if (pc && realDt > 0) this.camVel = { yaw: (this.yaw - pc.yaw) / h, pitch: (this.pitch - pc.pitch) / h, dist: (this.dist - pc.dist) / h, target: this.target.map((v, i) => (v - pc.target[i]) / h) };
      this._camPrev = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: [...this.target] }; }
    // hand-held: the operator's posture and breathing, strongest in close-ups and settled framings, never while travelling far
    this.hh += ((this.reduceMotion ? 0 : (this.tw ? 0.25 : 1) * handheldAmp(this.dist)) - this.hh) * (1 - Math.exp(-realDt / 0.8));
    const hh = handheld(this.t, this.hh), tgt = this.target.map((v, i) => v + hh.target[i]);
    if (!this.dragging && this.releasedAt != null && this.t - this.releasedAt > 3) { const k = 1 - Math.exp(-realDt * 1.6); this.off.yaw *= 1 - k; this.off.pitch *= 1 - k; }
    const yawV = this.yaw + this.off.yaw + hh.yaw, pitchV = clamp(this.pitch + this.off.pitch + hh.pitch, 0.08, 1.52);
    const asp = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight), D = (this.dist + lift) * (1 + hh.dist) * (asp < 1.25 ? Math.min(2.1, 1.25 / asp) : 1);   // portrait screens: pull back so the whole bay still fits
    const eye = [tgt[0] + D * Math.cos(pitchV) * Math.sin(yawV), tgt[1] + D * Math.sin(pitchV), tgt[2] + D * Math.cos(pitchV) * Math.cos(yawV)];
    { const U = this.bendU; if (U && U[2] && tgt[0] < 1.2) {                     // head of the bed raised: what is framed on the patient rises with it, close-ups turn with it
      const th = U[2] * bendWeight(tgt, U) * (1 - smooth01(0.9, 1.7, D)), tb = bendPoint(tgt, U), off = turnDir([eye[0] - tgt[0], eye[1] - tgt[1], eye[2] - tgt[2]], th);
      for (let i = 0; i < 3; i++) { eye[i] = tb[i] + off[i]; tgt[i] = tb[i]; } } }
    eye[0] = clamp(eye[0], ROOM.x0 + 0.15, ROOM.x1 - 0.15); eye[2] = clamp(eye[2], ROOM.z0 + 0.15, ROOM.z1 - 0.15); eye[1] = clamp(eye[1], 0.4, ROOM.h - 0.12);   // never leave the bay
    const cam = { eye, target: tgt, fov: 0.85 };
    { const W = Math.max(1, this.canvas.clientWidth), goal = clamp((this.inset.l - this.inset.r) / W, -0.5, 0.5); this.shift += (goal - this.shift) * (1 - Math.exp(-realDt * 5)); r.shiftX = this.shift;
      const H = Math.max(1, this.canvas.clientHeight), goalY = clamp(((this.inset.b || 0) - (this.inset.t || 0)) / H, -0.7, 0.7); this.shiftY += (goalY - this.shiftY) * (1 - Math.exp(-realDt * 5)); r.shiftY = this.shiftY; }

    // ---------------- physiology -> appearance
    const sao2 = p.resp.sao2, arrested = p.arrest.arrested, perf = p.circ.mapArt;
    const sk = this.skinAnim.update(realDt, p, this._skinT == null ? 0 : p.t - this._skinT); this._skinT = p.t;   // sweat, mottling, cyanosis, hives, neck veins (skin.js)
    const cyan = clamp((0.85 - sao2) / 0.3, 0, 1), pallor = clamp((p.vol.fractionLost - 0.1) / 0.3, 0, 1) * 0.9 + (perf < 55 ? 0.3 : 0) + (arrested ? 0.4 : 0);
    const skin = skinColor(SKIN_TONES[this.tone] || SKIN_TONES[2], { cyanosis: cyan, pallor: clamp(pallor, 0, 1), flush: Math.max(clamp((p.therm.tc - 37.8) / 2, 0, 1), sk.flush) });
    // breathing: from the engine respiratory rate and tidal volume; ventilated chest rise during BVM / vent
    const rrNow = p.resp.rr;
    this.breathPh += realDt * (rrNow / 60) * Math.PI * 2;
    const cprOn = !!(p.cpr?.mode && p.cpr.mode !== 'off'), awd = p.airway?.device;
    const bmv = !cprOn && p.vent?.mode === 'ctrl' && !p.airway?.intubated && awd !== 'sga' && awd !== 'ett';   // bag-mask ventilation with a pulse: a bag and mask, not a ventilator circuit
    this.bag = (cprOn && this.rescuers?.length) || bmv ? bagger(p, true) : null;   // a rescuer bagging at the head: the chest rises with each squeeze
    const bp = breathPose(p, this.bag ? this.bag.cycles : this.breathPh / (Math.PI * 2)), breath = [bp.L, bp.R, bp.A];   // left chest, right chest, abdomen (breathing.js)
    // compressions: animate each engine compression event
    const cpr = this.cprAnim.update(realDt, p);              // sternum travel, mattress sink, head, arms, belly (cpr-anim.js)
    this.compAmt = cpr.sternum;
    const ba = this.bodyAnim.update(realDt, p, cpr.active);  // shock jolt, seizure, shivering, fasciculations, coughing on the tube, agonal gasps (body-anim.js)
    breath[0] += ba.chest; breath[1] += ba.chest; breath[2] += ba.abd;
    // the sheet: rises with the belly at once (never lets the skin through), settles back a little behind it like real cloth, 3 mm clear
    { const k = 1 - Math.exp(-realDt / 0.22); this.sheetB = (this.sheetB || [0, 0, 0]).map((v, i) => Math.max(breath[i], v + (breath[i] - v) * k)); }
    const sheetBreath = this.sheetB.map(v => v * 1.08 + 0.003);
    if (p.shockLog.length && p.shockLog[p.shockLog.length - 1].t !== this._shockSeen) { this._shockSeen = p.shockLog[p.shockLog.length - 1].t; this.shockT = 0.35; }
    this.shockT = Math.max(0, this.shockT - realDt);

    const once = {}, first = (k, fn) => (k in once ? once[k] : (once[k] = fn()));   // frame() runs twice (shadows, then the picture): animations advance once per frame
    const frame = () => {
    // ---------------- room and equipment
    const fr = this.g;
    this._room(p); this._equipment(p);
    const face = this.world.face;
    // bed
    r.draw(fr.bedFrame, mat4.translation(-0.1, 0.74, 0), { color: [0.55, 0.58, 0.62], spec: 0.3 });
    for (const [x, z] of [[-1.0, -0.35], [-1.0, 0.35], [0.8, -0.35], [0.8, 0.35]]) r.draw(fr.leg, mat4.translation(x, 0.36, z), { color: [0.4, 0.42, 0.45], spec: 0.3 });
    r.bend = this.bendU;                                     // the back section of the mattress and everything on the patient follow the raised head of the bed
    for (let i = 0; i < MAT_N; i++) r.draw(fr.mattress, mat4.translation(-1.15 + 2.1 * (i + 0.5) / MAT_N, 0.80, 0), { color: [0.19, 0.23, 0.28], spec: 0.15 });
    r.bend = null;
    r.draw(fr.rail, mat4.translation(-0.1, 0.98, 0.43), { color: [0.7, 0.72, 0.75], spec: 0.4 });
    // monitor on its stand: the screen shows the very same canvas as the HUD monitor
    const [standX, standZ] = STAND;
    r.draw(fr.cyl, mat4.multiply(mat4.translation(standX, 0.7, standZ), mat4.scaling(0.025, 1.4, 0.025)), { color: [0.3, 0.3, 0.32] });
    r.draw(fr.monitorBody, mat4.multiply(mat4.translation(standX, 1.55, standZ), mat4.rotationY(-0.55)), { color: [0.12, 0.13, 0.15], spec: 0.2 });
    r.updateTexture(this.monTex, this.monitorCanvas);
    r.drawQuad(this.monTex, mat4.multiply(mat4.multiply(mat4.translation(standX, 1.55, standZ), mat4.rotationY(-0.55)), mat4.multiply(mat4.translation(0, 0, 0.05), mat4.scaling(0.94, 0.5, 1))), 1.15);   // screen decal 1 cm in front of the bezel

    // ---------------- patient
    r.bend = this.bendU;
    const M = B.M;                                           // the shock moves the body itself (body-anim.js)
    // face: blink, jaw, grimace and gaze (face.js); painful procedures under way on screen, and the side they are on
    const PAINFUL = ['needle', 'cannula', 'drain', 'fona', 'laryn', 'step_scalpel'], st = this.world.sternum;
    const hurt = this.gest.list.find(g => PAINFUL.includes(g.k) && this.t >= g.t0 && this.t <= g.t0 + g.dur);
    { // waking movements; a part a hand is working on keeps still
      const busy = new Set(), W0 = this.world, R0 = this.sideSign || 1;
      for (const g of this.gest.list) {
        const q = g.f?.p; if (!q || g.k === 'laryn') { busy.add('head'); continue; }
        if (q[0] > W0.neck[0] - 0.06) busy.add('head'); else if (q[0] < W0.femoral[0] - 0.04) busy.add(q[2] * R0 > 0 ? 'legR' : 'legL'); else if (q[2] * R0 < -0.18) busy.add('armL');
      }
      if (this.pupilCheck || this.ghost) busy.add('head');
      const F = B.bFrame, mv = first('wake', () => this.wakeAnim.update(realDt, p, { painful: !!hurt, busy }));
      this._moveU = F.arm ? { axes: [F.axes.slice(0, 3), F.axes.slice(3, 6), F.axes.slice(6, 9)], ref: F.ref, cprRef: F.cprRef, arm: F.arm, armD: F.armD, leg: F.leg, move: mv.move, move2: mv.move2 } : null;
      this._moveO = this._moveU ? mv : null;
    }
    const faceW = first('face', () => this.faceAnim.update(realDt, p, { painful: !!hurt, side: hurt?.f?.p ? clamp(-(hurt.f.p[2] - st[2]) * (this.sideSign || 1) / 0.2, -1, 1) : 0 }));
    // pupil check: the eyelids are held open and a penlight swept onto the eyes (checkPupils)
    const pc = this.pupilCheck, pu = pc ? clamp((this.t - pc.t0) / pc.dur, 0, 1) : 0; if (pc && pu >= 1) this.pupilCheck = null;
    const lidUp = pc ? clamp(pu / 0.15, 0, 1) * clamp((1 - pu) / 0.12, 0, 1) : 0, lightOn = !!pc && pu > 0.35 && pu < 0.78;
    const pupilMm = first('pupil', () => { const v = this.pupilAnim.update(realDt, p, this._pupT == null ? 0 : p.t - this._pupT, lightOn); this._pupT = p.t; return v; });
    const faceAll = [Math.min(1, faceW[0] + ba.face[0]) * (1 - 0.92 * lidUp), Math.min(1, faceW[1] + ba.face[1]), Math.min(1, faceW[2] + ba.face[2]), faceW[3]];
    if (this._bloodFor !== p) { this._bloodFor = p; this._lost0 = p.vol?.totalLost ?? 0; }   // blood lost before the case was opened is not shown here
    const bl = bloodState(p, this._lost0), BS = this.bloodSites;
    const bloodSkin = BS && bl.source ? { a: bl.source === 'mouth' ? [...BS.mouthL, Math.min(0.04, 0.018 + bl.r.stain * 0.2) / BS.s] : [...BS.thighL, bl.r.stain * 0.55 / BS.s], dry: bl.dry } : null;
    const bloodSheet = BS && bl.source === 'thigh' ? { a: [...BS.sheetL, bl.r.stain / BS.s], dry: bl.dry } : null;
    const o = { breath, bFrame: B.bFrame, compress: this.compAmt, face: faceAll, cpr: [cpr.head + ba.head, cpr.sink - ba.lift, cpr.arms + ba.arms, cpr.belly + ba.belly], tremor: ba.tremor, move: this._moveO, time: this.t % 600, skinA: [sk.sweat, sk.mottle, sk.cyanC, sk.cyanP], skinB: [sk.hives, sk.jvd, 0, 0] };
    const sheetCol = p.therm.cover < 1 ? [0.74, 0.58, 0.40] : [0.72, 0.79, 0.84];
    if (B.b.glb) {
      const T = this.asset.tex, tint = skin.map((v, i) => v / TONE_REF[i]), A = (k) => T['patient_' + k] || {};
      o.compDir = [0, 1, 0];                                   // the asset's anterior axis is +y (procedural body: +z)
      // the chest is exposed for anything done on it: pads, leads, CPR, chest procedures and examinations in progress
      const exposed = p.flags.padsOn || p.flags.ecgLeads || arrested || !!this.echoProbe || !!(p.chest && (p.chest.needle || p.chest.tube)) || this.gest.list.some(g => ['needle', 'tube', 'steth', 'probe', 'step_pads', 'pericard'].includes(g.k) || (g.k === 'cvc' && g.site === 'scv'));
      const fem = (B.b.weights.female ?? 0) > 0.5, sx = (k) => (fem && B.g[k + '_f'] ? k + '_f' : k), skinT = fem && T.patient_body_female ? T.patient_body_female : A('body');
      r.draw(B.g.body, M, { color: tint, spec: 0.3, pattern: 7, albedo: skinT.albedo, normalMap: skinT.normal, ...o, blood: bloodSkin });
      r.draw(B.g.eyes, M, { color: [1, 1, 1], spec: 0.9, pattern: 6, albedo: A('eyes').albedo, pupil: pupilMm, ...o });
      r.draw(B.g[sx('eyebrows')], M, { color: [1, 1, 1], spec: 0.05, albedo: A(sx('eyebrows')).albedo, alphaCut: -1, cull: false, depthWrite: false, noShadow: true, ...o });
      if (B.g.eyelashes) r.draw(B.g.eyelashes, M, { color: [1, 1, 1], spec: 0.05, albedo: A('eyelashes').albedo, alphaCut: -1, cull: false, depthWrite: false, noShadow: true, ...o });
      const grey = Math.min(1, Math.max(0, (B.spec.age - 45) / 35));
      r.draw(B.g[sx('hair')], M, { color: [1 + grey * 1.6, 1 + grey * 1.55, 1 + grey * 1.5], spec: 0.2, pattern: 4, albedo: A(sx('hair')).albedo, alphaCut: 0.5, cull: false, noShadow: true, ...o });
      const infl = 0.004 + 0.016 * Math.min(1, B.b.weights.heavy + 0.5 * B.b.weights.female_heavy);   // heavier morphs need more clearance
      if (!exposed) r.draw(B.g.gown, M, { color: [0.36, 0.55, 0.66], spec: 0.05, pattern: 5, cull: false, inflate: infl, ...o });
      r.draw(B.g.sheet, M, { color: sheetCol, spec: 0.05, pattern: 5, cull: false, ...o, breath: sheetBreath, cloth: true, blood: bloodSheet });   // the draped sheet's normals are not consistently outward: no inflate
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
      r.draw(B.g.sheet, M, { color: sheetCol, spec: 0.05, pattern: 5, ...{ breath: breath.map(v => v * 0.2), bFrame: B.bFrame } });
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
    const ride = (q) => { const left = (q[2] - W.sternum[2]) * (this.sideSign || 1) < 0; return [q[0], q[1] + 0.85 * (left ? breath[0] : breath[1]) - cpr.sink * B.b.scale, q[2]]; };   // things stuck on the chest rise with it
    // blood: pool on the mattress, over the edge, drops falling, pool on the floor; a pressure dressing once controlled; oozing punctures
    if (bl.source && BS) {
      const R = this.sideSign || 1, bc = [0.2 - 0.06 * bl.dry, 0.006 + 0.022 * bl.dry, 0.01 + 0.008 * bl.dry], wet = { spec: 0.6 - 0.4 * bl.dry, noShadow: true };
      const src = bl.source === 'mouth' ? BS.mouthW : BS.thighW, EDGE = 0.4;
      const pool = (c, rad, y) => { for (const [dx, dz, k] of [[0, 0, 1], [0.42, 0.22, 0.6], [-0.38, -0.16, 0.52], [0.12, -0.4, 0.42], [-0.18, 0.36, 0.38], [0.62, -0.05, 0.3], [-0.6, 0.12, 0.25]]) disc([c[0] + dx * rad, y, c[2] + dz * rad], [0, 1, 0], [1, 0, 0], rad * k * 1.25, rad * k * 0.8, bc, { alpha: 0.96, ...wet }); };
      if (bl.r.mat > 0.005) { const rz = bl.r.mat * 0.8, zc = R * clamp(Math.abs(src[2]) + 0.1, 0, EDGE - rz * 0.9); pool([src[0] + (bl.source === 'mouth' ? -0.02 : 0), 0, zc], bl.r.mat, BED_TOP + 0.002); }
      if (bl.r.floor > 0.005) {
        pool([src[0], 0, R * (EDGE + 0.05 + bl.r.floor * 0.55)], bl.r.floor, 0.003);
        seg([src[0], BED_TOP - 0.005, R * (EDGE + 0.006)], [src[0], BED_TOP - 0.12, R * (EDGE + 0.006)], 0.006, bc, { alpha: 0.9, ...wet });   // run down the mattress side
      }
      if (bl.drips > 0) for (let j = Math.floor(this.t * bl.drips) - 2; j <= Math.floor(this.t * bl.drips); j++) {   // drops in flight from the frame edge to the floor
        const age = this.t - (j + 0.4 * (Math.sin(j * 12.9898) * 0.5 + 0.5)) / bl.drips, y = BED_TOP - 0.13 - 4.9 * age * age;
        if (age > 0 && y > 0.005) blob([src[0] + 0.01 * Math.sin(j * 7.1), y, R * (EDGE + 0.01)], 0.0035, 0.006, 0.0035, bc, wet);
      }
      if (bl.source === 'thigh' && p.bleedControlledAt != null && !bl.active) {               // pressure dressing over the wound, soaked through at the centre
        const c = [BS.thighW[0], BS.thighW[1] + 0.045, BS.thighW[2]];
        disc(c, [0, 1, 0], [1, 0, 0], 0.06, 0.045, [0.95, 0.95, 0.93], { spec: 0.15 }); disc([c[0], c[1] + 0.002, c[2]], [0, 1, 0], [1, 0, 0], 0.03, 0.022, bc, { alpha: 0.85, ...wet });
      }
    }
    if (bl.ooze > 0) for (const k of [fl.ivAccess && 'rightArmIV', fl.aline && 'wristR', fl.ioAccess && 'ioR'].filter(Boolean)) {   // coagulopathy: the punctures ooze under their dressings
      const f = SF(k); if (f) disc(onSkin(f, 0.0025), f.n, [1, 0, 0], 0.004 + 0.012 * bl.ooze, 0.003 + 0.009 * bl.ooze, [0.42, 0.012, 0.018], { alpha: 0.9, spec: 0.9, noShadow: true });
    }
    if (fl.padsOn) {                                            // multifunction pads stuck on the skin, red leads to the defibrillator
      for (const [k, nm] of [['padRight', 'defibPadRight'], ['padLeft', 'defibPadLeft']]) { const f = SF(k) || { p: W[k], n: [0, 1, 0] }; inst(nm, ride(onSkin(f, 0.003)), f.n, 0, { noHand: true }); }
      const pr = W.padRight; hose(up(pr, 0.02), [pr[0] + 0.3, 1.05, pr[2] - 0.35], [CART[0] + 0.19, 1.0, CART[2] + 0.17], 0.004, [0.72, 0.07, 0.06], { spec: 0.5 });
    }
    if (fl.ecgLeads) {                                          // three foam electrodes with snaps, leads gathered toward the monitor
      const st = SF('sternum') || { p: W.sternum, n: [0, 1, 0] }, lead = [[0.12, -0.09, [0.95, 0.95, 0.95]], [0.12, 0.09, [0.9, 0.2, 0.2]], [-0.1, 0.1, [0.2, 0.8, 0.3]]];
      for (const [dx, dz, col] of lead) {
        const q = [st.p[0] + dx, st.p[1], st.p[2] + dz], n = this.normalAt(q), base = ride([q[0] + n[0] * 0.012, q[1] + n[1] * 0.012 - 0.008, q[2] + n[2] * 0.012]);
        disc(base, n, [1, 0, 0], 0.02, 0.02, [0.96, 0.96, 0.94], { spec: 0.2 }); blob([base[0] + n[0] * 0.004, base[1] + n[1] * 0.004, base[2] + n[2] * 0.004], 0.005, 0.004, 0.005, [0.75, 0.77, 0.8], { spec: 0.9 });
        hose([base[0] + n[0] * 0.006, base[1] + n[1] * 0.006, base[2] + n[2] * 0.006], [base[0] + 0.12, base[1] + 0.02, -0.45], [STAND[0] - 0.25, 0.95, STAND[1] + 0.35], 0.0018, col, { spec: 0.4 });
      }
    }
    if (fl.spo2Probe) { const f = SF('leftArm') || { p: W.leftArm, n: [0, 1, 0] }; blob(this.moved(up([f.p[0] - 0.24, f.p[1], f.p[2] + 0.03], 0.015), [1, 0, 0]), 0.022, 0.012, 0.014, [0.18, 0.22, 0.28], { spec: 0.5 }); }
    if (fl.nibp) { const a = W.leftArm; seg(this.moved([a[0] + 0.03, a[1] - 0.02, a[2]], [1, 0, 0]), this.moved([a[0] + 0.15, a[1] - 0.02, a[2]], [1, 0, 0]), 0.05, [0.2, 0.22, 0.28], { spec: 0.15 }); }
    if (fl.ivAccess && this.gest.ok('iv', this.t)) {            // 18 G cannula taped under a clear dressing, giving set to the IV pole
      const f = SF('rightArmIV') || { p: W.rightArmIV, n: [0, 1, 0] }, ax = this.armAxis(), dir = vec3.norm(vec3.add(vec3.scale(f.n, -1), vec3.scale(ax, 2.7)));
      const tip = vec3.add(f.p, vec3.scale(dir, 0.02)); inst('ivCannula', tip, vec3.scale(dir, -1), 0, { skip: ['steel'], noHand: true });
      disc(onSkin(f, 0.003), f.n, ax, 0.022, 0.018, [0.92, 0.96, 1.0], { alpha: 0.18, spec: 1, noShadow: true });
      const hub = vec3.add(f.p, vec3.add(vec3.scale(dir, -0.05), vec3.scale(f.n, 0.012)));
      hose(hub, [hub[0] + 0.05, hub[1] + 0.25, hub[2] - 0.2], [POLE[0] + 0.07, 1.25, POLE[2]], 0.0025, ...(this._dripNow?.blood ? [[0.42, 0.0, 0.02], { alpha: 0.95, spec: 0.3 }] : [[0.86, 0.93, 0.97], { alpha: 0.75, spec: 0.9 }]));   // red while blood runs in
    }
    // lines, tubes and catheters left in place after their procedure
    const PS = this.procSites || {}, R = this.sideSign || 1, inPlane = (f, d) => vec3.norm(vec3.sub(d, vec3.scale(f.n, vec3.dot(d, f.n))));
    const along = (a, d, k) => vec3.add(a, vec3.scale(d, k));
    if (fl.ioAccess && PS.ioR && this.gest.ok('io', this.t)) {     // intraosseous needle in the tibia: short hub on a stabilising flange, extension set to the pole
      const f = PS.ioR, b = this.moved(onSkin(f, 0.002), [0, 0, 1]);
      disc(b, f.n, [1, 0, 0], 0.014, 0.014, [0.95, 0.95, 0.93], { spec: 0.2 }); seg(b, along(b, f.n, 0.014), 0.0055, [0.85, 0.18, 0.16], { spec: 0.5 });
      hose(along(b, f.n, 0.014), [b[0] + 0.1, b[1] + 0.12, b[2] - R * 0.05], [POLE[0] + 0.07, 1.25, POLE[2]], 0.0022, [0.86, 0.93, 0.97], { alpha: 0.75, spec: 0.9 });
    }
    if (fl.aline && PS.wristR) {                                    // radial arterial cannula, red-striped pressure line to the transducer on the pole
      const f = PS.wristR, ax = this.armAxis(), dir = vec3.norm(vec3.add(vec3.scale(f.n, -1), vec3.scale(ax, -1.7)));
      inst('ivCannula', along(f.p, dir, 0.015), vec3.scale(dir, -1), 0, { skip: ['steel'], noHand: true });
      disc(onSkin(f, 0.003), f.n, ax, 0.02, 0.016, [0.92, 0.96, 1.0], { alpha: 0.18, spec: 1, noShadow: true });
      const hub = vec3.add(along(f.p, dir, -0.045), vec3.scale(f.n, 0.01));
      hose(hub, [hub[0] + 0.1, hub[1] + 0.2, hub[2] - R * 0.1], [POLE[0] + 0.05, 1.12, POLE[2]], 0.0022, [0.92, 0.3, 0.28], { alpha: 0.85, spec: 0.8 });
      r.draw(fr.ub, mat4.multiply(mat4.translation(POLE[0] + 0.05, 1.12, POLE[2]), mat4.scaling(0.025, 0.05, 0.02)), { color: [0.9, 0.92, 0.95], spec: 0.6 });   // transducer
    }
    if (fl.cvc) {                                                   // triple-lumen central catheter: hub sutured flat on the skin, three coloured lumens, clear dressing
      const site = [...(p.log || [])].reverse().find(e => e.type === 'procedure.central_line')?.site || 'ijv', f = PS[{ ijv: 'ijvR', scv: 'scvR', fem: 'femR' }[site] || 'ijvR'];
      if (f) {
        const tan = inPlane(f, site === 'fem' ? [-1, 0, 0] : site === 'scv' ? [0, 0, R] : [1, 0, 0]), side = vec3.norm(vec3.cross(f.n, tan)), a = onSkin(f, 0.004), b = along(a, tan, 0.03);
        disc(onSkin(f, 0.003), f.n, tan, 0.04, 0.03, [0.92, 0.96, 1.0], { alpha: 0.2, spec: 1, noShadow: true });
        seg(a, b, 0.0045, [0.95, 0.95, 0.94], { spec: 0.5 }); disc(along(a, tan, 0.012), f.n, side, 0.012, 0.005, [0.95, 0.95, 0.94], { spec: 0.4 });   // hub and suture wings
        for (const [i, col] of [[-1, [0.2, 0.35, 0.8]], [0, [0.95, 0.95, 0.95]], [1, [0.45, 0.26, 0.12]]]) {
          const e = vec3.add(along(b, tan, 0.045), vec3.scale(side, i * 0.016)); seg(b, e, 0.0016, [0.92, 0.94, 0.95], { alpha: 0.85, spec: 0.8 }); blob(e, 0.004, 0.004, 0.004, col, { spec: 0.5 });
        }
      }
    }
    if (fl.ngTube && PS.nostril && this.gest.ok('ng', this.t)) {    // nasogastric tube taped to the nose, over the cheek, to a drainage bag
      const f = { ...PS.nostril, p: this.moved(PS.nostril.p) }, b = this.moved(vec3.add(along(PS.nostril.p, f.n, 0.008), [0.012, 0, 0])), cheek = this.moved([b[0] - 0.03, b[1] - 0.045, b[2] + R * 0.09]);
      seg(f.p, b, 0.0026, [0.93, 0.9, 0.7], { alpha: 0.85, spec: 0.8 }); disc(along(b, f.n, 0.003), f.n, [1, 0, 0], 0.012, 0.007, [0.93, 0.92, 0.86], { spec: 0.1 });
      hose(b, [b[0] + 0.01, b[1] + 0.01, b[2] + R * 0.05], cheek, 0.0026, [0.93, 0.9, 0.7], { alpha: 0.85, spec: 0.8 });
      hose(cheek, [cheek[0], cheek[1] + 0.04, R * 0.38], [W.airway[0] - 0.12, 0.66, R * 0.46], 0.0026, [0.93, 0.9, 0.7], { alpha: 0.85, spec: 0.8 });
      blob([W.airway[0] - 0.12, 0.58, R * 0.465], 0.06, 0.08, 0.012, [0.9, 0.95, 0.9], { alpha: 0.35, spec: 0.9, noShadow: true });
      seg([W.airway[0] - 0.12, 0.66, R * 0.465], [W.airway[0] - 0.12, 0.74, R * 0.44], 0.002, [0.85, 0.87, 0.9]);   // hanger on the bed frame
    }
    if (fl.urineCath) {                                             // Foley catheter from under the sheet to a drainage bag hung on the bed frame, filling with this patient's urine
      const s0 = [W.femoral[0] - 0.1, W.femoral[1] + 0.02, W.femoral[2] + R * 0.08], bag = [W.femoral[0] - 0.05, 0.55, R * 0.47];
      hose(s0, [s0[0], s0[1] + 0.03, R * 0.46], [bag[0], bag[1] + 0.12, bag[2]], 0.0035, [0.9, 0.85, 0.6], { alpha: 0.8, spec: 0.8 });
      seg([bag[0], bag[1] + 0.13, bag[2]], [bag[0], 0.74, bag[2] - R * 0.03], 0.002, [0.85, 0.87, 0.9]);   // hanger
      blob(bag, 0.09, 0.13, 0.015, [0.92, 0.95, 0.97], { alpha: 0.3, spec: 1, noShadow: true });
      const ml = (p.vol.urine || 0) + (p.vol.urineBasal || 0) - (p.urine0 || 0), h = 0.13 * clamp(ml / 2000, 0.03, 1);
      blob([bag[0], bag[1] - 0.13 + h, bag[2]], 0.085 * Math.sqrt(Math.min(1, h / 0.065 + 0.2)), h, 0.013, [0.86, 0.66, 0.16], { alpha: 0.8, spec: 0.8, noShadow: true });
    }
    if (p.neuraxial?.kind === 'epidural' && this.chestSites) {      // epidural catheter taped up the back and over the shoulder, filter on the upper chest
      const sh = this.chestSites.R.mcl2, st = [sh[0] + 0.07, sh[1] - 0.05, sh[2] + R * 0.1], fil = ride([sh[0] + 0.03, sh[1] + 0.02, sh[2] + R * 0.02]);
      hose(st, [st[0] - 0.01, st[1] + 0.08, st[2]], fil, 0.0011, [0.95, 0.96, 0.97], { alpha: 0.8, spec: 0.9 });
      disc(fil, [0, 1, 0], [1, 0, 0], 0.017, 0.017, [0.97, 0.85, 0.2], { spec: 0.5 });
    }
    // airway devices
    const dev = p.airway.device;
    if (p.o2 && dev !== 'ett') blob(this.moved([face[0] + 0.02, face[1] + 0.035, face[2]]), 0.075, 0.05, 0.065, [0.7, 0.85, 0.9], { alpha: 0.55, spec: 0.5 });
    if ((dev === 'ett' || p.airway.intubated) && dev !== 'fona' && this.gest.ok('ett', this.t)) {   // clear PVC tube with its blue line, taped at the corner of the mouth, 15 mm connector
      const m0 = this.moved(up(W.airway, 0.006)), m1 = this.moved(up([W.airway[0] + 0.07, W.airway[1], W.airway[2] + 0.01], 0.05)), m2 = up([W.airway[0] + 0.17, W.airway[1], W.airway[2] + 0.01], 0.075);   // the tube turns with the head; the connector stays with the circuit
      hose(m0, m1, m2, 0.0058, [0.88, 0.94, 0.96], { alpha: 0.8, spec: 1 }); seg(m2, [m2[0] + 0.025, m2[1] + 0.004, m2[2]], 0.0085, [0.95, 0.95, 0.93], { spec: 0.5 });
      seg(this.moved(up([W.airway[0] - 0.005, W.airway[1], W.airway[2] - 0.035], 0.004)), this.moved(up([W.airway[0] + 0.01, W.airway[1], W.airway[2] + 0.04], 0.004)), 0.004, [0.93, 0.92, 0.86], { spec: 0.1 });   // tape
    }
    if (p.tube?.scopeIn) {                                     // bronchoscope: insertion cord into the tube connector, control body held above the head, light cable
      const port = up([W.airway[0] + 0.2, W.airway[1], W.airway[2]], 0.075), body = [port[0] + 0.02, port[1] + 0.34, port[2] + 0.16], top = [body[0] + 0.03, body[1] + 0.13, body[2]];
      seg(port, [port[0] + 0.03, port[1] + 0.06, port[2]], 0.012, [0.85, 0.87, 0.9], { spec: 0.6 });   // swivel adaptor
      seg([port[0] + 0.03, port[1] + 0.06, port[2]], body, 0.0035, [0.08, 0.08, 0.09], { spec: 0.5 });
      seg(body, top, 0.018, [0.12, 0.13, 0.15], { spec: 0.5 }); blob(top, 0.022, 0.016, 0.022, [0.15, 0.16, 0.18], { spec: 0.6 });
      seg([body[0], body[1] + 0.05, body[2] - 0.02], [body[0] + 0.25, body[1] - 0.05, body[2] - 0.35], 0.006, [0.1, 0.1, 0.11]);   // light cable, routed behind the head
    }
    if (p.vent.mode === 'ctrl' && (dev === 'ett' || dev === 'bvm' || p.o2) && !this.bag) {   // (a bag in a rescuer's hands instead: below)
      const y0 = up([face[0] + 0.21, face[1] + 0.07, face[2]], 0.03), y1 = [y0[0] + 0.06, y0[1] + 0.02, y0[2]];
      seg(y0, y1, 0.009, [0.9, 0.92, 0.93], { spec: 0.6 });                                                  // catheter mount + Y-piece
      for (const k of [-1, 1]) {                                                                            // inspiratory and expiratory limbs, corrugated
        const a = [y1[0], y1[1], y1[2] + k * 0.012], ctrl = [y1[0] + 0.25, y1[1] + 0.25, y1[2] + k * 0.08 + 0.1], b = [VENT[0] - 0.2, 1.08, VENT[2] - 0.12 + k * 0.05];
        let prev = a; for (let i = 1; i <= 16; i++) { const t = i / 16, q = [0, 1, 2].map(j => (1 - t) * (1 - t) * a[j] + 2 * (1 - t) * t * ctrl[j] + t * t * b[j]); seg(prev, q, i % 2 ? 0.0105 : 0.0115, k < 0 ? [0.55, 0.68, 0.8] : [0.82, 0.86, 0.9], { alpha: 0.85, spec: 0.7 }); prev = q; }
      }
    }
    // chest compressions: the chest itself (compression weights), the monitor's CPR artefact, and the rescuer's two hands, heel of the
    // lower hand on the lower half of the sternum, fingers interlaced, arms coming straight down from the rescuer at the patient's side
    this._resc = null;
    const ra = first('resc', () => this.rescuerAnim.update(realDt, p));
    if (this.hands?.hand_cprBottom && B.bFrame.compPt && (ra || cpr.active)) {
      const k = B.b.scale, cp = localToWorld(B.M, B.bFrame.compPt), n = this.normalAt?.(cp) || [0, 1, 0];
      const ax = vec3.norm([n[0] * 0.3, 1, n[2] * 0.3]), op = vec3.norm([0, 0.8, -1]);
      // each rescuer at the chest has their own pair of hands: the compressor's push; at a switch the one leaving lifts them off and
      // back toward the body (the sleeves slide up the arms, as elbows bending) while the one arriving puts theirs on; "all clear"
      // and rhythm checks lift the compressor's straight up. The body stays where the hands-on position puts it.
      const back = vec3.norm([ax[0], ax[1], ax[2] - 0.9]), at = ra ? ra.people.map((q, i) => [q, i]).filter(([q]) => q.role === 'push' && q.hands > 0) : [[null, 0]];
      const em = {}, drops = {};
      for (const [q, i] of at) {
        const mine = !ra || i === ra.who, press = !ra ? 1 : mine ? q.hands * (1 - q.lift) : 0;
        const V = ra ? vec3.add(vec3.scale(ax, 0.1 * q.lift), vec3.scale(back, 0.2 * (1 - q.hands))) : [0, 0, 0];   // hands lifted: "all clear", or coming off / going on
        const skin = [cp[0] + n[0] * 0.004 + V[0], cp[1] + n[1] * 0.004 - (cpr.sternum + cpr.sink) * k * press + V[1], cp[2] + n[2] * 0.004 + V[2]];
        const MB = inst('cprBottom', skin, ax, -0.18, { toward: op });                // the two forearms meet at a slight angle, as from two shoulders
        const MT = inst('cprTop', vec3.add(skin, vec3.scale(ax, 0.026)), ax, 0.18, { toward: op });
        if (!ra || !this.rescuers?.length) continue;
        const end = (M, cf) => (M && cf ? this.bent(vec3.sub(mat4.transformPoint(M, cf.c), vec3.scale(V, 1 - 0.5 * (q.lift || 0)))) : null);   // the body where the hands-on position puts it
        const eB = end(MB, this.hands.hand_cprBottom.cuff), eT = end(MT, this.hands.hand_cprTop?.cuff);
        if (eB && eT) em[i] = eB.map((v, j) => (v + eT[j]) / 2);
        drops[i] = (cpr.sternum + cpr.sink) * k * press - V[1];                     // how far the hands are pushed down now (negative: lifted)
      }
      if (ra && this.rescuers?.length) this._resc = { ra, cp: this.bent(cp), em, drops };   // the whole rescuers are drawn after the bed turn (they stand on the floor)
    }
    // the third rescuer's bag-valve-mask: face mask in an E-C grip (on a supraglottic airway, the bag on its connector), the
    // self-inflating bag beside the head squeezed by the other hand, oxygen tubing; the person is drawn with the others below
    this._bagR = null;
    if (this.bag && this.hands?.hand_pressL) {                                 // outside CPR the two hands only (as for the other gestures), during CPR the third rescuer's
      const bg = this.bag, f = SF('face') || { p: W.face, n: [0, 1, 0] }, n = f.n, op = vec3.norm([1, 0.45, 0]), sq = bg.squeeze;
      const MM = bg.mask ? inst('faceMask', vec3.add(f.p, vec3.scale(n, 0.006)), n, 0, { toward: op, act: 0.85, sleeve: BAGGER_GOWN })
        : inst('press', vec3.add(f.p, vec3.scale(n, 0.08)), n, 0, { toward: op, act: 0.5, sleeve: BAGGER_GOWN });   // supraglottic airway: the other hand steadies the valve on its connector
      const conn = vec3.add(f.p, vec3.scale(n, bg.mask ? 0.075 : 0.06)), ax = vec3.norm([0.35, 0.12, -0.6]);   // valve, then the bag lying out toward the rescuer's right hand
      const L = 0.27, rad = 0.062, mid = vec3.add(conn, vec3.scale(ax, 0.05 + L / 2)), ex = vec3.norm(vec3.cross([0, 1, 0], ax)), ez = vec3.norm(vec3.cross(ax, ex));
      seg(conn, vec3.add(conn, vec3.scale(ax, 0.05)), 0.011, [0.92, 0.93, 0.95], { spec: 0.7 });                       // valve housing
      r.draw(fr.sph, mat4.multiply(mat4.fromBasis(ex, ax, ez, mid), mat4.scaling(rad * (1 + 0.15 * sq), L / 2, rad * (1 - 0.4 * sq))), { color: [0.42, 0.74, 0.52], alpha: 0.88, spec: 0.8, noShadow: true });   // the bag (green silicone), flattened as it is squeezed
      const tail = vec3.add(conn, vec3.scale(ax, 0.05 + L)); hose(tail, vec3.add(tail, [0.15, -0.05, -0.05]), [ROOM.x1 - 0.05, 1.35, -0.35], 0.004, [0.3, 0.75, 0.45], { alpha: 0.85, spec: 0.6 });   // oxygen tubing to the wall outlet
      const top = vec3.add(mid, vec3.scale(ez, rad * (1 - 0.4 * sq) + 0.004)), MH = inst('pressL', top, ez, 0, { toward: vec3.norm([1, 0.5, -0.2]), act: 0.3 + 0.7 * sq, sleeve: BAGGER_GOWN });
      const end = (M, cf) => (M && cf ? this.bent(mat4.transformPoint(M, cf.c)) : null);
      const eM = end(MM, this.hands[bg.mask ? 'hand_faceMask' : 'hand_press']?.cuff) || this.bent(vec3.add(conn, [0.25, 0.08, 0.12])), eH = end(MH, this.hands.hand_pressL.cuff);
      if (eH && this._resc) this._bagR = { e: eM.map((v, i) => (v + eH[i]) / 2), sq };
    }
    // surgical gestures: catheter, chest drain, surgical airway, ultrasound mark
    const ch = p.chest, nk = p.neck;
    if (ch) {
      if (ch.needle && ch.side && this.gest.ok('needle', this.t)) {           // 14 G catheter left in the chest wall, perpendicular to the skin
        const f = SF(`${ch.side}_${ch.needle.site || 'mcl2'}`) || { p: this.chestSites[ch.side].mal5, n: [0, 1, 0] };
        inst('needle14G', vec3.add(f.p, vec3.scale(f.n, -0.045)), f.n, 0, { skip: ['steel', 'flash_orange'], noHand: true });
        if (!ch.needle.patent) disc(onSkin(f, 0.003), f.n, [1, 0, 0], 0.006, 0.006, [0.6, 0.05, 0.05], { spec: 0.8 });
      }
      if (ch.tube && ch.tube.side && this.gest.ok('tube', this.t)) {         // drain aimed at the apex, sutured, tubing to an underwater-seal bottle on the floor
        const f = SF(`${ch.tube.side}_mal5`) || { p: this.chestSites[ch.tube.side].mal5, n: [0, 1, 0] };
        const dir = vec3.norm(vec3.add(vec3.scale(f.n, -1), vec3.scale([1, 0, 0], 0.9)));
        inst('chestDrain', vec3.add(f.p, vec3.scale(dir, 0.11)), vec3.scale(dir, -1), 0, { noHand: true });
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
      } else if (nk.fona?.kind === 'cannula') { inst('needle14G', vec3.add(f.p, vec3.scale(f.n, -0.03)), f.n, 0, { skip: ['steel', 'flash_orange'], noHand: true }); }
    }
    this.gest.draw({ r, fr, seg, blob, scene: this, inst, disc }, this.t);
    if (pc && this.eyeC) {                                          // penlight in a pen grip, swept in from the side onto the eyes and away again
      const sw = clamp((pu - 0.2) / 0.2, 0, 1) * clamp((0.92 - pu) / 0.14, 0, 1), side = this.sideSign || 1;
      const from = vec3.norm([-0.08, 0.6, side * (1.0 - 0.7 * sw)]), tip = vec3.add(this.eyeC, vec3.scale(from, 0.07 + 0.2 * (1 - Math.min(1, pu / 0.2)) + 0.2 * (1 - clamp((1 - pu) / 0.1, 0, 1))));
      inst('needle14G', tip, from, 0, { only: [], toward: vec3.norm([0.6, 0.6, side]) });
      seg(tip, vec3.add(tip, vec3.scale(from, 0.13)), 0.0045, [0.75, 0.77, 0.8], { spec: 0.95 });
      blob(tip, 0.0042, 0.0042, 0.0042, lightOn ? [1, 0.97, 0.85] : [0.6, 0.6, 0.55], lightOn ? { emissive: [1, 0.95, 0.8], noShadow: true } : { noShadow: true });
    }
    // focused echo: the phased-array probe held on the skin (axis tilted by the operator), gel, orientation marker, cable
    if (this.echoProbe) {
      const e = this.echoProbe, a = e.axis, at = (k, v = a) => vec3.add(e.p, vec3.scale(v, k));
      disc(vec3.add(e.p, vec3.scale(e.n, 0.0012)), e.n, e.m, 0.026, 0.018, [0.7, 0.85, 0.95], { alpha: 0.35, spec: 1, noShadow: true });
      seg(at(0.003), at(0.03), 0.013, [0.2, 0.21, 0.24], { spec: 0.6 }); seg(at(0.03), at(0.11), 0.016, [0.14, 0.15, 0.18], { spec: 0.5 });
      blob(vec3.add(at(0.026), vec3.scale(e.m, 0.014)), 0.0035, 0.0035, 0.0035, e.q >= 0.7 ? [0.25, 0.9, 0.55] : [1, 0.75, 0.2], { emissive: e.q >= 0.7 ? [0.1, 0.4, 0.2] : [0.4, 0.3, 0.05] });
      seg(at(0.11), vec3.add(at(0.2), [0, 0.04, 0]), 0.004, [0.1, 0.1, 0.12]);
    }
    // hands-on: the instrument in the hand, the incision being drawn
    const gh = this.ghost || (this.afterGhost && this.t < this.afterGhost.until ? this.afterGhost : null);
    if (gh) { const n = gh.n, q = [gh.p[0] + n[0] * ((gh.lift || 0) - (gh.depth || 0)), gh.p[1] + n[1] * ((gh.lift || 0) - (gh.depth || 0)), gh.p[2] + n[2] * ((gh.lift || 0) - (gh.depth || 0))]; this._instrument(gh.tool, q, n, gh.angle || 0); }
    if (this.cut) { const c = this.cut, mid = c.a.map((v, i) => (v + c.b[i]) / 2), d = vec3.sub(c.b, c.a), L = Math.hypot(...d); if (L > 0.002) { const n = this.normalAt(mid); disc(vec3.add(mid, vec3.scale(n, 0.0014)), n, vec3.scale(d, 1 / L), L / 2, 0.0012, [0.32, 0.02, 0.03], { spec: 0.9 }); } }   // the incision opening as it is drawn
    r.bend = null;
    if (this._resc) this._drawRescuers(this._resc);
    if (this._bagR) this._drawBagger(this._bagR, this._resc.ra.t);
    // hotspot highlight
    if (this.hover && this.hover.equip) { const h = this.hover; r.draw(fr.sph, mat4.multiply(mat4.translation(h.c[0], h.c[1], h.c[2]), mat4.scaling(h.rad, h.rad, h.rad)), { color: [0.2, 0.8, 1.0], alpha: 0.1, emissive: [0.0, 0.12, 0.16], noShadow: true }); }
    // defibrillation flash
    if (this.shockT > 0.25) { r.draw(fr.sph, mat4.multiply(mat4.translation(W.sternum[0], W.sternum[1], W.sternum[2]), mat4.scaling(0.3, 0.3, 0.3)), { color: [1, 1, 1], emissive: [1, 1, 1], alpha: 0.6 }); }
    };
    r.beginShadow(); frame(); r.endShadow();
    r.begin(cam); frame(); r.end();
  }
}
