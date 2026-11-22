// Gestures of the procedures that used to happen off screen (src/web/gestures.js): intraosseous access, arterial and
// central lines, pericardiocentesis, nasogastric tube. Checked through the draw calls they make on a stub context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gestures } from '../src/web/gestures.js';

const R = -1;                                                         // the patient's right side is -z here
const W = { neck: [0.7, 1.0, 0], rightArmIV: [0.2, 0.92, -0.3], padRight: [0.4, 1.0, -0.12], sternum: [0.45, 1.0, 0], airway: [0.86, 1.0, 0], femoral: [-0.05, 0.95, -0.08] };
const SITES = { ioR: [-0.45, 0.93, -0.1], wristR: [0.15, 0.92, -0.55], ijvR: [0.67, 0.99, -0.035], scvR: [0.55, 1.02, -0.09], femR: [-0.05, 0.95, -0.07], subxiph: [0.33, 1.02, 0.008], nostril: [0.885, 1.04, -0.007] };
const scene = () => ({ t: 0, world: W, sideSign: R, siteFrame: (k) => (SITES[k] ? { p: SITES[k], n: [0, 1, 0] } : null), armAxis: () => [0, 0, -1], surfaceAt: (p) => ({ p, n: [0, 1, 0] }), normalAt: () => [0, 1, 0] });

function record(ev) {
  const g = new Gestures(), sc = scene(), cam = g.start(sc, ev), calls = [], segs = [];
  const c = { scene: { ...sc, hands: { hand_pressL: true } }, inst: (name, p, n, a, opts = {}) => calls.push({ u: c.u, name, p, n, a, opts }), seg: (a, b, rad, col, o = {}) => segs.push({ u: c.u, a, b, rad, col, o }), disc() {}, blob() {} };
  const dur = g.list[0]?.dur || 1;
  for (let i = 0; i <= 200; i++) { c.u = i / 200; g.draw(c, c.u * dur); }
  return { cam, calls, segs, g: g.list[0] };
}
const deg = (axis, n = [0, 1, 0]) => 90 - Math.acos(Math.abs(axis[0] * n[0] + axis[1] * n[1] + axis[2] * n[2]) / Math.hypot(...axis)) * 180 / Math.PI;   // angle to the skin

test('every missing procedure now has a gesture, framed on its site', () => {
  for (const [ev, cam] of [[{ type: 'io.access' }, 'groin'], [{ type: 'procedure.arterial_line' }, 'arm'], [{ type: 'procedure.central_line', site: 'ijv' }, 'neck'],
    [{ type: 'procedure.central_line', site: 'scv' }, 'chest'], [{ type: 'procedure.central_line', site: 'fem' }, 'groin'], [{ type: 'procedure.pericardiocentesis' }, 'chest'], [{ type: 'procedure.ng_tube' }, 'head']]) {
    const r = record(ev); assert.equal(r.cam, cam, ev.type); assert.ok(r.calls.length + r.segs.length > 50, ev.type + ' draws');
  }
});

test('intraosseous: the needle is twisted in square to the bone, then the trocar comes out', () => {
  const { calls } = record({ type: 'io.access' }), inn = calls.filter(x => x.name === 'needle14G' && x.u > 0.32 && x.u < 0.62);
  const rolls = inn.map(x => x.a); assert.ok(Math.max(...rolls) - Math.min(...rolls) > 0.8, 'rotary back-and-forth');
  assert.ok(inn.every(x => deg(x.n) > 75), 'square to the bone');
  assert.ok(calls.filter(x => x.u > 0.75).every(x => x.name !== 'needle14G' || (x.opts.only && x.opts.only.join() === 'steel')), 'only the trocar leaves');
});

test('arterial line goes in steeper than an IV cannula (about 30 vs 20 degrees) and toward the elbow', () => {
  const at = (ev) => record(ev).calls.find(x => x.name === 'ivCannula' && x.u > 0.45 && x.u < 0.55);
  const a = at({ type: 'procedure.arterial_line' }), iv = at({ type: 'iv.access' });
  assert.ok(deg(a.n) > 26 && deg(a.n) < 36 && deg(iv.n) < 24, `${deg(a.n)} vs ${deg(iv.n)}`);
  assert.ok(a.n[2] < 0 && iv.n[2] > 0, 'the two point opposite ways along the forearm');           // n points back toward the hub
});

test('central line: aspirate dark blood once in the vein, then the wire goes through the needle', () => {
  const { segs } = record({ type: 'procedure.central_line', site: 'ijv' });
  const blood = segs.filter(s => s.col[0] < 0.4 && s.col[0] > 0.2 && s.col[1] < 0.05 && s.rad > 0.005);
  assert.ok(blood.length && Math.min(...blood.map(s => s.u)) > 0.3, 'dark venous blood only after the needle is in');
  const wire = segs.filter(s => s.rad < 0.0006); assert.ok(wire.length && Math.min(...wire.map(s => s.u)) >= 0.5, 'wire after the syringe comes off');
});

test('central line directions: jugular toward the feet, femoral toward the head, subclavian shallow', () => {
  const needle = (site) => record({ type: 'procedure.central_line', site }).calls.find(x => x.name === 'syringe' && x.u > 0.4 && x.u < 0.45).n;
  assert.ok(needle('ijv')[0] > 0, 'jugular: syringe trails toward the head, needle toward the feet');
  assert.ok(needle('fem')[0] < 0, 'femoral: needle toward the head');
  assert.ok(deg(needle('scv')) < 20, `subclavian ${deg(needle('scv'))} deg`);
});

test('pericardiocentesis: subxiphoid, aimed at the head and the left shoulder, fills with effusion', () => {
  const { calls, segs } = record({ type: 'procedure.pericardiocentesis' }), s = calls.find(x => x.name === 'syringe' && x.u > 0.6 && x.u < 0.7).n;
  assert.ok(s[0] < 0 && s[2] * R > 0, 'the syringe trails toward the feet and the right, so the needle points at the head and the left shoulder');
  assert.ok(segs.some(x => x.u > 0.7 && x.rad > 0.005 && x.col[0] > 0.5), 'barrel fills');
});

test('nasogastric tube: fed into the nostril in pushes, right hand on it', () => {
  const { calls, segs } = record({ type: 'procedure.ng_tube' });
  assert.ok(segs.some(x => x.a === SITES.nostril), 'tube starts at the nostril');
  const hands = calls.filter(x => x.name === 'bronchoscope' && x.u > 0.3 && x.u < 0.8); assert.ok(hands.length && hands.every(x => x.opts.only?.length === 0), 'hand only');
  const ys = hands.map(x => x.p[1]); assert.ok(Math.max(...ys) - Math.min(...ys) > 0.012, 'push strokes');
});

test('finger weights of the new gestures stay within 0..1', () => {
  for (const ev of [{ type: 'io.access' }, { type: 'procedure.arterial_line' }, { type: 'procedure.central_line', site: 'scv' }, { type: 'procedure.pericardiocentesis' }, { type: 'procedure.ng_tube' }])
    for (const x of record(ev).calls) for (const k of ['act', 'relax']) { const v = x.opts[k]; if (v != null) assert.ok(v >= 0 && v <= 1, `${ev.type} ${x.name} ${k} ${v}`); }
});
