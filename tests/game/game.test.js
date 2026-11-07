import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../../src/game/game.js';
import { RunPhase } from '../../src/game/run.js';
import { InputState } from '../../src/input/input.js';
import { SPECIES_COUNT } from '../../src/sim/layout.js';

const STEP = 1 / 60;
const CAPACITY = 262144;

function createFakeGpu() {
  const submitted = [];
  return {
    submitted,
    device: {
      createCommandEncoder: () => ({ finish: () => ({}) }),
      queue: { submit: (buffers) => submitted.push(buffers) },
    },
  };
}

// Same method names as Simulation. readAllStats returns the next scripted stats frame (or none).
function createFakeSimulation() {
  const simulation = {
    capacity: CAPACITY,
    shares: new Array(SPECIES_COUNT).fill(1 / SPECIES_COUNT),
    frameSequence: 0,
    time: 0,
    scriptedStats: [],
    killAllRequests: 0,
    acknowledged: [],
    playerStates: [],
    playerPositions: [],
    spawnBudgets: [],
    passes: [],
    events: [],
    registerPass(encodeFunction) {
      this.passes.push(encodeFunction);
      return () => { this.passes = this.passes.filter((entry) => entry !== encodeFunction); };
    },
    setPlayer(x, y) { this.playerPositions.push({ x, y }); },
    setPlayerState(state) { this.playerStates.push(state); },
    acknowledgeHit(sequence) { this.acknowledged.push(sequence); },
    requestKillAll() {
      this.killAllRequests += 1;
      this.events.push('killAll');
    },
    step(encoder, deltaSeconds, spawnPerSpecies) {
      this.frameSequence += 1;
      this.time += deltaSeconds;
      this.spawnBudgets.push(Array.from(spawnPerSpecies));
      this.events.push('step');
    },
    afterSubmit() {},
    readAllStats() {
      const next = this.scriptedStats.shift();
      return next === undefined ? [] : [next];
    },
  };
  return simulation;
}

function createFakeProjectiles() {
  return {
    spawns: [],
    beams: [],
    clears: 0,
    queueSpawn(spawn) { this.spawns.push(spawn); return this.spawns.length; },
    setBeam(beam) { this.beams.push(beam); },
    clear() { this.clears += 1; },
    encode() {},
  };
}

function createFakeRenderer() {
  return {
    frames: [],
    render(encoder, options) { this.frames.push(options); },
    afterSubmit() {},
    setSimulation() {},
  };
}

function createFakeInput() {
  return { state: new InputState(), update() {} };
}

async function createGame() {
  const gpu = createFakeGpu();
  const simulation = createFakeSimulation();
  const projectiles = createFakeProjectiles();
  const renderer = createFakeRenderer();
  const input = createFakeInput();
  let seconds = 0;
  const game = await Game.create({
    gpu, simulation, projectiles, renderer, input, capacity: CAPACITY, clock: () => seconds, random: () => 0.5,
  });
  const advanceClock = (deltaSeconds) => { seconds += deltaSeconds; };
  return { game, gpu, simulation, projectiles, renderer, input, advanceClock };
}

// A stats frame as Simulation.readAllStats returns it.
function stats(fields) {
  return {
    aliveTotal: 1000,
    alivePerSpecies: new Uint32Array(SPECIES_COUNT),
    killsSinceLastRead: 0,
    frameSequence: 1,
    killsUnscored: 0,
    playerHitSequence: 0,
    hitLatch: 0,
    ...fields,
  };
}

function runFor(game, seconds) {
  const steps = Math.round(seconds / STEP);
  for (let index = 0; index < steps; index += 1) game.update(STEP);
}

// Feeds a hit latched in the step this update runs, and runs that update.
function hitNow(game, simulation) {
  const sequence = simulation.frameSequence + 1;
  simulation.scriptedStats.push(stats({ frameSequence: sequence, playerHitSequence: sequence, hitLatch: 1 }));
  game.update(STEP);
}

test('registers the projectile pass with the simulation and starts in Ready without contact', async () => {
  const { game, simulation } = await createGame();
  assert.equal(simulation.passes.length, 1);
  assert.equal(game.state.phase, RunPhase.Ready);
  game.update(STEP);
  assert.equal(simulation.playerStates.length, 0);
  assert.equal(simulation.playerPositions.length, 1);
  game.start();
  game.update(STEP);
  assert.equal(game.state.phase, RunPhase.Playing);
  assert.equal(simulation.playerStates.length, 1);
  assert.equal(simulation.playerStates[0].invulnerable, false);
});

test('the first gesture starts the run from Ready, and the start press does not bomb', async () => {
  const { game, simulation, input } = await createGame();
  game.update(STEP);
  assert.equal(game.state.phase, RunPhase.Ready);
  const killAllBefore = simulation.killAllRequests;
  input.state.bomb = true;
  game.update(STEP);
  assert.equal(game.state.phase, RunPhase.Playing);
  assert.equal(game.state.bombs, 3);
  assert.equal(simulation.killAllRequests, killAllBefore + 1);
});

