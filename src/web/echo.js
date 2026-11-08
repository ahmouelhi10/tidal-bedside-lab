// Focused echocardiography exercise: the learner puts the probe on the 3D patient (drag on the chest), turns and tilts it to find
// the five FoCUS views, freezes, measures with calipers or M-mode, and writes the report. The image is a Canvas2D drawing of the
// heart whose sizes, motion, effusion and IVC come from the live engine (echoState in /engine/echo.js); it only reads the patient.
// What reaches the patient record goes through engine events (echo.view / echo.measure / echo.report) so it replays and scores.
import { t } from './i18n.js';
import { echoState, ECHO_VIEWS, ECHO_REPORT } from '/engine/echo.js';

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
const ease = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
const lerp3 = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addS = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const angDiff = (a, b) => { const d = ((a - b) % 360 + 540) % 360 - 180; return Math.abs(d); };

/** Acoustic window of each view, and the probe pose that gives it: marker direction (degrees; 0 = toward the head, 90 = patient's
 *  left, 270 = patient's right) and beam tilt from perpendicular. Standard teaching positions (REF design in docs/VALIDATION.md). */
export const VIEW_WINDOW = { plax: 'para', psax: 'para', a4c: 'apex', subcostal: 'sub', ivc: 'sub' };
export const VIEW_POSE = { plax: { rot: 315, tilt: 10 }, psax: { rot: 45, tilt: 10 }, a4c: { rot: 90, tilt: 35 }, subcostal: { rot: 90, tilt: 65 }, ivc: { rot: 0, tilt: 45 } };
const DEPTH = { plax: 160, psax: 150, a4c: 170, subcostal: 190, ivc: 160 };
/** What each step of the protocol records (measurement ids, see ECHO_MEASURES). */
const STEP_MEASURES = { plax: ['lvef'], psax: [], a4c: ['tapse'], subcostal: ['effusion'], ivc: ['ivc_max', 'ivc_min'] };
const CALIPER_TARGETS = ['lvedd', 'rv_basal', 'tapse', 'effusion', 'ivc_max', 'ivc_min'];

/** Cardiac cycle: LV size factor (1 = end-diastole at the R wave, 0 = end-systole). */
function lvFill(ph) {
  if (ph < 0.33) return 1 - ease(ph / 0.33);
  if (ph < 0.55) return 0.8 * Math.sin((ph - 0.33) / 0.22 * Math.PI / 2);
  if (ph < 0.82) return 0.8 + 0.05 * (ph - 0.55) / 0.27;
  return 0.85 + 0.15 * ease((ph - 0.82) / 0.18);
}
function ecgAt(ph) {                                                // stylised lead II for the timing strip
  const g = (c, w, a) => a * Math.exp(-(((ph - c + 1.5) % 1 - 0.5) ** 2) / (2 * w * w));
  return g(0.9, 0.018, 0.15) + g(0, 0.008, 1) - g(0.025, 0.008, 0.25) - g(0.975, 0.007, 0.12) + g(0.27, 0.04, 0.28);
}

