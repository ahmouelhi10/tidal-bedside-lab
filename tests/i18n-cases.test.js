// French coverage that the interface cannot check for itself: every case's own text, and the engine's refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
globalThis.document ??= { documentElement: {} };                 // setLang() sets the page language
const { setLang, scenarioText, errText } = await import('../src/web/i18n.js');
const { scenarioList } = await import('../src/engine/scenarios.js');

test('every case has a French summary and as many French objectives as English ones', () => {
  setLang('fr');
  for (const s of scenarioList()) {
    const f = scenarioText(s);
    assert.notEqual(f.summary, s.summary, s.id + ': summary still in English');
    assert.equal(f.learning?.length, s.learning?.length, s.id + ': objectives');
  }
  setLang('en');
});

test("every refusal the engine can give is translated (patient.js, ett.js, infection.js)", () => {
  setLang('fr');
  for (const file of ['patient.js', 'ett.js', 'infection.js']) {
    const src = fs.readFileSync(new URL('../src/engine/' + file, import.meta.url), 'utf8');
    for (const m of src.matchAll(/ok: false, error: '([^']+)'/g)) assert.notEqual(errText(m[1]), m[1], `${file}: "${m[1]}"`);
  }
  assert.equal(errText('ceftriaxone is already prescribed'), 'ceftriaxone est déjà prescrit');
  assert.equal(errText('something new'), 'something new', 'unknown messages are shown as they are');
  setLang('en'); assert.equal(errText('not charged'), 'not charged');
});
