// Realistic patient from assets/patient.glb (MakeHuman/MPFB, CC0; see assets-src/README.md).
// One supine body with morph targets; this module turns a patient spec (sex, age, height, weight) into morph weights,
// blends every mesh, and returns the same shape as the procedural buildBody() so the scene and gestures need not care.
// Visual only: nothing here feeds the physiology engine.
import { blendMorphs } from './gltf.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
/** weight at which a monotonic calibration row reaches value v (linear inside, linear extrapolation outside) */
function invert(row, weights, v) {
  const n = row.length, up = row[n - 1] > row[0];
  const below = (x) => (up ? x < v : x > v);
  if (!below(row[n - 1])) {
    for (let i = 1; i < n; i++) if (!below(row[i])) { const t = (v - row[i - 1]) / ((row[i] - row[i - 1]) || 1e-9); return lerp(weights[i - 1], weights[i], t); }
  }
  const t = (v - row[n - 2]) / ((row[n - 1] - row[n - 2]) || 1e-9); return lerp(weights[n - 2], weights[n - 1], t);
}

/** Morph weights for a patient (pure; see patient.json shapeKeyRules). */
export function morphWeights({ sex = 'M', age = 40, heightCm = 175, weightKg = 75 }, meta) {
  const H = heightCm / 100, female = sex === 'F' ? 1 : 0, old = clamp((age - 25) / 65, 0, 1);
  const bmiRef = (weightKg / (H * H)) * meta.referenceHeight / H;                 // uniform scaling changes BMI by h/referenceHeight
  const C = meta.bmiCalibration, W = C.weights, T = C.table;
  const row = (k) => W.map((_, i) => lerp(lerp(T.male_25y[k][i], T.male_90y[k][i], old), lerp(T.female_25y[k][i], T.female_90y[k][i], old), female));
  const heavyRow = row('heavy'), thinRow = row('thin');
  let heavy = 0, thin = 0;
  if (bmiRef >= heavyRow[0]) heavy = clamp(invert(heavyRow, W, bmiRef), 0, 1.35);   // short, very obese patients extrapolate a little past 1
  else thin = clamp(invert(thinRow, W, bmiRef), 0, 1.2);
  return { female, heavy, thin, old, female_heavy: female * heavy, female_thin: female * thin, female_old: female * old, scale: H / meta.referenceHeight, bmiRef };
}

// head assets come in a male set (hair, eyebrows) and a female set (hair_f, eyebrows_f); eyelashes are shared. The scene draws
// the set that matches the patient's sex (weights.female), so the two faces no longer share hair and brows.
/** face shape keys in the order the renderer's uFace weights use (assets-src/build_patient.py FACE_KEYS) */
export const FACE_KEYS = ['face_blink', 'face_jaw', 'face_pain', 'face_gaze'];
const MESHES = ['patient_body', 'patient_eyes', 'patient_eyebrows', 'patient_hair', 'patient_eyebrows_f', 'patient_hair_f', 'patient_eyelashes', 'patient_gown', 'patient_sheet'];

/** Blend the asset for a spec. Returns renderer-ready meshes (positions in asset space, metres) and blended landmarks. */
export function buildGlbBody(asset, meta, spec, morph) {
  const wts = morphWeights(spec, meta), out = {};
  for (const name of MESHES) {
    const m = asset.meshes[name]; if (!m) continue;
    const { pos, nrm } = blendMorphs(m, wts), n = pos.length / 3, w = new Float32Array(n * 2), region = new Uint8Array(n);
    if (m.color) for (let i = 0; i < n; i++) { const c = m.color.data, k = m.color.size; w[i * 2] = c[i * k]; w[i * 2 + 1] = c[i * k + 1]; region[i] = Math.round(c[i * k + 2] * 10); }
    // face expression deltas (blink, jaw, pain, gaze): blended on the GPU every frame, not baked here
    const face = FACE_KEYS.map(k => { const i = m.targetNames.indexOf(k); return i >= 0 && m.targets[i]?.pos ? m.targets[i].pos : null; });
    out[name.replace('patient_', '')] = { pos, nrm, w, uv: m.uv, idx: m.idx, region, material: m.material, face: face.some(Boolean) ? face : null };
  }
  const body = out.body, landmarks = {};
  for (const [k, lm] of Object.entries(meta.landmarks)) { const v = lm.anchorVertex; landmarks[k] = [body.pos[v * 3], body.pos[v * 3 + 1], body.pos[v * 3 + 2]]; }
  return { glb: true, meshes: out, landmarks, weights: wts, scale: wts.scale, H: spec.heightCm / 100, morph, zBack: 0 };
}
