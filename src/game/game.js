// Over 500 lines: the frame order is one sequence (header) that the update steps implement in place.
// Game orchestration: joins input, the player ship, weapons, pickups, score, run state and spawn
// pressure to the GPU simulation and its projectiles. The game waits in Ready (the swarm runs
// with player contact off) until start(), or until the first gesture: a press of fire, bomb, a
// movement key or stick, or any touch (the spec's one tap, click or button press). At GameOver a
// fresh fire or bomb press restarts once RESTART_GUARD_SECONDS of game time have passed (the
// HUD's Play again button covers mouse and touch). pause() freezes the run (Playing, Dying or
// Respawning only; Ready and GameOver have nothing to freeze): update() then returns at once, so no
// step, stats read, hit, timer or score moves and every sequence guard stays as it was; stats a step
// already submitted are read, and a hit in flight is honored or ignored by the usual rules, after
// resume(). state.phase reads 'paused' meanwhile. startsOnGesture (default true) is switched off
// by the title menu, which then owns the start (a menu cursor must not start the run). One update
// is one step:
//   1. input.update and read input.state (a gesture starts or restarts the run); a rising bomb
//      edge that run.useBomb accepts calls simulation.requestKillAll before this step, so the
//      bomb kills before projectiles and contact.
//   2. player.update (Playing only), with mouse aim derived as pointerWorld minus the player; with
//      the beam armed the aim turns at most beamTurnRevolutionsPerSecond (0 is instant).
//   3. pickups.update, then collect at the player into weapons.collect (before charge expiry; a
//      rail pickup adds a turret and leaves the armed weapon alone, owner ruling R29); a
//      collection plays the pickup effect and, with pickupBlastRadius above 0, fires the pickup
//      blast (owner ruling R22): simulation.requestRadialKill at the ship for this step (unscored,
//      like a bomb) and a PICKUP_BLAST_IMPULSE_STRENGTH shockwave; with the blast off it queues
//      the smaller PICKUP_IMPULSE_STRENGTH impulse instead. A time warp pickup (owner ruling R31)
//      leaves the weapons alone: it starts or extends timeWarp, plays pickup('timewarp') and its
//      shockwave is the larger TIME_WARP_IMPULSE_STRENGTH (the blast still fires).
//   4. weapons.update; the armed weapon's spawns and then the rail turrets' spawns go to
//      projectiles.queueSpawn and the beam to setBeam (null on the expiry frame even when the
//      weapon still returned one). A frame that fires plays one weaponFire cue: the armed weapon's
//      kind and tier when it fired (spawns or a beam), else 'rail' at the turret tier when only the
//      turrets fired; then the expiry cue (expiry keeps the turrets).
//   5. simulation.setPlayerState (setPlayer only while Ready, so contact stays off until start).
//   6. the spawn director (gates and waves; no waves in Ready) and spawn pressure (both paused
//      while Dying and Respawning, when the step gets no gates), its seek scale and its spawn
//      distance (setSeekScale, setSpawnDistanceFraction: both ramp with the count), then the
//      simulation step is submitted with the director's gate table. At half simulation rate
//      (setSimulationRate('half')) step 6 runs every other update with the two updates' summed
//      delta, so speeds, spawn pressure per second, fire rate and charge drain (steps 1 to 5
//      still run every update) do not change. During a
//      time warp the director, spawn pressure and the simulation get deltaSeconds times
//      timeWarp.scale while the projectile step gets the unscaled delta; the warp timer counts
//      real time (every update not paused). Death, a new run and quit to title end the warp.
//   7. every ready stats frame (readAllStats, oldest first): kills (killsSinceLastRead) score once
//      per stats frame and only while Playing; kills grow the player swarm (one ship per
//      KILLS_PER_SWARM_SHIP) and awards add bombs; a frame with pulse ring detonations queues one
//      RING_IMPULSE_STRENGTH impulse at its reported ring position; while Playing its swarm hit
//      mask kills the hit swarm ships (PlayerSwarm.applyHits), and losing the last one is the run's
//      one death (run.playerHit, which drops the weapon and the turrets and resets the multiplier).
// Player swarm spike: the ship is replaced by PlayerSwarm (white ships orbiting the controlled
// point, which moves as the ship did and cannot be hit); SwarmFire spreads step 4's shots over the
// ships, and step 6 uploads the swarm for the contact pass (Simulation.setSwarmShips).
//   8. run.update drains this step's actions: clearArena requests the kill-all for the next step
//      (with the death flood) and clears projectiles, shockwave (bomb and death) queues an impulse
//      that also boosts bloom, respawn recenters the player, sets the respawn sequence to the next
//      step and resets spawn pressure and the spawn director; gameOver leaves the run frozen until
//      restart.
// Watch mode (the lab, task C6b): setWatch(fraction) puts the run in Ready and keeps it there (no
// gesture starts it, so weapons and contact stay off); the player point follows the pointer (or
// the move stick without one) so the swarm chases it, and a watch SpawnPressure with full seek
// holds the alive target at fraction of capacity in place of the play ramp. setWatch(null) leaves
// it; start() (the lab's Play) leaves it too.
import { Projectiles } from './projectiles.js';
import { PlayerShip } from './player.js';
import { DEFAULT_BEAM_TURN_REVOLUTIONS_PER_SECOND, MAXIMUM_BEAM_TURN_REVOLUTIONS_PER_SECOND } from './weaponTypes.js';
import { WeaponState } from './weapons.js';
import { PickupDirector } from './pickups.js';
import { Awards, ScoreKeeper } from './score.js';
import { RunPhase, RunState } from './run.js';
import { CapacitySwap } from './capacity-swap.js';
import { TimeWarp } from './time-warp.js';
import { INITIAL_SWARM_SHIPS, MAXIMUM_SWARM_SHIPS, PlayerSwarm, SWARM_SHIP_RADIUS } from './player-swarm.js';
import { SwarmFire } from './swarm-fire.js';
import { SPEC_SPAWN_DISTANCE_FRACTION, SpawnPressure } from '../sim/spawner.js';
import { SpawnDirector } from '../sim/spawn-director.js';
import { SPECIES_COUNT, WORLD_BOUNDS, WORLD_HEIGHT, WORLD_WIDTH, boundsAround, viewSizeForAspect } from '../sim/layout.js';
import { Camera } from './camera.js';

