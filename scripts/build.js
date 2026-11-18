#!/usr/bin/env node
// Build a self-contained, deployable dist/ (the app has no runtime dependencies and no bundling step):
//   dist/src/{engine,server,web}, dist/package.json, dist/docs, dist/BUILD.json (version + engine content hash for traceability).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-syntax.js')], { stdio: 'inherit' });
if (check.status !== 0) { console.error('build aborted: syntax check failed'); process.exit(1); }

fs.rmSync(DIST, { recursive: true, force: true });
const EXCLUDE = new Set(['bodytest.html']);
function copy(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const n of fs.readdirSync(src)) if (!EXCLUDE.has(n)) copy(path.join(src, n), path.join(dst, n)); }
  else fs.copyFileSync(src, dst);
}
copy(path.join(ROOT, 'src'), path.join(DIST, 'src'));
for (const f of ['package.json', 'README.md', 'LICENSE']) if (fs.existsSync(path.join(ROOT, f))) copy(path.join(ROOT, f), path.join(DIST, f));
if (fs.existsSync(path.join(ROOT, 'docs'))) copy(path.join(ROOT, 'docs'), path.join(DIST, 'docs'));
fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });

const engineDir = path.join(DIST, 'src', 'engine');
const h = crypto.createHash('sha256');
for (const n of fs.readdirSync(engineDir).sort()) { h.update(n); h.update(fs.readFileSync(path.join(engineDir, n))); }
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const count = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
const { EUCAST_VERSION } = await import(new URL('../src/engine/infection.js', import.meta.url));   // breakpoint table the infectiology ward was built against (CLINICAL_REVIEW INF-1)
const manifest = { name: pkg.name, version: pkg.version, builtAt: new Date().toISOString(), engineSha256: h.digest('hex'), eucastVersion: EUCAST_VERSION, files: count(DIST) };
fs.writeFileSync(path.join(DIST, 'BUILD.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('built', path.relative(ROOT, DIST), manifest);
