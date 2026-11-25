// Submitting a finished case when the server is busy (display side, pure, no DOM): a whole class pressing "Finish" at
// once can fill the server's replay queue (503) or a shared address's request budget (429). A refused submit leaves the
// session open, so it is safe to send again: wait 2, 4, 8, 16, 16 s (a little random spread so the class does not
// return in step; the server's Retry-After is honoured when longer), under a minute in all, hidden behind the
// self-assessment the learner is filling in meanwhile.

export const RETRY_DELAYS_S = Object.freeze([2, 4, 8, 16, 16]);
const BUSY = new Set([429, 503]);

/** send(): Promise<Response-like {status, ok, headers?}>. Returns the last response (busy or not). sleep(ms) and
 *  rand() are injectable for tests. onWait(attempt, seconds) is told before each wait. */
export async function sendWithRetry(send, { delays = RETRY_DELAYS_S, sleep = (ms) => new Promise(r => setTimeout(r, ms)), rand = Math.random, onWait } = {}) {
  let r = await send();
  for (let i = 0; i < delays.length && BUSY.has(r.status); i++) {
    const after = Number(r.headers?.get?.('retry-after'));
    const s = Math.max(delays[i] * (0.75 + 0.5 * rand()), Number.isFinite(after) ? after : 0);
    onWait?.(i + 1, s);
    await sleep(s * 1000);
    r = await send();
  }
  return r;
}
