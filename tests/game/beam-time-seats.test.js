import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../../src/game/game.js';
import { BEAM_TIME_SECONDS } from '../../src/game/beam-time.js';
import { MAXIMUM_BEAM_TIME_SURGE, SpawnPressure } from '../../src/sim/spawner.js';
import { startBeamTime } from '../../src/game/beam-time-seats.js';
import { PROJECTILE_KINDS } from '../../src/game/weaponTypes.js';
import { RunPhase } from '../../src/game/run.js';
import {
  CAPACITY, STEP, createFakeGpu, createFakeInput, createFakeProjectiles, createFakeRenderer, createFakeSimulation, createGame, hitNow, runFor, stats,
} from './game-harness.js';

// A running game with the shard cadence at one wave per shard and the played cues recorded.
async function startedGame({ interval = 1 } = {}) {
  const played = [];
  const effects = {
    bomb: () => played.push('bomb'),
    death: () => played.push('death'),
    pickup: (type) => played.push(`pickup:${type}`),
    expiry: () => played.push('expiry'),
    weaponFire: () => {},
  };
  const simulation = createFakeSimulation();
  const projectiles = createFakeProjectiles();
  const input = createFakeInput();
  const game = await Game.create({
    gpu: createFakeGpu(), simulation, projectiles, renderer: createFakeRenderer(), input, capacity: CAPACITY, clock: () => 0, random: () => 0.5, effects,
  });
  game.beamShards.setWaveInterval(interval);
  game.start();
  game.update(STEP);
  return { game, simulation, projectiles, input, played };
}

function shardsInWorld(game) {
  return game.pickups.pickups.filter((pickup) => pickup.type === 'beamshard');
}

// Drops a shard under the first seat and runs the update that collects it.
function collectShard(game) {
  const { x, y } = game.player.position;
  game.pickups.spawnShard(x, y);
  game.update(STEP);
}

function collectAllShards(game, count = 6) {
  for (let index = 0; index < count; index += 1) collectShard(game);
}

test('a wave places a persistent shard inside the world and off screen, and the field never holds more than needed', async () => {
  const { game } = await startedGame();
  runFor(game, 1.7);
  const placed = shardsInWorld(game);
  assert.equal(placed.length, 1);
  const [shard] = placed;
  assert.equal(shard.persistent, true);
  const { minX, maxX, minY, maxY } = game.worldBounds;
  assert.ok(shard.x >= minX && shard.x <= maxX && shard.y >= minY && shard.y <= maxY);
  const { view } = game;
  const offScreen = Math.abs(shard.x - view.centerX) > view.width / 2 + 1 || Math.abs(shard.y - view.centerY) > view.height / 2 + 1;
  assert.ok(offScreen, 'the shard lies outside the view grown by 1');
  for (let step = 0; step < 15 * 60; step += 1) {
    game.update(STEP);
    assert.ok(game.pickups.waitingShards + game.beamShards.count <= game.beamShards.needed);
  }
  runFor(game, 30);
  assert.equal(shardsInWorld(game).length, game.beamShards.needed - game.beamShards.count);
  assert.ok(shardsInWorld(game).every((entry) => entry.fade === 1 && entry.age === 0), 'a shard does not age or fade');
});

test('a shard collected counts, plays its cue and the pickup blast, and leaves the weapons alone', async () => {
  const { game, simulation, played } = await startedGame({ interval: 60 });
  game.weapons.collect('scatter');
  played.length = 0;
  const { x, y } = game.player.position;
  game.pickups.spawnShard(x, y);
  game.update(STEP);
  assert.equal(game.beamShards.count, 1);
  assert.equal(game.state.beamShards, 1);
  assert.equal(game.state.beamShardsNeeded, 6);
  assert.deepEqual(played, ['pickup:beamshard']);
  assert.deepEqual(simulation.radialKills, [{ x, y, radius: 1.5 }]);
  assert.equal(game.state.armed, 'scatter');
  assert.equal(game.state.tier, 1);
  assert.equal(shardsInWorld(game).length, 0);
});

