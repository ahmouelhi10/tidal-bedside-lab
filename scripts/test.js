#!/usr/bin/env node
// Run every tests/*.test.js with node:test. The file list is built here because Node 20 does not expand glob patterns given to
// `node --test` (Node >= 21 does) and Windows shells do not expand them either. Extra arguments are passed through, e.g.
//   npm test -- --test-name-pattern="catalogue"
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = fs.readdirSync(path.join(ROOT, 'tests')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join('tests', f));
if (!files.length) { console.error('no tests/*.test.js files found'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
