// The fake gpu, simulation, projectiles, renderer and input every Game scenario shares, with the helpers that drive them.
import { Game } from '../../src/game/game.js';
import { InputState } from '../../src/input/input.js';
import { SPECIES_COUNT, SWARM_HIT_MASK_WORDS } from '../../src/sim/layout.js';

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };

export const STEP = 1 / 60;
export const CAPACITY = 262144;

export function createFakeGpu() {
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
export function createFakeSimulation() {
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
    swarmUploads: [],
    setSwarmShips(ships, radius) { this.swarmUploads.push({ ships: ships.map((ship) => ({ ...ship })), radius, sequence: this.frameSequence + 1 }); },
    setSeekScale(scale) { this.seekScales.push(scale); },
    setSpawnDistanceFraction(fraction) { this.spawnDistanceFractions.push(fraction); },
    worldBoundsCalls: [],
    spawnViewWidths: [],
    setWorldBounds(bounds) { this.worldBoundsCalls.push(bounds); },
    setSpawnViewWidth(width) { this.spawnViewWidths.push(width); },
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
    stepSeconds: [],
    projectileStepSeconds: [],
    step(encoder, deltaSeconds, spawnPerSpecies, spawnGates, projectileDeltaSeconds = deltaSeconds) {
      this.frameSequence += 1;
      this.time += deltaSeconds;
      this.stepSeconds.push(deltaSeconds);
      this.projectileStepSeconds.push(projectileDeltaSeconds);
      this.spawnBudgets.push(Array.from(spawnPerSpecies));
      this.events.push('step');
    },
    afterSubmit() {},
    pollDensity() { this.densityPolls = (this.densityPolls ?? 0) + 1; },
    densityAt(x, y) { this.densitySamples.push([x, y]); return this.densityFunction(x, y); },
    densitySamples: [],
    densityFunction: () => 0,
    readAllStats() {
      const next = this.scriptedStats.shift();
      return next === undefined ? [] : [next];
    },
  };
  return simulation;
}

export function createFakeProjectiles() {
  return {
    spawns: [],
    beams: [],
    clears: 0,
    queueSpawn(spawn) { this.spawns.push(spawn); return this.spawns.length; },
    setBeam(beam) { this.beams.push(beam); },
    clear() { this.clears += 1; },
    cacheClears: 0,
    clearBindGroupCaches() { this.cacheClears += 1; },
    encode() {},
  };
}

export function createFakeRenderer() {
  return {
    frames: [],
    render(encoder, options) { this.frames.push(options); },
    afterSubmit() {},
    setSimulation() {},
  };
}

export function createFakeInput() {
  return { state: new InputState(), update() {} };
}

export async function createGame() {
  const gpu = createFakeGpu();
  const simulation = createFakeSimulation();
  const projectiles = createFakeProjectiles();
  const renderer = createFakeRenderer();
  const input = createFakeInput();
  let seconds = 0;
  // The capacity swap's monotonic millisecond source (its timeout), apart from the game clock.
  let milliseconds = 0;
  const game = await Game.create({
    gpu, simulation, projectiles, renderer, input, capacity: CAPACITY, clock: () => seconds, random: () => 0.5,
    now: () => milliseconds,
  });
  const advanceClock = (deltaSeconds) => { seconds += deltaSeconds; };
  const advanceMilliseconds = (delta) => { milliseconds += delta; };
  return { game, gpu, simulation, projectiles, renderer, input, advanceClock, advanceMilliseconds };
}

// A stats frame as Simulation.readAllStats returns it.
export function stats(fields) {
  return {
    aliveTotal: 1000,
    alivePerSpecies: new Uint32Array(SPECIES_COUNT),
    killsSinceLastRead: 0,
    frameSequence: 1,
    killsUnscored: 0,
    playerHitSequence: 0,
    hitLatch: 0,
    swarmHitMask: new Uint32Array(SWARM_HIT_MASK_WORDS),
    ringsThisFrame: 0,
    lastRingX: 0,
    lastRingY: 0,
    ...fields,
  };
}

export function runFor(game, seconds) {
  const steps = Math.round(seconds / STEP);
  for (let index = 0; index < steps; index += 1) game.update(STEP);
}

export const SWARM_WIPE_MASK = new Uint32Array(SWARM_HIT_MASK_WORDS).fill(0xffffffff);

// Feeds a stats frame from the step this update runs in which every swarm ship was hit (the run's
// one death), and runs that update.
export function hitNow(game, simulation) {
  const sequence = simulation.frameSequence + 1;
  simulation.scriptedStats.push(stats({ frameSequence: sequence, swarmHitMask: SWARM_WIPE_MASK }));
  game.update(STEP);
}

// A hit mask with only these slots set.
export function maskFor(slots) {
  const mask = new Uint32Array(SWARM_HIT_MASK_WORDS);
  for (const slot of slots) mask[Math.floor(slot / 32)] |= (1 << (slot % 32)) >>> 0;
  return mask;
}
