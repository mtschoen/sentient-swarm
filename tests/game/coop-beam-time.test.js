import test from 'node:test';
import assert from 'node:assert/strict';
import { BEAM_TIME_SECONDS } from '../../src/game/beam-time.js';
import { SWARM_WIPE_MASK, STEP, createGame, runFor, stats } from './game-harness.js';

async function startTwoSeats() {
  const harness = await createGame();
  harness.game.setPlayerCount(2);
  harness.game.beamShards.setWaveInterval(60);
  harness.game.start();
  harness.game.update(STEP);
  return harness;
}

function updateWithStats(game, simulation, fields) {
  simulation.scriptedStats.push(stats({ frameSequence: simulation.frameSequence + 1, ...fields }));
  game.update(STEP);
}

// Drops a shard on the seat's point and runs the update that collects it.
function collectShardWith(game, seatIndex) {
  const { x, y } = game.seats[seatIndex].point;
  game.pickups.spawnShard(x, y);
  game.update(STEP);
}

function collectSix(game, seatIndex = 0) {
  for (let index = 0; index < 6; index += 1) collectShardWith(game, seatIndex);
}

const armedKinds = (game) => game.state.seats.map((seat) => seat.armed);

test('either seat completes the shared count and beam time arms every seat that is up', async () => {
  const { game } = await startTwoSeats();
  game.seats[0].weapons.collect('scatter');
  game.seats[1].weapons.collect('pulse');
  collectShardWith(game, 1);
  assert.equal(game.state.beamShards, 1);
  collectShardWith(game, 0);
  assert.equal(game.state.beamShards, 2);
  for (let index = 0; index < 4; index += 1) collectShardWith(game, 1);
  assert.deepEqual(armedKinds(game), ['beam', 'beam']);
  assert.equal(game.state.beamShards, 6);
  runFor(game, BEAM_TIME_SECONDS + 0.2);
  assert.deepEqual(armedKinds(game), ['scatter', 'pulse']);
  assert.equal(game.state.beamShards, 0);
});

test('a seat that is down at the start gets no beam; when it revives mid beam time it fires the beam and gets its loadout back at the end', async () => {
  const { game, simulation } = await startTwoSeats();
  updateWithStats(game, simulation, { swarmHitMask: SWARM_WIPE_MASK });
  assert.equal(game.seats[0].down, true);
  collectSix(game, 1);
  assert.deepEqual(armedKinds(game), ['base', 'beam']);
  // Enough scored kills bring seat 1 back beside the live seat.
  updateWithStats(game, simulation, { killsSinceLastRead: 100 });
  assert.equal(game.seats[0].down, false);
  assert.deepEqual(armedKinds(game), ['beam', 'beam']);
  runFor(game, BEAM_TIME_SECONDS + 0.2);
  assert.deepEqual(armedKinds(game), ['base', 'base']);
});

test('a seat that goes down during beam time drops to base and does not get its old weapon back', async () => {
  const { game, simulation } = await startTwoSeats();
  game.seats[0].weapons.collect('scatter');
  collectSix(game, 1);
  updateWithStats(game, simulation, { swarmHitMask: SWARM_WIPE_MASK });
  assert.equal(game.seats[0].down, true);
  assert.deepEqual(armedKinds(game), ['base', 'beam']);
  assert.equal(game.beamTime.active, true);
  runFor(game, BEAM_TIME_SECONDS + 0.2);
  assert.deepEqual(armedKinds(game), ['base', 'base']);
});
