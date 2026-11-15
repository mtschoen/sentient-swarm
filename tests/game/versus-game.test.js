import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STEP, SWARM_WIPE_MASK, createGame, maskFor, stats } from './game-harness.js';
import { PICKUP_TYPE_NAMES } from '../../src/game/weaponTypes.js';
import { VERSUS_PICKUP_ROTATION } from '../../src/game/versus.js';
import { NEUTRAL_ESCALATION } from '../../src/game/escalation.js';

const PROJECTILE_BUFFER = { label: 'projectiles' };

// A two-seat harness whose fakes also take the versus calls.
async function versusHarness({ mode = 'versus', start = true } = {}) {
  const harness = await createGame();
  const { simulation, projectiles, game } = harness;
  simulation.versusProjectileCalls = [];
  simulation.setVersusProjectiles = (buffer) => simulation.versusProjectileCalls.push(buffer);
  projectiles.buffer = PROJECTILE_BUFFER;
  projectiles.spawnOwners = [];
  projectiles.queueSpawn = function queueSpawn(spawn, ...owner) {
    this.spawns.push(spawn);
    this.spawnOwners.push(owner);
    return this.spawns.length;
  };
  game.setPlayerCount(2);
  game.setMode(mode);
  if (start) {
    game.start();
    game.update(STEP);
  }
  return harness;
}

function updateWithStats(game, simulation, fields) {
  simulation.scriptedStats.push(stats({ frameSequence: simulation.frameSequence + 1, ...fields }));
  game.update(STEP);
}

// Runs updates until the phase leaves Dying (game over), at most two seconds.
function runToGameOver(game) {
  for (let index = 0; index < 120 && game.state.phase !== 'gameOver'; index += 1) game.update(STEP);
}

test('setMode switches to versus in Ready with two seats only, and hands the simulation the projectiles', async () => {
  const { game, simulation } = await versusHarness({ start: false });
  assert.equal(game.mode, 'versus');
  assert.equal(game.versus, true);
  assert.deepEqual(simulation.versusProjectileCalls, [PROJECTILE_BUFFER]);
  assert.deepEqual([...game.pickups.rotation], [...VERSUS_PICKUP_ROTATION]);
  game.setMode('coop');
  assert.deepEqual(simulation.versusProjectileCalls, [PROJECTILE_BUFFER, null]);
  assert.equal(game.pickups.rotation, PICKUP_TYPE_NAMES);
  game.setMode('coop');
  assert.equal(simulation.versusProjectileCalls.length, 2, 'an unchanged mode makes no call');
  assert.throws(() => game.setMode('conquest'), RangeError);
  game.setPlayerCount(1);
  assert.throws(() => game.setMode('versus'), RangeError);
  game.setPlayerCount(2);
  game.setMode('versus');
  game.start();
  assert.throws(() => game.setMode('coop'), /only in Ready/);
});

test('one seat, quitToTitle and setWatch return to co-op', async () => {
  const { game, simulation } = await versusHarness({ start: false });
  game.setPlayerCount(1);
  assert.equal(game.mode, 'coop');
  assert.equal(simulation.versusProjectileCalls.at(-1), null);
  game.setPlayerCount(2);
  game.setMode('versus');
  game.start();
  game.quitToTitle();
  assert.equal(game.mode, 'coop');
  game.setPlayerCount(2);
  game.setMode('versus');
  game.setWatch(0.1);
  assert.equal(game.mode, 'coop');
  assert.equal(game.state.mode, 'coop');
});

test('in versus every shot and beam carries its seat as owner', async () => {
  const { game, input, projectiles } = await versusHarness();
  input.state.firing = true;
  input.state.aim = { x: 1, y: 0 };
  input.seatTwoState.firing = true;
  input.seatTwoState.aim = { x: -1, y: 0 };
  for (let index = 0; index < 30; index += 1) game.update(STEP);
  const owners = new Set(projectiles.spawnOwners.map((owner) => owner.join(',')));
  assert.ok(owners.has('0') && owners.has('1'), `owners ${[...owners]}`);
  assert.ok(!owners.has(''), 'no unowned spawn in versus');
});

test('co-op shots carry no owner argument', async () => {
  const { game, input, projectiles } = await versusHarness({ mode: 'coop' });
  input.state.firing = true;
  input.state.aim = { x: 1, y: 0 };
  for (let index = 0; index < 30; index += 1) game.update(STEP);
  assert.ok(projectiles.spawnOwners.length > 0);
  assert.ok(projectiles.spawnOwners.every((owner) => owner.length === 0));
});

test('versus kills grow only the seat whose projectiles made them, and the score stays shared', async () => {
  const { game, simulation } = await versusHarness();
  updateWithStats(game, simulation, { killsSinceLastRead: 100, ownerKillsSinceLastRead: [100, 0] });
  assert.equal(game.seats[0].aliveCount, 13);
  assert.equal(game.seats[1].aliveCount, 12);
  assert.ok(game.score.score > 0);
  updateWithStats(game, simulation, { killsSinceLastRead: 200, ownerKillsSinceLastRead: [0, 200] });
  assert.equal(game.seats[0].aliveCount, 13);
  assert.equal(game.seats[1].aliveCount, 14);
});

