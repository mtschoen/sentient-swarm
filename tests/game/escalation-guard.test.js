import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ESCALATION_DEFAULTS } from '../../src/game/escalation.js';

const SOURCE_DIRECTORY = new URL('../../src/', import.meta.url);

function sourceFiles(directory = SOURCE_DIRECTORY, prefix = 'src/') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
    return entry.name.endsWith('.js') ? [{ path: `${prefix}${entry.name}`, url: new URL(entry.name, directory) }] : [];
  });
}

// The escalation ships on at rate 1; only the lab retunes it, so a run from the title plays the shipped curve.
test('the shipped escalation runs at rate 1 and only the lab binding calls escalation.set', () => {
  assert.equal(ESCALATION_DEFAULTS.rate, 1);
  const files = sourceFiles().filter(({ url }) => readFileSync(url, 'utf8').includes('escalation.set(')).map(({ path }) => path);
  assert.deepEqual(files, ['src/ui/lab.js']);
});
