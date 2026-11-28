// Live instructor channel: the learner's browser streams a small state summary, an instructor who has the case's join code
// watches it and sends changes (engine event 'instructor.inject'). The server relays each change and keeps the ones it
// delivered on the session record; the learner's client puts each change into its own event log, so the session still
// replays, and the submit checks that the log carries exactly the delivered changes (checkInjects).
// Transport: Server-Sent Events (one-way streams) + small JSON POSTs. Zero dependencies.
import crypto from 'node:crypto';
import { INJECTS } from '../engine/patient.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';            // no 0/O, 1/I: read aloud or typed from a screen
export const LIVE_LIMITS = Object.freeze({ codeLen: 6, stateBytes: 8_000, minStateMs: 400, idleMs: 2 * 3600_000, heartbeatMs: 15_000, maxChannels: 500, maxWatchers: 8 });

export function newCode() { let s = ''; for (let i = 0; i < LIVE_LIMITS.codeLen; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; return s; }
export const validCode = (c) => typeof c === 'string' && c.length === LIVE_LIMITS.codeLen && [...c].every(ch => CODE_CHARS.includes(ch));

/** Check an instructor command before relaying it (the engine validates it again when the learner's client applies it). */
export function validateCommand(b) {
  if (!b || typeof b !== 'object' || !INJECTS.includes(b.what)) return { ok: false, error: 'unknown instructor change' };
  const cmd = { what: b.what };
  if (b.what === 'bleed') { if (!(Number.isFinite(b.mlPerMin) && b.mlPerMin >= 20 && b.mlPerMin <= 1000)) return { ok: false, error: 'mlPerMin must be in [20, 1000]' }; cmd.mlPerMin = Math.round(b.mlPerMin); }
  if (b.what === 'tension_ptx' && b.side != null) { if (!['L', 'R'].includes(b.side)) return { ok: false, error: 'invalid side' }; cmd.side = b.side; }
  if (b.what === 'marker') { if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 200) return { ok: false, error: 'marker text up to 200 characters' }; cmd.text = b.text.trim(); }
  return { ok: true, cmd };
}

/** The instructor changes in a submitted log must be exactly the commands the server delivered to that session, in order
 *  (the session record keeps them: see the cmd route). Content and order are checked; timing is not, because simulated
 *  time runs at the learner's chosen speed. A log that drops, reorders, edits or invents a change fails. */
const injectKey = (c) => JSON.stringify([c.what, c.mlPerMin ?? null, c.side ?? null, c.text ?? null]);
export function checkInjects(sent, log) {
  const got = log.filter(e => e.type === 'instructor.inject').map(injectKey), want = sent.map(injectKey);
  if (got.length !== want.length) return { ok: false, error: `${got.length} instructor change(s) in the log, ${want.length} delivered by the server` };
  const i = got.findIndex((k, n) => k !== want[n]);
  return i < 0 ? { ok: true } : { ok: false, error: `instructor change ${i + 1} does not match what the server delivered` };
}

