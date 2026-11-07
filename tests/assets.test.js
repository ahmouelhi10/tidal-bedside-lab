import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGlb, blendMorphs, splitGlb } from '../src/web/gl/gltf.js';
import { morphWeights, buildGlbBody } from '../src/web/gl/patient-glb.js';
import { prepare, rayMesh } from '../src/web/gl/pick.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'assets');
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

/** Build a tiny GLB in memory: one triangle with a morph target and a named landmark node. */
function tinyGlb() {
  const f32 = (a) => Buffer.from(new Float32Array(a).buffer), u16 = (a) => Buffer.from(new Uint16Array(a).buffer);
  const pos = f32([0, 0, 0, 1, 0, 0, 0, 1, 0]), nrm = f32([0, 0, 1, 0, 0, 1, 0, 0, 1]), dpos = f32([0, 0, 1, 0, 0, 1, 0, 0, 1]), idx = Buffer.concat([u16([0, 1, 2]), Buffer.alloc(2)]);
  const bin = Buffer.concat([pos, nrm, dpos, idx]);
  const view = (o, l) => ({ buffer: 0, byteOffset: o, byteLength: l });
  const json = {
    asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }],
    bufferViews: [view(0, 36), view(36, 36), view(72, 36), view(108, 6)],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' }],
    meshes: [{ name: 'tri', extras: { targetNames: ['up'] }, primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 3, targets: [{ POSITION: 2 }] }] }],
    nodes: [{ name: 'tri', mesh: 0 }, { name: 'mark', translation: [0.5, 0.5, 0], extras: { anchorVertex: 1 } }],
  };
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  const body = Buffer.concat([chunk(0x4e4f534a, js), chunk(0x004e4942, bin)]), head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + body.length, 8);
  return ab(Buffer.concat([head, body]));
}

test('GLB reader: chunks, accessors, indices, morph targets and named nodes', () => {
  const g = parseGlb(tinyGlb()), m = g.meshes.tri;
  assert.deepEqual([...m.pos], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual([...m.idx], [0, 1, 2]);
  assert.deepEqual(m.targetNames, ['up']);
  assert.deepEqual(g.nodes.mark.translation, [0.5, 0.5, 0]); assert.equal(g.nodes.mark.extras.anchorVertex, 1);
  const half = blendMorphs(m, { up: 0.5 });
  assert.deepEqual([...half.pos], [0, 0, 0.5, 1, 0, 0.5, 0, 1, 0.5]);
  assert.throws(() => splitGlb(new ArrayBuffer(16)), /not a GLB/);
});

test('ray picking hits the triangle and reports a normal facing the ray', () => {
  const m = prepare(parseGlb(tinyGlb()).meshes.tri);
  const h = rayMesh({ o: [0.2, 0.2, 2], d: [0, 0, -1] }, m);
  assert.ok(h && Math.abs(h.t - 2) < 1e-9 && h.n[2] > 0.99);
  assert.equal(rayMesh({ o: [2, 2, 2], d: [0, 0, -1] }, m), null);
});

const glbPath = path.join(ASSETS, 'patient.glb'), have = fs.existsSync(glbPath);

test('patient asset: size budget and expected content', { skip: !have && 'patient.glb not built' }, () => {
  assert.ok(fs.statSync(glbPath).size < 6.5e6, 'patient.glb under 6.5 MB');
  assert.ok(fs.statSync(path.join(ASSETS, 'instruments.glb')).size < 1e6, 'instruments.glb under 1 MB');
  const g = parseGlb(ab(fs.readFileSync(glbPath)));
  for (const k of ['patient_body', 'patient_gown', 'patient_sheet', 'patient_hair', 'patient_eyes']) assert.ok(g.meshes[k], k);
  assert.deepEqual(g.meshes.patient_body.targetNames, ['female', 'heavy', 'thin', 'old', 'female_heavy', 'female_thin', 'female_old']);
  for (const k of ['face', 'airway', 'sternum', 'neck', 'rightArmIV', 'leftArm', 'abdomen', 'femoral', 'padRight', 'padLeft', 'R_mcl2', 'L_mal5']) assert.ok(g.nodes[k], 'landmark ' + k);
});

test('morph weights follow sex, age and BMI (calibration), and height scales uniformly', { skip: !have && 'patient.glb not built' }, () => {
  const meta = JSON.parse(fs.readFileSync(path.join(ASSETS, 'patient.json'), 'utf8'));
  const w = (spec) => morphWeights({ sex: 'M', age: 25, heightCm: 173, ...spec }, meta);
  const normal = w({ weightKg: 63.6 }), obese = w({ weightKg: 135 }), thin = w({ weightKg: 48 });
  assert.ok(normal.heavy < 0.05 && normal.thin < 0.05, JSON.stringify(normal));
  assert.ok(obese.heavy > 0.7 && obese.thin === 0, JSON.stringify(obese));
  assert.ok(thin.thin > 0.7 && thin.heavy === 0, JSON.stringify(thin));
  assert.equal(w({ sex: 'F', weightKg: 60 }).female, 1); assert.equal(w({ weightKg: 60 }).female, 0);
  assert.ok(w({ age: 90, weightKg: 60 }).old > 0.99 && w({ age: 25, weightKg: 60 }).old === 0);
  assert.ok(Math.abs(w({ heightCm: 200, weightKg: 80 }).scale - 2.0 / meta.referenceHeight) < 1e-9);
  // the same BMI on a shorter patient needs a slightly heavier morph (uniform scaling shrinks the apparent BMI)
  const bmi35 = (h) => w({ heightCm: h, weightKg: 35 * (h / 100) ** 2 }).heavy;
  assert.ok(bmi35(150) > bmi35(190));
});

test('landmarks follow the morph: an obese chest is higher above the bed than a thin one', { skip: !have && 'patient.glb not built' }, () => {
  const meta = JSON.parse(fs.readFileSync(path.join(ASSETS, 'patient.json'), 'utf8'));
  const asset = parseGlb(ab(fs.readFileSync(glbPath)));
  const thin = buildGlbBody(asset, meta, { sex: 'M', age: 40, heightCm: 175, weightKg: 52 }), obese = buildGlbBody(asset, meta, { sex: 'M', age: 40, heightCm: 175, weightKg: 140 });
  assert.ok(obese.landmarks.sternum[1] > thin.landmarks.sternum[1] + 0.05, `${obese.landmarks.sternum[1]} vs ${thin.landmarks.sternum[1]}`);
  assert.ok(obese.landmarks.R_mal5[2] < thin.landmarks.R_mal5[2], 'the lateral chest wall moves out with weight');
  const body = obese.meshes.body;
  assert.equal(body.w.length, (body.pos.length / 3) * 2);
  assert.ok(body.region.some(r => r === 3) && body.region.some(r => r === 1), 'region ids decoded from COLOR_0');
});
