// Coagulation: dilution of clotting factors, fibrinogen and platelets by blood loss and their replacement, plus the in-vivo
// effect of cold and acidosis (the "lethal triad" with hypothermia and acidosis). Amounts live in Volumes (fluids.js) so they
// follow every litre lost or given; this module turns them into laboratory values and an in-vivo clotting function.
// Laboratory tests are run at 37 C on a buffered sample, so the INR does NOT show the effect of cold or acidosis: that is
// a deliberate teaching point (REF wolberg2004).
import { clamp } from './util.js';

/** Normal plasma levels: factor activity 1.0 (100 %), fibrinogen 3.0 g/L, platelets 250 x10^9/L. REF textbook */
export const NORMAL = Object.freeze({ factors: 1.0, fib: 3.0, plt: 250 });

/** Blood products (per unit): plasma volume (L), factor activity of that plasma, fibrinogen (g), platelets (x10^9, after the
 *  ~2/3 in-vivo recovery of transfused platelets). FFP ~ normal factor levels; stored whole blood keeps fewer working
 *  platelets; an adult apheresis unit raises the count by ~30-50 x10^9/L; a 10-unit cryoprecipitate pool carries ~2.5 g of
 *  fibrinogen. REF textbook, design */
export const PRODUCTS = Object.freeze({
  prbc: { plasma: 0, factors: 0, fib: 0, plt: 0 },
  whole: { plasma: 0.30, factors: 0.9, fib: 0.75, plt: 50 },
  ffp: { plasma: 0.25, factors: 0.9, fib: 0.6, plt: 0 },
  platelets: { plasma: 0.25, factors: 0.9, fib: 0.6, plt: 200 },
  cryo: { plasma: 0.15, factors: 0.3, fib: 2.5, plt: 0 },
});

/** Stores outside the circulating blood that refill it during a haemorrhage: the splenic platelet pool and the extravascular
 *  fibrinogen and clotting factors, as a fraction of the circulating amount, refilling with a ~10 min time constant. Sized so
 *  that replacing loss with plasma-poor fluids reaches fibrinogen ~1 g/L near 150 % of blood volume lost and platelets
 *  ~50 x10^9/L near 230 % (REF hiippala1995); a pure wash-out would get there at ~100 % and ~160 % (REF design). */
export const RESERVE = Object.freeze({ factors: 0.3, fib: 0.3, plt: 0.45 }), RESERVE_TAU_MIN = 10;

/** INR from factor activity: INR ~1.5 when activity has fallen to ~35 % (the usual transfusion trigger). REF textbook, design */
export const inrOf = (factors) => Math.pow(clamp(factors, 0.03, 1.5), -0.42);
/** aPTT (s), normal ~30 s. REF textbook, design */
export const apttOf = (factors) => 30 * Math.pow(clamp(factors, 0.03, 1.5), -0.35);

/** In-vivo enzyme activity: ~10 % lower per degree C below 37 (REF wolberg2004); at pH 7.2 about half (REF meng2003). */
export function triadFactor(coreC, ph) {
  const cold = 1 - 0.10 * Math.max(0, 37 - coreC);
  const acid = 1 - 0.5 * clamp((7.4 - ph) / 0.2, 0, 1.4);
  return clamp(cold, 0.2, 1) * clamp(acid, 0.15, 1);
}

/** Clotting status of the patient: laboratory values and the in-vivo clotting function 0..1 (1 = normal haemostasis).
 *  Haemostasis fails when working factors fall below ~40 %, fibrinogen below 1.5 g/L or platelets below 75 x10^9/L
 *  (European trauma guideline thresholds, REF rossaint2023). */
export function coagStatus(vol, coreC = 37, ph = 7.4) {
  const factors = vol.fAmt / vol.vp, fib = vol.fibAmt / vol.vp, plt = vol.pltAmt / vol.bloodVolume;
  const inVivo = factors * triadFactor(coreC, ph);
  const fn = clamp(Math.min(inVivo / 0.4, fib / 1.5, plt / 75), 0, 1);
  return { factors, fib, plt, inr: inrOf(factors), aptt: apttOf(factors), fn };
}

/** Coagulopathy adds oozing to surgical bleeding: up to twice the source bleeding with no clotting at all. REF design */
export const OOZE_MAX = 1.0;