test('a scripted stream of 60 kills raises the score and steps the multiplier', async () => {
  const { game, simulation } = await createGame();
  game.start();
  for (let frame = 1; frame <= 6; frame += 1) {
    simulation.scriptedStats.push(stats({ frameSequence: frame, killsSinceLastRead: 10 }));
    game.update(STEP);
  }
  // 50 kills at multiplier 1, then 10 at multiplier 2, 10 points each at the reference capacity.
  assert.equal(game.state.score, 50 * 10 + 10 * 10 * 2);
  assert.equal(game.state.multiplier, 2);
  assert.equal(game.state.aliveTotal, 1000);
});

test('a stats frame read twice scores once, and kills read outside Playing score nothing', async () => {
  const { game, simulation } = await createGame();
  game.start();
  simulation.scriptedStats.push(stats({ frameSequence: 3, killsSinceLastRead: 5 }));
  simulation.scriptedStats.push(stats({ frameSequence: 3, killsSinceLastRead: 5 }));
  game.update(STEP);
  game.update(STEP);
  assert.equal(game.state.score, 50);
  hitNow(game, simulation);
  assert.equal(game.state.phase, RunPhase.Dying);
  simulation.scriptedStats.push(stats({ frameSequence: simulation.frameSequence, killsSinceLastRead: 500 }));
  game.update(STEP);
  assert.equal(game.state.score, 50);
});

test('a current hit drops a life, drops the weapon to base, resets the multiplier and clears the arena', async () => {
  const { game, simulation, projectiles } = await createGame();
  game.start();
  simulation.scriptedStats.push(stats({ frameSequence: 1, killsSinceLastRead: 60 }));
  game.update(STEP);
  assert.equal(game.state.multiplier, 2);
  game.weapons.collect('rail');
  assert.equal(game.state.armed, 'rail');
  const killAllBefore = simulation.killAllRequests;
  hitNow(game, simulation);
  const hitSequence = simulation.frameSequence;
  assert.equal(game.state.lives, 2);
  assert.equal(game.state.armed, 'base');
  assert.equal(game.state.tier, 1);
  assert.equal(game.state.multiplier, 1);
  assert.equal(game.state.phase, RunPhase.Dying);
  assert.equal(simulation.killAllRequests, killAllBefore + 1);
  assert.ok(simulation.acknowledged.includes(hitSequence));
  assert.ok(projectiles.clears >= 1);
  // The hit's shockwave is handed to the renderer once.
  game.render(0);
  game.render(0);
  const impulses = game.renderer.frames.flatMap((frame) => frame.impulses);
  assert.equal(impulses.length, 1);
});

test('a hit whose sequence predates the respawn is ignored but still acknowledged', async () => {
  const { game, simulation } = await createGame();
  game.start();
  hitNow(game, simulation);
  assert.equal(game.state.lives, 2);
  // Dying 0.8 s and Respawning 0.6 s, then 2 s of invulnerability.
  runFor(game, 1.4);
  assert.equal(game.state.phase, RunPhase.Playing);
  const respawnSequence = game.run.respawnSequence;
  assert.ok(respawnSequence > 1);
  runFor(game, 2.1);
  assert.equal(game.run.invulnerable, false);
  const stale = respawnSequence - 1;
  simulation.scriptedStats.push(stats({ frameSequence: simulation.frameSequence, playerHitSequence: stale, hitLatch: 1 }));
  game.update(STEP);
  assert.equal(game.state.lives, 2);
  assert.equal(game.state.phase, RunPhase.Playing);
  assert.ok(simulation.acknowledged.includes(stale));
  hitNow(game, simulation);
  assert.equal(game.state.lives, 1);
});

test('respawn returns the player to the center and resets spawn pressure', async () => {
  const { game, simulation, input } = await createGame();
  game.start();
  input.state.move = { x: 1, y: 0 };
  runFor(game, 0.5);
  input.state.move = { x: 0, y: 0 };
  assert.ok(game.player.position.x > 8.5);
  runFor(game, 3);
  hitNow(game, simulation);
  runFor(game, 1.4);
  assert.equal(game.state.phase, RunPhase.Playing);
  assert.deepEqual(game.player.position, { x: 8, y: 4.5 });
  assert.ok(game.spawnPressure.elapsed < 0.1);
  const latest = simulation.playerStates[simulation.playerStates.length - 1];
  assert.equal(latest.invulnerable, true);
});

test('a bomb press kills everything before the step, once per press', async () => {
  const { game, simulation, input } = await createGame();
  game.start();
  game.update(STEP);
  simulation.events.length = 0;
  input.state.bomb = true;
  game.update(STEP);
  game.update(STEP);
  assert.deepEqual(simulation.events, ['killAll', 'step', 'step']);
  assert.equal(game.state.bombs, 2);
  input.state.bomb = false;
  game.update(STEP);
  input.state.bomb = true;
  game.update(STEP);
  assert.equal(game.state.bombs, 1);
  assert.equal(simulation.killAllRequests, 3);
});

