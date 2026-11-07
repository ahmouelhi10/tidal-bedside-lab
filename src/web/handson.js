// Hands-on procedures: drag an instrument from the tray onto the patient's skin, then perform the gesture the step asks for.
//   place  : drop it on the site
//   hold   : press and keep it on the site (antisepsis, pressure)
//   stroke : press and draw the incision across the skin
//   push   : press and drag down to advance it to a depth
//   rotate : press and drag sideways to turn it (blade 90 degrees)
// The result (where, how far, how deep, how long) is evaluated by handson-eval.js and handed to the guided step, which
// dispatches the ordinary engine events. Where the engine needs a location (needle side and site, drain side, neck
// approach) the drop point decides it, so a wrong spot has its real consequence.
import { t, getLang } from './i18n.js';
import { evalPlace, evalStroke, evalPush, evalRotate, evalHold, nearestSite, describe } from './handson-eval.js';

const L = (o) => (o ? (getLang() === 'fr' ? o.fr : o.en) ?? o.en : '');
export const TOOLS = {
  syringe: { en: 'Syringe', fr: 'Seringue' }, needle14G: { en: '14 G catheter', fr: 'Cathéter 14 G' }, scalpel: { en: 'Scalpel', fr: 'Bistouri' },
  bougie: { en: 'Bougie', fr: 'Bougie' }, chestDrain: { en: 'Chest drain', fr: 'Drain thoracique' }, forcepsGauze: { en: 'Swab', fr: 'Compresse' },
  tourniquet: { en: 'Tourniquet', fr: 'Garrot' }, ivCannula: { en: 'IV cannula', fr: 'Cathéter IV' }, defibPadRight: { en: 'Pads', fr: 'Électrodes' },
};
const GESTURE_HELP = {
  place: { en: 'Drag it onto the right spot and let go', fr: 'Glissez-le au bon endroit et relâchez' },
  hold: { en: 'Press on it and keep pressing', fr: 'Appuyez dessus et maintenez' },
  stroke: { en: 'Press and draw the incision on the skin', fr: "Appuyez et tracez l'incision sur la peau" },
  push: { en: 'Press and drag down to advance it', fr: 'Appuyez et glissez vers le bas pour avancer' },
  rotate: { en: 'Press and drag sideways to turn it', fr: 'Appuyez et glissez latéralement pour tourner' },
};
const CHEST_KEYS = ['R_mcl2', 'R_mal5', 'R_aal5', 'L_mcl2', 'L_mal5', 'L_aal5'];

export class HandsOn {
  constructor({ scene, ui }) { this.scene = scene; this.ui = ui; this.active = null; this._bind(); }
  get available() { return !!(this.scene.asset && this.scene.instruments); }

  /** Grab an instrument from the instrument table for the current step. onDone(result) gets { res, prm, note }, or null. */
  grab(tool, e, step, prm, onDone) {
    this.end();
    this.active = { step, hand: step.hand, prm: { ...prm }, onDone, phase: 'drag', tool, hit: null, t0: 0 };
    this._chip(); this._move(e);
  }
  end() {
    this.active = null; this.scene.ghost = null; this.scene.canvas.style.cursor = '';
    this.chip?.remove(); this.chip = null;
  }

  /** world position of the step's target (chest sites come from the chosen side and site) */
  _target() {
    const a = this.active, h = a.hand, W = this.scene.world, cs = this.scene.chestSites;
    if (h.target === 'chestSite') return cs?.[a.prm.side || 'R']?.[h.site || a.prm.site || 'mal5'] || W.sternum;
    return W[h.target] || W.sternum;
  }

  _chip(extra = '') {
    const a = this.active; if (!a) return;
    if (!this.chip) {
      this.chip = document.createElement('div'); this.chip.className = 'ho-chip';
      this.chip.append(this.chipTxt = document.createElement('span'), Object.assign(document.createElement('button'), { className: 'ghost', textContent: t('ho_cancel'), onclick: () => { const d = this.active?.onDone; this.end(); d?.(null); } }));
      document.body.append(this.chip);
    }
    const what = a.phase === 'drag' ? L(GESTURE_HELP.place) : L(GESTURE_HELP[a.hand.gesture]);
    this.chipTxt.textContent = what + (extra ? ' · ' + extra : '');
  }