// ------------------------------------------------------------------------------------------------ image
class EchoImage {
  constructor(canvas, mcanvas) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.mc = mcanvas; this.mctx = mcanvas.getContext('2d');
    this.lo = document.createElement('canvas'); this.lo.width = 300; this.lo.height = 240;
    this.lctx = this.lo.getContext('2d', { willReadFrequently: true });
    this.noise = [0, 1].map(k => this._noise(300, 240, 1234 + k * 977));
  }
  _noise(w, h, seed) {                                              // speckle texture (deterministic LCG; visual only)
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d'), im = x.createImageData(w, h);
    let s = seed >>> 0; const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < w * h; i++) { const v = Math.min(255, 70 + 220 * Math.pow(r(), 1.7) + (r() < 0.04 ? 60 : 0)); im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
    x.putImageData(im, 0, 0); return cv;
  }
  fit() {
    for (const cv of [this.c, this.mc]) {
      const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
      if (w && h && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; }
    }
  }
  /** geometry of the sector on the low-res tissue canvas: apex, mm -> px */
  geo(depth) { const L = this.lo; return { ax: L.width / 2, ay: 6, k: (L.height - 12) / depth, half: 0.66 }; }

  /** Draw one frame. f: { view, q, dr, s, ph, resp, sniff, wall, depth, frozen } */
  render(f) {
    this.fit();
    const L = this.lctx, lo = this.lo, depth = f.depth, G = this.geo(depth);
    L.setTransform(1, 0, 0, 1, 0, 0); L.globalCompositeOperation = 'source-over'; L.filter = 'none';
    L.fillStyle = '#000'; L.fillRect(0, 0, lo.width, lo.height);
    L.save();
    L.translate(G.ax, G.ay); L.scale(G.k, G.k);                     // now in mm: x lateral (screen right +), y depth
    if (f.view && f.q > 0.08) {
      L.fillStyle = '#191919'; L.fillRect(-120, 0, 240, depth + 10);            // surrounding tissue (mediastinum, lung edges) gives the fan its grey
      L.fillStyle = 'rgba(255,255,255,.035)'; for (let i = 0; i < 7; i++) L.fillRect(-120, 20 + i * 22 + 4 * Math.sin(i * 3.1), 240, 6);
      L.rotate((f.off || 0) * Math.PI / 180);
      L.translate(0, f.wall);
      ({ plax: drawPlax, psax: drawPsax, a4c: drawA4c, subcostal: drawSubcostal, ivc: drawIvc })[f.view](L, f);
      L.translate(0, -f.wall);
      L.rotate(-(f.off || 0) * Math.PI / 180);
      L.fillStyle = '#4a4a4a'; L.fillRect(-120, 0, 240, f.wall);      // chest wall
      L.fillStyle = '#9a9a9a'; L.fillRect(-120, f.wall * 0.35, 240, 1.2); L.fillRect(-120, f.wall * 0.8, 240, 1.0);
    } else {                                                        // no window: ribs and lung (A-lines, shadows)
      L.fillStyle = '#3a3a3a'; L.fillRect(-120, 0, 240, f.wall);
      for (let i = 1; i < 6; i++) { L.fillStyle = `rgba(150,150,150,${0.5 / i})`; L.fillRect(-120, f.wall + i * (f.wall + 8), 240, 2.4); }
      L.fillStyle = '#000'; L.fillRect(-30 + 10 * Math.sin(f.ph * 2), f.wall, 18, depth);
    }
    L.restore();
    // speckle and attenuation
    L.globalCompositeOperation = 'multiply';
    const nz = this.noise[(f.tick || 0) % 2]; L.drawImage(nz, ((f.tick || 0) * 7) % 3 - 1, ((f.tick || 0) * 5) % 3 - 1);
    const grad = L.createLinearGradient(0, 0, 0, lo.height); grad.addColorStop(0, '#fff'); grad.addColorStop(1, `rgb(${Math.round(150 + 60 * f.q)},${Math.round(150 + 60 * f.q)},${Math.round(150 + 60 * f.q)})`);
    L.fillStyle = grad; L.fillRect(0, 0, lo.width, lo.height);
    L.globalCompositeOperation = 'source-over';
    if (f.q < 0.9) { L.globalAlpha = clamp(0.95 - f.q, 0, 0.85); L.drawImage(this.noise[1 - (f.tick || 0) % 2], 3, 0); L.globalAlpha = 1; }   // off-axis: clutter
    // to the screen, inside the sector
    const C = this.ctx, W = this.c.width, H = this.c.height;
    C.setTransform(1, 0, 0, 1, 0, 0); C.fillStyle = '#000'; C.fillRect(0, 0, W, H);
    const s = Math.min(W / lo.width, H / lo.height), ox = (W - lo.width * s) / 2;
    C.save(); C.beginPath();
    const ax = ox + G.ax * s, ay = G.ay * s, R = (lo.height - 6) * s;
    C.moveTo(ax, ay); C.arc(ax, ay, R, Math.PI / 2 + G.half, Math.PI / 2 - G.half, true); C.closePath(); C.clip();
    C.filter = `blur(${(0.6 + 2.2 * (1 - f.q)) * s * 0.5}px) brightness(1.55) contrast(1.3)`;
    C.drawImage(lo, ox, 0, lo.width * s, lo.height * s); C.filter = 'none'; C.restore();
    // overlays: depth scale, orientation marker, M-mode cursor
    C.fillStyle = '#9fb3c8'; C.font = `${11 * s * 0.45}px system-ui, sans-serif`;
    for (let d = 0; d <= depth; d += 10) { const y = (G.ay + d * G.k) * s; C.fillRect(W - 14 * s * 0.4, y, d % 50 ? 4 : 9, 1.5); if (d % 50 === 0 && d) C.fillText(String(d / 10), W - 34 * s * 0.4, y + 4); }
    C.beginPath(); C.arc(ax + R * Math.sin(G.half) * 0.92, ay + 10, 4 * s * 0.5, 0, Math.PI * 2); C.fillStyle = '#ffc23d'; C.fill();   // screen marker (right)
    if (f.mmode != null) {
      const a = f.mmode; C.strokeStyle = 'rgba(76,195,255,.85)'; C.setLineDash([6, 5]); C.lineWidth = 1.5;
      C.beginPath(); C.moveTo(ax, ay); C.lineTo(ax + Math.sin(a) * R, ay + Math.cos(a) * R); C.stroke(); C.setLineDash([]);
    }
    this._s = s; this._ox = ox; this._G = G;
  }
  /** client point -> image mm (relative to the sector apex) */
  toMm(cx, cy) {
    const r = this.c.getBoundingClientRect(), dpr = this.c.width / Math.max(1, r.width), x = (cx - r.left) * dpr, y = (cy - r.top) * dpr;
    const G = this._G, s = this._s; if (!G) return null;
    return { x: ((x - this._ox) / s - G.ax) / G.k, y: (y / s - G.ay) / G.k, px: x, py: y };
  }
  fromMm(x, y) { const G = this._G, s = this._s; return { px: this._ox + (G.ax + x * G.k) * s, py: (G.ay + y * G.k) * s }; }
  /** M-mode: sample the tissue canvas along the cursor ray and scroll the trace */
  mmodeSample(angle, depth, speed = 2) {
    const M = this.mctx, W = this.mc.width, H = this.mc.height, G = this.geo(depth);
    if (!W || !H) return;
    const img = this.lctx.getImageData(0, 0, this.lo.width, this.lo.height).data;
    M.drawImage(this.mc, -speed, 0);
    const col = M.createImageData(speed, H);
    for (let y = 0; y < H; y++) {
      const d = (y / H) * depth, px = Math.round(G.ax + Math.sin(angle) * d * G.k), py = Math.round(G.ay + Math.cos(angle) * d * G.k);
      const v = px >= 0 && py >= 0 && px < this.lo.width && py < this.lo.height ? img[(py * this.lo.width + px) * 4] : 0;
      for (let k = 0; k < speed; k++) { const i = (y * speed + k) * 4; col.data[i] = col.data[i + 1] = col.data[i + 2] = Math.min(255, v * 1.8); col.data[i + 3] = 255; }
    }
    M.putImageData(col, W - speed, 0);
    this.mDepth = depth;
  }
  clearM() { this.mctx.fillStyle = '#000'; this.mctx.fillRect(0, 0, this.mc.width, this.mc.height); }
}

// ------------------------------------------------------------------------------------------------ anatomy (mm, apex of the sector at 0,0)
const MYO = '#8c8c8c', MYO2 = '#a4a4a4', BLOOD = '#0a0a0a', PERI = '#ececec', VALVE = '#d2d2d2', LIVER = '#6c6c6c';
function poly(L, pts, fill) { L.beginPath(); pts.forEach(([x, y], i) => (i ? L.lineTo(x, y) : L.moveTo(x, y))); L.closePath(); L.fillStyle = fill; L.fill(); }
function ellipse(L, x, y, rx, ry, fill, rot = 0) { L.beginPath(); L.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), rot, 0, Math.PI * 2); L.fillStyle = fill; L.fill(); }
function lvDiam(s, ph) { return s.perfusing ? s.lvesd + (s.lvedd - s.lvesd) * lvFill(ph) : s.lvedd; }
const sysPh = (ph) => ph < 0.36;                                    // ventricular systole

