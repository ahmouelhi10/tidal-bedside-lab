// Browser smoke test, with no dependency: starts the server on a free port, opens the app in headless Chrome driven over
// the DevTools protocol (Node's built-in WebSocket), and plays it the way a learner would:
//  - every scenario, in English and in French: start it, open every dock section, and look for any interface text that is
//    still a raw translation key (e_g_ "wd_r_amox") or below WCAG AA contrast against its real background;
//  - every guided procedure with hands-on steps, played with the real mouse (trusted DevTools input events): drag each
//    instrument from the table onto its site, then hold, push or cut; every hands-on step must succeed by hand, first try;
//  - one case online end to end: the server issues the seed, the browser plays it, the server replays the log and must
//    find the same state hash;
//  - throughout: any uncaught exception, console error or failed request fails the run.
// Usage: npm run smoke   (CHROME_PATH=... to choose the browser; SMOKE_REQUIRED=1 fails instead of skipping without one;
//                         SMOKE_ONLY=cases or SMOKE_ONLY=handson runs one part; SMOKE_PROCS=iv,rsi limits the procedures)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createServer } from '../src/server/server.js';

const REQUIRED = process.env.SMOKE_REQUIRED === '1';
const STEP_MS = 90_000;                                      // longest single step (one scenario, both checks)

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const win = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  const mac = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  for (const p of process.platform === 'win32' ? win : process.platform === 'darwin' ? mac : []) if (fs.existsSync(p)) return p;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null; } catch { /* not installed */ }
  }
  return null;
}

function skip(why) {
  console.log(`smoke: ${REQUIRED ? 'FAIL' : 'skipped'}: ${why}`);
  process.exit(REQUIRED ? 1 : 0);
}

/** A DevTools-protocol connection: send(method, params, sessionId) -> result; on(method, fn) for events. */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl), pending = new Map(), handlers = new Map(); let id = 0;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method) for (const fn of handlers.get(msg.method) || []) fn(msg.params, msg.sessionId);
  };
  return {
    ready: new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools connection failed')); }),
    send: (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); }),
    on: (method, fn) => { (handlers.get(method) || handlers.set(method, []).get(method)).push(fn); },
    close: () => ws.close(),
  };
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms).unref())]);