const NO_SPAWNS = new Uint32Array(SPECIES_COUNT);
const NO_AIM = Object.freeze({ x: 0, y: 0 });
const NO_SWARM_HITS = Object.freeze([]);
// Warp grid impulse strengths; bomb and death shockwaves carry their own (1) from RunState.
const RING_IMPULSE_STRENGTH = 0.3;
const PICKUP_IMPULSE_STRENGTH = 0.15;
const PICKUP_BLAST_IMPULSE_STRENGTH = 0.5;
const TIME_WARP_IMPULSE_STRENGTH = 0.6;
export const DEFAULT_PICKUP_BLAST_RADIUS = 1.5;
// Player swarm spike: a lost ship ripples the warp grid; a swarm ship collects pickups this close;
// the run has one life, lost when the last swarm ship dies (so the death clear and game over follow).
const SWARM_SHIP_LOSS_IMPULSE_STRENGTH = 0.12;
export const SWARM_PICKUP_RADIUS = 0.2;
const SWARM_RUN_LIVES = 1;

function createRunState() {
  return new RunState({ lives: SWARM_RUN_LIVES });
}
// Matches the HUD's touch restart guard, so the press that ended the run cannot restart it.
export const RESTART_GUARD_SECONDS = 0.7;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function isGesture(inputState) {
  const { move, aim } = inputState;
  return inputState.firing || inputState.pointerPrimaryDown || inputState.bomb || inputState.touching
    || move.x !== 0 || move.y !== 0 || aim.x !== 0 || aim.y !== 0;
}

export class Game {
  // projectiles is created (and registered with the simulation) when omitted; spawnPressure,
  // random and clock (seconds, used to stamp impulses) are injectable for tests. effects
  // (optional, the audio hook's cues) gets bomb() for an accepted bomb press, death() for an
  // accepted hit, pickup() for a collection, weaponFire(kind, tier) for a frame that fires and
  // expiry() when the upgrade's charge runs out; a missing method is skipped.
  // frameTimer (optional, src/gpu/frame-timer.js) brackets every simulation step and render.
  // spawnDirector (injectable too) owns the spawn gates and waves.
  static async create({ gpu, simulation, projectiles, renderer, input, capacity, clock, spawnPressure, spawnDirector, random = Math.random, effects = null, frameTimer = null, now }) {
    const projectileSet = projectiles ?? await Projectiles.create(gpu);
    return new Game({ gpu, simulation, projectiles: projectileSet, renderer, input, capacity, clock, spawnPressure, spawnDirector, random, effects, frameTimer, now });
  }

