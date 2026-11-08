// Game orchestration: joins input, the player ship, weapons, pickups, score, run state and spawn
// pressure to the GPU simulation and its projectiles. The game waits in Ready (the swarm runs
// with player contact off) until start(), or until the first gesture: a press of fire, bomb, a
// movement key or stick, or any touch (the spec's one tap, click or button press). At GameOver a
// fresh fire or bomb press restarts once RESTART_GUARD_SECONDS of game time have passed (the
// HUD's Play again button covers mouse and touch). One update is one step:
//   1. input.update and read input.state (a gesture starts or restarts the run); a rising bomb
//      edge that run.useBomb accepts calls simulation.requestKillAll before this step, so the
//      bomb kills before projectiles and contact.
//   2. player.update (Playing only), with mouse aim derived as pointerWorld minus the player.
//   3. pickups.update, then collect at the player into weapons.collect (before charge expiry); a
//      collection queues a PICKUP_IMPULSE_STRENGTH impulse at the ship.
//   4. weapons.update; spawns go to projectiles.queueSpawn and the beam to setBeam (null on the
//      expiry frame even when the weapon still returned one).
//   5. simulation.setPlayerState (setPlayer only while Ready, so contact stays off until start).
//   6. spawn pressure (paused while Dying and Respawning), its seek scale and its spawn distance
//      (setSeekScale, setSpawnDistanceFraction: both ramp with the count), then the simulation
//      step is submitted.
//   7. every ready stats frame (readAllStats, oldest first): kills (killsSinceLastRead) score once
//      per stats frame and only while Playing; awards add lives and bombs; a frame with pulse ring
//      detonations queues one RING_IMPULSE_STRENGTH impulse at its reported ring position; every
//      new playerHitSequence is acknowledged (accepted or not) and offered to run.playerHit, which
//      on success drops the weapon and resets the multiplier.
//   8. run.update drains this step's actions: clearArena requests the kill-all for the next step
//      and clears projectiles, shockwave (bomb and death) queues an impulse that also boosts
//      bloom, respawn recenters the player, sets the respawn sequence to the next step and
//      resets spawn pressure; gameOver leaves the run frozen until restart.
import { Projectiles } from './projectiles.js';
import { PlayerShip } from './player.js';
import { WeaponState } from './weapons.js';
import { PickupDirector } from './pickups.js';
import { Awards, ScoreKeeper } from './score.js';
import { RunPhase, RunState } from './run.js';
import { CapacitySwap } from './capacity-swap.js';
import { SpawnPressure } from '../sim/spawner.js';
import { ARENA_HEIGHT, ARENA_WIDTH, SPECIES_COUNT } from '../sim/layout.js';

const NO_SPAWNS = new Uint32Array(SPECIES_COUNT);
const NO_AIM = Object.freeze({ x: 0, y: 0 });
// Warp grid impulse strengths; bomb and death shockwaves carry their own (1) from RunState.
const RING_IMPULSE_STRENGTH = 0.3;
const PICKUP_IMPULSE_STRENGTH = 0.15;
// Matches the HUD's touch restart guard, so the press that ended the run cannot restart it.
export const RESTART_GUARD_SECONDS = 0.7;

function isGesture(inputState) {
  const { move, aim } = inputState;
  return inputState.firing || inputState.pointerPrimaryDown || inputState.bomb || inputState.touching
    || move.x !== 0 || move.y !== 0 || aim.x !== 0 || aim.y !== 0;
}

export class Game {
  // projectiles is created (and registered with the simulation) when omitted; spawnPressure,
  // random and clock (seconds, used to stamp impulses) are injectable for tests. effects
  // (optional, the audio hook's EffectsSynth) gets bomb() for an accepted bomb press and death()
  // for an accepted hit.
  static async create({ gpu, simulation, projectiles, renderer, input, capacity, clock, spawnPressure, random = Math.random, effects = null }) {
    const projectileSet = projectiles ?? await Projectiles.create(gpu);
    return new Game({ gpu, simulation, projectiles: projectileSet, renderer, input, capacity, clock, spawnPressure, random, effects });
  }