// ---- in-page checks (run inside the app; they only use what main.js exposes on window.__tbl) ----
const PAGE_SCAN = `(() => {                                    // raw translation keys visible on screen or in tooltips
  const KEY = /^[a-z]{1,6}_[a-z0-9_]{2,}$/, out = new Set(), w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; while ((n = w.nextNode())) { const s = n.nodeValue.trim(); if (KEY.test(s) && n.parentElement && n.parentElement.offsetParent !== null) out.add(s); }
  document.querySelectorAll('[title],[aria-label],[placeholder]').forEach(e => { for (const a of ['title', 'aria-label', 'placeholder']) { const v = e.getAttribute(a); if (v && KEY.test(v)) out.add(a + '=' + v); } });
  return [...out];
})()`;
// Text contrast (WCAG 2 AA: 4.5:1, or 3:1 for large text) against the real background: the panel colours (gradient stops
// included) composited, where a panel is see-through, over both a dark scene and a light wall behind it (the worse counts).
// Text inside an element still fading in or out is left for a later visit; an element faded out (opacity under 0.05)
// is not shown and not measured.
const PAGE_CONTRAST = `(() => {
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const stops = (img) => [...(img || '').matchAll(/rgba?\\([^)]+\\)/g)].map(m => parse(m[0]));
  const over = (t, b) => [t[0] * t[3] + b[0] * (1 - t[3]), t[1] * t[3] + b[1] * (1 - t[3]), t[2] * t[3] + b[2] * (1 - t[3]), 1];
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const moving = new Set(document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming?.().iterations !== Infinity).map(a => a.effect.target).filter(Boolean));
  const inMotion = (e) => { for (; e; e = e.parentElement) if (moving.has(e)) return true; return false; };   // fading in or out: measured on a later visit
  const out = [], memo = new Map(), st = (e) => memo.get(e) || (memo.set(e, getComputedStyle(e)), memo.get(e));   // one style lookup per element per scan
  const opac = new Map(), opOf = (e) => { if (!e) return 1; if (!opac.has(e)) opac.set(e, +st(e).opacity * opOf(e.parentElement)); return opac.get(e); };
  for (const el of document.querySelectorAll('body *')) {
    if (!el.firstChild) continue;
    const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.nodeValue.trim()).map(n => n.nodeValue.trim()).join(' '); if (!own) continue;
    if (!el.offsetParent && st(el).position !== 'fixed') continue;
    const cs = st(el); if (cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    const op = opOf(el); if (op < 0.05 || inMotion(el)) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const layers = []; let solid = false;
    for (let e = el; e && !solid; e = e.parentElement) { const s = st(e), b = parse(s.backgroundColor), g = stops(s.backgroundImage);
      if (g.length) { layers.push(g); if (g.every(c => c[3] >= 1)) solid = true; } if (b && b[3] > 0) { layers.push([b]); if (b[3] >= 1) solid = true; } }
    const combos = (i) => i === layers.length ? [[]] : combos(i + 1).flatMap(rest => layers[i].map(a => [a, ...rest]));
    let worst = Infinity;
    for (const bd of solid ? [[0, 0, 0, 1]] : [[8, 10, 14, 1], [205, 210, 214, 1]]) for (const c of combos(0).slice(0, 64)) { let bg = bd; for (const l of c.slice().reverse()) bg = over(l, bg); worst = Math.min(worst, ratio(over([fg[0], fg[1], fg[2], fg[3] * op], bg), bg)); }
    const size = parseFloat(cs.fontSize), large = size >= 24 || (+cs.fontWeight >= 700 && size >= 18.66);
    if (worst < (large ? 3 : 4.5)) out.push('"' + own.slice(0, 30) + '" ' + cs.color + ' ' + worst.toFixed(2) + ':1 (' + ((typeof el.className === 'string' && el.className) || el.tagName.toLowerCase()) + ')');
  }
  return out;
})()`;
const playCase = (id, lang, checkContrast) => `(async () => {
  const { sim, ui } = window.__tbl, i18n = await import('/i18n.js'), wait = (ms) => new Promise(r => setTimeout(r, ms));
  const low = new Set(), contrast = async () => { if (!${checkContrast ? 'true' : 'false'}) return; for (const x of ${PAGE_CONTRAST}) low.add(x); };   // colours do not change with the language: checked in English
  const scan = () => ${PAGE_SCAN};
  if (i18n.getLang() !== ${JSON.stringify(lang)}) {                      // the way a learner switches: the Language setting (it rebuilds the interface)
    const sel = document.getElementById('selLang'); sel.value = ${JSON.stringify(lang)}; sel.dispatchEvent(new Event('change')); await wait(300);
  }
  if (i18n.getLang() !== ${JSON.stringify(lang)}) throw new Error('the language did not switch to ${lang}');
  sim.online = false;
  await ui.onStart({ scenarioId: ${JSON.stringify(id)}, spec: {}, learner: '', tone: 2 }); await wait(150);   // what the Start button does (it also draws the case's patient)
  [...document.querySelectorAll('button')].find(b => /ready|prêt/i.test(b.textContent))?.click(); await wait(100);
  const tabs = [...document.querySelectorAll('.dock button, nav button')];
  let hits = scan(); await contrast(); for (const b of tabs) { b.click(); await wait(60); hits = hits.concat(scan()); await contrast(); }
  sim.patient.run(60);                                                 // a minute of physiology must stay finite
  const bad = []; const walk = (o, p, d) => { if (d > 3 || !o) return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'number' && !Number.isFinite(v)) bad.push(p + k); else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p + k + '.', d + 1); } };
  walk(sim.patient.snapshot(), '', 0);
  sim.patient.run(1); await wait(100); await contrast();             // alarms and banners that a minute brought up
  return { tabs: tabs.length, rawKeys: [...new Set(hits)], nonFinite: bad, lowContrast: [...low] };
})()`;
// ---- hands-on procedures, played with the real mouse: drag the instrument from the table onto the patient, then hold,
// push or cut as the step asks. The page only reports where things are on screen; the gestures are trusted mouse events
// sent through the DevTools protocol, so they go through the same pointer handlers a learner's mouse does.
const START_PROC = (id) => `(async () => {
  const { sim, ui, scene } = window.__tbl, wait = (ms) => new Promise(r => setTimeout(r, ms));
  const { PROCEDURES, SKILL_CASE } = await import('/procedures.js');
  const pr = PROCEDURES.find(p => p.id === ${JSON.stringify(id)});
  for (let i = 0; i < 100 && !(scene.asset && scene.instruments); i++) await wait(100);   // the realistic patient and the instrument models
  if (!(scene.asset && scene.instruments)) return { error: 'the patient or instrument models did not load' };
  sim.online = false; await ui.onStart({ scenarioId: SKILL_CASE[pr.id] || null, spec: {}, learner: '', tone: 2 }); await wait(150);
  [...document.querySelectorAll('button')].find(b => /ready|prêt/i.test(b.textContent))?.click(); await wait(150);
  ui.startGuide(pr); await wait(200);
  return { steps: pr.steps.length, hands: pr.steps.filter(s => s.hand).map(s => s.id) };
})()`;
/** Where the current step's instrument tile and target are on screen, once the camera has settled on the step. */
const GUIDE_STATE = `(async () => {
  const { sim, ui, scene } = window.__tbl, g = ui.guide, wait = (ms) => new Promise(r => setTimeout(r, ms));
  if (!g) return { error: 'no guide' };
  if (g.finished) return { finished: true };
  const s = g.step, p = sim.patient;
  if (g.hold) return { i: g.i, id: s.id, hold: true };
  const rem = g.remaining(p); if (rem > 0) p.run(rem + 1);                         // the step must wait (a drug's onset): let patient time pass
  const h = s.hand; if (!h) return { i: g.i, id: s.id, button: true };
  const W = scene.world, cs = scene.chestSites;
  const tgt = h.target === 'chestSite' ? cs[g.prm.side || 'R'][h.site || g.prm.site || 'mal5'] : W[h.target];
  const ax = h.axis === 'cross' ? [0, 0, 1] : [1, 0, 0], len = ((h.minCm ?? 2) + (h.maxCm ?? 4)) / 200;   // a stroke: half-way between the shortest and longest cut, along the body
  // an incision is judged by its midpoint: cut across the site, from half a length before it to half a length after
  const P = (k) => [tgt[0] + ax[0] * len * k, tgt[1], tgt[2] + ax[2] * len * k], cut = h.gesture === 'stroke';
  const shot = () => ({ a: scene.project(cut ? P(-0.5) : tgt), b: scene.project(P(0.5)) });
  // the guide frames the step's site after a short delay: wait until the camera is headed there and has arrived
  const key = h.target === 'chestSite' ? (g.prm.side || 'R') + '_' + (h.site || g.prm.site || 'mal5') : h.target, site = scene.siteFrame?.(key)?.p || tgt;
  const there = () => scene.goal?.target && Math.hypot(scene.goal.target[0] - site[0], scene.goal.target[1] - site[1], scene.goal.target[2] - site[2]) < 0.02 && !scene.tw;
  for (let k = 0; k < 80 && !there(); k++) await wait(100);
  // aim by checking, not by trusting the camera: the body point under the drop pixel must be on the site (within a third of
  // the step's tolerance; for a cut, the cut's start). Software rendering in headless Chrome is slow, so this can take seconds.
  const c0 = scene.canvas.getBoundingClientRect(), aim = cut ? P(-0.5) : tgt, tol = (h.radiusCm ?? 3) / 300;
  let cur = shot(), off = Infinity;
  for (let k = 0; k < 150; k++) {
    cur = shot(); const hit = cur.a && scene.pickBody(c0.left + cur.a.x, c0.top + cur.a.y);
    off = hit ? Math.hypot(hit.p[0] - aim[0], hit.p[1] - aim[1], hit.p[2] - aim[2]) : Infinity;
    if (off < tol && !scene.tw) break; await wait(100);
  }
  if (!(off < tol)) return { i: g.i, id: s.id, error: 'the site is not under its own projection after 15 s (' + (off * 100).toFixed(1) + ' cm off, view ' + scene.view + ')' };
  const tile = document.querySelector('.pw-table.live .pw-tool[data-tool="' + h.tool + '"]'); if (!tile) return { i: g.i, id: s.id, error: 'no live instrument tile for ' + h.tool };
  const r = tile.getBoundingClientRect(), c = scene.canvas.getBoundingClientRect();
  return { i: g.i, id: s.id, gesture: h.gesture, tool: h.tool, tile: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
    at: cur.a && { x: c.left + cur.a.x, y: c.top + cur.a.y, visible: cur.a.visible }, to: cur.b && { x: c.left + cur.b.x, y: c.top + cur.b.y },
    holdMs: ((h.holdS ?? 2) + 0.4) * 1000, pushPx: ((h.minCm + h.maxCm) / 2) / (h.cmPerPx ?? 0.05) };
})()`;
const GUIDE_CHECK = (id) => `(() => {
  const { sim, ui } = window.__tbl, g = ui.guide, notes = sim.patient.log.filter(e => e.type === 'note').map(e => e.text);
  const hands = new Set(g ? g.proc.steps.filter(s => s.hand).map(s => s.id) : []);
  return { finished: !!g?.finished, status: g ? [...g.status] : [], handsOn: notes.filter(n => n.startsWith('guide ${id}:') && n.includes('[hands-on:')),
    present: notes.filter(n => n.startsWith('guide ${id}:') && n.endsWith('(already in place)') && hands.has(n.slice('guide ${id}: '.length, -' (already in place)'.length))).length,
    failed: notes.filter(n => n.startsWith('guide attempt ${id}:')) };
})()`;