function drawPlax(L, f) {
  const s = f.s, ph = f.ph, d = lvDiam(s, ph), wall = 9 + 3 * (1 - (d - s.lvesd) / Math.max(1, s.lvedd - s.lvesd)), eff = s.effusionMm;
  const effA = eff * 0.35, rv = s.rvMid * 0.8 * (s.perfusing ? 0.92 + 0.08 * lvFill(ph) : 1);
  let y = 4 + effA;
  if (effA > 0.5) { L.fillStyle = PERI; L.fillRect(-90, 2, 180, 2); }
  L.fillStyle = MYO; L.fillRect(-90, y, 140, 5); y += 5;                                   // RV free wall
  L.fillStyle = BLOOD; L.fillRect(-85, y, 135, rv); y += rv;                  // RVOT
  const yS = y; poly(L, [[-90, yS], [55, yS - 4], [55, yS + 6], [-90, yS + wall]], MYO);     // septum, continuous with the anterior aortic wall
  const yL = yS + wall;
  // LV cavity tapering to the apex (screen left)
  L.beginPath(); L.moveTo(-80, yL + d * 0.5); L.quadraticCurveTo(-70, yL, -40, yL); L.lineTo(18, yL - 2); L.lineTo(18, yL + d + 2); L.lineTo(-40, yL + d); L.quadraticCurveTo(-70, yL + d, -80, yL + d * 0.5); L.fillStyle = BLOOD; L.fill();
  // posterior wall, effusion, pericardium
  const yP = yL + d; L.fillStyle = MYO; L.beginPath(); L.moveTo(-80, yP - d * 0.4); L.quadraticCurveTo(-60, yP + wall, -30, yP + wall); L.lineTo(30, yP + wall); L.lineTo(30, yP); L.lineTo(-40, yP); L.closePath(); L.fill();
  const yE = yP + wall; if (eff > 0.3) { L.fillStyle = BLOOD; L.fillRect(-80, yE, 112, eff); }
  L.fillStyle = PERI; L.fillRect(-85, yE + eff, 125, 3);
  // aortic root and left atrium (screen right)
  const ao = 30, yAo = yS + 1;
  L.fillStyle = BLOOD; L.fillRect(28, yAo + 4, 70, ao - 4);
  L.fillStyle = MYO2; L.fillRect(28, yAo + ao, 70, 4);
  const yLa = yAo + ao + 4, la = 34; ellipse(L, 58, yLa + la / 2, 30, la / 2, BLOOD);
  L.fillStyle = PERI; L.fillRect(28, yLa + la + 1, 70, 3);
  if (s.perfusing && sysPh(ph)) { L.fillStyle = VALVE; L.fillRect(34, yAo + 5, 1.5, 6); L.fillRect(34, yAo + ao - 6, 1.5, 6); }   // open aortic cusps
  else { L.strokeStyle = VALVE; L.lineWidth = 1.5; L.beginPath(); L.moveTo(34, yAo + 5); L.lineTo(40, yAo + ao / 2); L.lineTo(34, yAo + ao - 1); L.stroke(); }
  // mitral leaflets: open toward the septum in diastole, coapting in systole
  const open = s.perfusing && !sysPh(ph) ? (ph < 0.55 ? 1 : ph < 0.8 ? 0.55 : 0.9) : 0;
  L.strokeStyle = VALVE; L.lineWidth = 2; L.beginPath();
  L.moveTo(26, yAo + ao + 2); L.lineTo(26 - 22 * (0.6 + 0.4 * open), yAo + ao + 2 + (d * 0.5) * (1 - open) - 12 * open);
  L.moveTo(24, yP); L.lineTo(24 - 12, yP - (d * 0.45) * (1 - open) - 2);
  L.stroke();
}
function drawPsax(L, f) {
  const s = f.s, ph = f.ph, d = lvDiam(s, ph), r = d / 2, wall = 9 + 4 * (1 - (d - s.lvesd) / Math.max(1, s.lvedd - s.lvesd)), eff = s.effusionMm;
  const rvT = s.rvMid * 0.7 * (s.perfusing ? 0.9 + 0.1 * lvFill(ph) : 1), cx = 4, cy = 14 + rvT + wall + r + eff * 0.3;
  const R = r + wall;
  // pericardium and effusion
  if (eff > 0.3) ellipse(L, cx - 4, cy, R + rvT * 0.5 + eff + 6, R + eff + 2, BLOOD);
  L.strokeStyle = PERI; L.lineWidth = 2.6; L.beginPath(); L.ellipse(cx - 4, cy, R + rvT * 0.5 + eff + 7, R + eff + 3, 0, 0, Math.PI * 2); L.stroke();
  // RV crescent (screen left / anterior)
  L.fillStyle = MYO; L.beginPath(); L.ellipse(cx - 10, cy - 4, R + rvT + 4, R + 6, 0, Math.PI * 0.62, Math.PI * 1.62); L.fill();
  L.fillStyle = BLOOD; L.beginPath(); L.ellipse(cx - 9, cy - 3, R + rvT, R + 2, 0, Math.PI * 0.66, Math.PI * 1.58); L.fill();
  // LV myocardium ring, cavity (D-shaped when the RV is pressure-loaded)
  ellipse(L, cx, cy, R, R, MYO);
  L.beginPath();
  if (s.dShape) { const a0 = Math.PI * 0.72, a1 = Math.PI * 1.36; L.ellipse(cx, cy, r, r, 0, a1, a0 + Math.PI * 2, false); L.closePath(); }
  else L.ellipse(cx, cy, r, r, 0, 0, Math.PI * 2);
  L.fillStyle = BLOOD; L.fill();
  if (s.dShape) { L.fillStyle = MYO; L.fillRect(cx + r * Math.cos(Math.PI * 0.72) - 2, cy + r * Math.sin(Math.PI * 1.36), 4, r * 1.6); }
  // papillary muscles
  ellipse(L, cx + r * 0.45, cy + r * 0.55, 3.5, 3, MYO2); ellipse(L, cx - r * 0.35, cy + r * 0.62, 3.5, 3, MYO2);
}
/** Apical four-chamber, apex at the top: LV on the screen right, RV on the left, atria in the far field. */
function heart4(L, f, apexY = 6) {
  const s = f.s, ph = f.ph, d = lvDiam(s, ph), eff = s.effusionMm, fill = s.perfusing ? lvFill(ph) : 1;
  const len = 78 * Math.cbrt(s.lvedd / 50) * (0.93 + 0.07 * fill), crux = apexY + len, rvW = s.rvBasal * (s.perfusing ? 0.86 + 0.14 * fill : 1);
  const sep = 9, w = 9;
  // TAPSE: the lateral tricuspid annulus moves toward the transducer by the excursion during systole (radially, so M-mode reads it exactly)
  const ex = s.perfusing ? s.tapse * (1 - fill) : 0;
  const ann0 = [-(sep / 2 + rvW + w * 0.4), crux], rr = Math.hypot(ann0[0], ann0[1]), ann = [ann0[0] * (rr - ex) / rr, ann0[1] * (rr - ex) / rr];
  const rvColl = s.rvCollapse && !sysPh(ph) && ph < 0.75 ? 0.35 : 0, raColl = s.raCollapse && sysPh(ph) ? 0.45 : 0;
  // pericardium and effusion around the ventricles
  const lx = (k, add) => sep / 2 + d * k + add;                    // LV lateral boundary: the LV diameter is measured septum to lateral wall
  if (eff > 0.3) { L.beginPath(); L.moveTo(0, apexY - eff - 2); L.bezierCurveTo(lx(1.15, 24 + eff), apexY + 10, lx(1, 22 + eff), crux, lx(0.85, 18 + eff), crux + 4); L.lineTo(ann[0] - 18 - eff, crux + 4); L.bezierCurveTo(ann[0] - 20 - eff, crux - 20, -30 - eff, apexY + 10, 0, apexY - eff - 2); L.fillStyle = BLOOD; L.fill(); }
  L.strokeStyle = PERI; L.lineWidth = 2.4; L.beginPath(); L.moveTo(0, apexY - eff - 4); L.bezierCurveTo(lx(1.15, 26 + eff), apexY + 10, lx(1, 24 + eff), crux, lx(0.85, 20 + eff), crux + 6); L.moveTo(0, apexY - eff - 4); L.bezierCurveTo(-32 - eff, apexY + 10, ann[0] - 22 - eff, crux - 20, ann[0] - 20 - eff, crux + 6); L.stroke();
  // ventricles: myocardium shell then cavities
  L.fillStyle = MYO; L.beginPath(); L.moveTo(0, apexY); L.bezierCurveTo(lx(1.15, 14), apexY + 10, lx(1, 12), crux - 10, lx(0.85, 9), crux); L.lineTo(ann[0] - 8, ann[1]); L.bezierCurveTo(ann[0] - 10 + rvColl * rvW, crux - 30, -24, apexY + 18, 0, apexY); L.fill();
  L.fillStyle = BLOOD; L.beginPath(); L.moveTo(sep / 2 + 2, apexY + w); L.bezierCurveTo(lx(1.15, 0), apexY + 18, lx(1, 0), crux - 14, lx(0.85, 0), crux); L.lineTo(sep / 2, crux); L.closePath(); L.fill();   // LV
  L.beginPath(); L.moveTo(-sep / 2 - 2, apexY + w + 14); L.lineTo(-sep / 2, crux); L.lineTo(ann[0], ann[1]); L.bezierCurveTo(ann[0] + 4 + rvColl * rvW * 1.2, crux - 30, -16, apexY + 30, -sep / 2 - 2, apexY + w + 14); L.fill();   // RV
  // atria (far field): RA screen left, LA screen right; RA free wall inverts in systole with tamponade
  const at = 40, yA = crux + 3;
  ellipse(L, -sep / 2 - 20, yA + at / 2, 22, at / 2 + 2, MYO); ellipse(L, sep / 2 + 21, yA + at / 2, 23, at / 2 + 2, MYO);
  ellipse(L, -sep / 2 - 20, yA + at / 2, 18 - raColl * 8, at / 2 - 1, BLOOD); ellipse(L, sep / 2 + 21, yA + at / 2, 19, at / 2 - 1, BLOOD);
  if (raColl) ellipse(L, -sep / 2 - 37 + raColl * 6, yA + at / 2, 6, 9, MYO);
  L.fillStyle = PERI; L.fillRect(-60, yA + at + 3, 120, 2.5);
  // AV valves: open in diastole
  const open = s.perfusing && !sysPh(ph) ? (ph < 0.55 ? 1 : ph < 0.8 ? 0.5 : 0.85) : 0;
  L.strokeStyle = VALVE; L.lineWidth = 1.8; L.beginPath();
  for (const [x0, x1] of [[sep / 2, lx(0.85, 0)], [-sep / 2, ann[0]]]) { const m = (x0 + x1) / 2, hw = (x1 - x0) / 2; L.moveTo(x0, crux); L.lineTo(m - hw * 0.15 * (1 - open) + (x0 - m) * 0.2 * open, crux - 14 * open - 2); L.moveTo(x1, x1 === ann[0] ? ann[1] : crux); L.lineTo(m + hw * 0.15 * (1 - open) + (x1 - m) * 0.2 * open, crux - 14 * open - 2); }
  L.stroke();
  return { crux, ann };
}
function drawA4c(L, f) { heart4(L, f, 8); }
function drawSubcostal(L, f) {
  L.fillStyle = LIVER; L.beginPath(); L.moveTo(-110, 0); L.lineTo(70, 0); L.quadraticCurveTo(20, 40, -110, 70); L.closePath(); L.fill();   // liver (near field, screen left)
  L.save(); L.translate(-8, 105); L.rotate(Math.PI / 2 - 0.22); L.scale(0.95, 0.95); L.translate(0, -60); heart4(L, f, 8); L.restore();
}
function drawIvc(L, f) {
  const D = f.ivcD, yc = 62;
  L.fillStyle = LIVER; L.fillRect(-110, 0, 220, 140);
  L.fillStyle = '#5c5c5c'; for (let i = 0; i < 6; i++) ellipse(L, -70 + i * 26, 30 + (i % 3) * 25, 9, 3, '#7a7a7a');
  // IVC from the abdomen (screen left) into the right atrium (screen right)
  L.fillStyle = '#9a9a9a'; L.beginPath(); L.moveTo(-100, yc - D / 2 - 1.6); L.lineTo(30, yc - D / 2 - 1.6); L.quadraticCurveTo(55, yc - D / 2 - 2, 62, yc - 40); L.lineTo(92, yc - 40); L.quadraticCurveTo(70, yc + D / 2 + 2, 30, yc + D / 2 + 1.6); L.lineTo(-100, yc + D / 2 + 1.6); L.closePath(); L.fill();
  L.fillStyle = BLOOD; L.beginPath(); L.moveTo(-100, yc - D / 2); L.lineTo(30, yc - D / 2); L.quadraticCurveTo(54, yc - D / 2, 64, yc - 38); L.lineTo(90, yc - 38); L.quadraticCurveTo(68, yc + D / 2, 30, yc + D / 2); L.lineTo(-100, yc + D / 2); L.closePath(); L.fill();
  L.strokeStyle = BLOOD; L.lineWidth = 5; L.beginPath(); L.moveTo(-20, 10); L.quadraticCurveTo(-5, yc - 20, 10, yc - D / 2 + 1); L.stroke();   // hepatic vein joining
  ellipse(L, 80, yc - 52, 26, 14, BLOOD);                                                                                                  // right atrium
  L.fillStyle = PERI; L.beginPath(); L.moveTo(40, 140); L.quadraticCurveTo(70, 70, 110, 60); L.lineTo(110, 64); L.quadraticCurveTo(74, 76, 44, 140); L.fill();   // diaphragm
}

