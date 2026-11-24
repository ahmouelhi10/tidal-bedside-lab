// CPR quality bar (src/web/cpr-bar.js): what a feedback device shows, read from the real engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scen } from './helpers/bots.js';
import { cprBar, CQ } from '../src/web/cpr-bar.js';

const vf = () => { const p = scen('witnessed_vf', 1); p.run(2); return p; };

test('nothing before CPR starts; good compressions land in every target band', () => {
  const p = vf(); assert.equal(cprBar(p), null);
  p.dispatch({ type: 'cpr.start', mode: 'auto' }); p.run(12);
  const q = cprBar(p);
  assert.equal(q.going, true); assert.equal(q.rate.ok, 'good', `${q.rate.v}`); assert.equal(q.depth.ok, 'good', `${q.depth.v}`);
  assert.ok(q.depth.x > 0.5 && q.depth.x < 0.8 && q.rate.x > 0.3 && q.rate.x < 0.7);
  assert.equal(q.pause, null); assert.ok(q.switchIn > 100 && q.switchIn <= CQ.switchS); assert.equal(q.tip, null);
});

test('shallow, slow compressions are flagged with the first thing to fix', () => {
  const p = vf(); p.dispatch({ type: 'cpr.start', mode: 'auto', opts: { depth: 3.5, rate: 85 } }); p.run(12);
  const q = cprBar(p); assert.equal(q.depth.ok, 'low'); assert.equal(q.rate.ok, 'low'); assert.equal(q.tip, 'cq_tip_harder', 'depth first');
  const r = vf(); r.dispatch({ type: 'cpr.start', mode: 'auto', opts: { rate: 140 } }); r.run(12); assert.equal(cprBar(r).rate.ok, 'high'); assert.equal(cprBar(r).tip, 'cq_tip_slower');
});

test('hands off: the pause is counted, flagged after 10 s; switch due after 2 min; gone once CPR has stopped for a while', () => {
  const p = vf(); p.dispatch({ type: 'cpr.start', mode: 'auto' }); p.run(20); while (!cprBar(p).going) p.run(0.2); p.dispatch({ type: 'cpr.stop' }); p.run(4);
  let q = cprBar(p); assert.equal(q.going, false); assert.ok(q.pause >= 3 && q.pause < 6, `${q.pause}`);
  p.run(CQ.showS + 1); assert.equal(cprBar(p), null, 'stopped for good');
  const s = vf(); s.dispatch({ type: 'cpr.start', mode: 'auto' }); s.run(125);
  while (!cprBar(s).going) s.run(0.5);
  q = cprBar(s); assert.ok(q.switchIn <= 0); assert.ok(['cq_tip_switch', 'cq_tip_harder', 'cq_tip_recoil'].includes(q.tip), q.tip);
  s.dispatch({ type: 'cpr.switch' }); s.run(2); assert.ok(cprBar(s).switchIn > 110, 'a fresh compressor');
});