export function createLive({ store, send, fail, readJson, info }) {
  const byId = new Map(), byCode = new Map();
  const sse = (res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
  };
  const emit = (res, event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ } };
  const touch = (ch) => { ch.seen = Date.now(); };
  const watchersMsg = (ch) => ({ watchers: ch.watchers.size });

  const hb = setInterval(() => {
    const now = Date.now();
    for (const ch of byId.values()) {
      for (const r of [...ch.learners, ...ch.watchers]) { try { r.write(': hb\n\n'); } catch { /* closed */ } }
      if (now - ch.seen > LIVE_LIMITS.idleMs && !ch.learners.size && !ch.watchers.size) { byId.delete(ch.id); byCode.delete(ch.code); }
    }
  }, LIVE_LIMITS.heartbeatMs); hb.unref();

  /** Handles /api/live/... ; returns true when it answered. */
  async function handle(req, res, parts) {
    const m = req.method;
    // instructor side: /api/live/join/:code[/cmd]
    if (parts[2] === 'join') {
      const code = String(parts[3] || '').toUpperCase(), ch = validCode(code) ? byCode.get(code) : null;
      if (!ch) { fail(res, 404, 'no live case with this code'); return true; }
      if (parts.length === 4 && m === 'GET') {
        if (ch.watchers.size >= LIVE_LIMITS.maxWatchers) { fail(res, 429, 'too many instructors on this case'); return true; }
        sse(res); ch.watchers.add(res); touch(ch);
        const rec = store.get(ch.id);
        emit(res, 'hello', { scenario: rec?.scenario ?? null, learner: rec?.learner ?? '', spec: rec?.spec ?? null, learnerOnline: ch.learners.size > 0 });
        if (ch.state) emit(res, 'state', ch.state);
        for (const l of ch.learners) emit(l, 'watchers', watchersMsg(ch));
        req.on('close', () => { ch.watchers.delete(res); for (const l of ch.learners) emit(l, 'watchers', watchersMsg(ch)); });
        return true;
      }
      if (parts.length === 5 && parts[4] === 'cmd' && m === 'POST') {
        const v = validateCommand(await readJson(req)); if (!v.ok) { fail(res, 400, v.error); return true; }
        const rec = store.get(ch.id);
        if (!rec || rec.status !== 'open') { fail(res, 409, 'the case has been submitted'); return true; }
        const c = { seq: ++ch.seq, ...v.cmd }; touch(ch);
        // keep what the learner's client will apply (it ignores changes once the case has finished), so the submit can
        // check the log against it; synchronous read and write, so it cannot interleave with a submit's final write
        if (ch.learners.size > 0 && !ch.state?.finished) store.put({ ...rec, instructor: [...(rec.instructor || []), v.cmd] });
        for (const l of ch.learners) emit(l, 'cmd', c);
        for (const w of ch.watchers) emit(w, 'sent', c);
        info('info', 'live command', { id: ch.id, what: c.what });
        send(res, 200, { ok: true, seq: c.seq, delivered: ch.learners.size > 0 }); return true;
      }
      fail(res, 405, 'method not allowed'); return true;
    }
    // learner side: /api/live/:sessionId/(open|stream|state)
    const id = parts[2], rec = store.get(id);
    if (!rec) { fail(res, 404, 'session not found'); return true; }
    let ch = byId.get(id);
    if (parts[3] === 'open' && m === 'POST') {
      if (rec.status !== 'open') { fail(res, 409, 'session already submitted'); return true; }
      if (!ch) {
        if (byId.size >= LIVE_LIMITS.maxChannels) { fail(res, 503, 'too many live cases'); return true; }
        let code; do code = newCode(); while (byCode.has(code));
        ch = { id, code, seq: 0, state: null, lastState: 0, learners: new Set(), watchers: new Set(), seen: Date.now() };
        byId.set(id, ch); byCode.set(code, ch);
      }
      touch(ch); send(res, 200, { code: ch.code, watchers: ch.watchers.size }); return true;
    }
    if (!ch) { fail(res, 404, 'live channel not open'); return true; }
    if (parts[3] === 'stream' && m === 'GET') {
      sse(res); ch.learners.add(res); touch(ch); emit(res, 'watchers', watchersMsg(ch));
      for (const w of ch.watchers) emit(w, 'learner', { online: true });
      req.on('close', () => { ch.learners.delete(res); for (const w of ch.watchers) emit(w, 'learner', { online: ch.learners.size > 0 }); });
      return true;
    }
    if (parts[3] === 'state' && m === 'POST') {
      const now = Date.now();
      if (now - ch.lastState < LIVE_LIMITS.minStateMs) { send(res, 429, { error: 'state too frequent' }); return true; }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > LIVE_LIMITS.stateBytes) { req.resume(); fail(res, 413, 'state too large'); return true; }
      const b = await readJson(req);
      if (JSON.stringify(b).length > LIVE_LIMITS.stateBytes) { fail(res, 413, 'state too large'); return true; }
      ch.state = b; ch.lastState = now; touch(ch);
      for (const w of ch.watchers) emit(w, 'state', b);
      send(res, 204, ''); return true;
    }
    fail(res, 405, 'method not allowed'); return true;
  }
  return { handle, close: () => { clearInterval(hb); for (const ch of byId.values()) for (const r of [...ch.learners, ...ch.watchers]) { try { r.end(); } catch { /* closed */ } } } };
}