// ------------------------------------------------------------------------------------------------ the exercise window
export class EchoLab {
  constructor({ sim, scene, ui }) { this.sim = sim; this.scene = scene; this.ui = ui; this.open = false; }
  get available() { return !!this.scene.world; }

  start() {
    if (this.open) return; const p = this.sim.patient; if (!p) return;
    this.open = true; this.probe = null; this.rot = 0; this.tilt = 0; this.frozen = false; this.cine = []; this.cineAt = 0; this.cal = []; this.calOn = null;
    this.mmode = null; this.sniffT = -9; this.ph = 0; this.rph = 0; this.tick = 0; this.steady = 0; this.lastSaved = null;
    this._build();
    this.img = new EchoImage(this.dom.canvas, this.dom.mcanvas);
    this._hs = this.scene.onHotspot; this.scene.onHotspot = null;                  // clicks on the patient place the probe instead
    const c = this.scene.canvas; this._pd = (e) => this._pointer(e, 'down'); this._pm = (e) => this._pointer(e, 'move'); this._pu = (e) => this._pointer(e, 'up');
    c?.addEventListener('pointerdown', this._pd); c?.addEventListener('pointermove', this._pm); c?.addEventListener('pointerup', this._pu);
    this.scene.frameStepSite?.('L_aal5', 0.85) || this.scene.setCamera?.('chest');
    this._last = performance.now(); this._raf = requestAnimationFrame(this._frame);
  }
  stop() {
    if (!this.open) return;
    this.open = false; cancelAnimationFrame(this._raf); window.removeEventListener('keydown', this._key, true);
    const c = this.scene.canvas; c?.removeEventListener('pointerdown', this._pd); c?.removeEventListener('pointermove', this._pm); c?.removeEventListener('pointerup', this._pu);
    this.scene.onHotspot = this._hs; this.scene.echoProbe = null;
    this.dom.root.remove(); this.dom = null; this.scene.setCamera?.('default');
  }

