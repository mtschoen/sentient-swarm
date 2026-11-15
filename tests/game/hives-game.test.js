import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, createGame, stats } from './game-harness.js';
import { VERSUS_PICKUP_ROTATION } from '../../src/game/versus.js';
import { PICKUP_TYPE_NAMES } from '../../src/game/weaponTypes.js';
import { HIVE_TUNING } from '../../src/game/hive-tuning.js';

const PROJECTILE_BUFFER = { label: 'projectiles' };

// A two-seat harness whose fake simulation also records the versus calls and every step's gate table.
async function hivesHarness({ mode = 'hives', start = true } = {}) {
  const harness = await createGame();
  const { simulation, projectiles, game } = harness;
  simulation.versusProjectileCalls = [];
  simulation.setVersusProjectiles = (buffer) => simulation.versusProjectileCalls.push(buffer);
  simulation.gateTables = [];
  const step = simulation.step.bind(simulation);
  simulation.step = (encoder, deltaSeconds, spawnPerSpecies, spawnGates, projectileDeltaSeconds) => {
    simulation.gateTables.push(spawnGates);
    step(encoder, deltaSeconds, spawnPerSpecies, spawnGates, projectileDeltaSeconds);
  };
  projectiles.buffer = PROJECTILE_BUFFER;
  game.setPlayerCount(2);
  if (mode !== 'coop') game.setMode(mode);
  if (start) {
    game.start();
    game.update(STEP);
  }
  return harness;
}

// Holds every alive ship of seat at (x, y) (the flock step moves them less than a disc radius).
function park(seat, { x, y }) {
  seat.swarm.slots.forEach((slot) => {
    if (!slot.alive) return;
    slot.x = x;
    slot.y = y;
  });
}

function updateParked(game, seconds, parking) {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += STEP) {
    parking();
    game.update(STEP);
  }
}

test('hives is a third mode: Ready only, two seats, versus projectiles and rotation, fixed hive gates', async () => {
  const { game, simulation } = await hivesHarness({ start: false });
  assert.equal(game.mode, 'hives');
  assert.equal(game.versus, true);
  assert.equal(game.state.mode, 'hives');
  assert.deepEqual(simulation.versusProjectileCalls, [PROJECTILE_BUFFER]);
  assert.deepEqual([...game.pickups.rotation], [...VERSUS_PICKUP_ROTATION]);
  assert.equal(game.spawnDirector.fixedSites.length, 3);
  game.setMode('versus');
  assert.equal(game.mode, 'versus');
  assert.equal(simulation.versusProjectileCalls.length, 1, 'versus and hives share the projectiles without a new call');
  assert.equal(game.spawnDirector.fixedSites, null);
  game.setMode('hives');
  game.setMode('coop');
  assert.deepEqual(simulation.versusProjectileCalls, [PROJECTILE_BUFFER, null]);
  assert.equal(game.pickups.rotation, PICKUP_TYPE_NAMES);
  assert.equal(game.spawnDirector.fixedSites, null);
  game.setPlayerCount(1);
  assert.throws(() => game.setMode('hives'), RangeError);
});

test('one seat, quit and the lab return hives to co-op with roaming gates', async () => {
  const { game } = await hivesHarness();
  game.quitToTitle();
  assert.equal(game.mode, 'coop');
  assert.equal(game.spawnDirector.fixedSites, null);
  game.setPlayerCount(2);
  game.setMode('hives');
  game.setWatch(0.1);
  assert.equal(game.mode, 'coop');
  game.setWatch(null);
  game.setPlayerCount(2);
  game.setMode('hives');
  game.setPlayerCount(1);
  assert.equal(game.mode, 'coop');
});

test('hives seats start at the versus starts, and every step gets the three hive rows', async () => {
  const { game, simulation } = await hivesHarness();
  assert.deepEqual(game.seats.map((seat) => Math.round(seat.point.x)), [6, 26]);
  const table = simulation.gateTables.at(-1);
  assert.equal(table.gates.length, 3);
  assert.deepEqual(table.gates.map((row) => row.site).sort(), [0, 1, 2]);
  for (const row of table.gates) {
    assert.equal(row.owner, null);
    assert.equal(row.target, null);
    assert.deepEqual(row.hive, { owner: null, capturer: null, progress: 0 });
  }
  assert.equal(game.state.hives.hives.length, 3);
});

test('a seat parked on a hive captures it in about 5 s; its rows then aim the agents at the other seat', async () => {
  const { game, simulation } = await hivesHarness();
  const hives = game.versusMatch.hives;
  const middle = hives.hives[2];
  updateParked(game, 2.5, () => park(game.seats[0], middle));
  assert.equal(middle.capturer, 0);
  assert.ok(middle.progress > 0.4 && middle.progress < 0.6, `progress ${middle.progress}`);
  assert.equal(simulation.gateTables.at(-1).gates.find((row) => row.site === 2).hive.capturer, 0);
  updateParked(game, 2.7, () => park(game.seats[0], middle));
  assert.equal(middle.owner, 0);
  const row = simulation.gateTables.at(-1).gates.find((entry) => entry.site === 2);
  assert.equal(row.owner, 0);
  assert.equal(row.target, 1);
  assert.deepEqual(game.state.hives.hives[2], { owner: 0, capturer: null, progress: 0 });
  // Seat 2 takes it back the same way.
  updateParked(game, 5.2, () => park(game.seats[1], middle));
  assert.equal(middle.owner, 1);
  assert.equal(simulation.gateTables.at(-1).gates.find((entry) => entry.site === 2).target, 0);
});

test('holding every hive for 20 s wins the match and the restart plays hives again from neutral', async () => {
  const { game } = await hivesHarness();
  const hives = game.versusMatch.hives;
  hives.hives.forEach((hive) => { hive.owner = 1; });
  const events = [];
  game.effects = { death: () => events.push('death') };
  for (let elapsed = 0; elapsed < HIVE_TUNING.holdSecondsToWin - 1; elapsed += STEP) game.update(STEP);
  assert.equal(game.state.matchResult, null);
  assert.equal(game.state.hives.holder, 1);
  assert.ok(game.state.hives.holdRemainingSeconds <= 1.1);
  for (let index = 0; index < 120 && game.state.matchResult === null; index += 1) game.update(STEP);
  assert.deepEqual(game.state.matchResult, { winner: 1, draw: false, hives: true });
  assert.equal(game.state.phase, 'dying');
  assert.deepEqual(events, ['death']);
  for (let index = 0; index < 240 && game.state.phase !== 'gameOver'; index += 1) game.update(STEP);
  assert.equal(game.state.phase, 'gameOver');
  game.restart();
  assert.equal(game.mode, 'hives');
  assert.equal(game.state.matchResult, null);
  assert.deepEqual(hives.owners, [null, null, null]);
});

test('feeding ground kills count double toward the killer\'s growth in hives only', async () => {
  const frame = (game, simulation) => {
    simulation.scriptedStats.push(stats({ frameSequence: simulation.frameSequence + 1, killsSinceLastRead: 60, ownerKillsSinceLastRead: [60, 0], feedingKillsSinceLastRead: [40, 0] }));
    game.update(STEP);
  };
  const hives = await hivesHarness();
  frame(hives.game, hives.simulation);
  assert.equal(hives.game.seats[0].aliveCount, 13, '60 kills plus 40 on the feeding ground grow one ship');
  const versus = await hivesHarness({ mode: 'versus' });
  frame(versus.game, versus.simulation);
  assert.equal(versus.game.seats[0].aliveCount, 12, 'plain versus ignores the feeding counter');
});