  // Use Game.create.
  constructor({ gpu, simulation, projectiles, renderer, input, capacity = simulation.capacity, clock, spawnPressure, random, effects = null }) {
    this.gpu = gpu;
    this.simulation = simulation;
    this.projectiles = projectiles;
    this.renderer = renderer;
    this.input = input;
    this.effects = effects;
    this.capacity = capacity;
    this.clock = clock ?? (() => this.simulation.time);
    this.spawnPressure = spawnPressure ?? new SpawnPressure({ capacity });
    this.player = new PlayerShip({ arenaWidth: ARENA_WIDTH, arenaHeight: ARENA_HEIGHT });
    this.weapons = new WeaponState({ random });
    this.pickups = new PickupDirector({ random });
    this.score = new ScoreKeeper({ capacity });
    this.awards = new Awards();
    this.run = new RunState();
    this.latestStats = null;
    // This update's read-back stats (the newest frame, kills summed over every frame read), or null.
    this.freshStats = null;
    // Both only grow: stats frames and hit sequences are monotonic across respawns and restarts.
    this.lastScoredFrameSequence = 0;
    this.lastHitSequenceRead = 0;
    this.bombHeld = false;
    this.firingHeld = false;
    // Game time spent in GameOver, for the restart guard.
    this.gameOverSeconds = 0;
    this.pendingImpulses = [];
    // Stepping pauses from a capacity request until the new simulation is installed (CapacitySwap).
    // install runs synchronously in the recreate's continuation, so no frame sees a destroyed
    // simulation; spawn pressure keeps its ramp and the score its normalization follows.
    this.capacitySwap = new CapacitySwap({
      getCapacity: () => this.simulation.capacity,
      recreate: (nextCapacity) => this.simulation.recreateWithCapacity(nextCapacity),
      install: (next) => {
        this.simulation = next;
        this.renderer.setSimulation(next);
        this.spawnPressure.setCapacity(next.capacity);
        this.score.setCapacity(next.capacity);
        this.capacity = next.capacity;
      },
    });
    this.removeProjectilePass = simulation.registerPass((encoder, context) => this.projectiles.encode(encoder, context));
  }

  get state() {
    return {
      score: this.score.score,
      multiplier: this.score.multiplier,
      lives: this.run.lives,
      bombs: this.run.bombs,
      armed: this.weapons.armed,
      tier: this.weapons.tier,
      charge: this.weapons.charge,
      offeredType: this.pickups.offeredType,
      phase: this.run.phase,
      aliveTotal: this.latestStats?.aliveTotal ?? 0,
      playerX: this.player.position.x,
      playerY: this.player.position.y,
    };
  }

  start() {
    this.beginRun();
  }

  // Resets every module and clears the arena (one kill-all). Sequence guards stay monotonic: the
  // respawn sequence moves to the next step, so a hit latched in the previous run takes no life.
  restart() {
    this.beginRun();
  }

  beginRun() {
    this.score.reset();
    this.awards = new Awards();
    this.run.start();
    this.weapons.dropAll();
    this.pickups.reset();
    this.player.respawn();
    this.spawnPressure.reset();
    this.projectiles.clear();
    this.simulation.requestKillAll();
    this.run.setRespawnSequence(this.simulation.frameSequence + 1);
    // Stats frames up to the last submitted step belong to the previous run (or to Ready): their
    // kills must not score in this one, even when they are read only after the restart.
    this.lastScoredFrameSequence = Math.max(this.lastScoredFrameSequence, this.simulation.frameSequence);
    this.pendingImpulses = [];
    this.gameOverSeconds = 0;
    // A bomb button held through the restart needs a fresh press.
    this.bombHeld = true;
  }