  _bind() {
    const c = this.scene.canvas;
    window.addEventListener('pointermove', (e) => { if (this.active && this.active.phase !== 'pick') this._move(e); }, true);
    window.addEventListener('pointerup', (e) => { if (this.active) this._up(e); }, true);
    // while a gesture is running, the canvas belongs to the instrument (no camera drag, no hotspot clicks)
    c.addEventListener('pointerdown', (e) => { if (this.active && this.active.phase === 'placed') { e.stopImmediatePropagation(); e.preventDefault(); this._down(e); } }, true);
  }
  _hit(e) { return this.scene.pickBody(e.clientX, e.clientY); }
  _move(e) {
    const a = this.active; if (!a) return;
    if (a.phase === 'drag') {
      const h = this._hit(e); a.hit = h;
      this.scene.ghost = h ? { tool: a.tool, p: h.p, n: h.n, depth: 0, angle: 0, lift: 0.04 } : null;
      this.scene.canvas.style.cursor = h ? 'copy' : 'not-allowed';
    } else if (a.phase === 'acting') {
      const g = a.hand.gesture, dx = e.clientX - a.x0, dy = e.clientY - a.y0;
      if (g === 'push') { a.depth = Math.max(0, dy * (a.hand.cmPerPx ?? 0.05)); this.scene.ghost.depth = a.depth / 100; this._chip(`${a.depth.toFixed(1)} cm`); }
      else if (g === 'rotate') { a.angle = dx * 0.6; this.scene.ghost.angle = a.angle * Math.PI / 180; this._chip(`${Math.round(a.angle)}°`); }
      else if (g === 'stroke') { const h = this._hit(e); if (h) { a.end = h.p; this.scene.ghost.p = h.p; this.scene.cut = { a: a.start, b: h.p }; const lc = Math.hypot(h.p[0] - a.start[0], h.p[1] - a.start[1], h.p[2] - a.start[2]) * 100; this._chip(`${lc.toFixed(1)} cm`); } }
    }
  }
  _down(e) {
    const a = this.active; a.phase = 'acting'; a.x0 = e.clientX; a.y0 = e.clientY; a.t0 = performance.now(); a.depth = 0; a.angle = 0; a.start = a.hit.p; a.end = a.hit.p;
    if (a.hand.gesture === 'hold') { this.scene.ghost.lift = 0; this._holdTick(); }
  }
  _holdTick() { const a = this.active; if (!a || a.phase !== 'acting') return; this._chip(`${((performance.now() - a.t0) / 1000).toFixed(1)} s`); requestAnimationFrame(() => this._holdTick()); }
  _up(e) {
    const a = this.active;
    if (a.phase === 'drag') {
      this.scene.canvas.style.cursor = '';
      if (!a.hit) { this.end(); return; }                                          // dropped off the patient: back on the table
      if (a.tool !== a.hand.tool) { this.ui.toast(t('ho_wrong_tool', { tool: L(TOOLS[a.tool]) }), true); this.ui.noteWrongTool?.(a.tool); this.end(); return; }
      this.scene.ghost.lift = 0;
      if (a.hand.gesture === 'place') return this._finish();
      a.phase = 'placed'; this._chip(); return;
    }
    if (a.phase === 'acting') this._finish();
  }

  _finish() {
    const a = this.active, h = a.hand, p = a.hit.p, prm = { ...a.prm };
    // where the engine takes a location, the drop point decides it
    if (h.target === 'chestSite') {
      const sites = Object.fromEntries(CHEST_KEYS.map(k => [k, this.scene.chestSites[k[0]][k.slice(2)]]));
      const allowed = h.site ? Object.fromEntries(Object.entries(sites).filter(([k]) => k.endsWith(h.site))) : sites;
      const n = nearestSite(p, allowed); prm.side = n.key[0]; if (!h.site) prm.site = n.key.slice(2);
    }
    const tgt = h.target === 'chestSite' ? this.scene.chestSites[prm.side][h.site || prm.site] : this._target(), rad = h.radiusCm / 100;
    let res;
    switch (h.gesture) {
      case 'place': res = evalPlace(p, tgt, rad); break;
      case 'hold': res = { ...evalPlace(p, tgt, rad), ...evalHold((performance.now() - a.t0) / 1000, h.holdS ?? 2) }; res.ok = res.ok && res.seconds >= (h.holdS ?? 2); break;
      case 'stroke': {
        const ax = h.axis === 'body' ? [1, 0, 0] : h.axis === 'cross' ? [0, 0, 1] : null;
        res = evalStroke(a.start, a.end, tgt, rad, { minCm: h.minCm, maxCm: h.maxCm, dir: h.axis === 'free' ? null : ax });
        if (h.deriveApproach) { const v = [a.end[0] - a.start[0], a.end[2] - a.start[2]]; prm.approach = Math.abs(v[0]) > Math.abs(v[1]) ? 'vertical' : 'palpate'; }
        break;
      }
      case 'push': res = { ...evalPlace(a.start, tgt, rad), ...evalPush(a.depth, { minCm: h.minCm, maxCm: h.maxCm }) }; res.ok = res.ok && res.depthCm >= h.minCm && res.depthCm <= h.maxCm; break;
      case 'rotate': res = { ...evalPlace(p, tgt, rad), ...evalRotate(a.angle) }; break;
    }
    const done = a.onDone, keepGhost = { ...this.scene.ghost };
    this.end();
    this.scene.afterGhost = { ...keepGhost, until: this.scene.t + 1.2 };            // leave the instrument visible a moment
    done?.({ res, prm, note: describe(res) });
  }
}