  /** acoustic windows on this patient's chest, from the GLB landmarks */
  windows() {
    const W = this.scene.world, Lc = this.scene.chestSites?.L; if (!W || !Lc) return null;
    return { para: lerp3(W.sternum, Lc.mcl2, 0.45), apex: lerp3(Lc.aal5, W.sternum, 0.25), sub: lerp3(W.sternum, W.abdomen, 0.38) };
  }
  /** tangent frame at the probe: head direction and the patient's left, projected on the skin */
  _frame3(n) {
    const sgn = this.scene.sideSign || 1, head = norm(addS([1, 0, 0], n, -n[0])), left0 = [0, 0, -sgn], left = norm(addS(left0, n, -dot(left0, n)));
    return { head, left };
  }
  _pointer(e, kind) {
    if (!this.open) return;
    if (kind === 'down') { this._drag = true; }
    if (kind === 'up') this._drag = false;
    if (kind === 'move' && !this._drag) return;
    const h = this.scene.pickBody?.(e.clientX, e.clientY);
    if (!h || ![3, 4, 6].includes(h.region)) return;                             // chest (L, R) and abdomen regions of the realistic body
    this.probe = { p: h.p, n: norm(h.n) };
  }
  _placeAt(win) { const w = this.windows()?.[win]; if (!w) return; this.probe = { p: w, n: this.scene.normalAt?.(w) || [0, 1, 0] }; }
  _nudge(dHead, dLeft) { if (!this.probe) return; const f = this._frame3(this.probe.n); const q = addS(addS(this.probe.p, f.head, dHead), f.left, dLeft); this.probe = { p: q, n: this.scene.normalAt?.(q) || this.probe.n }; }

  /** what the probe sees: best view at the nearest window and its quality 0..1 */
  acquire() {
    const pr = this.probe, win = this.windows(); if (!pr || !win) return { view: null, q: 0 };
    let best = null; for (const [k, w] of Object.entries(win)) { const d = Math.hypot(...sub(pr.p, w)); if (!best || d < best.d) best = { k, d }; }
    const posQ = 1 - smooth(0.02, 0.055, best.d);
    let v = null; for (const view of ECHO_VIEWS.filter(x => VIEW_WINDOW[x] === best.k)) {
      const P = VIEW_POSE[view], dr = angDiff(this.rot, P.rot), dt = Math.abs(this.tilt - P.tilt);
      const oq = Math.max(0, 1 - (dr / 45) ** 2) * Math.max(0, 1 - (dt / 35) ** 2);
      if (!v || oq > v.oq) v = { view, oq, dr: ((this.rot - P.rot + 540) % 360) - 180, dt };
    }
    const bmi = this.sim.patient.body.bmi, habitus = 1 - 0.25 * clamp((bmi - 30) / 20, 0, 1);
    return { view: v.view, q: +(posQ * v.oq * habitus).toFixed(2), off: v.dr * 0.25, win: best.k };
  }

