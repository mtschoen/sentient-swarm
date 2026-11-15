import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STEP, createGame } from './game-harness.js';
import { packGateOwnership } from '../../src/sim/params.js';

const SOURCE_DIRECTORY = new URL('../../src/', import.meta.url);

function sourceFiles(directory = SOURCE_DIRECTORY, prefix = 'src/') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
    return entry.name.endsWith('.js') ? [{ path: `${prefix}${entry.name}`, url: new URL(entry.name, directory) }] : [];
  });
}

const filesWith = (needle) => sourceFiles().filter(({ url }) => readFileSync(url, 'utf8').includes(needle)).map(({ path }) => path).sort();

// Hive gates and agent targets are hives only: the fixed sites are set by the mode switch alone, and
// the gate rows' owner and target (the agent target bits spawn.wgsl writes) come from hive-seats.js alone.
test('setFixedSites is defined by the spawn director and called only by the mode switch', () => {
  assert.deepEqual(filesWith('setFixedSites('), ['src/game/versus-seats.js', 'src/sim/spawn-director.js']);
  assert.deepEqual(filesWith('hiveTarget('), ['src/game/hive-seats.js', 'src/game/hives.js']);
  assert.deepEqual(filesWith('hiveGateTable('), ['src/game/game.js', 'src/game/hive-seats.js']);
});

async function gateTablesFor(mode) {
  const { game, simulation } = await createGame();
  const tables = [];
  const step = simulation.step.bind(simulation);
  simulation.step = (encoder, deltaSeconds, spawnPerSpecies, spawnGates, projectileDeltaSeconds) => {
    tables.push(spawnGates);
    step(encoder, deltaSeconds, spawnPerSpecies, spawnGates, projectileDeltaSeconds);
  };
  simulation.setVersusProjectiles = () => {};
  if (mode !== 'solo') game.setPlayerCount(2);
  if (mode === 'versus') game.setMode('versus');
  for (let index = 0; index < 30; index += 1) game.update(STEP);
  game.start();
  for (let index = 0; index < 600; index += 1) game.update(STEP);
  return { tables: tables.filter((table) => table !== null), game };
}

for (const mode of ['solo', 'coop', 'versus']) {
  test(`${mode} gate tables carry no hive fields and pack no ownership, from roaming gates`, async () => {
    const { tables, game } = await gateTablesFor(mode);
    assert.ok(tables.length > 0);
    assert.equal(game.spawnDirector.fixedSites, null);
    assert.equal(game.state.hives, null);
    for (const table of tables) {
      assert.equal(packGateOwnership(table.gates), 0);
      for (const row of table.gates) assert.deepEqual(Object.keys(row).sort(), ['emit', 'open', 'radius', 'species', 'telegraph', 'x', 'y']);
    }
  });
}