test('the sixth shard opens beam time: the beam is armed at tier 1, ships stop shooting and the rail turrets keep firing', async () => {
  const { game, projectiles, input, played } = await startedGame({ interval: 60 });
  game.weapons.collect('rail');
  input.state.aim = { x: 1, y: 0 };
  collectAllShards(game, 5);
  assert.equal(game.state.beamTime, 0);
  played.length = 0;
  game.render(0);
  game.renderer.frames.length = 0;
  collectShard(game);
  assert.equal(game.state.armed, 'beam');
  assert.equal(game.state.tier, 1);
  assert.ok(game.state.beamTime > 0.99, 'a full window less the collecting update');
  assert.equal(game.state.beamShards, 6);
  assert.deepEqual(played, ['pickup:beamtime']);
  game.render(0);
  const impulses = game.renderer.frames.flatMap((frame) => frame.impulses);
  assert.deepEqual(impulses.map((impulse) => [impulse.strength, impulse.bloomBoost]), [[1, true]]);
  input.state.firing = true;
  projectiles.spawns.length = 0;
  runFor(game, 0.5);
  assert.notEqual(projectiles.beams.at(-1), null);
  assert.ok(projectiles.spawns.length > 0, 'the rail turrets fire');
  assert.ok(projectiles.spawns.every((spawn) => spawn.kind === PROJECTILE_KINDS.rail), 'no ship shots meanwhile');
});

test('beam time ends after its seconds of updates: the weapon returns, the count resets and one expiry plays', async () => {
  const { game, played, input } = await startedGame({ interval: 60 });
  game.weapons.collect('scatter');
  game.weapons.collect('scatter');
  game.weapons.charge = 0.5;
  collectAllShards(game);
  assert.equal(game.state.armed, 'beam');
  input.state.firing = true;
  played.length = 0;
  runFor(game, BEAM_TIME_SECONDS - 0.5);
  assert.equal(game.state.armed, 'beam');
  assert.equal(game.state.charge, 1, 'the beam charge does not drain');
  input.state.firing = false;
  runFor(game, 0.7);
  assert.equal(game.state.armed, 'scatter');
  assert.equal(game.state.tier, 2);
  assert.ok(Math.abs(game.state.charge - 0.5) < 1e-9);
  assert.equal(game.state.beamTime, 0);
  assert.equal(game.state.beamShards, 0);
  assert.equal(played.filter((cue) => cue === 'expiry').length, 1);
});

test('a pause keeps the remaining beam time and resuming counts it again', async () => {
  const { game } = await startedGame({ interval: 60 });
  collectAllShards(game);
  runFor(game, 1);
  const remaining = game.beamTime.remainingSeconds;
  game.pause();
  for (let step = 0; step < 100; step += 1) game.update(STEP);
  assert.equal(game.beamTime.remainingSeconds, remaining);
  game.resume();
  game.update(STEP);
  assert.ok(game.beamTime.remainingSeconds < remaining);
});

// Updates one step with a stats frame that keeps the alive count low, so a deficit never closes.
function updateWithLowAlive(game, simulation) {
  simulation.scriptedStats.push(stats({ frameSequence: simulation.frameSequence + 1, aliveTotal: 1000 }));
  game.update(STEP);
}

// True between waves once the first fill is over: some gate is fully open and none emits.
function betweenWaves(game) {
  const { gates } = game.spawnDirector;
  return !game.spawnPressure.filling
    && gates.some((gate) => gate.open >= 1 && !gate.closing)
    && gates.every((gate) => gate.emit === 0);
}

// The scripted run both surge tests share: the same injected inputs every time.
async function surgeRun(steps) {
  const harness = await startedGame({ interval: 60 });
  const quiet = [];
  for (let step = 0; step < steps; step += 1) {
    updateWithLowAlive(harness.game, harness.simulation);
    quiet.push(betweenWaves(harness.game));
  }
  return { ...harness, quiet };
}