  update(deltaSeconds) {
    // The old simulation is being copied into a new one; stepping it now would lose those steps.
    this.freshStats = null;
    if (this.capacitySwap.simulationPaused) return;
    this.input.update();
    const inputState = this.input.state;
    const firingPressed = inputState.firing && !this.firingHeld;
    this.firingHeld = inputState.firing;
    if (this.run.phase === RunPhase.Ready && isGesture(inputState)) this.start();
    else if (this.run.phase === RunPhase.GameOver) this.updateGameOver(deltaSeconds, firingPressed || (inputState.bomb && !this.bombHeld));

    const bombPressed = inputState.bomb && !this.bombHeld;
    this.bombHeld = inputState.bomb;
    if (bombPressed && this.run.useBomb(this.player.position)) {
      this.simulation.requestKillAll();
      this.effects?.bomb();
    }

    const playing = this.run.phase === RunPhase.Playing;
    const controls = this.controlsFrom(inputState);
    if (playing) this.player.update(deltaSeconds, controls);
    const { x, y } = this.player.position;

    this.pickups.update(deltaSeconds, {
      playerX: x,
      playerY: y,
      onBaseGun: this.weapons.isBase,
      milestone: playing && this.score.consumeMilestone(),
      phasePlaying: playing,
    });
    if (playing) {
      const collected = this.pickups.collect(x, y);
      if (collected !== null) {
        this.weapons.collect(collected);
        this.queueImpulse(x, y, PICKUP_IMPULSE_STRENGTH, false);
      }
    }

    const aim = this.player.aim;
    const fire = this.weapons.update(deltaSeconds, { firing: playing && controls.firing, aimX: aim.x, aimY: aim.y, x, y });
    fire.spawns.forEach((spawn) => this.projectiles.queueSpawn(spawn));
    this.projectiles.setBeam(fire.expired ? null : fire.beam);

    if (this.run.phase === RunPhase.Ready) {
      this.simulation.setPlayer(x, y);
    } else {
      this.simulation.setPlayerState({ x, y, radius: this.player.radius, invulnerable: !playing || this.run.invulnerable });
    }

    const spawnPerSpecies = this.spawnCounts(deltaSeconds);
    this.simulation.setSeekScale(this.spawnPressure.seekScale);
    this.simulation.setSpawnDistanceFraction(this.spawnPressure.spawnDistanceFraction);
    this.stepSimulation(deltaSeconds, spawnPerSpecies);
    const frames = this.simulation.readAllStats();
    frames.forEach((stats) => this.processStats(stats));
    if (frames.length > 0) {
      const killsSinceLastRead = frames.reduce((sum, stats) => sum + stats.killsSinceLastRead, 0);
      this.freshStats = { ...frames[frames.length - 1], killsSinceLastRead };
    }
    this.run.update(deltaSeconds).forEach((action) => this.handleAction(action));
  }

  // Gamepad and keyboard restart: a fresh fire or bomb press once the guard window has passed.
  updateGameOver(deltaSeconds, pressed) {
    this.gameOverSeconds += deltaSeconds;
    if (pressed && this.gameOverSeconds > RESTART_GUARD_SECONDS) this.restart();
  }

  // Stick or touch aim wins while it is pushed; otherwise the mouse aims from the ship to the
  // pointer. A pointer on top of the ship gives no aim, so the ship keeps its last one.
  controlsFrom(inputState) {
    let aim = inputState.aim;
    if (aim.x === 0 && aim.y === 0 && inputState.pointerWorld) {
      const offsetX = inputState.pointerWorld.x - this.player.position.x;
      const offsetY = inputState.pointerWorld.y - this.player.position.y;
      const length = Math.hypot(offsetX, offsetY);
      aim = length > this.player.radius ? { x: offsetX / length, y: offsetY / length } : NO_AIM;
    }
    return { move: inputState.move, aim, firing: inputState.firing || inputState.pointerPrimaryDown };
  }

  // No spawns between death and respawn: the arena stays clear for the pause.
  spawnCounts(deltaSeconds) {
    const phase = this.run.phase;
    if (phase === RunPhase.Dying || phase === RunPhase.Respawning) return NO_SPAWNS;
    return this.spawnPressure.update(deltaSeconds, this.latestStats, this.simulation.shares, this.simulation.frameSequence + 1);
  }

  stepSimulation(deltaSeconds, spawnPerSpecies) {
    const { device } = this.gpu;
    const encoder = device.createCommandEncoder();
    this.simulation.step(encoder, deltaSeconds, spawnPerSpecies);
    device.queue.submit([encoder.finish()]);
    this.simulation.afterSubmit();
  }