  // Use Game.create.
  constructor({ gpu, simulation, projectiles, renderer, input, capacity = simulation.capacity, clock, spawnPressure, spawnDirector, random, effects = null, frameTimer = null, now }) {
    this.gpu = gpu;
    this.simulation = simulation;
    this.projectiles = projectiles;
    this.renderer = renderer;
    this.input = input;
    this.effects = effects;
    this.frameTimer = frameTimer;
    this.capacity = capacity;
    // Updates per simulation step (1 full rate, 2 half rate), updates since the last step and the
    // game seconds they covered (the next step's delta).
    this.simulationStepInterval = 1;
    this.updatesSinceSimulationStep = 0;
    this.pendingSimulationSeconds = 0;
    // Real seconds for the same steps (the projectile step's delta, unscaled by a time warp), and
    // the real time that animates projectiles, pickups and the ship.
    this.pendingProjectileSeconds = 0;
    this.sceneSeconds = 0;
    this.timeWarp = new TimeWarp();
    this.clock = clock ?? (() => this.simulation.time);
    this.spawnPressure = spawnPressure ?? new SpawnPressure({ capacity });
    this.spawnDirector = spawnDirector ?? new SpawnDirector({ random });
    // The lab's watch mode spawn pressure (setWatch), or null in play.
    this.watchPressure = null;
    // The gate table for the next simulation step (null while Dying and Respawning).
    this.stepGates = null;
    // The view's size in world units (setView, from Viewport.viewSize on every resize) and the
    // playable rectangle inside the world: the view's size centered in the world.
    this.viewSize = viewSizeForAspect(WORLD_WIDTH / WORLD_HEIGHT);
    this.worldBounds = WORLD_BOUNDS;
    // The renderer draws around this camera (Viewport.setCamera with camera.sample); it stays on
    // the world center.
    this.camera = new Camera({ centerX: WORLD_WIDTH / 2, centerY: WORLD_HEIGHT / 2 });
    this.player = new PlayerShip({ bounds: this.worldBounds });
    this.weapons = new WeaponState({ random });
    this.pickups = new PickupDirector({ random, bounds: this.worldBounds });
    this.score = new ScoreKeeper({ capacity });
    this.awards = new Awards();
    this.run = createRunState();
    // The player swarm replaces the ship: the ship's position is the controlled point it seeks.
    this.swarm = new PlayerSwarm({ random, bounds: this.worldBounds });
    this.initialSwarmShips = INITIAL_SWARM_SHIPS;
    this.swarm.reset(this.player.position.x, this.player.position.y, this.initialSwarmShips);
    this.swarmFire = new SwarmFire();
    // Reused each update: the swarm's attack-run controls (firing, unit aim).
    this.swarmControls = { firing: false, aimX: 0, aimY: 0 };
    this.latestStats = null;
    // This update's read-back stats (the newest frame, kills summed over every frame read), or null.
    this.freshStats = null;
    // Both only grow: stats frames and hit sequences are monotonic across respawns and restarts.
    this.lastScoredFrameSequence = 0;
    this.bombHeld = false;
    this.firingHeld = false;
    this.paused = false;
    this.startsOnGesture = true;
    // Set by LabMode while the lab is open (Watch or Play); lab mixes are not real play.
    this.labActive = false;
    // Game time spent in GameOver, for the restart guard.
    this.gameOverSeconds = 0;
    this.pendingImpulses = [];
    // Reads this.simulation at call time, so it stays valid across a capacity swap.
    this.densityAt = (positionX, positionY) => this.simulation.densityAt(positionX, positionY);
    // World units cleared around the ship on every pickup (0 disables); setPickupBlastRadius.
    this.pickupBlastRadiusValue = DEFAULT_PICKUP_BLAST_RADIUS;
    // Revolutions per second the aim may turn while the beam is armed (0 is instant); setBeamTurnRate.
    this.beamTurnRevolutionsPerSecondValue = DEFAULT_BEAM_TURN_REVOLUTIONS_PER_SECOND;
    // Debug switch (debugInvulnerable): player contact stays off while it is on.
    this.debugInvulnerableValue = false;
    // The old simulation keeps stepping while a capacity change is prepared (CapacitySwap); commit
    // and install run synchronously together between two updates, so no frame sees a destroyed
    // simulation; spawn pressure keeps its ramp and the score carries its streak (ScoreKeeper).
    // now (optional, performance.now by default) times out a swap that never settles.
    this.capacitySwap = new CapacitySwap({
      now,
      getConfiguration: () => ({
        capacity: this.simulation.capacity,
        neighborRadius: this.simulation.neighborRadius,
        particleCapacity: this.simulation.particlePool?.capacity,
      }),
      prepare: ({ capacity: nextCapacity, ...options }) => this.simulation.prepareCapacity(nextCapacity, options),
      commit: (prepared) => this.simulation.commitCapacity(prepared),
      discard: (prepared) => this.simulation.discardCapacity(prepared),
      install: (next) => {
        this.simulation = next;
        this.projectiles.clearBindGroupCaches();
        this.renderer.setSimulation(next);
        this.spawnPressure.setCapacity(next.capacity);
        this.watchPressure?.setCapacity(next.capacity);
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
      // The swarm size stands in for lives (the HUD's life icons).
      lives: this.swarm.aliveCount,
      bombs: this.run.bombs,
      armed: this.weapons.armed,
      tier: this.weapons.tier,
      charge: this.weapons.charge,
      railTurrets: this.weapons.railTurrets,
      railTier: this.weapons.railTier,
      timeWarp: this.timeWarp.fraction,
      offeredType: this.pickups.offeredType,
      phase: this.paused ? 'paused' : this.run.phase,
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
    this.watchPressure = null;
    this.paused = false;
    // start() zeroes the run's respawn sequence, so it runs before resetModules moves it forward.
    this.run.start();
    this.resetModules();
    this.bombHeld = true;
  }

  // Back to the title: every module reset and the run in Ready again (the arena is cleared once,
  // the swarm keeps running behind the menu). Sequence guards stay monotonic as in beginRun.
  quitToTitle() {
    this.paused = false;
    this.resetModules();
    this.run = createRunState();
    // The title menu takes over the start; the confirming press (Space, a face button) must not start the run.
    this.startsOnGesture = false;
  }

  // Lab watch mode: fraction in [0, 1] is the alive target as a fraction of capacity (held, no
  // ramp, full seek, spawns at the spec's quarter of the arena); null leaves watch mode. Entering
  // it resets the run to Ready as quitToTitle does; a new fraction while watching only moves the
  // target (the in-flight spawn estimate carries over). Throws RangeError for any other value.
  setWatch(fraction) {
    if (fraction === null) {
      this.watchPressure = null;
      return;
    }
    if (!(typeof fraction === 'number' && fraction >= 0 && fraction <= 1)) throw new RangeError(`watch fraction must lie in [0, 1], got ${fraction}`);
    const previous = this.watchPressure;
    if (previous === null) {
      this.paused = false;
      this.resetModules();
      this.run = createRunState();
    }
    const next = new SpawnPressure({
      capacity: this.capacity, floorFraction: fraction, ceilingFraction: fraction, seekFloorFraction: 1,
      spawnDistanceStartFraction: SPEC_SPAWN_DISTANCE_FRACTION,
    });
    if (previous !== null) {
      next.newestStats = previous.newestStats;
      next.requests = previous.requests;
      next.filling = previous.filling;
    }
    next.setAreaFraction(this.areaFraction());
    this.watchPressure = next;
  }

  // The playable rectangle's share of the world's area.
  areaFraction() {
    return (this.worldBounds.width * this.worldBounds.height) / (WORLD_WIDTH * WORLD_HEIGHT);
  }

  // The view's { width, height } for the canvas aspect (Viewport.viewSize, on every resize). The
  // playable rectangle is that size centered in the world: the ship, pickups, spawn gates and the
  // simulation's walls follow it, spawn pressure holds the same density by scaling the alive target
  // with its area, and spawns keep their distance as a fraction of the view width.
  setView({ width, height }) {
    this.viewSize = { width, height };
    const bounds = boundsAround(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, width, height);
    this.worldBounds = bounds;
    this.simulation.setSpawnViewWidth(width);
    this.player.setBounds(bounds);
    this.swarm.setBounds(bounds);
    this.pickups.setBounds(bounds);
    this.simulation.setWorldBounds(bounds);
    const fraction = this.areaFraction();
    this.spawnPressure.setAreaFraction(fraction);
    this.watchPressure?.setAreaFraction(fraction);
  }

  get watching() {
    return this.watchPressure !== null;
  }

  // The spawn pressure in effect: the watch one in the lab's watch mode, else the play ramp.
  get activeSpawnPressure() {
    return this.watchPressure ?? this.spawnPressure;
  }

  // Freezes the run; returns whether it paused (Ready and GameOver have nothing to freeze).
  pause() {
    const phase = this.run.phase;
    if (this.paused || phase === RunPhase.Ready || phase === RunPhase.GameOver) return false;
    this.paused = true;
    return true;
  }

  // A button or key held through the pause needs a fresh press, as after a restart.
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.bombHeld = true;
    this.firingHeld = true;
  }

  resetModules() {
    this.score.reset();
    this.awards = new Awards();
    this.weapons.dropAll();
    this.pickups.reset();
    this.player.respawn();
    this.swarm.reset(this.player.position.x, this.player.position.y, this.initialSwarmShips);
    this.swarmFire.reset();
    this.spawnPressure.reset();
    this.spawnDirector.reset();
    this.timeWarp.end();
    this.projectiles.clear();
    this.simulation.requestKillAll();
    this.run.setRespawnSequence(this.simulation.frameSequence + 1);
    // Stats frames up to the last submitted step belong to the previous run (or to Ready): their
    // kills must not score in this one, even when they are read only after the restart.
    this.lastScoredFrameSequence = Math.max(this.lastScoredFrameSequence, this.simulation.frameSequence);
    this.pendingImpulses = [];
    this.gameOverSeconds = 0;
  }

  // 'full' steps the simulation every update, 'half' every other update with twice the delta (the
  // renderer then interpolates glyphs between the last two steps).
  setSimulationRate(rate) {
    this.simulationStepInterval = rate === 'half' ? 2 : 1;
  }

  get simulationRate() {
    return this.simulationStepInterval === 2 ? 'half' : 'full';
  }

  // The quality probe measures only real play: Playing outside the lab, with no capacity change in
  // flight (so a lab mix never steps or persists a preset, and the lab-leave rate restore holds).
  get acceptsProbeFrames() {
    return this.run.phase === RunPhase.Playing && !this.paused && !this.labActive && !this.capacitySwap.pending;
  }

  update(deltaSeconds) {
    this.freshStats = null;
    if (this.paused) return;
    this.sceneSeconds += deltaSeconds;
    this.input.update();
    const inputState = this.input.state;
    const firingPressed = inputState.firing && !this.firingHeld;
    this.firingHeld = inputState.firing;
    if (this.run.phase === RunPhase.Ready && this.startsOnGesture && !this.watching && isGesture(inputState)) this.start();
    else if (this.run.phase === RunPhase.GameOver) this.updateGameOver(deltaSeconds, firingPressed || (inputState.bomb && !this.bombHeld));

    const bombPressed = inputState.bomb && !this.bombHeld;
    this.bombHeld = inputState.bomb;
    if (bombPressed && this.run.useBomb(this.player.position)) {
      this.simulation.requestKillAll();
      this.effects?.bomb();
    }

    const playing = this.run.phase === RunPhase.Playing;
    const controls = this.controlsFrom(inputState);
    if (playing) {
      const limited = this.weapons.armed === 'beam' && this.beamTurnRevolutionsPerSecondValue > 0;
      const maximumTurnRadians = limited ? this.beamTurnRevolutionsPerSecondValue * 2 * Math.PI * deltaSeconds : Infinity;
      this.player.update(deltaSeconds, controls, { maximumTurnRadians });
    }
    else if (this.watching) this.moveWatchPoint(deltaSeconds, inputState, controls);
    const { x, y } = this.player.position;
    const swarmFiring = playing && controls.firing;
    const aimLength = Math.hypot(this.player.aim.x, this.player.aim.y);
    const swarmControls = this.swarmControls;
    swarmControls.firing = swarmFiring;
    swarmControls.aimX = aimLength > 0 ? this.player.aim.x / aimLength : 0;
    swarmControls.aimY = aimLength > 0 ? this.player.aim.y / aimLength : 0;
    this.swarm.update(deltaSeconds, x, y, swarmControls);

    this.pickups.update(deltaSeconds, {
      playerX: x,
      playerY: y,
      onBaseGun: this.weapons.isBase,
      milestone: playing && this.score.consumeMilestone(),
      phasePlaying: playing,
      densityAt: this.densityAt,
    });
    if (playing) {
      const collected = this.collectPickup(x, y);
      if (collected !== null) {
        const timeWarp = collected === 'timewarp';
        if (timeWarp) {
          this.timeWarp.start();
          this.effects?.pickup?.('timewarp');
        } else {
          this.weapons.collect(collected);
          this.effects?.pickup?.();
        }
        const blast = this.pickupBlastRadiusValue > 0;
        if (blast) this.simulation.requestRadialKill(x, y, this.pickupBlastRadiusValue);
        const strength = blast ? PICKUP_BLAST_IMPULSE_STRENGTH : PICKUP_IMPULSE_STRENGTH;
        this.queueImpulse(x, y, timeWarp ? TIME_WARP_IMPULSE_STRENGTH : strength, false);
      }
    }

    const aim = this.player.aim;
    // The kind and tier this frame fires at; the update itself drops to base on expiry.
    const firedKind = this.weapons.armed;
    const firedTier = this.weapons.tier;
    const fire = this.weapons.update(deltaSeconds, { firing: playing && controls.firing, aimX: aim.x, aimY: aim.y, x, y });
    const railTier = this.weapons.railTier;
    const swarmShots = this.swarmFire.distribute(fire, this.swarm.ships, { x, y }, this.swarm.centroid, {
      firing: swarmFiring,
      aimX: swarmControls.aimX,
      aimY: swarmControls.aimY,
      fireInterval: this.weapons.types[firedKind].tiers[firedTier - 1].fireInterval,
      deltaSeconds,
      kind: firedKind,
    });
    swarmShots.spawns.forEach((spawn) => this.projectiles.queueSpawn(spawn));
    swarmShots.turretSpawns.forEach((spawn) => this.projectiles.queueSpawn(spawn));
    this.projectiles.setBeam(fire.expired ? null : swarmShots.beam);
    if (fire.spawns.length > 0 || (fire.beam !== null && !fire.expired)) this.effects?.weaponFire?.(firedKind, firedTier);
    else if (fire.turretSpawns.length > 0) this.effects?.weaponFire?.('rail', railTier);
    if (fire.expired) this.effects?.expiry?.();

    if (this.run.phase === RunPhase.Ready) {
      this.simulation.setPlayer(x, y);
    } else {
      this.simulation.setPlayerState({ x, y, radius: this.player.radius, invulnerable: !playing || this.run.invulnerable || this.debugInvulnerableValue });
    }

    this.timeWarp.update(deltaSeconds);
    this.pendingSimulationSeconds += deltaSeconds * this.timeWarp.scale;
    this.pendingProjectileSeconds += deltaSeconds;
    this.updatesSinceSimulationStep += 1;
    if (this.updatesSinceSimulationStep >= this.simulationStepInterval) {
      const simulationSeconds = this.pendingSimulationSeconds;
      const projectileSeconds = this.pendingProjectileSeconds;
      this.pendingSimulationSeconds = 0;
      this.pendingProjectileSeconds = 0;
      this.updatesSinceSimulationStep = 0;
      const spawnPerSpecies = this.spawnCounts(simulationSeconds);
      const pressure = this.activeSpawnPressure;
      this.simulation.setSeekScale(pressure.seekScale);
      this.simulation.setSpawnDistanceFraction(pressure.spawnDistanceFraction);
      this.simulation.setSwarmShips(this.swarm.contactShips(this.simulation.frameSequence + 1), SWARM_SHIP_RADIUS);
      this.stepSimulation(simulationSeconds, spawnPerSpecies, this.stepGates, projectileSeconds);
    }
    this.simulation.pollDensity();
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

  // Watch mode: the point sits on the pointer (clamped inside the arena), else moves with the stick.
  moveWatchPoint(deltaSeconds, inputState, controls) {
    const pointer = inputState.pointerWorld;
    if (!pointer) {
      this.player.update(deltaSeconds, { ...controls, firing: false });
      return;
    }
    const { radius, bounds } = this.player;
    this.player.positionX = clamp(pointer.x, bounds.minX + radius, bounds.maxX - radius);
    this.player.positionY = clamp(pointer.y, bounds.minY + radius, bounds.maxY - radius);
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

  // No spawns and no gates between death and respawn: the arena stays clear for the pause.
  spawnCounts(deltaSeconds) {
    const phase = this.run.phase;
    const pressure = this.activeSpawnPressure;
    this.stepGates = null;
    if (phase === RunPhase.Dying || phase === RunPhase.Respawning) return NO_SPAWNS;
    this.spawnDirector.update(deltaSeconds, {
      playerX: this.player.position.x,
      playerY: this.player.position.y,
      safeDistance: pressure.spawnDistanceFraction * this.viewSize.width,
      bounds: this.worldBounds,
      filling: pressure.filling,
      shares: this.simulation.shares,
      // The Ready arena (before a run) trickles from every gate; waves start with the run.
      continuous: phase === RunPhase.Ready,
      // Waves avoid the gates in the player's aim lane (the lane being shot open).
      aimX: this.player.aim.x,
      aimY: this.player.aim.y,
    });
    this.stepGates = this.spawnDirector.spawnGates;
    return pressure.update(deltaSeconds, this.latestStats, this.simulation.shares, this.simulation.frameSequence + 1, this.spawnDirector.wave);
  }

  stepSimulation(deltaSeconds, spawnPerSpecies, spawnGates = null, projectileDeltaSeconds = deltaSeconds) {
    const { device } = this.gpu;
    const encoder = device.createCommandEncoder();
    this.frameTimer?.beginSection(encoder);
    this.simulation.step(encoder, deltaSeconds, spawnPerSpecies, spawnGates, projectileDeltaSeconds);
    this.frameTimer?.endSection(encoder);
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
        // Kills grow the swarm; award lives are superseded by it, bombs stay.
        this.swarm.addKills(stats.killsSinceLastRead);
        const earned = this.awards.update(this.score.score);
        for (let index = 0; index < earned.bombs; index += 1) this.run.addBomb();
      }
    }
    if (this.run.phase === RunPhase.Playing) this.processSwarmHits(stats);
  }

  // Swarm ships the GPU reported hit die (a small shockwave each); losing the last one is the run's
  // one death: the death clear, then game over. A lost ship does not reset the multiplier.
  processSwarmHits(stats) {
    const killed = this.swarm.applyHits(stats.swarmHitMask ?? NO_SWARM_HITS, stats.frameSequence);
    killed.forEach((ship) => this.queueImpulse(ship.x, ship.y, SWARM_SHIP_LOSS_IMPULSE_STRENGTH, false));
    if (killed.length === 0 || this.swarm.aliveCount > 0) return;
    const last = killed[killed.length - 1];
    if (this.run.playerHit(stats.frameSequence, last)) {
      this.weapons.dropAll();
      this.timeWarp.end();
      this.score.recordHit();
      this.effects?.death();
    }
  }

  // A pickup at the controlled point, else at the first swarm ship close enough; null for none.
  collectPickup(x, y) {
    const atPoint = this.pickups.collect(x, y);
    if (atPoint !== null) return atPoint;
    for (const ship of this.swarm.ships) {
      const collected = this.pickups.collect(ship.x, ship.y, SWARM_PICKUP_RADIUS);
      if (collected !== null) return collected;
    }
    return null;
  }

  handleAction(action) {
    switch (action.type) {
      case 'clearArena':
        // The death clear: the step also floods particles and flashes at the ship (task C0b2).
        this.simulation.requestKillAll({ deathFlood: true });
        this.projectiles.clear();
        break;
      case 'shockwave':
        this.queueImpulse(action.x, action.y, action.strength, true);
        break;
      case 'respawn':
        this.player.respawn();
        this.run.setRespawnSequence(this.simulation.frameSequence + 1);
        this.spawnPressure.reset();
        this.spawnDirector.reset();
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

  // What the renderer draws besides the enemy swarm: the player swarm (white ships, the controlled
  // point's marker while Playing) replaces the ship, so ship is always null. The player swarm hides
  // from death on, and at game over.
  scene() {
    const hidden = [RunPhase.Dying, RunPhase.Respawning, RunPhase.GameOver].includes(this.run.phase);
    return {
      projectiles: this.projectiles,
      pickups: this.pickups.pickups,
      ship: null,
      swarm: hidden ? null : {
        ships: this.swarm.ships,
        facing: this.player.facing,
        pointX: this.player.position.x,
        pointY: this.player.position.y,
        pointShown: this.run.phase === RunPhase.Playing,
        armed: this.weapons.armed,
      },
    };
  }

  // Debug hook: arms the weapon type at the tier with a full charge, reaching the tier the way
  // pickups do (the same type again adds a tier). 'rail' is the turrets: base gun plus tier
  // turrets (past 12 each further one raises the turret tier).
  debugArm(type, tier = 1) {
    this.weapons.dropAll();
    if (type === 'base') return;
    this.weapons.collect(type);
    for (let upgrade = 1; upgrade < tier; upgrade += 1) this.weapons.collect(type);
  }

  // Ships every run starts with (the ?swarm= query parameter); the swarm resets to it now.
  setInitialSwarmShips(count) {
    if (!(Number.isInteger(count) && count >= 1 && count <= MAXIMUM_SWARM_SHIPS)) throw new RangeError(`initial swarm ships must be an integer in [1, ${MAXIMUM_SWARM_SHIPS}], got ${count}`);
    this.initialSwarmShips = count;
    this.swarm.reset(this.player.position.x, this.player.position.y, count);
  }

  // The pickup blast radius in world units (the lab sets it); 0 turns the blast off.
  setPickupBlastRadius(radius) {
    if (!(Number.isFinite(radius) && radius >= 0)) throw new RangeError(`pickupBlastRadius must be a finite number of at least 0, got ${radius}`);
    this.pickupBlastRadiusValue = radius;
  }

  get pickupBlastRadius() {
    return this.pickupBlastRadiusValue;
  }

  // Beam aim turn rate in revolutions per second (the lab sets it); 0 turns the limit off.
  setBeamTurnRate(revolutionsPerSecond) {
    if (!(Number.isFinite(revolutionsPerSecond) && revolutionsPerSecond >= 0 && revolutionsPerSecond <= MAXIMUM_BEAM_TURN_REVOLUTIONS_PER_SECOND)) {
      throw new RangeError(`beamTurnRevolutionsPerSecond must lie in [0, ${MAXIMUM_BEAM_TURN_REVOLUTIONS_PER_SECOND}], got ${revolutionsPerSecond}`);
    }
    this.beamTurnRevolutionsPerSecondValue = revolutionsPerSecond;
  }

  get beamTurnRevolutionsPerSecond() {
    return this.beamTurnRevolutionsPerSecondValue;
  }

  // Debug hook (browser checks, a lab sandbox): while enabled, the GPU contact test never hits, so
  // the ship survives a measurement in a crowded arena (the C0b corridor metric).
  debugInvulnerable(enabled) {
    this.debugInvulnerableValue = Boolean(enabled);
  }

  // alpha is FrameLoop's fraction of an update; it becomes the fraction of the current simulation
  // step interval, so at half rate glyphs interpolate across both updates of a step. deltaSeconds
  // is the frame's elapsed time (FrameLoop), for the time-based trail decay.
  render(alpha, deltaSeconds) {
    // Polled here, not in update, which returns early while paused (where Settings swaps happen).
    this.capacitySwap.expire();
    const { device } = this.gpu;
    const encoder = device.createCommandEncoder();
    const interval = this.simulationStepInterval;
    this.frameTimer?.beginSection(encoder);
    this.renderer.render(encoder, {
      alpha: (this.updatesSinceSimulationStep + alpha) / interval,
      interpolate: interval > 1,
      time: this.simulation.time,
      sceneTime: this.sceneSeconds,
      deltaSeconds,
      impulses: this.takeImpulses(),
      scene: this.scene(),
      timeWarp: this.timeWarp.strength,
    });
    this.frameTimer?.endSection(encoder);
    this.frameTimer?.endFrame(encoder);
    device.queue.submit([encoder.finish()]);
    this.renderer.afterSubmit();
    this.frameTimer?.afterFrameSubmit();
  }

  // The capacity swap goes through the game's CapacitySwap: the new simulation is prepared while
  // the old one keeps stepping, then commitCapacity compacts the alive agents and carries
  // registered passes, player state and the stats persistent tail, and the renderer, spawn
  // pressure (keeping its ramp) and score normalization follow. options: neighborRadius and
  // particleCapacity (default: unchanged). One swap at a time; resolves false for an ignored
  // request and rethrows a failed one, leaving the old simulation installed.
  setCapacity(capacity, { neighborRadius, particleCapacity } = {}) {
    return this.capacitySwap.request({ capacity, neighborRadius, particleCapacity });
  }
}
