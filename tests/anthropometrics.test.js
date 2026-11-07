// Oracles: research note "anthropometrics_body_composition.md" section 9 (equations from the primary papers, computed independently in Python).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/engine/anthropometrics.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} +/- ${tol}`);
// case: sex, H, W, James, Janmahasatian, Hume, Mosteller, DuBois, Watson(age 40), Nadler, Lemmens
const CASES = {
  A: ['F', 150, 40, 32.28, 28.27, 31.25, 1.2910, 1.3029, 23.80, 2.708, 3.115],
  B: ['M', 175, 70, 56.52, 55.86, 52.81, 1.8447, 1.8481, 40.97, 4.824, 4.807],
  C: ['M', 175, 150, 70.96, 80.56, 79.06, 2.7003, 2.5551, 67.87, 7.399, 7.037],
  D: ['F', 160, 130, 41.40, 56.92, 62.05, 2.4037, 2.2531, 47.06, 5.942, 5.990],
  E: ['M', 175, 250, 13.78, 95.32, 111.87, 3.4861, 3.1746, 101.49, 10.618, 9.085],
  F: ['F', 160, 200, -17.25, 66.59, 82.75, 2.9814, 2.7058, 64.33, 8.258, 7.429],
  G: ['F', 165, 60, 44.63, 39.29, 43.44, 1.6583, 1.6587, 30.34, 3.768, 4.196],
  H: ['M', 185, 95, 70.75, 69.48, 64.40, 2.2095, 2.1908, 50.45, 5.985, 5.920],
};

for (const [k, [sex, h, w, james, janma, hume, most, dub, wat, nad, lem]] of Object.entries(CASES)) {
  test(`published-equation vectors, case ${k} (${sex}, ${h} cm, ${w} kg)`, () => {
    near(A.lbmJames(sex, w, h), james, 0.01, 'James');
    near(A.lbmJanmahasatian(sex, w, h), janma, 0.01, 'Janmahasatian');
    near(A.lbmHume(sex, w, h), hume, 0.01, 'Hume');
    near(A.bsaMosteller(w, h), most, 0.0005, 'Mosteller');
    near(A.bsaDuBois(w, h), dub, 0.0005, 'DuBois');
    near(A.tbwWatson(sex, 40, w, h), wat, 0.01, 'Watson');
    near(A.bloodVolumeNadler(sex, w, h), nad, 0.005, 'Nadler');
    near(A.bloodVolumeLemmens(w, h), lem, 0.005, 'Lemmens');
  });
}

test('Watson (male) uses the correct age coefficient: 80-year-old discriminator', () => {
  // with the common typo (-0.09156) the 80-y value would be 0.288 L higher
  const v = A.tbwWatson('M', 80, 70, 175);
  near(v, 2.447 - 0.09516 * 80 + 0.1074 * 175 + 0.3362 * 70, 1e-9, 'Watson age 80');
  assert.ok(Math.abs(v - (2.447 - 0.09156 * 80 + 0.1074 * 175 + 0.3362 * 70)) > 0.28);
});

test('ideal / predicted body weight and Vt per kg PBW', () => {
  near(A.ibwDevine('M', 175), 70.46, 0.15, 'Devine M 175');
  near(A.ibwDevine('F', 160), 52.38, 0.15, 'Devine F 160');
  near(A.pbwArdsnet('M', 175), 70.57, 0.01, 'ARDSNet M 175');
  near(6 * A.pbwArdsnet('M', 175), 423, 1, 'Vt 6 mL/kg');
  near(A.adjustedBodyWeight(A.ibwDevine('M', 175), 150), 102.28, 0.15, 'AdjBW');
});

test('Janmahasatian lean mass saturates; James collapses and goes negative (why the engine caps)', () => {
  const b = A.describeBody({ sex: 'F', age: 40, heightCm: 160, weightKg: 200 });
  assert.ok(A.lbmJames('F', 200, 160) < 0, 'James negative at case F');
  assert.ok(b.lbm > 40 && b.lbm <= 0.95 * 200, 'engine LBM sane');
  const lo = A.describeBody({ sex: 'M', age: 40, heightCm: 175, weightKg: 150 }).lbm, hi = A.describeBody({ sex: 'M', age: 40, heightCm: 175, weightKg: 250 }).lbm;
  assert.ok(hi > lo && hi < 131.4 * 1.0 + 1, 'asymptote near 131 kg (male 175 cm) reached from below');
});

test('describeBody monotonicity across the BMI range, both sexes', () => {
  for (const sex of ['M', 'F']) {
    let prev = null;
    for (const w of [40, 55, 70, 85, 100, 130, 170, 220]) {
      const b = A.describeBody({ sex, age: 45, heightCm: 168, weightKg: w });
      assert.ok(b.lbm > 0 && b.tbw > 0 && b.bloodVolume > 0 && b.bsa > 0 && Number.isFinite(b.vo2), `finite/positive at ${w} kg`);
      assert.ok(b.fatFraction >= 0.04 && b.fatFraction <= 0.70, `fat fraction ${b.fatFraction.toFixed(2)} plausible at ${w} kg`);
      if (prev) { assert.ok(b.bloodVolume > prev.bloodVolume && b.bsa > prev.bsa && b.lbm >= prev.lbm - 1e-9, 'monotone in weight'); assert.ok(b.bloodVolume / w < prev.bloodVolume / (prev.weightKg) + 1e-9, 'mL/kg falls with obesity'); }
      prev = b;
    }
  }
});

test('blood volume per kg decreases with BMI (Lemmens) and is 60-80 mL/kg in normal-weight adults', () => {
  const n = A.describeBody({ sex: 'M', age: 40, heightCm: 175, weightKg: 70 });
  assert.ok(n.bloodVolume / 70 * 1000 > 60 && n.bloodVolume / 70 * 1000 < 80);
  const ob = A.describeBody({ sex: 'M', age: 40, heightCm: 175, weightKg: 150 });
  assert.ok(ob.bloodVolume / 150 * 1000 < 55);
});

test('BMI classes follow the WHO cut-points', () => {
  for (const [bmi, cls] of [[15.5, 'severe_thinness'], [17.5, 'mild_thinness'], [22, 'normal'], [27, 'overweight'], [32, 'obese_I'], [37, 'obese_II'], [45, 'obese_III'], [55, 'super_obese']]) {
    assert.equal(A.bmiClass(bmi), cls);
  }
});

test('Mifflin REE reference value', () => {
  near(A.reeMifflin('M', 40, 70, 175), 10 * 70 + 6.25 * 175 - 5 * 40 + 5, 1e-9, 'male');
  near(A.reeMifflin('F', 40, 60, 165), 10 * 60 + 6.25 * 165 - 5 * 40 - 161, 1e-9, 'female');
});
