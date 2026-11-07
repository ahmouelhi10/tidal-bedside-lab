#!/usr/bin/env node
// Syntax-check every .js file under src/, scripts/ and tests/ with `node --check` (ES modules). Exit code 1 on any failure.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : (e.name.endsWith('.js') ? [path.join(dir, e.name)] : [])) : [];
const files = ['src', 'scripts', 'tests'].flatMap(d => walk(path.join(ROOT, d)));
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error(`FAIL ${path.relative(ROOT, f)}\n${r.stderr}`); }
}
console.log(`${files.length - bad}/${files.length} files OK`);
process.exit(bad ? 1 : 0);
