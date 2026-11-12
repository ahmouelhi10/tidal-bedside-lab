// Tidal Bedside Lab server: static client + scenario/session API + authoritative replay verification.
// Zero dependencies (node:http, node:crypto, node:fs, node:worker_threads). Node >= 20.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, scenarioList } from '../engine/scenarios.js';
import { EVENT_TYPES } from '../engine/patient.js';
import { createLive } from './live.js';
import { researchRows, validateSelf } from './research.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

export const LIMITS = Object.freeze({
  maxBodyBytes: 1_000_000, maxEvents: 20_000, maxSimSeconds: 4 * 3600, maxStrLen: 64,
  body: { age: [18, 100], heightCm: [140, 210], weightKg: [35, 250] }, bmi: [15, 65],        // BMI envelope = the range covered by the engine's baseline sweep test
  ratePerMinute: 120, replayTimeoutMs: 120_000, replayConcurrency: 2, replayQueue: 20,
});
const EVENT_SET = new Set(EVENT_TYPES);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const log = (level, msg, extra = {}) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + '\n');
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const inRange = (x, [lo, hi]) => isNum(x) && x >= lo && x <= hi;

// ----------------------------------------------------------------------------- validation
export function validateBodySpec(spec, { allowFull = false } = {}) {
  if (spec == null) return { ok: true, spec: {} };
  if (typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, error: 'spec must be an object' };
  const out = {};
  if ('sex' in spec) { if (spec.sex !== 'M' && spec.sex !== 'F') return { ok: false, error: 'sex must be "M" or "F"' }; out.sex = spec.sex; }
  for (const k of ['age', 'heightCm', 'weightKg']) if (k in spec) { if (!inRange(spec[k], LIMITS.body[k])) return { ok: false, error: `${k} must be a number in [${LIMITS.body[k].join(', ')}]` }; out[k] = spec[k]; }
  if (allowFull) for (const k of Object.keys(spec)) if (!(k in out) && ['lvFunction', 'rhythm', 'causes', 'vo2Scale', 'pseudocholinesterase', 'propofolModel', 'remiModel', 'map0', 'hr0'].includes(k)) out[k] = spec[k];
  return { ok: true, spec: out };
}

export function validateLog(logIn, until) {
  if (!Array.isArray(logIn)) return { ok: false, error: 'log must be an array' };
  if (logIn.length > LIMITS.maxEvents) return { ok: false, error: `log longer than ${LIMITS.maxEvents} events` };
  if (!isNum(until) || until < 0 || until > LIMITS.maxSimSeconds) return { ok: false, error: `until must be a number in [0, ${LIMITS.maxSimSeconds}]` };
  let last = 0; const clean = [];
  for (const [i, e] of logIn.entries()) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, error: `event ${i}: not an object` };
    if (!EVENT_SET.has(e.type)) return { ok: false, error: `event ${i}: unknown type` };
    if (!isNum(e.t) || e.t < last || e.t > until) return { ok: false, error: `event ${i}: t must be non-decreasing and <= until` };
    last = e.t;
    if (JSON.stringify(e).length > 2000) return { ok: false, error: `event ${i}: too large` };
    clean.push(JSON.parse(JSON.stringify(e)));                       // strips prototypes / non-JSON values
  }
  return { ok: true, log: clean };
}

// ----------------------------------------------------------------------------- session store (JSON files, atomic writes)
export class SessionStore {
  constructor(dir) { this.dir = path.join(dir, 'sessions'); fs.mkdirSync(this.dir, { recursive: true }); }
  static validId(id) { return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id); }
  file(id) { return path.join(this.dir, id + '.json'); }
  get(id) { if (!SessionStore.validId(id)) return null; try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { return null; } }
  put(rec) {
    const f = this.file(rec.id), tmp = f + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec)); fs.renameSync(tmp, f);
  }
  list() {
    return fs.readdirSync(this.dir).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); } catch { return null; } }).filter(Boolean);
  }
}

// ----------------------------------------------------------------------------- replay job queue
class ReplayPool {
  constructor({ concurrency, maxQueue, timeoutMs }) { this.c = concurrency; this.max = maxQueue; this.timeout = timeoutMs; this.running = 0; this.queue = []; }
  run(data) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.max) return reject(Object.assign(new Error('replay queue full'), { status: 503 }));
      this.queue.push({ data, resolve, reject }); this._next();
    });
  }
  _next() {
    while (this.running < this.c && this.queue.length) {
      const job = this.queue.shift(); this.running++;
      const w = new Worker(new URL('./replay-worker.js', import.meta.url), { workerData: job.data });
      let done = false;
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); this.running--; w.terminate().catch(() => {}); fn(v); this._next(); };
      const timer = setTimeout(() => finish(job.reject, Object.assign(new Error('replay timeout'), { status: 504 })), this.timeout);
      w.once('message', m => (m.ok ? finish(job.resolve, m) : finish(job.reject, Object.assign(new Error(m.error), { status: 422 }))));
      w.once('error', e => finish(job.reject, Object.assign(e, { status: 500 })));
    }
  }
}

