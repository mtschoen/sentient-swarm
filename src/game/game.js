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
//      edge that run.useBomb accepts calls simulation.requestRadialKill before this step (around
//      the swarm centroid, bombRadiusForView of the view; a start and the death clear stay
//      world-wide kill-alls), so the bomb kills before projectiles and contact.
//   2. player.update (Playing only), with mouse aim derived as pointerWorld minus the player; with
//      the beam armed the aim turns at most beamTurnRevolutionsPerSecond (0 is instant). After the
//      swarm moves, followCamera eases the camera toward cameraFocus (the point and the swarm
//      centroid; held still while watching); a start, a quit and a respawn cut it there.
//   3. pickups.update, then collect at the player into weapons.collect (before charge expiry; a
//      rail pickup adds a turret and leaves the armed weapon alone, owner ruling R29); a
//      collection plays the pickup effect and, with pickupBlastRadius above 0, fires the pickup
//      blast (owner ruling R22): simulation.requestRadialKill at the ship for this step (unscored,
//      like a bomb) and a PICKUP_BLAST_IMPULSE_STRENGTH shockwave; with the blast off it queues
//      the smaller PICKUP_IMPULSE_STRENGTH impulse instead. A time warp pickup (owner ruling R31)
//      leaves the weapons alone: it starts or extends timeWarp, plays pickup('timewarp') and its
//      shockwave is the larger TIME_WARP_IMPULSE_STRENGTH (the blast still fires).
//   4. weapons.update (the armed kind, tier, charge and cue cadence; its own volley spawns are not
//      queued); SwarmFire fires one projectile per ship shot from the ships by the armed recipe and
//      the rate law, and its shots and then the rail turrets' spawns go to
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
// point, which moves as the ship did and cannot be hit); SwarmFire fires step 4's shots from the
// ships, and step 6 uploads the swarm for the contact pass (Simulation.setSwarmShips).
//   8. run.update drains this step's actions: clearArena requests the kill-all for the next step
//      (with the death flood) and clears projectiles, shockwave (bomb and death) queues an impulse
//      that also boosts bloom, respawn recenters the player, sets the respawn sequence to the next
//      step and resets spawn pressure and the spawn director; gameOver leaves the run frozen until
//      restart.
// Seats: the game runs one or two PlayerSeats (setPlayerCount, Ready only; the page seats one until
// the join screen). Every step above runs per seat in seat order, each reading its own input (input.state
// for seat 1, input.seatTwoState for seat 2): either seat's gesture starts or restarts the run, and
// either seat's bomb press spends the shared pool around its own swarm. Both seats' contact tables
// and seek points reach the simulation (src/game/seats.js); with one seat the calls are exactly the
// solo ones. A seat wiped while another still has ships goes down; the run's one death is the last
// seat falling. Kills score once and grow every seat still in the run.
// Watch mode (the lab, task C6b): setWatch(fraction) puts the run in Ready and keeps it there (no
// gesture starts it, so weapons and contact stay off); the player point follows the pointer (or
// the move stick without one) so the swarm chases it, and a watch SpawnPressure with full seek
// holds the alive target at fraction of capacity in place of the play ramp. setWatch(null) leaves
// it; start() (the lab's Play) leaves it too.
import { Projectiles } from './projectiles.js';
import { PlayerSeat, SWARM_PICKUP_RADIUS } from './player-seat.js';
import { DEFAULT_BEAM_TURN_REVOLUTIONS_PER_SECOND, MAXIMUM_BEAM_TURN_REVOLUTIONS_PER_SECOND } from './weaponTypes.js';
import { PickupDirector } from './pickups.js';
import { Awards, ScoreKeeper } from './score.js';
import { RunPhase, RunState } from './run.js';
import { CapacitySwap } from './capacity-swap.js';
import { TimeWarp } from './time-warp.js';
import { INITIAL_SWARM_SHIPS, MAXIMUM_SWARM_SHIPS } from './player-swarm.js';
import { SpawnPressure } from '../sim/spawner.js';
import { createWatchPressure, moveWatchPoint } from './watch.js';
import { SpawnDirector } from '../sim/spawn-director.js';
import { MAXIMUM_PLAYER_SEATS, SPECIES_COUNT, VIEW_HEIGHT, VIEW_WIDTH, WORLD_BOUNDS, WORLD_HEIGHT, WORLD_WIDTH, viewSizeForAspect } from '../sim/layout.js';
import { Camera, bombRadiusForView, framingCenter } from './camera.js';
import { applySwarmHits, fireSeats, framedFocuses, gameSeekTargets, partnerFor, pickupAnchor, primarySeat, seatStarts, uploadSwarms } from './seats.js';