const ONLINE_CASE = `(async () => {
  const { sim, ui } = window.__tbl, i18n = await import('/i18n.js');
  if (i18n.getLang() !== 'en') { const sel = document.getElementById('selLang'); sel.value = 'en'; sel.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 300)); }
  await sim.probeServer(); if (!sim.online) return { error: 'the page did not reach the server' };
  await ui.onStart({ scenarioId: 'obese_rsi', spec: {}, learner: '', tone: 2 }); const p = sim.patient;
  for (const e of [{ type: 'position.set', headUp: true }, { type: 'o2.mask', fio2: 0.8, seal: 0.95 }, { type: 'drug.bolus', drug: 'propofol', amount: 200 },
    { type: 'drug.bolus', drug: 'rocuronium', amount: 100 }, { type: 'procedure.arterial_line', us: true }]) { sim.act(e); p.run(30); }
  p.run(120); const out = await sim.finish();
  return { id: sim.session.id, verified: out.server ? out.server.verified : null, error: out.error || null };
})()`;

async function main() {
  const chrome = findChrome(); if (!chrome) return skip('no Chrome or Chromium found (set CHROME_PATH)');
  if (!fs.existsSync(chrome)) return skip(`no browser at ${chrome}`);
  if (typeof WebSocket !== 'function') return skip(`Node ${process.version} has no built-in WebSocket (Node 22 or later)`);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbl-smoke-data-')), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tbl-smoke-chrome-'));
  const webDir = process.env.WEB_DIR ? path.resolve(process.env.WEB_DIR) : undefined;                    // as for the server: another copy of the client
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true, ...(webDir ? { webDir } : {}) }), addr = await srv.listen(), base = `http://127.0.0.1:${addr.port}`;
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1280,800', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'];
  const proc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const problems = [], started = Date.now();
  let browser = null;
  const cleanup = async () => { try { browser?.close(); } catch { /* closed */ } proc.kill(); await srv.close(); for (const d of [dataDir, profile]) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* still locked */ } };
  try {
    const wsUrl = await withTimeout(new Promise((res, rej) => {
      let buf = ''; proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
      proc.on('exit', (c) => rej(new Error(`Chrome exited (${c}) before DevTools was ready`)));
    }), 30_000, 'Chrome start');
    browser = cdp(wsUrl); await browser.ready;
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: s } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (m, p) => browser.send(m, p, s);
    browser.on('Runtime.exceptionThrown', (p) => problems.push(`uncaught: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`));
    browser.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'assert') problems.push(`console.${p.type}: ${p.args.map(a => a.value ?? a.description ?? '').join(' ')}`); });
    browser.on('Log.entryAdded', (p) => { if (p.entry.level === 'error') problems.push(`${p.entry.source}: ${p.entry.text}${p.entry.url ? ' ' + p.entry.url : ''}`); });
    browser.on('Page.javascriptDialogOpening', (p) => { problems.push(`dialog: ${p.message}`); send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
    await Promise.all([send('Runtime.enable'), send('Log.enable'), send('Page.enable')]);
    const evaluate = async (expression, what) => {
      const r = await withTimeout(send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), STEP_MS, what);
      if (r.exceptionDetails) throw new Error(`${what}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    };

    await send('Page.navigate', { url: base + '/' });
    // wait for boot() to finish (the case menu is built): window.__tbl is set before ui.init() has run
    const t0 = Date.now(); while (!(await evaluate('Boolean(window.__tbl && window.__tbl.ui.dom && window.__tbl.ui.dom.menu)', 'page load'))) { if (Date.now() - t0 > 30_000) throw new Error('the app did not start within 30 s'); await new Promise(r => setTimeout(r, 200)); }
    const ids = await evaluate(`import('/engine/scenarios.js').then(m => Object.keys(m.SCENARIOS))`, 'scenario list');
    const webgl = await evaluate(`Boolean(document.createElement('canvas').getContext('webgl2'))`, 'WebGL2 check');
    console.log(`smoke: ${ids.length} scenarios, WebGL2 ${webgl ? 'available' : 'not available (procedural fallback)'}`);
    if (process.env.SMOKE_DEBUG) console.log('smoke: page', JSON.stringify(await evaluate(`(async () => { let n = 0; const t0 = performance.now(); await new Promise(r => { const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); }); return { visibility: document.visibilityState, focus: document.hasFocus(), framesPerSecond: n }; })()`, 'frame rate')));

    let played = 0; const only = process.env.SMOKE_ONLY || '', tCases = Date.now();     // SMOKE_ONLY=cases | handson: one part only (CI runs them as two jobs)
    for (const lang of ['en', 'fr']) for (const id of only === 'handson' ? [] : ids) {
      const before = problems.length, r = await evaluate(playCase(id, lang, lang === 'en'), `${lang} ${id}`); played++;
      if (r.tabs < 5) problems.push(`${lang} ${id}: only ${r.tabs} dock sections found`);
      for (const k of r.rawKeys) problems.push(`${lang} ${id}: raw translation key on screen: ${k}`);
      for (const k of r.nonFinite) problems.push(`${lang} ${id}: non-finite value after a minute: ${k}`);
      for (const k of r.lowContrast) if (!problems.some(p => p.endsWith(k))) problems.push(`${lang} ${id}: text below WCAG AA contrast: ${k}`);
      if (problems.length > before) for (const p of problems.slice(before)) if (!p.startsWith(`${lang} ${id}`)) problems[problems.indexOf(p)] = `${lang} ${id}: ${p}`;
    }
    if (played) console.log(`smoke: ${played} cases played in ${((Date.now() - tCases) / 1000).toFixed(0)} s`);
    // hands-on procedures with the real mouse
    const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse', ...extra });
    const glide = async (x0, y0, x1, y1, n = 12) => { for (let k = 1; k <= n; k++) { await mouse('mouseMoved', x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n); await sleep(16); } };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const procs = (await evaluate(`import('/procedures.js').then(m => m.PROCEDURES.filter(p => p.steps.some(s => s.hand)).map(p => p.id))`, 'procedure list'))
      .filter(id => only !== 'cases' && (!process.env.SMOKE_PROCS || process.env.SMOKE_PROCS.split(',').includes(id)));   // SMOKE_PROCS=iv,rsi: only these
    let gestures = 0;
    for (const id of procs) {
      const t0 = Date.now(), before = problems.length, start = await evaluate(START_PROC(id), `start ${id}`);
      if (start.error) { problems.push(`hands-on ${id}: ${start.error}`); continue; }
      for (let guard = 0; guard < start.steps * 3; guard++) {
        const ts = Date.now(), st = await evaluate(GUIDE_STATE, `${id} step state`);
        if (process.env.SMOKE_DEBUG) console.log(`    ${id} step ${st.i} ${st.id || ''} ${st.hold ? 'hold' : st.button ? 'button' : st.gesture || ''} (state ${Date.now() - ts} ms)`);
        if (st.error) { problems.push(`hands-on ${id}: ${st.error}`); break; }
        if (st.finished) break;
        if (st.hold) { await evaluate(`document.getElementById('btnGuideNext')?.click()`, 'continue'); await sleep(200); continue; }
        if (st.button) { await evaluate(`document.getElementById('btnGuideDo')?.click()`, 'perform'); await sleep(250); continue; }
        if (!st.at || !st.at.visible) { problems.push(`hands-on ${id} ${st.id}: the target is off screen`); break; }
        // drag the instrument from the table and drop it on the site
        await mouse('mousePressed', st.tile.x, st.tile.y); await glide(st.tile.x, st.tile.y, st.at.x, st.at.y, 6); await mouse('mouseReleased', st.at.x, st.at.y); await sleep(120);
        // then the gesture itself
        if (st.gesture === 'hold') { await mouse('mousePressed', st.at.x, st.at.y); await sleep(st.holdMs); await mouse('mouseReleased', st.at.x, st.at.y); }
        else if (st.gesture === 'push') { await mouse('mousePressed', st.at.x, st.at.y); await glide(st.at.x, st.at.y, st.at.x, st.at.y + st.pushPx, 5); await mouse('mouseReleased', st.at.x, st.at.y + st.pushPx); }
        else if (st.gesture === 'stroke') { await mouse('mousePressed', st.at.x, st.at.y); await glide(st.at.x, st.at.y, st.to.x, st.to.y, 6); await mouse('mouseReleased', st.to.x, st.to.y); }
        else if (st.gesture === 'rotate') { await mouse('mousePressed', st.at.x, st.at.y); await glide(st.at.x, st.at.y, st.at.x + 150, st.at.y, 5); await mouse('mouseReleased', st.at.x + 150, st.at.y); }
        gestures++; await sleep(250);
        const after = await evaluate(GUIDE_CHECK(id), `${id} check`);
        if (after.failed.length) { problems.push(`hands-on ${id} ${st.id}: ${after.failed.pop()}`); break; }
      }
      const end = await evaluate(GUIDE_CHECK(id), `${id} end`);
      if (problems.length === before) {
        if (!end.finished) problems.push(`hands-on ${id}: the procedure did not reach its end (steps ${end.status.join(',')})`);
        const byHand = start.hands.length - end.present;                    // a step whose equipment the case already has is marked in place, not played
        if (end.handsOn.length !== byHand) problems.push(`hands-on ${id}: ${end.handsOn.length} of ${byHand} hands-on steps done by hand`);
      }
      console.log(`smoke:   ${id}: ${end.handsOn.length} hands-on steps by mouse, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    if (procs.length) console.log(`smoke: ${procs.length} hands-on procedures, ${gestures} gestures with the real mouse`);
    const online = await evaluate(ONLINE_CASE, 'online case');
    if (online.error) problems.push(`online case: ${online.error}`); else if (online.verified !== true) problems.push(`online case: the server replay did not verify (session ${online.id})`);

    console.log(`smoke: played ${played} cases (EN and FR), every dock section opened; online case ${online.verified === true ? 'verified by the server' : 'NOT verified'}; ${((Date.now() - started) / 1000).toFixed(0)} s`);
  } catch (e) {
    problems.push(`smoke harness: ${e.message}`);
  } finally { await cleanup(); }
  if (problems.length) { console.log(`smoke: FAIL, ${problems.length} problem(s):`); for (const p of problems) console.log('  - ' + p); process.exit(1); }
  console.log('smoke: OK');
}

main().catch((e) => { console.error('smoke:', e); process.exit(1); });
