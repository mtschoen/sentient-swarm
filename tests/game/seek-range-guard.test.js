import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const SOURCE_DIRECTORY = new URL('../../src/', import.meta.url);

function sourceFiles(directory = SOURCE_DIRECTORY, prefix = 'src/') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
    return entry.name.endsWith('.js') ? [{ path: `${prefix}${entry.name}`, url: new URL(entry.name, directory) }] : [];
  });
}

// The seek range is lab only: the game must never set it, so shipped play stays unlimited.
test('setSeekRange appears only in the Simulation (definition and carryStateInto) and the lab binding', () => {
  const files = sourceFiles().filter(({ url }) => readFileSync(url, 'utf8').includes('setSeekRange')).map(({ path }) => path);
  assert.deepEqual(files.sort(), ['src/sim/simulation.js', 'src/ui/lab.js']);
});
