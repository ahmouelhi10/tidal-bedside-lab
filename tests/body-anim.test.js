// The body reacting to events (src/web/body-anim.js): shock jolt, seizure, shivering, fasciculations, coughing, agonal gasps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BodyAnim } from '../src/web/body-anim.js';

const pt = (o = {}, eff = {}) => ({ t: 0, shockLog: [], crises: { seizure: false }, therm: { shivering: 0 }, arrest: { arrested: false, tArrest: 0 }, airway: { device: 'none' },
  drugs: { pk: {}, effects: () => ({ hyp: 0, paralyzed: false, ...eff }) }, ...o });
const run = (p, secs, each, recent = false) => { const b = new BodyAnim(), h = 1 / 120; for (let i = 0; i < secs / h; i++) { p.t += h; each?.(p, i * h); const o = b.update(h, p, recent); if (each) each.out?.(o, i * h); } return b; };
const track = (p, secs, recent = false, step) => { const b = new BodyAnim(), h = 1 / 120, rec = []; for (let i = 0; i < secs / h; i++) { p.t += h; step?.(p, i * h); const o = b.update(h, p, recent); rec.push({ t: i * h, lift: o.lift, arms: o.arms, head: o.head, tremor: [...o.tremor], face: [...o.face], chest: o.chest }); } return rec; };

test('a shock makes the body jump, then it settles', () => {
  const p = pt(); let shot = false;
  const r = track(p, 3, false, (q, t) => { if (!shot && t > 0.5) { q.shockLog.push({ t: q.t }); shot = true; } });
  const peak = Math.max(...r.map(x => x.lift)), arms = Math.max(...r.map(x => x.arms)), head = Math.max(...r.map(x => x.head));
  assert.ok(peak > 0.015 && peak < 0.05, `lift ${peak}`); assert.ok(arms > 0.03 && arms < 0.08, `arms ${arms}`); assert.ok(head > 0.1 && head < 0.3);
  const at = r.find(x => x.lift === peak).t; assert.ok(at > 0.5 && at < 0.8, 'peaks within 0.3 s');
  assert.ok(Math.abs(r.at(-1).lift) < 0.001 && Math.abs(r.at(-1).arms) < 0.002, 'settled');
});

test('an old shock already in the log when the scene starts does not jolt the body', () => {
  const p = pt({ t: 50, shockLog: [{ t: 10 }] }); const r = track(p, 1);
  assert.ok(Math.max(...r.map(x => Math.abs(x.lift))) < 1e-6);
});

test('seizure: strong limb and head shaking at a few Hz, clenched face', () => {
  const all = track(pt({ crises: { seizure: true } }), 10), r = all.at(-1);       // bursts come and go: judge the strongest moment
  const limb = Math.max(...all.map(x => x.tremor[0])), head = Math.max(...all.map(x => x.tremor[1]));
  assert.ok(limb > 0.008 && head > 0.04 && r.tremor[2] > 3 && r.tremor[2] < 6, `${limb} ${head}`); assert.ok(r.face[2] > 0.4);
});

test('shivering: a fine fast tremor that grows with cold; none in arrest', () => {
  const a = track(pt({ therm: { shivering: 0.3 } }), 1).at(-1), b = track(pt({ therm: { shivering: 1 } }), 1).at(-1);
  assert.ok(b.tremor[0] > a.tremor[0] && b.tremor[0] < 0.006 && b.tremor[2] > 8);
  assert.equal(track(pt({ therm: { shivering: 1 }, arrest: { arrested: true, tArrest: 999 } }), 1).at(-1).tremor[0], 0);
});

test('succinylcholine: fasciculations while the block sets in, none once it is established or wearing off', () => {
  let ce = 0; const p = pt(); p.drugs.pk.succinylcholine = { get ce() { return ce; } };
  const r = track(p, 120, false, (q, t) => { ce = t < 40 ? 2 * t / 40 : Math.max(0, 2 - (t - 40) / 30); });
  const during = Math.max(...r.filter(x => x.t > 5 && x.t < 30).map(x => x.tremor[3])), after = Math.max(...r.filter(x => x.t > 50).map(x => x.tremor[3]));
  assert.ok(during > 0.001, String(during)); assert.ok(after < 2e-4, String(after));
});

test('tube in, too light, not paralysed: coughing bouts; none when paralysed or deep', () => {
  const coughs = (eff) => { const r = track(pt({ airway: { device: 'ett' } }, eff), 30); return r.filter((x, i) => i && x.face[0] > 0.6 && r[i - 1].face[0] <= 0.6).length; };
  const n = coughs({ hyp: 0.2 }); assert.ok(n >= 3 && n <= 16, `${n} coughs`);
  assert.equal(coughs({ hyp: 0.2, paralyzed: true }), 0); assert.equal(coughs({ hyp: 0.7 }), 0);
});

test('early arrest without compressions: agonal gasps; none during CPR or after a few minutes', () => {
  const gasps = (tArrest, recent) => { const r = track(pt({ arrest: { arrested: true, tArrest } }), 40, recent); return r.filter((x, i) => i && x.face[1] > 0.5 && r[i - 1].face[1] <= 0.5).length; };
  const n = gasps(30, false); assert.ok(n >= 2 && n <= 6, `${n} gasps`);
  assert.equal(gasps(30, true), 0); assert.equal(gasps(600, false), 0);
});