// ----------------------------------------------------------------------------- server factory
export function createServer({ port = 8080, host = '0.0.0.0', dataDir = path.join(ROOT, 'data'), webDir = path.join(ROOT, 'src', 'web'), engineDir = path.join(ROOT, 'src', 'engine'), apiToken = process.env.API_TOKEN || '', quiet = false, trustProxy = process.env.TRUST_PROXY === '1' } = {}) {
  const store = new SessionStore(dataDir);
  const pool = new ReplayPool({ concurrency: LIMITS.replayConcurrency, maxQueue: LIMITS.replayQueue, timeoutMs: LIMITS.replayTimeoutMs });
  const started = Date.now(), hits = new Map();
  const debug = process.env.LOG_LEVEL === 'debug';
  const info = (level, ...a) => { if (!quiet && (level !== 'debug' || debug)) log(level, ...a); };

  const rateLimited = (ip) => {
    const now = Date.now(), w = hits.get(ip);
    if (!w || now - w.start > 60_000) { hits.set(ip, { start: now, n: 1 }); return false; }
    w.n++; return w.n > LIMITS.ratePerMinute;
  };
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > 60_000) hits.delete(k); }, 60_000).unref();

  const send = (res, status, body, headers = {}) => {
    const isStr = typeof body === 'string' || Buffer.isBuffer(body);
    const payload = isStr ? body : JSON.stringify(body);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(payload);
  };
  const fail = (res, status, error) => send(res, status, { error }, status === 413 ? { Connection: 'close' } : {});
  const tooBig = () => Object.assign(new Error('payload too large'), { status: 413 });
  const readJson = (req) => new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > LIMITS.maxBodyBytes) { req.resume(); return reject(tooBig()); }     // refuse before buffering anything
    let n = 0, over = false; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (over) { if (n > 4 * LIMITS.maxBodyBytes) req.destroy(); return; }                                          // keep draining (so the client can read the 413) up to a hard cap
      if (n > LIMITS.maxBodyBytes) { over = true; chunks.length = 0; reject(tooBig()); } else chunks.push(c);
    });
    req.on('end', () => { if (over) return; try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
  const authorised = (req) => {
    if (!apiToken) return false;                                      // instructor endpoints are disabled unless API_TOKEN is configured
    const h = req.headers.authorization || '', given = h.startsWith('Bearer ') ? h.slice(7) : '';
    const a = Buffer.from(given), b = Buffer.from(apiToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const live = createLive({ store, send, fail, readJson, info });
  const salt = apiToken || crypto.randomBytes(16).toString('hex');   // learner pseudonyms in the research export (stable while API_TOKEN is)
  const publicView = (r) => ({ id: r.id, scenario: r.scenario, learner: r.learner, spec: r.spec, seed: r.seed, createdAt: r.createdAt, status: r.status, result: r.result ?? null });

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean);              // ['api', ...]
    const m = req.method;
    if (parts[1] === 'health' && parts.length === 2 && m === 'GET') return send(res, 200, { status: 'ok', version: VERSION, uptimeS: Math.round((Date.now() - started) / 1000), scenarios: Object.keys(SCENARIOS).length, node: process.version });
    if (parts[1] === 'scenarios' && parts.length === 2 && m === 'GET') return send(res, 200, scenarioList());
    if (parts[1] === 'live' && parts.length >= 4) return live.handle(req, res, parts);   // live instructor channel (see live.js)
    if (parts[1] === 'research' && parts[2] === 'export' && parts.length === 3 && m === 'GET') {   // de-identified rows for validity studies (research.js)
      if (!authorised(req)) return fail(res, apiToken ? 401 : 403, apiToken ? 'bearer token required' : 'research export is disabled (set API_TOKEN)');
      const { rows, csv } = researchRows(store.list(), salt);
      return url.searchParams.get('format') === 'json' ? send(res, 200, rows) : send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tidal-research.csv"' });
    }
    if (parts[1] === 'sessions') {
      if (parts.length === 2 && m === 'POST') {
        const b = await readJson(req);
        const scenarioId = b.scenario ?? null;
        if (scenarioId !== null && !SCENARIOS[scenarioId]) return fail(res, 404, 'unknown scenario');
        const v = validateBodySpec(b.spec); if (!v.ok) return fail(res, 400, v.error);
        const learner = b.learner == null ? '' : String(b.learner).slice(0, LIMITS.maxStrLen);
        const base = scenarioId ? SCENARIOS[scenarioId].spec : { sex: 'M', age: 45, heightCm: 175, weightKg: 80 };
        const spec = { ...base, ...v.spec };
        const bmi = spec.weightKg / (spec.heightCm / 100) ** 2;
        if (!(bmi >= LIMITS.bmi[0] && bmi <= LIMITS.bmi[1])) return fail(res, 400, `BMI must be within [${LIMITS.bmi.join(', ')}] (validated envelope), got ${bmi.toFixed(1)}`);
        const seed = crypto.randomInt(1, 2 ** 31 - 1);                  // the server issues the seed: the client cannot choose a favourable one
        const rec = { id: crypto.randomBytes(16).toString('hex'), scenario: scenarioId, learner, spec, seed, createdAt: new Date().toISOString(), status: 'open' };
        store.put(rec); info('info', 'session created', { id: rec.id, scenario: scenarioId });
        return send(res, 201, publicView(rec));
      }
      if (parts.length === 2 && m === 'GET') {
        if (!authorised(req)) return fail(res, apiToken ? 401 : 403, apiToken ? 'bearer token required' : 'instructor listing is disabled (set API_TOKEN)');
        return send(res, 200, store.list().map(publicView).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
      }
      const id = parts[2];
      if (!SessionStore.validId(id)) return fail(res, 400, 'invalid session id');
      const rec = store.get(id); if (!rec) return fail(res, 404, 'session not found');
      if (parts.length === 3 && m === 'GET') return send(res, 200, url.searchParams.get('log') === '1' && authorised(req) ? { ...publicView(rec), log: rec.log ?? [] } : publicView(rec));
      if (parts.length === 4 && parts[3] === 'submit' && m === 'POST') {
        if (rec.status === 'submitted') return fail(res, 409, 'session already submitted');
        const b = await readJson(req);
        const lv = validateLog(b.log, b.until); if (!lv.ok) return fail(res, 400, lv.error);
        const sc = rec.scenario ? SCENARIOS[rec.scenario] : null;
        if (sc && b.until > sc.durationS * 2) return fail(res, 400, 'until exceeds twice the scenario duration');
        let out;
        try { out = await pool.run({ spec: rec.spec, seed: rec.seed, scenario: rec.scenario, log: lv.log, until: b.until }); }
        catch (e) { return fail(res, e.status || 500, e.message); }
        const clientHash = typeof b.hash === 'string' ? b.hash.slice(0, 16) : null;
        const result = { verified: clientHash === out.hash, serverHash: out.hash, clientHash, simTimeS: out.t, events: lv.log.length, score: out.score, arrests: out.arrests, roscCount: out.roscCount, final: { rhythm: out.snapshot.rhythm, map: out.snapshot.map, spo2: out.snapshot.spo2, hr: out.snapshot.hr } };
        const done = { ...rec, status: 'submitted', submittedAt: new Date().toISOString(), result, log: lv.log };
        store.put(done); info('info', 'session submitted', { id, verified: result.verified, pct: out.score?.pct });
        return send(res, 200, publicView(done));
      }
      if (parts.length === 4 && parts[3] === 'self' && m === 'POST') {   // the learner's self-assessment, once, after the case
        if (rec.status !== 'submitted') return fail(res, 409, 'submit the session first');
        if (rec.self) return fail(res, 409, 'self-assessment already recorded');
        const v = validateSelf(await readJson(req)); if (!v.ok) return fail(res, 400, v.error);
        store.put({ ...rec, self: v.self }); return send(res, 200, { ok: true });
      }
      return fail(res, 405, 'method not allowed');
    }
    return fail(res, 404, 'not found');
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
    let rel; try { rel = decodeURIComponent(url.pathname); } catch { return fail(res, 400, 'bad path'); }
    if (rel.includes('\0')) return fail(res, 400, 'bad path');
    let base = webDir;
    if (rel.startsWith('/engine/')) { base = engineDir; rel = rel.slice('/engine'.length); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(base, '.' + path.posix.normalize(rel));
    if (file !== base && !file.startsWith(base + path.sep)) return fail(res, 404, 'not found');
    let st; try { st = fs.statSync(file); } catch { return fail(res, 404, 'not found'); }
    if (!st.isFile()) return fail(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    if (!MIME[ext]) return fail(res, 404, 'not found');
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = { ...SECURITY_HEADERS, 'Content-Type': MIME[ext], 'Content-Length': st.size, ETag: etag, 'Cache-Control': 'no-cache' };       // always revalidate (ETag): engine and client modules must never be a stale mix after a deployment
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now(); const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (!url.pathname.startsWith('/api/live/') && rateLimited(ip)) return fail(res, 429, 'too many requests');   // the live channel has its own limits (live.js)
        await api(req, res, url);
      } else serveStatic(req, res, url);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) info('error', 'request failed', { err: String(e.message || e) });
      if (!res.headersSent) fail(res, status, status >= 500 ? 'internal error' : e.message);
    } finally { info('debug', 'req', { m: req.method, u: req.url.slice(0, 120), ms: Date.now() - t0 }); }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
  return {
    server, store,
    listen: () => new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    close: () => new Promise((resolve) => { live.close(); server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

// ----------------------------------------------------------------------------- CLI entry
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080), host = process.env.HOST || '0.0.0.0';
  const webDir = process.env.WEB_DIR ? path.resolve(process.env.WEB_DIR) : undefined;
  const s = createServer({ port, host, dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined, ...(webDir ? { webDir } : {}) });
  s.listen().then(addr => log('info', 'listening', { addr, version: VERSION, instructorApi: Boolean(process.env.API_TOKEN) }));
  const stop = (sig) => { log('info', 'shutting down', { sig }); s.close().then(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
}
