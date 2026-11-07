#!/usr/bin/env node
// Generate docs/REFERENCES.md from the evidence registry (src/engine/references.js). Run: npm run docs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFERENCES } from '../src/engine/references.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = Object.entries(REFERENCES);
const by = (s) => entries.filter(([, v]) => v.status === s);
const row = ([id, v]) => `| \`${id}\` | ${v.role === 'background' ? 'background' : 'cited in code/tests'} | ${v.cite.replace(/\|/g, '/')}${v.url ? ` <${v.url}>` : ''} |`;
const section = (title, status, note) => `## ${title} (${by(status).length})\n\n${note}\n\n| id | use | citation |\n|---|---|---|\n${by(status).map(row).join('\n')}\n`;
const md = `# References

Generated from \`src/engine/references.js\` by \`npm run docs\` - do not edit by hand. Total entries: ${entries.length}.

Every engine constant that is not a pure convention carries a \`REF <id>\` tag in code, tests or docs; \`tests/references.test.js\` fails if a cited id is missing from the registry or an entry is never used. Status meanings:

- **VERIFIED** - checked against the primary text/abstract, or against at least two concordant independent sources, in the project research notes.
- **SECONDARY** - taken from a review, a software library or a teaching page; the primary paper was not read.
- **UNVERIFIED** - a design value or textbook recollection. A clinician or physiologist must review it before any educational claim relies on it (see VALIDATION.md).

${section('Verified', 'VERIFIED', 'Primary source or two concordant independent sources.')}
${section('Secondary', 'SECONDARY', 'Primary source not read in this project.')}
${section('Unverified', 'UNVERIFIED', 'Design values. Review required.')}
`;
fs.writeFileSync(path.join(ROOT, 'docs', 'REFERENCES.md'), md);
console.log(`docs/REFERENCES.md: ${entries.length} entries (${by('VERIFIED').length} verified, ${by('SECONDARY').length} secondary, ${by('UNVERIFIED').length} unverified)`);
