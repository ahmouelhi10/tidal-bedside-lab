export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
/** Hill / Emax function: effect = e^g / (e^g + c50^g) */
export const hill = (c, c50, g) => { if (c <= 0) return 0; const a = Math.pow(c, g); return a / (a + Math.pow(c50, g)); };
export const lag = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
