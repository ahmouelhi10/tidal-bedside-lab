// Adult anthropometrics and body composition. Inputs: sex 'M'|'F', age (y), heightCm, weightKg.
// Every formula carries the reference id registered in references.js.
export const WHO_BMI_CLASSES = [
  { max: 16.0, key: 'severe_thinness' }, { max: 17.0, key: 'moderate_thinness' }, { max: 18.5, key: 'mild_thinness' },
  { max: 25.0, key: 'normal' }, { max: 30.0, key: 'overweight' }, { max: 35.0, key: 'obese_I' },
  { max: 40.0, key: 'obese_II' }, { max: 50.0, key: 'obese_III' }, { max: Infinity, key: 'super_obese' },
];
export const bmiOf = (w, hCm) => w / Math.pow(hCm / 100, 2);
export const bmiClass = bmi => WHO_BMI_CLASSES.find(c => bmi < c.max).key;

export const bsaMosteller = (w, h) => Math.sqrt((w * h) / 3600);                         // REF mosteller1987
export const bsaDuBois = (w, h) => 0.007184 * Math.pow(w, 0.425) * Math.pow(h, 0.725);  // REF dubois1916

export function ibwDevine(sex, hCm) {                                                    // REF devine1974
  const inches = hCm / 2.54;
  return (sex === 'F' ? 45.5 : 50) + 2.3 * Math.max(0, inches - 60);
}
export function pbwArdsnet(sex, hCm) { return (sex === 'F' ? 45.5 : 50) + 0.91 * (hCm - 152.4); } // REF ardsnet2000
export const adjustedBodyWeight = (ibw, w) => ibw + 0.4 * (w - ibw);

// Lean body mass ---------------------------------------------------------------
export function lbmJames(sex, w, hCm) {                                                  // REF james1976
  const r = w / hCm;
  return sex === 'F' ? 1.07 * w - 148 * r * r : 1.1 * w - 128 * r * r;
}
export function lbmJanmahasatian(sex, w, hCm) {                                          // REF janmahasatian2005
  const bmi = bmiOf(w, hCm);
  return sex === 'F' ? (9270 * w) / (8780 + 244 * bmi) : (9270 * w) / (6680 + 216 * bmi);
}
export function lbmHume(sex, w, hCm) {                                                   // REF hume1966
  return sex === 'F' ? 0.29569 * w + 0.41813 * hCm - 43.2933 : 0.3281 * w + 0.33929 * hCm - 29.5336;
}

// Body water and blood volume -----------------------------------------------------
export function tbwWatson(sex, age, w, hCm) {                                            // REF watson1980  (L)
  return sex === 'F' ? -2.097 + 0.1069 * hCm + 0.2466 * w : 2.447 - 0.09516 * age + 0.1074 * hCm + 0.3362 * w;
}
export function bloodVolumeNadler(sex, w, hCm) {                                         // REF nadler1962  (L)
  const h = hCm / 100;
  return sex === 'F' ? 0.3561 * h ** 3 + 0.03308 * w + 0.1833 : 0.3669 * h ** 3 + 0.03219 * w + 0.6041;
}
export function bloodVolumeLemmens(w, hCm) {                                             // REF lemmens2006 (L)
  const bmi = bmiOf(w, hCm);
  return (70 / Math.sqrt(bmi / 22)) * w / 1000;
}

/** Blood volume (L) for any build: Nadler for normal weight, Lemmens for severe obesity, with a smooth hand-over.
 *  The weight is a smoothstep of BMI from 27 to 45, so the volume and its slope are both continuous and the volume per kg
 *  never rises with weight. The older linear blend over BMI 28-32 made the volume per kg rise in women (Lemmens is not
 *  sex-specific and lies ~9 % above Nadler there) and put kinks at both ends. REF nadler1962, lemmens2006; window REF design */
export const BV_BLEND_BMI = Object.freeze([27, 45]);
export function bloodVolumeBlend(sex, w, hCm) {
  const x = Math.min(1, Math.max(0, (bmiOf(w, hCm) - BV_BLEND_BMI[0]) / (BV_BLEND_BMI[1] - BV_BLEND_BMI[0]))), k = x * x * (3 - 2 * x);
  return bloodVolumeNadler(sex, w, hCm) * (1 - k) + bloodVolumeLemmens(w, hCm) * k;
}

/** Mifflin-St Jeor resting energy expenditure, kcal/day (REF mifflin1990). Actual weight is the validated input for BMI < 30; obesity is UNVERIFIED here. */
export const reeMifflin = (sex, age, w, hCm) => 10 * w + 6.25 * hCm - 5 * age + (sex === 'F' ? -161 : 5);

/** Complete body description used by all engine modules. */
export function describeBody({ sex = 'M', age = 40, heightCm = 175, weightKg = 75 }) {
  const bmi = bmiOf(weightKg, heightCm);
  const lbm = Math.min(lbmJanmahasatian(sex, weightKg, heightCm), weightKg * 0.95);
  const lbmJ = lbmJames(sex, weightKg, heightCm);
  const ibw = ibwDevine(sex, heightCm), pbw = pbwArdsnet(sex, heightCm);
  const bsa = bsaMosteller(weightKg, heightCm);
  const tbw = Math.min(tbwWatson(sex, age, weightKg, heightCm), weightKg * 0.75);
  const bloodVolume = bloodVolumeBlend(sex, weightKg, heightCm);   // Nadler -> Lemmens, smooth over BMI 27-45
  return {
    sex, age, heightCm, weightKg, bmi, bmiClass: bmiClass(bmi),
    lbm, lbmJames: lbmJ, ibw, pbw, abw: adjustedBodyWeight(ibw, weightKg), bsa,
    fatMass: weightKg - lbm, fatFraction: 1 - lbm / weightKg,
    tbw, ecf: tbw * 0.40, icf: tbw * 0.60,           // ~40% of TBW extracellular (REF guyton_hall)
    plasmaVolume: bloodVolume * 0.58, bloodVolume,
    ree: reeMifflin(sex, age, weightKg, heightCm),
    vo2: Math.max(120, reeMifflin(sex, age, weightKg, heightCm) / 1440 / 4.86 * 1000),   // mL/min, 4.86 kcal per L O2 at RQ 0.8
  };
}
