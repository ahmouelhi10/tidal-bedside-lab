import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, buildAirwayMesh, buildTubeMesh, regionOf, Scope, V } from '../src/web/gl/airway.js';

const tree = buildTree({ heightCm: 175, sex: 'M' });

/** steer like a bronchoscopist: rotate the frame toward the next branch, bend the tip just enough, advance */
function drive(target) {
  const sc = new Scope(tree);
  for (let guard = 0; guard < 500; guard++) {
    const nextId = target.find(id => !sc.path().includes(id)); if (!nextId) break;
    const c = tree.by[nextId];
    const near = sc.b.id === c.parent && (c.at >= 0.99 ? sc.s > sc.b.len - 1.2 : Math.abs(sc.s - c.at * sc.b.len) < 0.8);
    if (near) {
      let bestA = 0, bd = -2;
      for (let a = 0; a < 6.28; a += 0.05) { const f = sc.fwd, u = sc.up, s = V.cross(f, u), uu = V.add(V.scale(u, Math.cos(a)), s, Math.sin(a)), d = V.dot(uu, c.d); if (d > bd) { bd = d; bestA = a; } }
      sc.roll(bestA); sc.bend = Math.min(1.3, Math.acos(Math.max(-1, Math.min(1, V.dot(sc.fwd, c.d)))));
    } else sc.bend = 0;
    sc.move(0.2); sc.update(0.1);
  }
  return sc;
}

test('the tree has every lobe and scales with the patient', () => {
  for (const id of ['T', 'RMB', 'RUL', 'BI', 'RML', 'RLL', 'LMB', 'LUL', 'LING', 'LLL', 'RB6', 'LB6']) assert.ok(tree.by[id], id);
  const short = buildTree({ heightCm: 150, sex: 'F' });
  assert.ok(short.by.T.len < tree.by.T.len && short.by.T.r1 < tree.by.T.r1);
  assert.ok(tree.by.RMB.len < tree.by.LMB.len, 'the right main bronchus is shorter');
  assert.ok(Math.acos(V.dot(tree.by.T.d, tree.by.RMB.d)) < Math.acos(V.dot(tree.by.T.d, tree.by.LMB.d)), 'and more vertical');
  assert.equal(regionOf('BI'), 'R'); assert.equal(regionOf('LING'), 'L'); assert.equal(regionOf('T'), 'trachea');
});

test('the lumen mesh and the tube mesh are built', () => {
  const m = buildAirwayMesh(tree);
  assert.ok(m.pos.length / 3 > 5000 && m.idx.length > 3 * 10000, `${m.pos.length / 3} vertices`);
  for (let i = 0; i < m.pos.length; i++) assert.ok(Number.isFinite(m.pos[i]));
  const ok = buildTubeMesh(tree, 4), deep = buildTubeMesh(tree, -1.5);
  assert.equal(ok.path.length, 2); assert.equal(deep.path.length, 3, 'a tube past the carina bends into the right main bronchus');
});

test('the scope can be steered into every lobe and back up to the trachea', () => {
  for (const t of [['T', 'LMB', 'LLL'], ['T', 'LMB', 'LUL', 'LING'], ['T', 'RMB', 'RUL'], ['T', 'RMB', 'BI', 'RML'], ['T', 'RMB', 'BI', 'RLL', 'RB6']]) {
    const sc = drive(t); assert.deepEqual(sc.path(), t);
    sc.bend = 0; for (let i = 0; i < 200; i++) sc.move(-0.3);
    assert.equal(sc.b.id, 'T'); assert.equal(sc.msg, 'top');
  }
});

test('going straight down follows the more vertical right side; a segment is a dead end; without aiming the scope stops at a fork', () => {
  const sc = new Scope(tree);
  for (let i = 0; i < 300 && sc.msg !== 'end'; i++) { sc.move(0.3); sc.update(0.1); }
  assert.equal(sc.path()[1], 'RMB'); assert.equal(sc.msg, 'end');
  const lmb = drive(['T', 'LMB']); lmb.bend = 0;
  for (let i = 0; i < 40; i++) { lmb.roll(0.4); lmb.bend = 0; lmb.move(0.3); lmb.update(0.1); }
  assert.ok(['LMB', 'LLL', 'LB8', 'LB9', 'LB10'].includes(lmb.b.id));
});
