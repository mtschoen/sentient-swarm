import test from 'node:test';
import assert from 'node:assert/strict';
import { SpawnDirector } from '../../src/sim/spawn-director.js';

const SITES = [{ x: 6, y: 4.5, radius: 1.5 }, { x: 26, y: 13.5, radius: 1.5 }, { x: 16, y: 9, radius: 1.5 }];
const STEP = 1 / 60;

function seededRandom() {
  let state = 7;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

test('fixed sites are the gates: open at once, never moving or closing, each row with its site', () => {
  const director = new SpawnDirector({ random: seededRandom() });
  director.setFixedSites(SITES);
  const context = { playerX: 6, playerY: 9, safeDistance: 4, view: { centerX: 6, centerY: 9, width: 16, height: 9 }, aimX: 1, aimY: 0 };
  director.update(STEP, { ...context, filling: true });
  let table = director.spawnGates;
  assert.equal(table.gates.length, 3);
  assert.ok(table.gates.every((row) => row.open === 1 && row.emit === 1), 'the first fill pours from every hive');
  for (let index = 0; index < 60 * 60; index += 1) director.update(STEP, context);
  table = director.spawnGates;
  assert.deepEqual(table.gates.map((row) => [row.site, row.x, row.y, row.radius]).sort((first, second) => first[0] - second[0]), SITES.map((site, index) => [index, site.x, site.y, site.radius]));
  assert.ok(director.waveSequence > 10, `waves ${director.waveSequence}`);
});

test('waves skip a hive inside the safe radius but ignore the aim lane, and null returns to roaming gates', () => {
  const director = new SpawnDirector({ random: seededRandom() });
  director.setFixedSites(SITES);
  // The player sits on hive 0 and aims straight through hive 2.
  const context = { playerX: 6, playerY: 4.5, safeDistance: 4, aimX: 1, aimY: 0.45 };
  const emitted = new Set();
  for (let index = 0; index < 60 * 30; index += 1) {
    director.update(STEP, context);
    director.spawnGates.gates.filter((row) => row.emit > 0).forEach((row) => emitted.add(row.site));
  }
  assert.ok(!emitted.has(0), 'the hive under the player never waves');
  assert.ok(emitted.has(2), 'the hive in the aim lane still waves');
  director.setFixedSites(null);
  director.update(STEP, context);
  assert.ok(director.spawnGates.gates.every((row) => row.site === undefined));
  assert.throws(() => director.setFixedSites([]), RangeError);
});
