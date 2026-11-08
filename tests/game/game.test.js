// Over 500 lines: every Game scenario shares the one fake simulation, gpu and input harness here.
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
    seekScales: [],
    spawnDistanceFractions: [],
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
    setSeekScale(scale) { this.seekScales.push(scale); },
    setSpawnDistanceFraction(fraction) { this.spawnDistanceFractions.push(fraction); },
    acknowledgeHit(sequence) { this.acknowledged.push(sequence); },
    requestKillAll() {
      this.killAllRequests += 1;
      this.events.push('killAll');
    },
    radialKills: [],
    requestRadialKill(x, y, radius) {
      this.radialKills.push({ x, y, radius });
      this.events.push('radialKill');
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
    ringsThisFrame: 0,
    lastRingX: 0,
    lastRingY: 0,
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
  assert.equal(impulses[0].strength, 1);
  assert.equal(impulses[0].bloomBoost, true);
});

test('a bomb queues a strength 1 impulse at the ship that boosts bloom, stamped with the game clock', async () => {
  const { game, input, advanceClock } = await createGame();
  game.start();
  game.update(STEP);
  advanceClock(2.5);
  input.state.bomb = true;
  game.update(STEP);
  game.render(0);
  const impulses = game.renderer.frames.flatMap((frame) => frame.impulses);
  assert.equal(impulses.length, 1);
  assert.deepEqual(impulses[0], { x: game.player.position.x, y: game.player.position.y, strength: 1, time: 2.5, bloomBoost: true });
});

test('a stats frame with rings queues one 0.3 impulse at the last ring position, once per frame', async () => {
  const { game, simulation } = await createGame();
  game.start();
  simulation.scriptedStats.push(stats({ frameSequence: 1, ringsThisFrame: 4, lastRingX: 3.5, lastRingY: 6.25 }));
  simulation.scriptedStats.push(stats({ frameSequence: 1, ringsThisFrame: 4, lastRingX: 3.5, lastRingY: 6.25 }));
  simulation.scriptedStats.push(stats({ frameSequence: 2 }));
  game.update(STEP);
  game.update(STEP);
  game.update(STEP);
  game.render(0);
  const impulses = game.renderer.frames.flatMap((frame) => frame.impulses);
  assert.equal(impulses.length, 1);
  assert.deepEqual(impulses[0], { x: 3.5, y: 6.25, strength: 0.3, time: 0, bloomBoost: false });
});

test('collecting a pickup requests one radial blast at the ship before the step and queues a 0.5 impulse', async () => {
  const { game, simulation } = await createGame();
  game.start();
  game.update(STEP);
  simulation.events.length = 0;
  game.renderer.frames.length = 0;
  const { x, y } = game.player.position;
  game.pickups.pickups.push({ x, y, type: 'scatter', age: 0, fade: 1 });
  game.update(STEP);
  game.render(0);
  assert.deepEqual(simulation.radialKills, [{ x, y, radius: 1.5 }]);
  assert.deepEqual(simulation.events, ['radialKill', 'step']);
  const impulses = game.renderer.frames.flatMap((frame) => frame.impulses);
  assert.equal(impulses.length, 1);
  assert.deepEqual(impulses[0], { x, y, strength: 0.5, time: 0, bloomBoost: false });
  assert.equal(game.state.armed, 'scatter');
  game.update(STEP);
  assert.equal(simulation.radialKills.length, 1);
});

test('every pickup collected fires exactly one blast; the blast kills score nothing', async () => {
  const { game, simulation } = await createGame();
  game.start();
  const { x, y } = game.player.position;
  game.pickups.pickups.push({ x, y, type: 'scatter', age: 0, fade: 1 }, { x: x + 0.1, y, type: 'rail', age: 0, fade: 1 });
  game.update(STEP);
  game.update(STEP);
  game.update(STEP);
  assert.equal(simulation.radialKills.length, 2);
  // The blast step's stats: 300 unscored kills, none in the scored counter.
  simulation.scriptedStats.push(stats({ frameSequence: simulation.frameSequence + 1, killsUnscored: 300 }));
  game.update(STEP);
  assert.equal(game.state.score, 0);
});