test('a versus seat wiped is out, not down: the other seat wins and the run ends', async () => {
  const { game, simulation } = await versusHarness();
  const events = [];
  game.effects = { seatDown: (index) => events.push(index), death: () => events.push('death') };
  updateWithStats(game, simulation, { secondSwarmHitMask: SWARM_WIPE_MASK });
  assert.equal(game.seats[1].down, false);
  assert.equal(game.state.phase, 'dying');
  assert.deepEqual(events, ['death']);
  assert.deepEqual(game.state.matchResult, { winner: 0, draw: false });
  runToGameOver(game);
  assert.equal(game.state.phase, 'gameOver');
  assert.deepEqual(game.state.matchResult, { winner: 0, draw: false });
  // A restart clears the result and plays versus again.
  game.restart();
  assert.equal(game.state.matchResult, null);
  assert.equal(game.mode, 'versus');
  assert.equal(game.seats[1].aliveCount, 12);
});

test('both versus seats wiped in one stats frame is a draw', async () => {
  const { game, simulation } = await versusHarness();
  updateWithStats(game, simulation, { swarmHitMask: SWARM_WIPE_MASK, secondSwarmHitMask: SWARM_WIPE_MASK });
  assert.deepEqual(game.state.matchResult, { winner: null, draw: true });
  assert.equal(game.state.phase, 'dying');
});

test('a partial versus hit kills ships without ending the match or resetting the multiplier', async () => {
  const { game, simulation } = await versusHarness();
  game.score.recordKills(300);
  const multiplier = game.score.multiplier;
  updateWithStats(game, simulation, { secondSwarmHitMask: maskFor([0, 1, 2]) });
  assert.equal(game.seats[1].aliveCount, 9);
  assert.equal(game.state.phase, 'playing');
  assert.equal(game.state.matchResult, null);
  assert.equal(game.score.multiplier, multiplier);
});

// Stacks every live ship of both seats on one spot, so each ship touches an opposing one.
function stackShips(game, x, y, countPerSeat = Infinity) {
  for (const seat of game.seats) {
    let placed = 0;
    for (const slot of seat.swarm.slots) {
      if (!slot.alive || placed >= countPerSeat) continue;
      slot.x = x;
      slot.y = y;
      placed += 1;
    }
  }
}

test('touching opposing ships both die one for one in versus', async () => {
  const { game } = await versusHarness();
  const { applyShipContact } = await import('../../src/game/versus-seats.js');
  stackShips(game, 10, 9, 3);
  applyShipContact(game);
  assert.equal(game.seats[0].aliveCount, 9);
  assert.equal(game.seats[1].aliveCount, 9);
  assert.equal(game.state.phase, 'playing');
});

test('ship contact that wipes both seats is a draw, and contact is off while a seat is invulnerable', async () => {
  const { game } = await versusHarness();
  const { applyShipContact } = await import('../../src/game/versus-seats.js');
  game.debugInvulnerable(true, 1);
  stackShips(game, 10, 9);
  applyShipContact(game);
  assert.equal(game.seats[0].aliveCount, 12);
  game.debugInvulnerable(false);
  applyShipContact(game);
  assert.equal(game.seats[0].aliveCount, 0);
  assert.equal(game.seats[1].aliveCount, 0);
  assert.deepEqual(game.state.matchResult, { winner: null, draw: true });
});

test('co-op never pairs ship contact', async () => {
  const { game } = await versusHarness({ mode: 'coop' });
  stackShips(game, 10, 9);
  game.seats.forEach((seat) => { seat.player.positionX = 10; seat.player.positionY = 9; });
  game.update(STEP);
  assert.equal(game.seats[0].aliveCount, 12);
  assert.equal(game.seats[1].aliveCount, 12);
});

test('versus keeps the escalation neutral and places no beam shards', async () => {
  const { game, simulation } = await versusHarness();
  game.spawnPressure.secondsPastRampValue = 1000;
  Object.defineProperty(game.spawnPressure, 'secondsPastRamp', { get: () => 1000, configurable: true });
  game.beamShards.onWaves = () => { throw new Error('the shard cadence ran in versus'); };
  for (let index = 0; index < 10; index += 1) updateWithStats(game, simulation, {});
  assert.deepEqual(game.escalationLevels, NEUTRAL_ESCALATION);
});

function sourceFiles(directory = new URL('../../src/', import.meta.url), prefix = 'src/') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
    return entry.name.endsWith('.js') ? [{ path: `${prefix}${entry.name}`, url: new URL(entry.name, directory) }] : [];
  });
}

// The versus hit pass is armed only by the versus mode switch: solo and co-op never dispatch it.
test('setVersusProjectiles appears only in the Simulation and the versus mode switch', () => {
  const files = sourceFiles().filter(({ url }) => readFileSync(url, 'utf8').includes('setVersusProjectiles')).map(({ path }) => path);
  assert.deepEqual(files.sort(), ['src/game/versus-seats.js', 'src/sim/simulation.js', 'src/sim/versus-hits.js']);
});
