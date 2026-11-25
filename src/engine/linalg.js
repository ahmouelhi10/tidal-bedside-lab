// Tiny dense linear algebra for exact solution of linear pharmacokinetic systems.
// Matrices are arrays of row arrays.
export function zeros(n, m = n) { return Array.from({ length: n }, () => new Array(m).fill(0)); }
export function identity(n) { const I = zeros(n); for (let i = 0; i < n; i++) I[i][i] = 1; return I; }
export function matMul(A, B) {
  const n = A.length, m = B[0].length, k = B.length, C = zeros(n, m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    let s = 0; for (let l = 0; l < k; l++) s += A[i][l] * B[l][j]; C[i][j] = s;
  }
  return C;
}
export function matScale(A, c) { return A.map(r => r.map(v => v * c)); }
export function matAdd(A, B) { return A.map((r, i) => r.map((v, j) => v + B[i][j])); }
export function normInf(A) { return Math.max(...A.map(r => r.reduce((s, v) => s + Math.abs(v), 0))); }

// Matrix exponential by scaling and squaring with a Taylor series (accurate for the
// small, well-scaled matrices used here; verified against RK4 in the test-suite).
export function expm(A) {
  const n = A.length;
  const nrm = normInf(A);
  let s = 0;
  if (nrm > 0.5) s = Math.max(0, Math.ceil(Math.log2(nrm / 0.5)));
  const As = matScale(A, 1 / Math.pow(2, s));
  let term = identity(n), sum = identity(n);
  for (let k = 1; k <= 20; k++) {
    term = matScale(matMul(term, As), 1 / k);
    sum = matAdd(sum, term);
  }
  for (let i = 0; i < s; i++) sum = matMul(sum, sum);
  return sum;
}