test('a pickup blast radius of 0 disables the blast and keeps the 0.15 pickup impulse', async () => {
  const { game, simulation } = await createGame();
  game.setPickupBlastRadius(0);
  assert.equal(game.pickupBlastRadius, 0);
  game.start();
  const { x, y } = game.player.position;
  game.pickups.pickups.push({ x, y, type: 'scatter', age: 0, fade: 1 });
  game.update(STEP);
  game.render(0);
  assert.deepEqual(simulation.radialKills, []);
  const impulses = game.renderer.frames.flatMap((frame) => frame.impulses);
  assert.equal(impulses.length, 1);
  assert.equal(impulses[0].strength, 0.15);
  assert.equal(game.state.armed, 'scatter');
});

test('setPickupBlastRadius takes a new radius for the next pickup and rejects a negative or non-finite one', async () => {
  const { game, simulation } = await createGame();
  assert.equal(game.pickupBlastRadius, 1.5);
  game.setPickupBlastRadius(2.5);
  assert.throws(() => game.setPickupBlastRadius(-1), RangeError);
  assert.throws(() => game.setPickupBlastRadius(Number.NaN), RangeError);
  assert.equal(game.pickupBlastRadius, 2.5);
  game.start();
  const { x, y } = game.player.position;
  game.pickups.pickups.push({ x, y, type: 'pulse', age: 0, fade: 1 });
  game.update(STEP);
  assert.deepEqual(simulation.radialKills, [{ x, y, radius: 2.5 }]);
});

test('a pickup collection plays the pickup effect', async () => {
  const gpu = createFakeGpu();
  const simulation = createFakeSimulation();
  const played = [];
  const effects = { bomb: () => played.push('bomb'), death: () => played.push('death'), pickup: () => played.push('pickup') };
  const game = await Game.create({
    gpu, simulation, projectiles: createFakeProjectiles(), renderer: createFakeRenderer(), input: createFakeInput(), capacity: CAPACITY, random: () => 0.5, effects,
  });
  game.start();
  const { x, y } = game.player.position;
  game.pickups.pickups.push({ x, y, type: 'scatter', age: 0, fade: 1 });
  game.update(STEP);
  game.update(STEP);
  assert.deepEqual(played, ['pickup']);
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
  // Record what the weapon itself returns each frame, so the expiry frame can be checked against it.
  const weaponReturns = [];
  const updateWeapons = game.weapons.update.bind(game.weapons);
  game.weapons.update = (deltaSeconds, controls) => {
    const result = updateWeapons(deltaSeconds, controls);
    weaponReturns.push(result);
    return result;
  };
  game.weapons.collect('beam');
  input.state.aim = { x: 1, y: 0 };
  input.state.firing = true;
  const MAXIMUM_FRAMES = 1000;
  for (let frame = 0; frame < MAXIMUM_FRAMES; frame += 1) {
    game.update(STEP);
    if (weaponReturns[weaponReturns.length - 1].expired) break;
  }
  const expiryReturn = weaponReturns[weaponReturns.length - 1];
  assert.equal(expiryReturn.expired, true, 'the beam charge should expire within the frame budget');
  assert.equal(game.state.armed, 'base');
  // The weapon's own return carried a beam on the expiry frame; the game must still send null.
  assert.notEqual(expiryReturn.beam, null);
  assert.equal(projectiles.beams[projectiles.beams.length - 1], null);
  // The frame before expiry sent the weapon's beam, so the null is the override, not the weapon.
  assert.notEqual(projectiles.beams[projectiles.beams.length - 2], null);
});

