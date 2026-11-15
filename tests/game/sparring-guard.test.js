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

const filesWith = (needle) => sourceFiles().filter(({ url }) => readFileSync(url, 'utf8').includes(needle)).map(({ path }) => path).sort();

// The sparring dummy is a debug option: only main.js, under ?debug=sparring, seats the virtual pad
// and marks neutral-immune seats, so shipped play is unchanged. The online wiring may only clear
// them (an online match has no dummy).
test('setNeutralImmuneSeats is defined by Game, called with seats only by main.js, and cleared by the online wiring', () => {
  assert.deepEqual(filesWith('setNeutralImmuneSeats('), ['src/game/game.js', 'src/main.js', 'src/ui/online-wiring.js']);
  const wiring = readFileSync(new URL('ui/online-wiring.js', SOURCE_DIRECTORY), 'utf8');
  assert.deepEqual(wiring.match(/setNeutralImmuneSeats\([^)]*\)/g), ['setNeutralImmuneSeats([])']);
});

test('the virtual seat is seated only by the coop join and enabled only by main.js', () => {
  assert.deepEqual(filesWith('seatVirtual('), ['src/input/seat-join.js', 'src/ui/coop-join.js']);
  assert.deepEqual(filesWith('menuElement: menu.element, sparring }'), ['src/main.js']);
  assert.ok(readFileSync(new URL('main.js', SOURCE_DIRECTORY), 'utf8').includes("get('debug') === 'sparring'"));
});