const NO_SPAWNS = new Uint32Array(SPECIES_COUNT);
// Warp grid impulse strengths; bomb and death shockwaves carry their own (1) from RunState.
const RING_IMPULSE_STRENGTH = 0.3;
const PICKUP_IMPULSE_STRENGTH = 0.15;
const PICKUP_BLAST_IMPULSE_STRENGTH = 0.5;
const TIME_WARP_IMPULSE_STRENGTH = 0.6;
export const DEFAULT_PICKUP_BLAST_RADIUS = 1.5;
// Player swarm spike: a swarm ship collects pickups this close; the run has one life, lost when
// the last swarm ship (of the last seat) dies, so the death clear and game over follow.
export { SWARM_PICKUP_RADIUS };
const SWARM_RUN_LIVES = 1;

function createRunState() {
  return new RunState({ lives: SWARM_RUN_LIVES });
}
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
    // playable rectangle: the whole world, at every aspect.
    this.viewSize = viewSizeForAspect(VIEW_WIDTH / VIEW_HEIGHT);
    this.worldBounds = WORLD_BOUNDS;
    // The renderer draws around this camera (Viewport.setCamera with camera.sample); followCamera
    // moves it every update.
    this.camera = new Camera({ centerX: WORLD_WIDTH / 2, centerY: WORLD_HEIGHT / 2 });
    // One seat per player; the first is the solo player.
    this.random = random;
    this.seats = [new PlayerSeat({ index: 0, random, bounds: this.worldBounds })];
    // The seat whose swarm was wiped last (where the death flood appears), and seats a debug hook made invulnerable.
    this.lastWipedSeat = null;
    this.debugInvulnerableSeats = new Set();
    this.pickups = new PickupDirector({ random, bounds: this.worldBounds });
    this.score = new ScoreKeeper({ capacity });
    this.awards = new Awards();
    this.run = createRunState();
    // The player swarm replaces the ship: the ship's position is the controlled point it seeks.
    this.initialSwarmShips = INITIAL_SWARM_SHIPS;
    this.seats[0].reset(this.initialSwarmShips);
    this.fireLog = null;
    this.latestStats = null;
    // This update's read-back stats (the newest frame, kills summed over every frame read), or null.
    this.freshStats = null;
    // Both only grow: stats frames and hit sequences are monotonic across respawns and restarts.
    this.lastScoredFrameSequence = 0;
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

  // The first seat's modules: the solo player (browser checks and the lab read these names).
  get player() { return this.seats[0].player; }
  get swarm() { return this.seats[0].swarm; }
  get swarmFire() { return this.seats[0].swarmFire; }
  get weapons() { return this.seats[0].weapons; }
  get swarmControls() { return this.seats[0].swarmControls; }
  get firingHeld() { return this.seats[0].firingHeld; }
  set firingHeld(held) { this.seats[0].firingHeld = held; }
  get bombHeld() { return this.seats[0].bombHeld; }
  set bombHeld(held) { this.seats[0].bombHeld = held; }

  get state() {
    return {
      score: this.score.score,
      multiplier: this.score.multiplier,
      ...this.seats[0].hudFields(),
      seats: this.seats.map((seat) => seat.stateEntry()),
      bombs: this.run.bombs,
      timeWarp: this.timeWarp.fraction,
      offeredType: this.pickups.offeredType,
      phase: this.paused ? 'paused' : this.run.phase,
      aliveTotal: this.latestStats?.aliveTotal ?? 0,
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
    this.seats.forEach((seat) => { seat.bombHeld = true; });
  }

  get playerCount() {
    return this.seats.length;
  }

  // One or two seats, changed only in Ready. Two seats start either side of the arena center; the
  // simulation's second seek point and contact table follow the seat count.
  setPlayerCount(count) {
    if (!(count === 1 || count === MAXIMUM_PLAYER_SEATS)) throw new RangeError(`player count must be 1 or ${MAXIMUM_PLAYER_SEATS}, got ${count}`);
    if (this.run.phase !== RunPhase.Ready) throw new Error('the player count changes only in Ready');
    if (count === this.seats.length) return;
    if (count === 2) {
      this.seats.push(new PlayerSeat({ index: 1, random: this.random, bounds: this.worldBounds }));
      this.projectiles.setBeamSlotCount(count);
    } else this.removeSecondSeat();
    this.placeSeats();
  }

  removeSecondSeat() {
    this.seats.length = 1;
    this.simulation.clearSecondPlayer();
    this.simulation.clearSwarmShips(1);
    this.projectiles.setBeamSlotCount(1);
  }

  // Every seat back at its start with the initial swarm, and the camera cut onto them.
  placeSeats() {
    const starts = seatStarts(this.seats.length, this.worldBounds);
    this.seats.forEach((seat, index) => seat.reset(this.initialSwarmShips, starts[index]));
    this.followCamera(0, { cut: true });
  }

  // Back to the title: every module reset and the run in Ready again (the arena is cleared once,
  // the swarm keeps running behind the menu). Sequence guards stay monotonic as in beginRun.
  quitToTitle() {
    this.paused = false;
    if (this.seats.length > 1) this.removeSecondSeat();
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
    if (this.seats.length > 1) this.removeSecondSeat();
    const previous = this.watchPressure;
    const next = createWatchPressure(this.capacity, fraction, previous);
    if (previous === null) {
      this.paused = false;
      this.resetModules();
      this.run = createRunState();
    }
    this.watchPressure = next;
  }

  // The view's { width, height } for the canvas aspect (Viewport.viewSize, on every resize): the
  // camera frames it, spawn gates ring it, pickups place within reach of it, the bomb clears around
  // it and spawns keep their distance as a fraction of its width. The world bounds and the alive
  // target do not depend on it, so every aspect plays the same world with the same count.
  setView({ width, height }) {
    this.viewSize = { width, height };
    this.simulation.setSpawnViewWidth(width);
    this.pickups.setView(width, height);
  }

  // The camera's view: { centerX, centerY, width, height } in world units.
  get view() {
    return { centerX: this.camera.centerX, centerY: this.camera.centerY, width: this.viewSize.width, height: this.viewSize.height };
  }

  // What the camera frames: the swarm (cameraFocus) unless watching, where it holds still so the
  // pointer-driven point cannot drag it. cut (run start, respawn, quit) jumps there with no easing.
  followCamera(deltaSeconds, { cut = false } = {}) {
    const focus = framingCenter(framedFocuses(this.seats));
    const view = { viewWidth: this.viewSize.width, viewHeight: this.viewSize.height, bounds: this.worldBounds };
    if (cut) this.camera.cut(focus.x, focus.y, view);
    else if (!this.watching) this.camera.update(deltaSeconds, { focusX: focus.x, focusY: focus.y, ...view });
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
    for (const seat of this.seats) {
      seat.bombHeld = true;
      seat.firingHeld = true;
    }
  }

  resetModules() {
    this.score.reset();
    this.awards = new Awards();
    this.pickups.reset();
    this.lastWipedSeat = null;
    const starts = seatStarts(this.seats.length, this.worldBounds);
    this.seats.forEach((seat, index) => seat.reset(this.initialSwarmShips, starts[index]));
    this.followCamera(0, { cut: true });
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
    const { seats } = this;
    const inputs = seats.map((seat) => this.inputFor(seat));
    const firingPressed = seats.map((seat, index) => seat.firingEdge(inputs[index]));
    if (this.run.phase === RunPhase.Ready && this.startsOnGesture && !this.watching && inputs.some(isGesture)) this.start();
    else if (this.run.phase === RunPhase.GameOver) {
      this.updateGameOver(deltaSeconds, seats.some((seat, index) => firingPressed[index] || (inputs[index].bomb && !seat.bombHeld)));
    }

    seats.forEach((seat, index) => {
      const pressed = seat.bombEdge(inputs[index]);
      if (pressed && !seat.down && this.run.useBomb(seat.point)) {
        // The bomb clears around the swarm out past the view's corners (bombRadiusForView), not the whole world.
        const center = seat.aliveCount > 0 ? seat.centroid : seat.point;
        this.simulation.requestRadialKill(center.x, center.y, bombRadiusForView(this.viewSize.width, this.viewSize.height));
        this.effects?.bomb();
      }
    });

    const playing = this.run.phase === RunPhase.Playing;
    const controls = seats.map((seat, index) => seat.controlsFrom(inputs[index]));
    seats.forEach((seat, index) => {
      if (seat.down) return;
      if (playing) seat.steer(deltaSeconds, controls[index], { beamTurnRevolutionsPerSecond: this.beamTurnRevolutionsPerSecondValue });
      else if (this.watching) moveWatchPoint(seat.player, deltaSeconds, inputs[index], controls[index]);
      seat.flock(deltaSeconds, playing && controls[index].firing);
    });
    this.followCamera(deltaSeconds);

    const anchor = pickupAnchor(seats);
    this.pickups.update(deltaSeconds, {
      playerX: anchor.x,
      playerY: anchor.y,
      onBaseGun: seats.every((seat) => seat.down || seat.weapons.isBase),
      milestone: playing && this.score.consumeMilestone(),
      phasePlaying: playing,
      densityAt: this.densityAt,
    });
    if (playing) seats.forEach((seat) => { if (!seat.down) this.collectFor(seat); });

    fireSeats(this, deltaSeconds, playing, inputs, controls);

    const targets = gameSeekTargets(this);
    if (this.run.phase === RunPhase.Ready) {
      this.simulation.setPlayer(targets.primary.x, targets.primary.y);
    } else {
      this.simulation.setPlayerState({ x: targets.primary.x, y: targets.primary.y, radius: this.player.radius, invulnerable: !playing || this.run.invulnerable || this.debugInvulnerableValue });
    }
    if (seats.length > 1) {
      if (targets.secondary !== null) this.simulation.setSecondPlayer(targets.secondary.x, targets.secondary.y);
      else this.simulation.clearSecondPlayer();
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
      uploadSwarms(this);
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

  // Seat 1 reads the first input state, seat 2 its own.
  inputFor(seat) {
    return seat.index === 0 ? this.input.state : this.input.seatTwoState;
  }

  // A pickup at this seat: its weapon (or the global time warp), the blast and the shockwave.
  collectFor(seat) {
    const collected = seat.collectPickup(this.pickups);
    if (collected === null) return;
    const { x, y } = seat.point;
    // Only a two-seat game tells the effect which seat collected.
    const seatArguments = this.seats.length > 1 ? [seat.index] : [];
    const timeWarp = collected === 'timewarp';
    if (timeWarp) {
      this.timeWarp.start();
      this.effects?.pickup?.('timewarp', ...seatArguments);
    } else {
      seat.weapons.collect(collected);
      this.effects?.pickup?.(...(seatArguments.length > 0 ? [undefined, ...seatArguments] : []));
    }
    const blast = this.pickupBlastRadiusValue > 0;
    if (blast) this.simulation.requestRadialKill(x, y, this.pickupBlastRadiusValue);
    const strength = blast ? PICKUP_BLAST_IMPULSE_STRENGTH : PICKUP_IMPULSE_STRENGTH;
    this.queueImpulse(x, y, timeWarp ? TIME_WARP_IMPULSE_STRENGTH : strength, false);
  }

  // Gamepad and keyboard restart: a fresh fire or bomb press once the guard window has passed.
  updateGameOver(deltaSeconds, pressed) {
    this.gameOverSeconds += deltaSeconds;
    if (pressed && this.gameOverSeconds > RESTART_GUARD_SECONDS) this.restart();
  }

  // No spawns and no gates between death and respawn: the arena stays clear for the pause.
  spawnCounts(deltaSeconds) {
    const phase = this.run.phase;
    const pressure = this.activeSpawnPressure;
    this.stepGates = null;
    if (phase === RunPhase.Dying || phase === RunPhase.Respawning) return NO_SPAWNS;
    const primary = primarySeat(this.seats);
    this.spawnDirector.update(deltaSeconds, {
      playerX: primary.point.x,
      playerY: primary.point.y,
      safeDistance: pressure.spawnDistanceFraction * this.viewSize.width,
      bounds: this.worldBounds,
      // Gates open in a ring just outside what the camera shows.
      view: this.view,
      filling: pressure.filling,
      shares: this.simulation.shares,
      // The Ready arena (before a run) trickles from every gate; waves start with the run.
      continuous: phase === RunPhase.Ready,
      // Waves avoid the gates in the player's aim lane (the lane being shot open).
      aimX: primary.player.aim.x,
      aimY: primary.player.aim.y,
      partner: partnerFor(this.seats),
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
        // Kills grow every swarm still in the run; award lives are superseded by it, bombs stay.
        for (const seat of this.seats) if (!seat.down) seat.swarm.addKills(stats.killsSinceLastRead);
        const earned = this.awards.update(this.score.score);
        for (let index = 0; index < earned.bombs; index += 1) this.run.addBomb();
      }
    }
    if (this.run.phase === RunPhase.Playing) applySwarmHits(this, stats);
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
        this.followCamera(0, { cut: true });
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
  // alpha is FrameLoop's fraction of an update, the one the camera samples with: the ships and the
  // point are drawn extrapolated by it so they agree with the camera.
  scene(alpha = 0) {
    const hidden = [RunPhase.Dying, RunPhase.Respawning, RunPhase.GameOver].includes(this.run.phase);
    const pointShown = this.run.phase === RunPhase.Playing;
    const swarms = hidden ? [] : this.seats.filter((seat) => !seat.down).map((seat) => seat.sceneEntry(alpha, this.camera.lastDeltaSeconds, pointShown));
    return {
      projectiles: this.projectiles,
      pickups: this.pickups.pickups,
      ship: null,
      swarm: swarms[0] ?? null,
      swarms,
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

  // A FireLog (src/game/fire-log.js) sampled every update, or null for none.
  setFireLog(fireLog) {
    this.fireLog = fireLog;
  }

  setInitialSwarmShips(count) {
    if (!(Number.isInteger(count) && count >= 1 && count <= MAXIMUM_SWARM_SHIPS)) throw new RangeError(`initial swarm ships must be an integer in [1, ${MAXIMUM_SWARM_SHIPS}], got ${count}`);
    this.initialSwarmShips = count;
    this.seats.forEach((seat) => seat.swarm.reset(seat.point.x, seat.point.y, count));
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
  // With a seat index only that seat's contact upload is invulnerable (two seats); null is every seat.
  debugInvulnerable(enabled, seat = null) {
    if (seat === null) {
      this.debugInvulnerableValue = Boolean(enabled);
      if (!enabled) this.debugInvulnerableSeats.clear();
    } else if (enabled) this.debugInvulnerableSeats.add(seat);
    else this.debugInvulnerableSeats.delete(seat);
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
      scene: this.scene(alpha),
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