  // Kills belong to their stats frame, counted once. Projectile kills precede contact in a step,
  // so a frame's kills score before its hit is applied.
  processStats(stats) {
    this.latestStats = stats;
    if (stats.frameSequence > this.lastScoredFrameSequence) {
      this.lastScoredFrameSequence = stats.frameSequence;
      if (stats.ringsThisFrame > 0) this.queueImpulse(stats.lastRingX, stats.lastRingY, RING_IMPULSE_STRENGTH, false);
      if (this.run.phase === RunPhase.Playing) {
        this.score.recordKills(stats.killsSinceLastRead);
        const earned = this.awards.update(this.score.score);
        for (let index = 0; index < earned.lives; index += 1) this.run.addLife();
        for (let index = 0; index < earned.bombs; index += 1) this.run.addBomb();
      }
    }
    const hitSequence = stats.playerHitSequence;
    if (hitSequence > this.lastHitSequenceRead) {
      this.lastHitSequenceRead = hitSequence;
      // Acknowledge accepted and rejected hits alike, or a rejected one keeps the GPU latch set.
      this.simulation.acknowledgeHit(hitSequence);
      if (this.run.playerHit(hitSequence, this.player.position)) {
        this.weapons.dropAll();
        this.score.recordHit();
        this.effects?.death();
      }
    }
  }

  handleAction(action) {
    switch (action.type) {
      case 'clearArena':
        this.simulation.requestKillAll();
        this.projectiles.clear();
        break;
      case 'shockwave':
        this.queueImpulse(action.x, action.y, action.strength, true);
        break;
      case 'respawn':
        this.player.respawn();
        this.run.setRespawnSequence(this.simulation.frameSequence + 1);
        this.spawnPressure.reset();
        break;
      case 'gameOver':
        // The phase itself freezes play until restart; the restart guard counts from here.
        this.gameOverSeconds = 0;
        break;
      default:
        // bomb: the kill-all was requested when the press was accepted.
        break;
    }
  }

  // Stamped with the game clock; the renderer ages them against the same clock.
  queueImpulse(x, y, strength, bloomBoost) {
    this.pendingImpulses.push({ x, y, strength, time: this.clock(), bloomBoost });
  }

  // Impulses queued since the last call (bomb, death, ring and pickup shockwaves), for the renderer.
  takeImpulses() {
    const impulses = this.pendingImpulses;
    this.pendingImpulses = [];
    return impulses;
  }

  // What the renderer draws besides the swarm. The ship hides from death until respawn, and at
  // game over.
  scene() {
    const hidden = [RunPhase.Dying, RunPhase.Respawning, RunPhase.GameOver].includes(this.run.phase);
    return {
      projectiles: this.projectiles,
      pickups: this.pickups.pickups,
      ship: hidden ? null : {
        x: this.player.position.x,
        y: this.player.position.y,
        facing: this.player.facing,
        charge: this.weapons.charge,
        armed: this.weapons.armed,
        invulnerable: this.run.invulnerable,
      },
    };
  }

  // Debug hook: arms the weapon type at the tier with a full charge, reaching the tier the way
  // pickups do (the same type again adds a tier).
  debugArm(type, tier = 1) {
    this.weapons.dropAll();
    if (type === 'base') return;
    this.weapons.collect(type);
    for (let upgrade = 1; upgrade < tier; upgrade += 1) this.weapons.collect(type);
  }

  // deltaSeconds is the frame's elapsed time (FrameLoop), for the time-based trail decay.
  render(alpha, deltaSeconds) {
    const { device } = this.gpu;
    const encoder = device.createCommandEncoder();
    this.renderer.render(encoder, { alpha, time: this.simulation.time, deltaSeconds, impulses: this.takeImpulses(), scene: this.scene() });
    device.queue.submit([encoder.finish()]);
    this.renderer.afterSubmit();
  }

  // The capacity swap goes through the game's CapacitySwap: stepping pauses while the new
  // simulation is built (recreateWithCapacity compacts the alive agents and carries registered
  // passes, player state and the stats persistent tail), then the renderer, spawn pressure
  // (keeping its ramp) and score normalization follow. One swap at a time; resolves false for an
  // ignored request and rethrows a failed one, leaving the old simulation installed.
  setCapacity(capacity) {
    return this.capacitySwap.request(capacity);
  }
}
