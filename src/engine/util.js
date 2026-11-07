export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sigmoid = x => 1 / (1 + Math.exp(-x));
/** Hill / Emax function: effect = e^g / (e^g + c50^g) */
export const hill = (c, c50, g) => { if (c <= 0) return 0; const a = Math.pow(c, g); return a / (a + Math.pow(c50, g)); };
export const lag = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
export function interp1(table, x) { // table: sorted [[x,y],...]
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) if (x <= table[i][0]) { const [x0, y0] = table[i - 1], [x1, y1] = table[i]; return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0); }
  return table[table.length - 1][1];
}