test('a pickup collected on the frame the charge would reach zero keeps the weapon armed and refills it', async () => {
  const { game, input } = await createGame();
  game.start();
  game.weapons.collect('rail');
  const drainPerStep = STEP / game.weapons.types.rail.tiers[0].chargeSeconds;
  input.state.aim = { x: 1, y: 0 };
  input.state.firing = true;
  // Drain while firing, stopping with a margin so float rounding cannot expire the weapon early.
  while (game.weapons.charge > 2 * drainPerStep) game.update(STEP);
  assert.equal(game.state.armed, 'rail');
  // Within one step of zero: the next firing step alone would expire the weapon.
  game.weapons.charge = drainPerStep / 2;
  // Put a scatter pickup under the ship; it is collected in the same update as the expiry step.
  const { x, y } = game.player.position;
  game.pickups.pickups.push({ x, y, type: 'scatter', age: 0, fade: 1 });
  game.update(STEP);
  assert.equal(game.state.armed, 'scatter');
  assert.equal(game.state.tier, 1);
  assert.ok(Math.abs(game.state.charge - (1 - drainPerStep)) < 1e-9);
});

test('restart after game over resets every module and clears the arena once', async () => {
  const { game, simulation, input, projectiles } = await createGame();
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
  const clearsBefore = projectiles.clears;
  const lastStepBeforeRestart = simulation.frameSequence;
  game.restart();
  assert.equal(simulation.killAllRequests, killAllBefore + 1);
  assert.equal(projectiles.clears, clearsBefore + 1);
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
  // A stats frame from the last step before the restart, read only now, scores nothing.
  simulation.scriptedStats.push(stats({ frameSequence: lastStepBeforeRestart, killsSinceLastRead: 50 }));
  game.update(STEP);
  assert.equal(game.state.score, 0);
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

// Plays the run with three current hits, each after the invulnerability window, and stops on the
// update that enters GameOver.
function reachGameOver(game, simulation) {
  game.start();
  for (let life = 0; life < 3; life += 1) {
    runFor(game, 2.1);
    hitNow(game, simulation);
    if (life < 2) runFor(game, 1.4);
  }
  const MAXIMUM_STEPS = 120;
  for (let step = 0; step < MAXIMUM_STEPS && game.state.phase !== RunPhase.GameOver; step += 1) game.update(STEP);
  assert.equal(game.state.phase, RunPhase.GameOver);
}

test('after game over a fresh bomb press past the guard window restarts without spending a bomb', async () => {
  const { game, simulation, input } = await createGame();
  reachGameOver(game, simulation);
  // A press inside the guard window (the press that may have ended the run) is ignored.
  input.state.bomb = true;
  game.update(STEP);
  assert.equal(game.state.phase, RunPhase.GameOver);
  // Held past the window it is not a fresh press.
  runFor(game, 1);
  assert.equal(game.state.phase, RunPhase.GameOver);
  input.state.bomb = false;
  game.update(STEP);
  input.state.bomb = true;
  game.update(STEP);
  assert.equal(game.state.phase, RunPhase.Playing);
  assert.equal(game.state.lives, 3);
  assert.equal(game.state.bombs, 3);
});

test('after game over a fresh fire (right stick) press past the guard window restarts', async () => {
  const { game, simulation, input } = await createGame();
  input.state.aim = { x: 1, y: 0 };
  input.state.firing = true;
  reachGameOver(game, simulation);
  runFor(game, 1);
  assert.equal(game.state.phase, RunPhase.GameOver, 'fire held through the death is not a fresh press');
  input.state.firing = false;
  game.update(STEP);
  input.state.firing = true;
  game.update(STEP);
  assert.equal(game.state.phase, RunPhase.Playing);
});

test('the guard window is game time: a fresh press just inside it does not restart', async () => {
  const { game, simulation, input } = await createGame();
  reachGameOver(game, simulation);
  runFor(game, 0.6);
  input.state.bomb = true;
  game.update(STEP);
  assert.equal(game.state.phase, RunPhase.GameOver);
});

test('a stationary touch (no stick displacement yet) starts the run from Ready', async () => {
  const { game, input } = await createGame();
  game.update(STEP);
  assert.equal(game.state.phase, RunPhase.Ready);
  input.state.touching = true;
  game.update(STEP);
  assert.equal(game.state.phase, RunPhase.Playing);
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

test('debugInvulnerable keeps contact off while playing until it is turned off again', async () => {
  const { game, simulation } = await createGame();
  game.start();
  game.debugInvulnerable(true);
  runFor(game, 5);
  assert.ok(simulation.playerStates.every((state) => state.invulnerable), 'every step while the debug switch is on');
  game.debugInvulnerable(false);
  game.update(STEP);
  assert.equal(simulation.playerStates.at(-1).invulnerable, false);
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

test('an accepted bomb press and an accepted hit play the bomb and death effects', async () => {
  const gpu = createFakeGpu();
  const simulation = createFakeSimulation();
  const input = createFakeInput();
  const played = [];
  const effects = { bomb: () => played.push('bomb'), death: () => played.push('death') };
  const game = await Game.create({
    gpu, simulation, projectiles: createFakeProjectiles(), renderer: createFakeRenderer(), input, capacity: CAPACITY, random: () => 0.5, effects,
  });
  game.start();
  game.update(STEP);
  input.state.bomb = true;
  game.update(STEP);
  game.update(STEP);
  assert.deepEqual(played, ['bomb']);
  input.state.bomb = false;
  game.update(STEP);
  hitNow(game, simulation);
  assert.deepEqual(played, ['bomb', 'death']);
});

test('a pickup, every shot (with the kind and tier it fired at) and the charge expiry play their cues', async () => {
  const gpu = createFakeGpu();
  const simulation = createFakeSimulation();
  const input = createFakeInput();
  const played = [];
  const effects = {
    pickup: () => played.push('pickup'),
    expiry: () => played.push('expiry'),
    weaponFire: (kind, tier) => played.push(`fire ${kind} ${tier}`),
  };
  const game = await Game.create({
    gpu, simulation, projectiles: createFakeProjectiles(), renderer: createFakeRenderer(), input, capacity: CAPACITY, random: () => 0.5, effects,
  });
  game.start();
  const { x, y } = game.player.position;
  game.pickups.pickups.push({ x, y, type: 'scatter', age: 0, fade: 1 });
  game.update(STEP);
  assert.deepEqual(played, ['pickup']);
  input.state.aim = { x: 1, y: 0 };
  input.state.firing = true;
  for (let frame = 0; frame < 1000 && game.state.armed !== 'base'; frame += 1) game.update(STEP);
  const expiryIndex = played.indexOf('expiry');
  assert.ok(expiryIndex > 1, 'the charge expired');
  const shots = played.slice(1, expiryIndex);
  assert.ok(shots.length >= 30, `scatter shots ${shots.length}`);
  assert.ok(shots.every((entry) => entry === 'fire scatter 1'));
  runFor(game, 0.5);
  assert.ok(played.slice(expiryIndex + 1).every((entry) => entry === 'fire base 1'));
  played.length = 0;
  game.debugArm('beam', 3);
  game.update(STEP);
  assert.deepEqual(played, ['fire beam 3'], 'the beam fires every frame it is on');
});

test('freshStats is the newest frame read this update with the kills of every frame summed', async () => {
  const { game, simulation } = await createGame();
  game.start();
  game.update(STEP);
  assert.equal(game.freshStats, null);
  simulation.readAllStats = () => [
    stats({ frameSequence: 2, killsSinceLastRead: 4, aliveTotal: 900 }),
    stats({ frameSequence: 3, killsSinceLastRead: 6, aliveTotal: 800 }),
  ];
  game.update(STEP);
  assert.equal(game.freshStats.killsSinceLastRead, 10);
  assert.equal(game.freshStats.aliveTotal, 800);
  assert.equal(game.freshStats.frameSequence, 3);
  assert.equal(game.latestStats.frameSequence, 3);
});

test('the old simulation keeps stepping while a capacity change is prepared, then the new one is followed', async () => {
  const { game, simulation, renderer } = await createGame();
  let finishPrepare;
  const next = createFakeSimulation();
  next.capacity = CAPACITY * 4;
  const changes = [];
  simulation.prepareCapacity = (capacity, options) => {
    changes.push({ capacity, ...options });
    return new Promise((resolve) => { finishPrepare = () => resolve({ next }); });
  };
  simulation.commitCapacity = ({ next: prepared }) => {
    prepared.frameSequence = simulation.frameSequence;
    return prepared;
  };
  let installed = null;
  renderer.setSimulation = (installedSimulation) => { installed = installedSimulation; };
  game.start();
  game.update(STEP);
  const stepsBefore = simulation.frameSequence;
  const request = game.setCapacity(CAPACITY * 4, { particleCapacity: 1024 });
  assert.deepEqual(changes, [{ capacity: CAPACITY * 4, neighborRadius: undefined, particleCapacity: 1024 }]);
  assert.equal(await game.setCapacity(CAPACITY * 2), false, 'one change at a time');
  assert.equal(game.acceptsProbeFrames, false, 'no probe frames while a change is in flight');
  game.update(STEP);
  game.update(STEP);
  assert.equal(simulation.frameSequence, stepsBefore + 2, 'play goes on while the change is prepared');
  finishPrepare();
  assert.equal(await request, true);
  assert.equal(game.simulation, next);
  assert.equal(installed, next);
  assert.equal(game.spawnPressure.capacity, CAPACITY * 4);
  assert.equal(game.score.capacity, CAPACITY * 4);
  assert.equal(game.acceptsProbeFrames, true);
  game.update(STEP);
  assert.equal(next.frameSequence, stepsBefore + 3);
  assert.equal(simulation.frameSequence, stepsBefore + 2);
});

test('a failed capacity change keeps the old simulation and keeps stepping', async () => {
  const { game, simulation } = await createGame();
  simulation.prepareCapacity = async () => { throw new Error('out of memory'); };
  game.start();
  await assert.rejects(game.setCapacity(CAPACITY * 4), /out of memory/);
  assert.equal(game.simulation, simulation);
  const before = simulation.frameSequence;
  game.update(STEP);
  assert.equal(simulation.frameSequence, before + 1);
});

test('at half rate the simulation steps every other update with both deltas; CPU play runs every update', async () => {
  const { game, simulation, renderer, input } = await createGame();
  game.setSimulationRate('half');
  assert.equal(game.simulationRate, 'half');
  game.start();
  const deltas = [];
  const step = simulation.step.bind(simulation);
  simulation.step = (encoder, deltaSeconds, spawnPerSpecies) => { deltas.push(deltaSeconds); step(encoder, deltaSeconds, spawnPerSpecies); };
  input.state.move = { x: 1, y: 0 };
  const startX = game.player.position.x;
  for (let update = 0; update < 6; update += 1) game.update(STEP);
  assert.equal(deltas.length, 3);
  deltas.forEach((delta) => assert.ok(Math.abs(delta - 2 * STEP) < 1e-12));
  assert.ok(Math.abs(simulation.time - 6 * STEP) < 1e-12, 'simulated time matches game time');
  const halfDistance = game.player.position.x - startX;

  const full = await createGame();
  full.game.start();
  full.input.state.move = { x: 1, y: 0 };
  const fullStartX = full.game.player.position.x;
  for (let update = 0; update < 6; update += 1) full.game.update(STEP);
  assert.equal(full.simulation.frameSequence, 6);
  assert.ok(Math.abs(halfDistance - (full.game.player.position.x - fullStartX)) < 1e-12, 'ship speed does not change');

  game.update(STEP);
  game.render(0.5, STEP);
  const frame = renderer.frames.at(-1);
  assert.equal(frame.interpolate, true);
  assert.equal(frame.alpha, (1 + 0.5) / 2);
  game.setSimulationRate('full');
  game.update(STEP);
  game.render(0.25, STEP);
  assert.equal(renderer.frames.at(-1).interpolate, false);
  assert.equal(renderer.frames.at(-1).alpha, 0.25);
});

test('spawn pressure per second is the same at half rate', async () => {
  const counts = [];
  for (const rate of ['full', 'half']) {
    const { game, simulation } = await createGame();
    game.setSimulationRate(rate);
    game.start();
    for (let update = 0; update < 600; update += 1) game.update(STEP);
    counts.push(simulation.spawnBudgets.flat().reduce((sum, count) => sum + count, 0));
  }
  assert.ok(counts[0] > 0);
  assert.ok(Math.abs(counts[1] - counts[0]) <= 0.02 * counts[0], `full ${counts[0]} half ${counts[1]}`);
});

test('probe frames are accepted only while Playing', async () => {
  const { game } = await createGame();
  assert.equal(game.acceptsProbeFrames, false);
  game.start();
  assert.equal(game.acceptsProbeFrames, true);
});

test('the frame timer brackets each simulation step and the render, and closes the frame after it', async () => {
  const { game } = await createGame();
  const calls = [];
  game.frameTimer = {
    beginSection: () => calls.push('begin'),
    endSection: () => calls.push('end'),
    endFrame: () => calls.push('endFrame'),
    afterFrameSubmit: () => calls.push('afterFrameSubmit'),
  };
  game.update(STEP);
  game.render(0, STEP);
  assert.deepEqual(calls, ['begin', 'end', 'begin', 'end', 'endFrame', 'afterFrameSubmit']);
});

test('every step hands the spawn pressure seek scale and spawn distance to the simulation before stepping', async () => {
  const { game, simulation } = await createGame();
  game.start();
  game.update(STEP);
  assert.equal(simulation.seekScales.length, simulation.frameSequence);
  assert.equal(simulation.spawnDistanceFractions.length, simulation.frameSequence);
  assert.equal(simulation.spawnDistanceFractions.at(-1), game.spawnPressure.spawnDistanceFraction);
  assert.equal(simulation.seekScales.at(-1), game.spawnPressure.seekScale);
  runFor(game, 60);
  assert.ok(simulation.seekScales.at(-1) > simulation.seekScales[0], 'seek ramps up during play');
  assert.ok(simulation.spawnDistanceFractions.at(-1) < simulation.spawnDistanceFractions[0], 'spawns move closer during play');
  assert.equal(simulation.seekScales.at(-1), game.spawnPressure.seekScale);
});

// Regression (Plan B minor): ScoreKeeper.capacity was a mutable public field the swap overwrote,
// so the raw streak met the new capacity's thresholds and the multiplier jumped tiers.
test('a capacity swap mid-run keeps the multiplier tier and the score earned so far', async () => {
  const { game, simulation } = await createGame();
  const next = createFakeSimulation();
  next.capacity = CAPACITY / 4;
  // A swap carries the frame sequence (commitCapacity does).
  simulation.prepareCapacity = async () => ({ next });
  simulation.commitCapacity = () => { next.frameSequence = simulation.frameSequence; return next; };
  game.start();
  game.update(STEP);
  // 150 kills at the reference capacity reach the third step (multiplier 3).
  simulation.scriptedStats.push(stats({ frameSequence: simulation.frameSequence + 1, killsSinceLastRead: 150 }));
  game.update(STEP);
  assert.equal(game.score.multiplier, 3);
  const scoreBefore = game.score.score;
  assert.equal(await game.setCapacity(CAPACITY / 4), true);
  assert.equal(game.score.score, scoreBefore, 'the swap leaves past score alone');
  next.scriptedStats.push(stats({ frameSequence: next.frameSequence + 1, killsSinceLastRead: 1 }));
  game.update(STEP);
  assert.equal(game.score.multiplier, 3, 'one more kill at a quarter of the capacity stays on the third step');
  assert.equal(game.score.score, scoreBefore + 3 * 40, 'the kill scores at the new capacity (40 points) times 3');
});