  _frame = (now) => {
    if (!this.open || !this.dom) return;
    const dt = Math.min(0.1, (now - this._last) / 1000); this._last = now;
    const p = this.sim.patient; if (!p || this.sim.finished) { this.stop(); return; }
    const s = echoState(p), run = this.sim.speed > 0;
    if (!this.frozen) {
      if (run) { this.ph = (this.ph + dt * Math.max(0.05, s.hr) / 60 * Math.min(this.sim.speed, 2)) % 1; this.rph = (this.rph + dt * Math.max(4, p.resp.rr || 12) / 60 * Math.min(this.sim.speed, 2)) % 1; }
      this.tick++;
      const a = this.acquire(), view = a.view, depth = view ? DEPTH[view] : 160;
      const insp = this.rph < 0.38 ? Math.sin(this.rph / 0.38 * Math.PI) : 0, sn = clamp(1 - Math.abs(now / 1000 - this.sniffT - 0.6) / 0.6, 0, 1);
      const ivcD = s.ventilated ? s.ivcMax * (1 - s.distension / 100 * (1 - insp)) : Math.min(s.ivcMax * (1 - s.quietCollapse / 100 * insp), s.ivcMax * (1 - s.sniffCollapse / 100 * sn));
      const wall = 12 + 0.6 * clamp(p.body.bmi - 25, -5, 25);
      const fr = { view, q: a.q, off: a.off, s, ph: this.ph, ivcD, wall, depth, tick: this.tick, mmode: this.mmode };
      this.cine.push(fr); if (this.cine.length > 120) this.cine.shift(); this.cineAt = this.cine.length - 1;
      this.img.render(fr);
      if (this.mmode != null) this.img.mmodeSample(this.mmode, depth);
      this.cur = a;
      this._probe3d();
      this.steady = a.q >= 0.7 ? this.steady + dt : 0;
    } else this.img.render({ ...this.cine[this.cineAt], mmode: this.mmode });
    this._overlay(); this._ecg(); this._hud(p);
    this._raf = requestAnimationFrame(this._frame);
  };
  _probe3d() {
    if (!this.probe) { this.scene.echoProbe = null; return; }
    const { p, n } = this.probe, f = this._frame3(n), r = this.rot * Math.PI / 180;
    const m = norm(addS(addS([0, 0, 0], f.head, Math.cos(r)), f.left, Math.sin(r))), e = cross(m, n), tl = this.tilt * Math.PI / 180;
    const axis = norm(addS(addS([0, 0, 0], n, Math.cos(tl)), e, Math.sin(tl)));
    this.scene.echoProbe = { p, n, axis, m, q: this.cur?.q ?? 0 };
  }

