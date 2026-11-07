import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFERENCES, refStatus } from '../src/engine/references.js';
import { SCENARIOS } from '../src/engine/scenarios.js';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine');
const files = fs.readdirSync(ENGINE).filter(f => f.endsWith('.js') && f !== 'references.js');
const idLike = s => /[0-9_]/.test(s) || s in REFERENCES;             // a token that looks like a registry id (digit/underscore) or is one

/** collect cited ids: "REF a, b" comments and ref: 'id' properties */
function cited() {
  const out = new Map();                                             // id -> [file:line]
  const add = (id, where) => { if (!out.has(id)) out.set(id, []); out.get(id).push(where); };
  for (const f of files) {
    fs.readFileSync(path.join(ENGINE, f), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/REF ([A-Za-z][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z][A-Za-z0-9_]*)*)/g)) {
        const [first, ...more] = m[1].split(/\s*,\s*/);
        add(first, `${f}:${i + 1}`);
        for (const x of more) if (idLike(x)) add(x, `${f}:${i + 1}`);
      }
      for (const m of line.matchAll(/\bref: *'([A-Za-z0-9_]+)'/g)) add(m[1], `${f}:${i + 1}`);
    });
  }
  return out;
}

test('every REF / ref: cited in the engine source exists in the evidence registry', () => {
  const c = cited();
  assert.ok(c.size >= 30, 'found ' + c.size + ' distinct citations');
  const missing = [...c].filter(([id]) => !REFERENCES[id]).map(([id, w]) => `${id} (${w[0]})`);
  assert.deepEqual(missing, []);
});

test('every scenario criterion cites a registry id', () => {
  for (const sc of Object.values(SCENARIOS)) for (const c of sc.score()) assert.ok(REFERENCES[c.ref], `${sc.id}.${c.id} -> ${c.ref}`);
});

test('registry entries are well-formed: status in {VERIFIED, SECONDARY, UNVERIFIED}, non-trivial citation text', () => {
  for (const [id, r] of Object.entries(REFERENCES)) {
    assert.ok(['VERIFIED', 'SECONDARY', 'UNVERIFIED'].includes(r.status), `${id} status ${r.status}`);
    assert.ok(typeof r.cite === 'string' && r.cite.length >= 20, `${id} cite`);
    if (r.url) assert.match(r.url, /^https:\/\//, `${id} url`);
    assert.equal(refStatus(id), r.status);
  }
  assert.equal(refStatus('does_not_exist'), null);
});

test('every registry entry is cited in code, tests or docs, or is explicitly flagged role: background', () => {
  const read = d => fs.readdirSync(d).filter(f => /\.(js|md)$/.test(f) && f !== 'references.js' && f !== 'references.test.js').map(f => fs.readFileSync(path.join(d, f), 'utf8')).join('\n');
  const root = path.join(ENGINE, '..', '..');
  const corpus = read(ENGINE) + read(path.join(root, 'tests')) + (fs.existsSync(path.join(root, 'docs')) ? read(path.join(root, 'docs')) : '');
  for (const sc of Object.values(SCENARIOS)) for (const c of sc.score()) corpus.concat(c.ref);
  const scoring = new Set(Object.values(SCENARIOS).flatMap(sc => sc.score().map(c => c.ref)));
  const orphans = Object.entries(REFERENCES).filter(([id, r]) => !r.role && !scoring.has(id) && !new RegExp('\\b' + id + '\\b').test(corpus)).map(([id]) => id);
  assert.deepEqual(orphans, [], 'uncited registry entries: ' + orphans.join(', '));
  for (const r of Object.values(REFERENCES)) assert.ok(!r.role || r.role === 'background');
});

test('honesty: design / textbook entries are UNVERIFIED and the registry reports its own verification mix', () => {
  assert.equal(REFERENCES.design.status, 'UNVERIFIED');
  assert.equal(REFERENCES.textbook.status, 'UNVERIFIED');
  const n = s => Object.values(REFERENCES).filter(r => r.status === s).length;
  assert.ok(n('VERIFIED') >= 20, 'VERIFIED count ' + n('VERIFIED'));
  console.log(`# registry: ${n('VERIFIED')} VERIFIED, ${n('SECONDARY')} SECONDARY, ${n('UNVERIFIED')} UNVERIFIED`);
});
