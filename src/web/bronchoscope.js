// Fibre-optic bronchoscopy through the tracheal tube: a floating procedure window with the live scope image (own small WebGL2
// renderer, head-light only, wet mucosa), steering controls, a map of the tree, live vitals, suction and tube-depth adjustment.
// Navigation is visual; what touches the patient goes through engine events (bronch.insert / suction / remove, airway.tube_adjust).
import { mat4 } from './gl/math.js';
import { sphere } from './gl/geometry.js';
import { buildTree, buildAirwayMesh, buildTubeMesh, secretionSpots, regionOf, Scope, V } from './gl/airway.js';
import { t, getLang } from './i18n.js';

const VS = `#version 300 es
in vec3 aPos; in vec3 aNorm; in vec3 aTint;
uniform mat4 uVP; uniform mat4 uM;
out vec3 vP; out vec3 vN; out vec3 vT;
void main(){ vec4 w = uM * vec4(aPos, 1.0); vP = w.xyz; vN = mat3(uM) * aNorm; vT = aTint; gl_Position = uVP * w; }`;
const FS = `#version 300 es
precision highp float;
in vec3 vP; in vec3 vN; in vec3 vT;
uniform vec3 uEye; uniform vec3 uDir; uniform int uMat; uniform vec2 uRes; uniform float uFog; uniform float uGain;
out vec4 o;
float h13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1,0,0)), f.x), mix(h13(i + vec3(0,1,0)), h13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h13(i + vec3(0,0,1)), h13(i + vec3(1,0,1)), f.x), mix(h13(i + vec3(0,1,1)), h13(i + vec3(1,1,1)), f.x), f.y), f.z); }
void main(){
  vec3 n = normalize(vN); vec3 V = uEye - vP; float d = length(V); V /= d;
  if (dot(n, V) < 0.0) n = -n;                                   // we look at every surface from inside the airway
  vec3 base; float shin, ks;
  if (uMat == 0) {                                               // mucosa: pink, paler over cartilage, fine vessels, deeper red distally
    float cart = vT.x, gen = vT.y;
    base = mix(vec3(0.84, 0.40, 0.36), vec3(0.74, 0.28, 0.26), gen);
    base = mix(base, vec3(0.95, 0.78, 0.70), cart * 0.8);
    float v1 = abs(vn(vP * 2.6) * 2.0 - 1.0), v2 = abs(vn(vP * 6.5 + 3.1) * 2.0 - 1.0);
    float vessel = (smoothstep(0.022, 0.0, v1) * 0.7 + 0.45 * smoothstep(0.016, 0.0, v2)) * (1.0 - cart) * smoothstep(0.25, 0.7, vn(vP * 0.9 + 7.0));   // sparse, fine submucosal vessels
    base = mix(base, vec3(0.62, 0.12, 0.13), clamp(vessel, 0.0, 1.0) * 0.45) * (0.92 + 0.1 * vn(vP * 14.0));
    n = normalize(n + (vec3(vn(vP * 9.0), vn(vP * 9.0 + 5.0), vn(vP * 9.0 + 9.0)) - 0.5) * 0.18);
    shin = 70.0; ks = 0.55;
  } else if (uMat == 1) { base = vec3(0.86, 0.78, 0.55); shin = 200.0; ks = 1.3; }   // secretions: glistening, yellowish
  else { base = mix(vec3(0.82, 0.88, 0.9), vec3(0.12, 0.13, 0.15), vT.x); base = mix(base, vec3(0.18, 0.38, 0.85), vT.y); shin = 50.0; ks = 0.5; }   // tube: depth marks, blue line
  float spot = smoothstep(0.15, 0.85, dot(-V, uDir));
  float fall = 1.25 * (0.12 + uGain * uGain * uFog) / (0.12 + d * d * uFog);   // auto-gain: the wall around the tip is always well exposed, depth falls off
  float dif = max(dot(n, V), 0.0), spec = pow(max(dot(n, V), 0.0), shin) * ks;
  vec3 col = base * base * dif * fall * (0.3 + 0.7 * spot) + vec3(1.0, 0.96, 0.9) * spec * fall * spot + base * 0.01;
  vec2 q = gl_FragCoord.xy / uRes - 0.5; col *= 1.0 - smoothstep(0.32, 0.5, length(q)) * 0.85;   // optical vignette
  col = col / (1.0 + col); o = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

class ScopeView {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl; this.canvas = canvas;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.bindAttribLocation(p, 1, 'aNorm'); gl.bindAttribLocation(p, 2, 'aTint'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.p = p; this.u = Object.fromEntries(['uVP', 'uM', 'uEye', 'uDir', 'uMat', 'uRes', 'uFog', 'uGain'].map(k => [k, gl.getUniformLocation(p, k)]));
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    this.ball = this.upload(sphere(1, 1, 1, 14, 10));
  }
  upload(m) {
    const gl = this.gl, vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf = (data, loc, n) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0); return b; };
    const bufs = [buf(m.pos, 0, 3), buf(m.nrm, 1, 3)];
    if (m.tint) bufs.push(buf(m.tint, 2, 3)); else { gl.disableVertexAttribArray(2); gl.vertexAttrib3f(2, 0, 0, 0); }
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, n: m.idx.length, bufs: [...bufs, ib], tint: !!m.tint };
  }
  release(g) { if (!g) return; const gl = this.gl; gl.deleteVertexArray(g.vao); for (const b of g.bufs) gl.deleteBuffer(b); }
  resize() {
    const c = this.canvas, dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }
  /** cam: { eye, dir, up }; items: [{ g, mat, M? }] */
  draw(cam, items) {
    const gl = this.gl; this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clearColor(0.02, 0.005, 0.005, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const proj = mat4.perspective(1.75, this.canvas.width / Math.max(1, this.canvas.height), 0.03, 40);
    this.vp = mat4.multiply(proj, mat4.lookAt(cam.eye, V.add(cam.eye, cam.dir), cam.up));
    gl.useProgram(this.p);
    gl.uniformMatrix4fv(this.u.uVP, false, this.vp); gl.uniform3fv(this.u.uEye, cam.eye); gl.uniform3fv(this.u.uDir, cam.dir);
    gl.uniform2f(this.u.uRes, this.canvas.width, this.canvas.height); gl.uniform1f(this.u.uFog, 0.32); gl.uniform1f(this.u.uGain, cam.gain ?? 0.8);
    for (const it of items) {
      if (!it.g) continue;
      gl.uniformMatrix4fv(this.u.uM, false, it.M || mat4.identity()); gl.uniform1i(this.u.uMat, it.mat);
      gl.bindVertexArray(it.g.vao); if (!it.g.tint) gl.vertexAttrib3f(2, 0, 0, 0);
      gl.drawElements(gl.TRIANGLES, it.g.n, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
  }
  /** world point -> pixel position in the canvas (CSS px), or null when behind */
  project(p) {
    const m = this.vp, x = p[0], y = p[1], z = p[2], w = m[3] * x + m[7] * y + m[11] * z + m[15]; if (w < 0.05) return null;
    const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w, ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    return { x: (nx * 0.5 + 0.5) * this.canvas.clientWidth, y: (0.5 - ny * 0.5) * this.canvas.clientHeight, r: Math.hypot(nx, ny) };
  }
}

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const SVGNS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

export class Bronchoscope {
  constructor({ sim, scene, ui }) { this.sim = sim; this.scene = scene; this.ui = ui; this.open = false; this.cache = null; }
  get lang() { return getLang(); }

  /** Insert the scope (engine event) and open the window. */
  start() {
    const p = this.sim.patient; if (!p || this.open) return;
    const r = this.ui.act({ type: 'bronch.insert' }, t('br_title'));
    if (!r || r.ok === false) return;
    this.open = true; this._build(); this.scene.setCamera('head');
    this.dom.msg.textContent = t('br_loading'); this.dom.msg.hidden = false;
    setTimeout(() => this._load(p), 30);                         // let the window paint before meshing the airway (~0.5 s)
  }
  /** Withdraw the scope and close. */
  stop() {
    if (!this.open) return;
    this.open = false; cancelAnimationFrame(this._raf); window.removeEventListener('keydown', this._key, true);
    if (this.sim.patient?.tube?.scopeIn) this.ui.act({ type: 'bronch.remove' }, t('br_removed'));
    this.dom.root.remove(); this.dom = null; this.scene.setCamera('default');
  }

  _load(p) {
    if (!this.open) return;
    const key = `${p.spec.heightCm}|${p.spec.sex}`;
    try {
      if (!this.view) this.view = new ScopeView(this.dom.canvas);
      if (!this.cache || this.cache.key !== key) {
        if (this.cache) this.view.release(this.cache.wall);
        const tree = buildTree({ heightCm: p.spec.heightCm, sex: p.spec.sex });
        this.cache = { key, tree, wall: this.view.upload(buildAirwayMesh(tree)) };
      }
    } catch (e) { this.dom.msg.textContent = String(e.message || e); return; }
    this.scope = new Scope(this.cache.tree, 0.4); this.tubeKey = null; this.secrKey = null; this.gain = null; this.dom.msg.hidden = true; this.dom.msg.textContent = '';
    this._map(); this._last = performance.now(); this._raf = requestAnimationFrame(this._frame);
  }

  _build() {
    const B = (cls, label, fn, title) => el('button', { class: cls, onclick: fn, title: title || label, 'aria-label': title || label, text: label });
    const hold = (cls, label, dir) => el('button', { class: cls, text: label, onpointerdown: (e) => { e.currentTarget.setPointerCapture(e.pointerId); this.moving = dir; this._moved = 0; }, onpointerup: () => { if (this._moved < 0.15) this.scope?.move(dir * 0.3); this.moving = 0; }, onpointercancel: () => { this.moving = 0; } });
    const d = this.dom = {};
    d.vit = el('div', { class: 'br-vit' });
    d.canvas = el('canvas', { class: 'br-canvas', 'aria-label': t('br_title') });
    d.labels = el('div', { class: 'br-labels' }); d.where = el('div', { class: 'br-where' }); d.msg = el('div', { class: 'br-msg', hidden: true });
    d.mapSvg = sv('svg', { viewBox: '0 0 120 150', class: 'br-map' });
    d.depth = el('b', { class: 'br-depth' }); d.find = el('div', { class: 'br-find small' });
    this.names = true;
    d.names = B('br-chip on', t('br_names'), () => { this.names = !this.names; d.names.classList.toggle('on', this.names); });
    const view = el('div', { class: 'br-view' }, d.canvas, d.labels, d.msg);
    d.root = el('div', { class: 'bronch', role: 'dialog', 'aria-label': t('br_title') },
      el('header', { class: 'br-head' }, el('b', { text: t('br_title') }), d.vit, B('x', '×', () => this.stop(), t('br_remove'))),
      el('div', { class: 'br-body' },
        el('div', { class: 'br-pad' },
          el('div', { class: 'br-cross' },
            B('br-k up', '▲', () => this.scope?.bendBy(-0.12), t('br_bend_up')), B('br-k lf', '⟲', () => this.scope?.roll(-0.15), t('br_roll_l')),
            B('br-k mid', t('br_straight'), () => this.scope?.straighten()), B('br-k rt', '⟳', () => this.scope?.roll(0.15), t('br_roll_r')), B('br-k dn', '▼', () => this.scope?.bendBy(0.12), t('br_bend_dn'))),
          el('p', { class: 'small muted', text: t('br_pad_hint') })),
        el('div', { class: 'br-center' }, view, el('div', { class: 'br-under' }, d.where, d.names)),
        el('div', { class: 'br-side' }, d.mapSvg,
          el('div', { class: 'br-move' }, hold('br-fwd', '▲ ' + t('br_forward'), 1), hold('br-back', '▼ ' + t('br_back'), -1)),
          B('br-suction', t('br_suction'), () => this._suction()),
          el('div', { class: 'br-tube' }, el('span', { class: 'small muted', text: t('br_tube_depth') }), el('div', { class: 'row3' }, B('', '−1', () => this._adjust(-1), t('br_pull')), d.depth, B('', '+1', () => this._adjust(1), t('br_push')))),
          d.find, B('br-remove danger', t('br_remove'), () => this.stop()))),
      el('footer', { class: 'br-foot small muted', text: t('br_hint') }));
    document.body.append(d.root);
    // drag on the image: sideways rotates the scope, up/down bends the tip
    let drag = null;
    d.canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; d.canvas.setPointerCapture(e.pointerId); });
    d.canvas.addEventListener('pointermove', e => { if (!drag || !this.scope) return; this.scope.roll((e.clientX - drag.x) * 0.006); this.scope.bendBy((e.clientY - drag.y) * 0.006); drag = { x: e.clientX, y: e.clientY }; });
    d.canvas.addEventListener('pointerup', () => { drag = null; });
    d.canvas.addEventListener('wheel', e => { e.preventDefault(); this.scope?.move(-Math.sign(e.deltaY) * 0.3); }, { passive: false });
    this._key = (e) => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      const s = this.scope, k = e.key, map = { ArrowUp: () => s?.bendBy(-0.1), ArrowDown: () => s?.bendBy(0.1), ArrowLeft: () => s?.roll(-0.12), ArrowRight: () => s?.roll(0.12), w: () => s?.move(0.3), W: () => s?.move(0.3), s: () => s?.move(-0.3), S: () => s?.move(-0.3), n: () => d.names.click(), N: () => d.names.click(), Escape: () => this.stop() };
      if (map[k]) { map[k](); e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', this._key, true);
  }

  _suction() {
    const p = this.sim.patient, where = regionOf(this.scope?.b.id || 'T');
    const r = this.ui.act({ type: 'bronch.suction', where }, null);
    if (r && r.ok !== false) { this.ui.toast(r.cleared > 0.05 ? t('br_sucked') : t('br_nothing')); this._suckT = performance.now(); }
  }
  _adjust(cm) {
    this.ui.act({ type: 'airway.tube_adjust', cm }, `${t('br_tube_depth')} ${cm > 0 ? '+' : ''}${cm} cm`);   // the scope stays where it is; the tube slides around it
  }

  _frame = (now) => {
    if (!this.open || !this.dom) return;
    const dt = Math.min(0.1, (now - this._last) / 1000); this._last = now;
    const p = this.sim.patient; if (!p || !p.tube.scopeIn) { this.stop(); return; }
    const s = this.scope, tree = this.cache.tree;
    if (this.moving) { s.move(this.moving * 1.2 * dt); this._moved += 1.2 * dt; }
    s.update(dt);
    // tube and secretions follow the engine
    const tip = p.tube.tipAboveCarina, tk = String(tip);
    if (tk !== this.tubeKey) { this.view.release(this.tubeG); const tm = buildTubeMesh(tree, tip); this.tubeG = this.view.upload(tm); this.tubeKey = tk; this.tubeTip = tm.tip; this._map(); }
    const sk = ['trachea', 'R', 'L'].map(k => Math.round(p.tube.secr[k] * 12)).join(',');
    if (sk !== this.secrKey) { this.secrKey = sk; this.blobs = ['trachea', 'R', 'L'].flatMap(k => secretionSpots(tree, k, p.tube.secr[k])); }
    const items = [{ g: this.cache.wall, mat: 0 }, { g: this.tubeG, mat: 2 }];
    for (const b of this.blobs) {
      const ny = b.n, ex = V.norm(V.cross(Math.abs(ny[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], ny)), ez = V.cross(ex, ny);
      items.push({ g: this.view.ball, mat: 1, M: mat4.multiply(mat4.fromBasis(ex, ny, ez, b.p), mat4.scaling(b.size, b.size * 0.35, b.size * 0.8)) });
    }
    const view = s.view, eye = V.add(s.pos, view, -0.05);
    const lumen = this._insideTube(p) ? 0.38 : s.b.r1 + (s.b.r2 - s.b.r1) * (s.s / s.b.len);
    this.gain = (this.gain ?? lumen) + (lumen - (this.gain ?? lumen)) * Math.min(1, dt * 4);   // the camera gain adapts in a fraction of a second
    this.view.draw({ eye, dir: view, up: s.camUp, gain: this.gain * 1.6 }, items);
    this._labels(eye, view); this._hud(p); this._mapDot();
    if (s.msg) { this.dom.msg.textContent = t('br_msg_' + s.msg); this.dom.msg.hidden = false; this._msgT = now; } else if (this._msgT && now - this._msgT > 1600) { this.dom.msg.hidden = true; this._msgT = 0; }
    this.dom.where.textContent = s.where(this.lang) + (this._insideTube(p) ? ' · ' + t('br_in_tube') : '');
    this._raf = requestAnimationFrame(this._frame);
  };
  _insideTube(p) {
    const tip = p.tube.tipAboveCarina, T = this.cache.tree.by.T, s = this.scope;
    if (tip === null) return false;
    if (tip >= 0) return s.b.id === 'T' && s.s < T.len - tip;
    return s.b.id === 'T' || (s.b.id === 'RMB' && s.s < -tip);
  }
  _labels(eye, view) {
    const L = this.dom.labels; L.replaceChildren(); if (!this.names) return;
    const s = this.scope, cand = new Set(s.b.children), placed = [];
    for (const c of s.b.children) if (s.s > s.b.len - 1.2) for (const g of c.children) if (g.at < 0.3 || c.len < 3) cand.add(g);   // the next generation only once close to the fork
    if (s.b.id === 'T' && s.s > s.b.len - 2.5) cand.add({ label: t('br_carina'), a: s.b.b, d: [0, -1, 0] });
    for (const c of cand) {
      const pt = V.add(c.a, c.d, 0.45), rel = V.sub(pt, eye), dist = V.len(rel); if (dist > 5 || V.dot(rel, view) < 0.15) continue;
      const q = this.view.project(pt); if (!q || q.r > 0.85) continue;
      if (placed.some(o => Math.hypot(o.x - q.x, o.y - q.y) < 34)) continue; placed.push(q);   // never stack labels
      L.append(el('span', { class: 'br-lbl', style: `left:${q.x.toFixed(0)}px;top:${q.y.toFixed(0)}px`, text: c.label }));
    }
  }
  _hud(p) {
    const m = p.monitor, f = (v, u = '') => (v == null ? '--' : v + u);
    const chips = [['HR', f(m.hr), 'hr'], ['SpO₂', f(m.spo2, '%'), 'sp'], ['EtCO₂', f(m.etco2), 'co'], [t('br_rr'), f(m.rr), 'rr']];
    if (!this.dom.vitEls) { this.dom.vitEls = chips.map(([k, , c]) => { const v = el('b'); this.dom.vit.append(el('span', { class: 'br-v ' + c }, el('i', { text: k }), v)); return v; }); }
    chips.forEach(([, v], i) => { this.dom.vitEls[i].textContent = v; });
    this.dom.depth.textContent = `${p.tube.depth} cm`;
    const sx = p.tube.secr, sec = Math.max(sx.trachea, sx.R, sx.L);
    this.dom.find.textContent = sec > 0.15 ? t('br_secretions') : '';
  }
  _map() {
    const svg = this.dom?.mapSvg; if (!svg || !this.cache) return; svg.replaceChildren();
    const tree = this.cache.tree, X = (p) => 60 - p[0] * 6.5, Y = (p) => 12 - p[1] * 6.5;   // frontal view: the patient's right on the left
    this._X = X; this._Y = Y;
    for (const b of tree.list) svg.append(sv('line', { x1: X(b.a), y1: Y(b.a), x2: X(b.b), y2: Y(b.b), 'stroke-width': Math.max(1.2, b.r1 * 4.5), class: 'br-mapline', 'data-id': b.id }));
    const tb = this.tubeTip; if (tb) svg.append(sv('circle', { cx: X(tb), cy: Y(tb), r: 2.6, class: 'br-maptube' }));
    svg.append(this._dot = sv('circle', { r: 3.2, class: 'br-mapdot' }));
    const r = sv('text', { x: 5, y: 10, class: 'br-maptxt' }); r.textContent = getLang() === 'fr' ? 'D' : 'R'; const l = sv('text', { x: 108, y: 10, class: 'br-maptxt' }); l.textContent = getLang() === 'fr' ? 'G' : 'L'; svg.append(r, l);
  }
  _mapDot() {
    if (!this._dot) return; const p = this.scope.pos, path = new Set(this.scope.path());
    this._dot.setAttribute('cx', this._X(p)); this._dot.setAttribute('cy', this._Y(p));
    for (const ln of this.dom.mapSvg.querySelectorAll('.br-mapline')) ln.classList.toggle('on', path.has(ln.dataset.id));
  }
}