  // ---------------------------------------------------------------- calipers and measurements
  _click(e, onM) {
    if (!this.frozen) { this._freeze(true); }
    if (onM) {
      const r = this.dom.mcanvas.getBoundingClientRect(), y = (e.clientY - r.top) / r.height, x = (e.clientX - r.left) / r.width;
      this.cal = (this.cal.length >= 2 || this.calOn !== 'm' ? [] : this.cal).concat([{ x, y }]); this.calOn = 'm';
    } else {
      const q = this.img.toMm(e.clientX, e.clientY); if (!q) return;
      this.cal = (this.cal.length >= 2 || this.calOn !== '2d' ? [] : this.cal).concat([{ x: q.x, y: q.y }]); this.calOn = '2d';
    }
    this._calText();
  }
  get calMm() {
    if (this.cal.length < 2) return null;
    const [a, b] = this.cal;
    if (this.calOn === 'm') return Math.abs(a.y - b.y) * (this.img.mDepth || 160);
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  _calText() {
    const v = this.calMm; this.dom.calVal.textContent = v == null ? t(this.cal.length ? 'ec_cal_second' : 'ec_cal_first') : `${v.toFixed(1)} mm`;
    for (const b of this.dom.calBtns) b.disabled = v == null;
  }
  _overlay() {
    const C = this.img.ctx; if (this.calOn === '2d' && this.cal.length) {
      C.fillStyle = '#ffd34d'; C.strokeStyle = '#ffd34d'; C.lineWidth = 1.5;
      const pts = this.cal.map(c => this.img.fromMm(c.x, c.y)); for (const q of pts) { C.beginPath(); C.arc(q.px, q.py, 5, 0, Math.PI * 2); C.stroke(); C.fillRect(q.px - 7, q.py - 0.75, 14, 1.5); C.fillRect(q.px - 0.75, q.py - 7, 1.5, 14); }
      if (pts.length === 2) { C.setLineDash([4, 4]); C.beginPath(); C.moveTo(pts[0].px, pts[0].py); C.lineTo(pts[1].px, pts[1].py); C.stroke(); C.setLineDash([]); }
    }
    const M = this.img.mctx, W = this.dom.mcanvas.width, H = this.dom.mcanvas.height;
    if (this.calOn === 'm' && this.cal.length && this.frozen) {
      M.save(); M.strokeStyle = '#ffd34d'; M.lineWidth = 1.5;
      for (const c of this.cal) { M.beginPath(); M.moveTo(c.x * W - 12, c.y * H); M.lineTo(c.x * W + 12, c.y * H); M.stroke(); }
      M.restore();
    }
  }
  _record(what, value) {
    const r = this.ui.act({ type: 'echo.measure', what, value: +value.toFixed(1) }, null);
    if (r && r.ok !== false) { this.ui.toast(`${t('ec_m_' + what)}: ${value.toFixed(what === 'lvef' ? 0 : 1)} ${what === 'lvef' ? '%' : 'mm'}`); this._steps(); this._measList(); }
  }
  _saveClip() {
    const a = this.cur; if (!a || !a.view || a.q < 0.25) { this.ui.toast(t('ec_no_image'), true); return; }
    const r = this.ui.act({ type: 'echo.view', view: a.view, quality: a.q }, null);
    if (r && r.ok !== false) { this.lastSaved = a.view; this.ui.toast(a.q >= 0.7 ? t('ec_saved', { v: t('ec_v_' + a.view), q: Math.round(a.q * 100) }) : t('ec_saved_poor', { q: Math.round(a.q * 100) }), a.q < 0.7); this._steps(); }
  }
  _freeze(on = !this.frozen) {
    this.frozen = on; this.dom.freeze.textContent = on ? '▶ ' + t('ec_live') : '❚❚ ' + t('ec_freeze'); this.dom.freeze.classList.toggle('on', on);
    this.dom.scrub.hidden = !on; this.dom.scrub.max = String(Math.max(0, this.cine.length - 1)); this.dom.scrub.value = String(this.cineAt);
    if (!on) { this.cal = []; this.calOn = null; this._calText(); }
  }
  _sniff() {
    const p = this.sim.patient;
    if (p.vent.mode === 'ctrl' || p.arrest.arrested || p.drugs.effects({ inArrest: false }).loc) { this.ui.toast(t('ec_sniff_no'), true); return; }
    this.sniffT = performance.now() / 1000; this.ui.toast(t('ec_sniff_go'));
  }

  // ---------------------------------------------------------------- panels
  _build() {
    const d = this.dom = {};
    const B = (cls, label, fn, title) => el('button', { class: cls, onclick: fn, title: title || label, 'aria-label': title || label, text: label });
    d.vit = el('div', { class: 'br-vit' });
    d.canvas = el('canvas', { class: 'ec-canvas', 'aria-label': t('ec_image') });
    d.ecg = el('canvas', { class: 'ec-ecg', 'aria-hidden': 'true' });
    d.mcanvas = el('canvas', { class: 'ec-mmode', hidden: true, 'aria-label': 'M-mode' });
    d.qual = el('div', { class: 'ec-qual' }, el('i')); d.viewName = el('span', { class: 'ec-vname' });
    d.canvas.addEventListener('click', (e) => this._click(e, false));
    d.mcanvas.addEventListener('click', (e) => this._click(e, true));
    d.canvas.addEventListener('pointermove', (e) => { if (this.mmode != null && e.buttons === 1) { const q = this.img.toMm(e.clientX, e.clientY); if (q) this.mmode = clamp(Math.atan2(q.x, q.y), -0.6, 0.6); } });
    d.freeze = B('ec-k', '❚❚ ' + t('ec_freeze'), () => this._freeze());
    d.scrub = el('input', { type: 'range', min: 0, max: 0, step: 1, class: 'ec-scrub', hidden: true, 'aria-label': t('ec_cine') });
    d.scrub.addEventListener('input', () => { this.cineAt = Number(d.scrub.value); });
    d.mbtn = B('ec-k', t('ec_mmode'), () => { this.mmode = this.mmode == null ? 0 : null; d.mcanvas.hidden = this.mmode == null; d.mbtn.classList.toggle('on', this.mmode != null); if (this.mmode != null) { this.img.fit(); this.img.clearM(); } });
    // probe controls
    d.rotV = el('b', { class: 'ec-rotv' }); d.tiltV = el('b', { class: 'ec-rotv' });
    const tilt = el('input', { type: 'range', min: 0, max: 80, step: 5, value: 0, 'aria-label': t('ec_tilt') });
    tilt.addEventListener('input', () => { this.tilt = Number(tilt.value); }); d.tilt = tilt;
    const rotBy = (k) => { this.rot = (this.rot + k + 360) % 360; };
    const probe = el('div', { class: 'ec-probe' },
      el('div', { class: 'ec-row' }, el('span', { class: 'small muted', text: t('ec_rotate') }), B('ec-k', '⟲', () => rotBy(-15), t('ec_rot_l')), d.rotV, B('ec-k', '⟳', () => rotBy(15), t('ec_rot_r'))),
      el('div', { class: 'ec-row' }, el('span', { class: 'small muted', text: t('ec_tilt') }), tilt, d.tiltV));
    if (!this.scene.asset) probe.append(el('div', { class: 'ec-row' }, el('span', { class: 'small muted', text: t('ec_windows') }), ...['para', 'apex', 'sub'].map(w => B('ec-k', t('ec_w_' + w), () => this._placeAt(w)))));
    // measurement panel
    d.calVal = el('b', { class: 'ec-calv', text: t('ec_cal_first') });
    d.calBtns = CALIPER_TARGETS.map(w => { const b = B('ec-chip', t('ec_m_' + w), () => { const v = this.calMm; if (v != null) this._record(w, v); }); b.disabled = true; return b; });
    d.ef = el('input', { type: 'range', min: 10, max: 85, step: 5, value: 55, 'aria-label': t('ec_m_lvef') }); d.efV = el('b', { text: '55 %' });
    d.ef.addEventListener('input', () => { d.efV.textContent = d.ef.value + ' %'; });
    d.meas = el('ul', { class: 'ec-meas small' });
    // report
    const sel = (k, opts) => el('label', { class: 'f' }, el('span', { text: t('ec_r_' + k) }), d['r_' + k] = el('select', {}, el('option', { value: '', text: '-' }), ...opts.map(o => el('option', { value: String(o), text: t(`ec_r_${k}_${o}`) }))));
    d.report = el('div', { class: 'ec-report' }, sel('lv', ECHO_REPORT.lv), sel('rv', ECHO_REPORT.rv), sel('rap', [...ECHO_REPORT.rap, 'na']), sel('peri', ECHO_REPORT.peri), sel('dx', ECHO_REPORT.dx),
      B('primary wide', t('ec_r_submit'), () => this._submitReport()), d.repOut = el('p', { class: 'small muted' }));
    // tabs
    d.steps = el('ol', { class: 'ec-steps' });
    const tabs = [['proto', t('ec_tab_proto'), el('div', {}, d.steps, el('p', { class: 'small muted', text: t('ec_proto_note') }))],
      ['meas', t('ec_tab_meas'), el('div', { class: 'ec-measp' }, el('p', { class: 'small muted', text: t('ec_cal_help') }), el('div', { class: 'ec-row' }, el('span', { class: 'small', text: t('ec_cal') }), d.calVal), el('div', { class: 'ec-chips' }, ...d.calBtns),
        el('div', { class: 'ec-row' }, el('span', { class: 'small', text: t('ec_ef_eye') }), d.ef, d.efV), B('ec-chip', t('ec_ef_rec'), () => this._record('lvef', Number(d.ef.value))), el('h4', { text: t('ec_recorded') }), d.meas,
        el('details', { class: 'small muted' }, el('summary', { text: t('ec_norms') }), el('ul', {}, ...['ec_n_ef', 'ec_n_tapse', 'ec_n_rv', 'ec_n_ivc', 'ec_n_vent'].map(k => el('li', { text: t(k) })))))],
      ['rep', t('ec_tab_rep'), d.report]];
    d.tabBtns = tabs.map(([k, label]) => B('ec-tab', label, () => this._tab(k)));
    d.tabBodies = Object.fromEntries(tabs.map(([k, , body]) => [k, el('div', { class: 'ec-tabbody', hidden: k !== 'proto' }, body)]));
    d.root = el('div', { class: 'echo', role: 'dialog', 'aria-label': t('ec_title') },
      el('header', { class: 'br-head' }, el('b', { text: t('ec_title') }), d.vit, B('x', '×', () => this.stop(), t('ec_close'))),
      el('div', { class: 'ec-body' },
        el('div', { class: 'ec-main' },
          el('div', { class: 'ec-view' }, d.canvas, el('div', { class: 'ec-top' }, d.viewName, d.qual)),
          d.ecg, d.mcanvas,
          el('div', { class: 'ec-tools' }, d.freeze, d.mbtn, B('ec-k', t('ec_sniff'), () => this._sniff(), t('ec_sniff_t')), B('ec-k primary', t('ec_save'), () => this._saveClip())), d.scrub, probe),
        el('div', { class: 'ec-side' }, el('div', { class: 'ec-tabs', role: 'tablist' }, ...d.tabBtns), ...Object.values(d.tabBodies))),
      el('footer', { class: 'br-foot small muted', text: t('ec_hint') }));
    document.body.append(d.root);
    this._tab('proto'); this._steps(); this._measList(); this._calText();
    this._key = (e) => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      const k = e.key, map = { q: () => rotBy(-15), Q: () => rotBy(-15), e: () => rotBy(15), E: () => rotBy(15), ArrowUp: () => this._nudge(0.01, 0), ArrowDown: () => this._nudge(-0.01, 0), ArrowLeft: () => this._nudge(0, 0.01), ArrowRight: () => this._nudge(0, -0.01),
        w: () => { tilt.value = String(Math.min(80, this.tilt + 5)); this.tilt = Number(tilt.value); }, s: () => { tilt.value = String(Math.max(0, this.tilt - 5)); this.tilt = Number(tilt.value); }, f: () => this._freeze(), F: () => this._freeze(), Enter: () => this._saveClip(), Escape: () => this.stop() };
      if (map[k]) { map[k](); e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', this._key, true);
  }
  _tab(k) { this.dom.tabBtns.forEach((b, i) => b.classList.toggle('on', ['proto', 'meas', 'rep'][i] === k)); for (const [n, b] of Object.entries(this.dom.tabBodies)) b.hidden = n !== k; }
  _steps() {
    const p = this.sim.patient, L = this.dom?.steps; if (!L || !p) return;
    const saved = new Set(p.echo.views.filter(v => v.quality >= 0.7).map(v => v.view)), meas = new Set(p.echo.measures.map(m => m.what));
    L.replaceChildren(...ECHO_VIEWS.map((v, i) => {
      const ms = STEP_MEASURES[v], done = saved.has(v) && ms.every(m => meas.has(m) || (m === 'effusion'));
      return el('li', { class: done ? 'done' : saved.has(v) ? 'part' : '' }, el('b', { text: `${i + 1}. ${t('ec_v_' + v)}` }), el('span', { class: 'small muted', text: t('ec_how_' + v) }),
        el('span', { class: 'small', text: t('ec_look_' + v) }));
    }), el('li', { class: p.echo.reports.length ? 'done' : '' }, el('b', { text: `6. ${t('ec_tab_rep')}` }), el('span', { class: 'small muted', text: t('ec_how_rep') })));
  }
  _measList() {
    const p = this.sim.patient, L = this.dom?.meas; if (!L || !p) return;
    const last = {}; for (const m of p.echo.measures) last[m.what] = m.value;
    L.replaceChildren(...(Object.keys(last).length ? Object.entries(last).map(([k, v]) => el('li', { text: `${t('ec_m_' + k)}: ${v} ${k === 'lvef' ? '%' : 'mm'}` })) : [el('li', { class: 'muted', text: t('ec_none') })]));
  }
  _submitReport() {
    const d = this.dom, v = (k) => d['r_' + k].value;
    if (['lv', 'rv', 'rap', 'peri', 'dx'].some(k => !v(k))) { d.repOut.textContent = t('ec_r_incomplete'); return; }
    const ev = { type: 'echo.report', lv: v('lv'), rv: v('rv'), rap: v('rap') === 'na' ? null : Number(v('rap')), peri: v('peri'), dx: v('dx') };
    const r = this.ui.act(ev, t('ec_r_saved'));
    if (r && r.ok !== false) { d.repOut.replaceChildren(el('span', { text: t('ec_r_done') + ' ' }), el('button', { class: 'ghost', onclick: () => { this.stop(); this.ui.onFinish?.(); }, text: t('ec_finish') })); this._steps(); }
  }
  _hud(p) {
    const m = p.monitor, f = (v, u = '') => (v == null ? '--' : v + u);
    const chips = [['HR', f(m.hr), 'hr'], ['SpO₂', f(m.spo2, '%'), 'sp'], [t('ec_bp'), m.sbp == null ? '--' : `${m.sbp}/${m.dbp}`, 'co']];
    if (!this.dom.vitEls) this.dom.vitEls = chips.map(([k, , c]) => { const v = el('b'); this.dom.vit.append(el('span', { class: 'br-v ' + c }, el('i', { text: k }), v)); return v; });
    chips.forEach(([, v], i) => { this.dom.vitEls[i].textContent = v; });
    const a = this.cur || { q: 0 }, q = this.frozen ? (this.cine[this.cineAt]?.q ?? 0) : a.q;
    this.dom.qual.firstChild.style.width = `${Math.round(q * 100)}%`; this.dom.qual.classList.toggle('ok', q >= 0.7);
    this.dom.viewName.textContent = !this.probe ? t('ec_place') : q >= 0.5 && a.view ? `${t('ec_v_' + a.view)} · ${Math.round(q * 100)} %` : q > 0.1 ? t('ec_adjust', { q: Math.round(q * 100) }) : t('ec_no_window');
    this.dom.rotV.textContent = `${Math.round(this.rot)}°`; this.dom.tiltV.textContent = `${this.tilt}°`;
  }
  _ecg() {
    const c = this.dom.ecg, x = c.getContext('2d'), dpr = Math.min(2, window.devicePixelRatio || 1), W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (!W || !H) return; if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.strokeStyle = '#3ee08f'; x.lineWidth = 1.4 * dpr; x.beginPath();
    const buf = this.cine, n = buf.length; if (!n) return;
    const s = buf[n - 1].s; if (!s.perfusing && s.rhythm !== 'VF' && s.rhythm !== 'PEA') { x.moveTo(0, H / 2); x.lineTo(W, H / 2); x.stroke(); return; }
    for (let i = 0; i < n; i++) { const X = (i / 119) * W, Y = H * 0.7 - ecgAt(buf[i].ph) * H * 0.55; i ? x.lineTo(X, Y) : x.moveTo(X, Y); }
    x.stroke();
    if (this.frozen) { const X = (this.cineAt / 119) * W; x.fillStyle = '#ffd34d'; x.fillRect(X - 1, 0, 2, H); }
  }
}