test('mouse aim is the pointer minus the player and the primary button fires', async () => {
  const { game, input, projectiles } = await createGame();
  game.start();
  input.state.pointerWorld = { x: 8, y: 2.5 };
  input.state.pointerPrimaryDown = true;
  runFor(game, 0.5);
  assert.ok(projectiles.spawns.length > 0);
  const middle = projectiles.spawns[1];
  assert.ok(Math.abs(middle.velocityX) < 1e-9);
  assert.ok(middle.velocityY < 0);
});

test('the expiry frame sends no beam even when the weapon still returned one', async () => {
  const { game, input, projectiles } = await createGame();
  game.start();
  game.weapons.collect('beam');
  input.state.aim = { x: 1, y: 0 };
  input.state.firing = true;
  game.update(STEP);
  assert.notEqual(projectiles.beams[projectiles.beams.length - 1], null);
  runFor(game, 8);
  assert.equal(game.state.armed, 'base');
  const expiryIndex = projectiles.beams.findIndex((beam, index) => index > 0 && beam === null);
  assert.ok(expiryIndex > 0);
});

test('restart after game over resets every module and clears the arena once', async () => {
  const { game, simulation, input } = await createGame();
  game.start();
  simulation.scriptedStats.push(stats({ frameSequence: 1, killsSinceLastRead: 200 }));
  game.update(STEP);
  input.state.bomb = true;
  game.update(STEP);
  input.state.bomb = false;
  game.weapons.collect('scatter');
  for (let life = 0; life < 3; life += 1) {
    runFor(game, 2.1);
    hitNow(game, simulation);
    runFor(game, 1.4);
  }
  assert.equal(game.state.phase, RunPhase.GameOver);
  const lastHitSequence = Math.max(...simulation.acknowledged);
  game.pickups.spawn(8, 4.5);
  game.weapons.collect('rail');
  const killAllBefore = simulation.killAllRequests;
  game.restart();
  assert.equal(simulation.killAllRequests, killAllBefore + 1);
  const state = game.state;
  assert.equal(state.score, 0);
  assert.equal(state.multiplier, 1);
  assert.equal(state.lives, 3);
  assert.equal(state.bombs, 3);
  assert.equal(state.armed, 'base');
  assert.equal(state.tier, 1);
  assert.equal(state.phase, RunPhase.Playing);
  assert.equal(game.pickups.pickups.length, 0);
  assert.equal(game.spawnPressure.elapsed, 0);
  // The previous run's last hit, still in the persistent stats tail, takes no life.
  simulation.scriptedStats.push(stats({ frameSequence: simulation.frameSequence, playerHitSequence: lastHitSequence, hitLatch: 1 }));
  game.update(STEP);
  assert.equal(game.state.lives, 3);
  // A hit latched in the last step before the restart, read only now, is stale too.
  const beforeRestart = game.run.respawnSequence - 1;
  assert.ok(beforeRestart > lastHitSequence);
  simulation.scriptedStats.push(stats({ frameSequence: simulation.frameSequence, playerHitSequence: beforeRestart, hitLatch: 1 }));
  game.update(STEP);
  assert.equal(game.state.lives, 3);
  assert.ok(simulation.acknowledged.includes(beforeRestart));
  assert.equal(simulation.killAllRequests, killAllBefore + 1);
});

test('awards add a life and a bomb at their thresholds', async () => {
  const { game, simulation } = await createGame();
  game.start();
  // 20 batches of 100 kills: 1000 + 2000 + 3000 + 3000 at multipliers 1, 2, 3, 3, then six at 4
  // and ten at 5, 83000 in all: past the first life (75000) and bomb (40000) thresholds only.
  for (let frame = 1; frame <= 20; frame += 1) {
    simulation.scriptedStats.push(stats({ frameSequence: frame, killsSinceLastRead: 100 }));
    game.update(STEP);
  }
  assert.equal(game.state.score, 83000);
  assert.equal(game.state.lives, 4);
  assert.equal(game.state.bombs, 4);
});

test('debugArm arms a weapon at a tier with a full charge, and base drops it', async () => {
  const { game } = await createGame();
  game.debugArm('rail', 3);
  assert.deepEqual([game.state.armed, game.state.tier, game.state.charge], ['rail', 3, 1]);
  game.debugArm('scatter', 1);
  assert.deepEqual([game.state.armed, game.state.tier], ['scatter', 1]);
  game.debugArm('base', 1);
  assert.equal(game.state.armed, 'base');
});

test('scene hides the ship from death until respawn and carries the armed weapon', async () => {
  const { game } = await createGame();
  game.debugArm('pulse', 2);
  const scene = game.scene();
  assert.equal(scene.ship.armed, 'pulse');
  assert.equal(scene.projectiles, game.projectiles);
  game.run.start();
  game.run.playerHit(game.simulation.frameSequence + 1, game.player.position);
  assert.equal(game.scene().ship, null);
});
