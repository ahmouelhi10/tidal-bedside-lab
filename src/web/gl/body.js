// Procedural adult body from sex / height / weight (BMI). Visual morphology only: circumference tables are
// approximate survey-style values used to draw believable silhouettes from underweight to super-obese;
// they are NOT clinical data and are not used by the physiology engine.
import { mat4 } from './math.js';

function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) { const [x0, y0] = table[i - 1], [x1, y1] = table[i]; return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0); }
  }
  return table[table.length - 1][1];
}
const T = {
  waistM: [[14, 58], [18, 68], [22, 80], [25, 88], [30, 101], [35, 114], [40, 126], [50, 148], [60, 166], [75, 186]],
  hipM: [[14, 76], [18, 86], [22, 94], [25, 98], [30, 106], [35, 114], [40, 122], [50, 138], [60, 152], [75, 170]],
  chestM: [[14, 78], [18, 86], [22, 96], [25, 100], [30, 108], [35, 116], [40, 124], [50, 140], [60, 154], [75, 172]],
  chestF: [[14, 72], [18, 80], [22, 88], [25, 92], [30, 100], [35, 108], [40, 116], [50, 132], [60, 146], [75, 164]],
  thighM: [[14, 38], [22, 54], [30, 62], [40, 72], [50, 82], [60, 90], [75, 100]],
  thighF: [[14, 38], [22, 56], [30, 66], [40, 78], [50, 90], [60, 100], [75, 110]],
  calf: [[14, 26], [22, 36], [30, 40], [40, 45], [50, 50], [60, 54], [75, 58]],
  arm: [[14, 20], [22, 29], [30, 34], [40, 40], [50, 45], [60, 49], [75, 54]],
  neckM: [[14, 32], [22, 38], [30, 42], [40, 46], [50, 50], [60, 54], [75, 58]],
};

export const SKIN_TONES = [
  [0.96, 0.80, 0.69], [0.90, 0.72, 0.58], [0.80, 0.60, 0.44], [0.66, 0.46, 0.32], [0.46, 0.31, 0.22], [0.30, 0.20, 0.15],
];

/** Compute body dimensions in metres. */
export function morphology({ sex = 'M', age = 40, heightCm = 175, weightKg = 75 }) {
  const H = heightCm / 100, bmi = weightKg / (H * H), fem = sex === 'F';
  const hs = heightCm / 175;                 // circumferences scale with stature
  const u = Math.max(0, Math.min(1, (bmi - 22) / 30)); // 0 at BMI 22, 1 at BMI 52
  const thin = Math.max(0, Math.min(1, (22 - bmi) / 8));
  const cm = x => x / 100;
  const waistC = (interp(T.waistM, bmi) - (fem ? 7 - 3 * u : 0)) * hs;
  const hipC = (interp(T.hipM, bmi) + (fem ? 6 : 0)) * hs;
  const chestC = interp(fem ? T.chestF : T.chestM, bmi) * hs;
  const thighC = interp(fem ? T.thighF : T.thighM, bmi) * hs;
  const calfC = interp(T.calf, bmi) * hs * (fem ? 0.97 : 1);
  const armC = interp(T.arm, bmi) * hs * (fem ? 0.95 : 1);
  const neckC = (interp(T.neckM, bmi) - (fem ? 4 : 0)) * hs;
  // supine soft-tissue spread: wider, flatter with adiposity
  const spreadX = 1 + 0.07 * u, spreadZ = 1 - 0.06 * u;
  const ell = (circ, r) => { const a = cm(circ) / (2 * Math.PI * Math.sqrt((1 + r * r) / 2)); return { a, b: a * r }; };
  const waist = ell(waistC, 0.66 + 0.26 * u), hip = ell(hipC, 0.68 + 0.14 * u), chest = ell(chestC, 0.60 + 0.22 * u + (fem ? 0.03 : 0));
  const thigh = ell(thighC, 0.95), calf = ell(calfC, 0.92), arm = ell(armC, 1.0), neck = ell(neckC, 1.0);
  const shoulderHalf = (fem ? 0.215 : 0.245) * H * (1 + 0.10 * u + 0.0 * thin);
  const skinTone = 1;
  return { H, bmi, fem, u, thin, age, spreadX, spreadZ, waist, hip, chest, thigh, calf, arm, neck, shoulderHalf, skinTone };
}

export { buildBody } from './anatomy.js';

/** Local -> world transform for a supine patient lying with the head toward +x on the mattress. */
export function supineMatrix(body, bedTop = 0.86, headX = 0.92) {
  return mat4.fromBasis([0, 0, 1], [1, 0, 0], [0, 1, 0], [headX - body.H * 0.93, bedTop - body.zBack, 0]);
}
export function localToWorld(M, p) { return mat4.transformPoint(M, p); }

/** Skin colour from base tone and physiological state. */
export function skinColor(baseRGB, { cyanosis = 0, pallor = 0, flush = 0 } = {}) {
  let [r, g, b] = baseRGB;
  const mix = (c, t) => { r += (c[0] - r) * t; g += (c[1] - g) * t; b += (c[2] - b) * t; };
  mix([0.55, 0.55, 0.62], Math.min(1, pallor) * 0.55);
  mix([0.40, 0.40, 0.66], Math.min(1, cyanosis) * 0.75);
  mix([0.85, 0.35, 0.30], Math.min(1, flush) * 0.35);
  return [r, g, b];
}