// A step k after which the director is between waves, and the next step is too (without beam time).
async function quietStep() {
  const { quiet } = await surgeRun(1200);
  const step = quiet.findIndex((value, index) => value && quiet[index + 1]);
  assert.ok(step >= 0, 'the script has a moment between waves');
  return step + 1;
}

test('beam time surges the spawning: every open gate emits between waves, which it does not without beam time', async () => {
  const stepsBefore = await quietStep();
  const plain = await startedGame({ interval: 60 });
  const surged = await startedGame({ interval: 60 });
  for (let step = 0; step < stepsBefore; step += 1) {
    updateWithLowAlive(plain.game, plain.simulation);
    updateWithLowAlive(surged.game, surged.simulation);
  }
  const baseTarget = surged.game.spawnPressure.targetAlive;
  assert.equal(surged.game.acceptsProbeFrames, true);
  startBeamTime(surged.game);
  assert.equal(surged.game.acceptsProbeFrames, false);
  updateWithLowAlive(plain.game, plain.simulation);
  updateWithLowAlive(surged.game, surged.simulation);
  const openGates = (game) => game.spawnDirector.gates.filter((gate) => gate.open >= 1 && !gate.closing);
  assert.ok(openGates(plain.game).length > 0 && openGates(plain.game).every((gate) => gate.emit === 0), 'between waves nothing emits without beam time');
  assert.ok(openGates(surged.game).length > 0 && openGates(surged.game).every((gate) => gate.emit === 1), 'beam time makes every open gate emit');
  assert.equal(surged.game.spawnPressure.surge, 3);
  assert.equal(plain.game.spawnPressure.surge, 1);
  assert.ok(surged.game.spawnPressure.targetAlive > baseTarget * 2.9);
  assert.ok(surged.game.spawnPressure.targetAlive <= Math.max(baseTarget, CAPACITY * 0.4) + 1e-9);
  // The seek ramp is not part of the surge: both runs hold the same seek scale at the same step.
  assert.equal(surged.simulation.seekScales.at(-1), plain.simulation.seekScales.at(-1));
  runFor(surged.game, BEAM_TIME_SECONDS + 0.1);
  assert.equal(surged.game.spawnPressure.surge, 1);
  assert.equal(surged.game.acceptsProbeFrames, true);
});

test('beam time bypasses the wave bank: refills are requested on every step, while between waves they are throttled otherwise', async () => {
  const waves = [];
  const totals = [];
  class SpyPressure extends SpawnPressure {
    update(deltaSeconds, latestStats, shares, frameSequence, wave) {
      const counts = super.update(deltaSeconds, latestStats, shares, frameSequence, wave);
      waves.push(wave);
      totals.push(counts.reduce((sum, count) => sum + count, 0));
      return counts;
    }
  }
  const spy = new SpyPressure({ capacity: CAPACITY });
  const simulation = createFakeSimulation();
  const game = await Game.create({
    gpu: createFakeGpu(), simulation, projectiles: createFakeProjectiles(), renderer: createFakeRenderer(), input: createFakeInput(),
    capacity: CAPACITY, clock: () => 0, random: () => 0.5, spawnPressure: spy,
  });
  game.beamShards.setWaveInterval(60);
  game.start();
  for (let step = 0; step < 600; step += 1) updateWithLowAlive(game, simulation);
  assert.equal(spy.filling, false);
  const plainSteps = waves.length;
  const throttled = waves.slice(0).map((wave, index) => ({ wave, total: totals[index] })).filter(({ wave }) => wave !== null && !wave.emitting);
  assert.ok(throttled.length > 0, 'the director has steps between waves');
  assert.ok(throttled.every(({ total }) => total === 0), 'between waves the bank holds the refills back');
  startBeamTime(game);
  for (let step = 0; step < 30; step += 1) updateWithLowAlive(game, simulation);
  const surgedWaves = waves.slice(plainSteps);
  const surgedTotals = totals.slice(plainSteps);
  assert.ok(surgedWaves.every((wave) => wave === null), 'the surge hands the pressure no wave');
  assert.ok(surgedTotals.every((total) => total > 0), 'a refill is requested on every step');
});

test('death during beam time ends it; the next run starts with no count, no shards and the base gun', async () => {
  const { game, simulation, played } = await startedGame({ interval: 60 });
  game.pickups.spawnShard(2, 2);
  collectAllShards(game);
  played.length = 0;
  hitNow(game, simulation);
  assert.equal(game.beamTime.active, false);
  assert.equal(game.run.phase, RunPhase.Dying);
  assert.equal(played.includes('expiry'), false);
  game.restart();
  game.update(STEP);
  assert.equal(game.beamShards.count, 0);
  assert.equal(shardsInWorld(game).length, 0);
  assert.equal(game.state.armed, 'base');
});

test('a weapon pickup during beam time waits for the end; a time warp starts and beam time still counts real time', async () => {
  const { game } = await startedGame({ interval: 60 });
  collectAllShards(game);
  const { x, y } = game.player.position;
  game.pickups.pickups.push({ x, y, type: 'scatter', age: 0, fade: 1 });
  game.update(STEP);
  assert.equal(game.state.armed, 'beam');
  const before = game.beamTime.remainingSeconds;
  game.pickups.pickups.push({ x, y, type: 'timewarp', age: 0, fade: 1 });
  game.update(STEP);
  assert.ok(game.timeWarp.fraction > 0);
  assert.ok(Math.abs(before - game.beamTime.remainingSeconds - STEP) < 1e-9);
  runFor(game, BEAM_TIME_SECONDS + 0.2);
  assert.equal(game.state.armed, 'scatter');
  assert.equal(game.state.tier, 1);
  assert.equal(game.state.charge, 1);
});

test('quit to title mid beam time resets the count, the timer, the surge and the shards', async () => {
  const { game } = await startedGame({ interval: 60 });
  game.pickups.spawnShard(2, 2);
  collectAllShards(game);
  runFor(game, 0.5);
  assert.equal(game.spawnPressure.surge, 3);
  game.quitToTitle();
  assert.equal(game.beamShards.count, 0);
  assert.equal(game.beamTime.active, false);
  assert.equal(game.spawnPressure.surge, 1);
  assert.equal(shardsInWorld(game).length, 0);
  assert.equal(game.state.armed, 'base');
});

test('the surge strength is range checked and the lab watch mode neither places shards nor surges', async () => {
  const { game } = await startedGame();
  assert.throws(() => game.setBeamTimeSurge(0.5), RangeError);
  assert.throws(() => game.setBeamTimeSurge(MAXIMUM_BEAM_TIME_SURGE + 1), RangeError);
  assert.equal(game.beamTimeSurge, 3);
  game.setBeamTimeSurge(5);
  assert.equal(game.beamTimeSurge, 5);
  game.setBeamTimeSurge(3);
  game.setWatch(0.1);
  runFor(game, 30);
  assert.equal(shardsInWorld(game).length, 0);
  assert.equal(game.activeSpawnPressure.surge, 1);
});

test('a director reset re-bases the shard cadence: no skipped interval after a respawn or a restart', async () => {
  const { game } = await startedGame({ interval: 3 });
  const director = game.spawnDirector;
  runFor(game, 0.2);
  assert.equal(shardsInWorld(game).length, 0);
  director.waveSequence = 3;
  game.update(STEP);
  assert.equal(shardsInWorld(game).length, 1);
  // The respawn resets the director; its next three waves are a full interval again.
  game.handleAction({ type: 'respawn' });
  assert.equal(director.waveSequence, 0);
  director.waveSequence = 3;
  game.update(STEP);
  assert.equal(shardsInWorld(game).length, 2, 'three fresh waves are one interval, not none');
  // A restart starts a new run with no shards and counts again from its first wave.
  game.restart();
  game.update(STEP);
  assert.equal(shardsInWorld(game).length, 0);
  director.waveSequence = 2;
  game.update(STEP);
  assert.equal(shardsInWorld(game).length, 0, 'two waves are not three');
  director.waveSequence = 3;
  game.update(STEP);
  assert.equal(shardsInWorld(game).length, 1);
});
