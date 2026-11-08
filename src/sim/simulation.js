// Simulation facade: owns the agent ping-pong buffers, the species table, the SimParams uniform,
// the stats buffer and its staging ring, and runs every compute pass in frame order.
//
// Frame contract, one step per submitted command buffer (params and the spawn budget go through
// queue.writeBuffer, so two steps in one submission would both see the last values):
//   const spawnPerSpecies = spawnPressure.update(deltaSeconds, lastStats, simulation.shares, simulation.frameSequence + 1);
//   simulation.step(encoder, deltaSeconds, spawnPerSpecies);
//   device.queue.submit([encoder.finish()]);
//   simulation.afterSubmit();
//   const stats = simulation.readStats(); // synchronous, null until a ring slot has mapped
// The caller owns the SpawnPressure and feeds it the last stats it read with the sequence of the
// step it requests for, so spawns still in flight are not requested twice. readStats() drains the
// ring and returns the newest ready frame, a few frames behind, so poll it every step.
//
// step order: frameSequence and time advance; params and spawn budget are written; the stats
// buffer's per-frame prefix is cleared (its persistent tail, holding the cumulative kills, the hit
// latch and playerHitSequence, is not), and so are the particle pool's per-step claims; spawn on
// agentsIn (wall band, reading the previous step's blurred coarse field); grid and coarse field on agentsIn; steer agentsIn
// to agentsOut plus integrate; kill-all (only in the step after requestKillAll, or radial after
// requestRadialKill; a kill-all requested in the same step wins); registered passes
// in registration order (registerPass); player contact (once setPlayerState has been called);
// debug kill on agentsOut (skipped when no kill is armed; the arm lasts one step, so callers
// re-arm every frame while the button is held); particle step; stats on agentsOut; copy stats
// into the staging ring; swap, so agentsBuffer is the newest output. So a bomb kills before
// projectiles, and projectiles kill before contact is tested.
//
// Player contact: the GPU latches the first touch (stats playerHitSequence = that frameSequence,
// hitLatch = 1) and reports no further hit until acknowledgeHit(sequence) reaches it; the latch
// clears in the first step whose params carry the acknowledgement. The game acknowledges every
// sequence it reads, accepted or not, and ignores sequences that predate its current respawn.
//
// A registered pass is encodeFunction(encoder, context) with context { agentsBuffer (agentsOut,
// freshly integrated), gridBuffers (built from agentsIn, so cell membership is one step stale),
// fieldBuffers, particlePool, statsBuffer (per-frame prefix cleared this step; kill passes add to
// its cumulative kills index), paramsBuffer, speciesTableBuffer }.
import { StagingRing, createStorageBuffer, createUniformBuffer } from '../gpu/buffers.js';
import { loadShader, substituteConstants } from '../gpu/shaders.js';
import { AgentCompaction } from './compact.js';
import { CoarseField } from './field.js';
import { SpatialGrid } from './grid.js';
import { DebugKillPass, KillAllPass, PlayerContactPass } from './kill.js';
import { DEFAULT_PARTICLE_CAPACITY, ParticlePool } from './particles.js';
import { ARENA_HEIGHT, ARENA_WIDTH, SHADER_CONSTANTS, SPECIES_COUNT, agentBufferBytes, gridDimensions } from './layout.js';
import {
  DEFAULT_KILL_BURST_PARTICLES, DEFAULT_SPAWN_BAND_WIDTH, DEFAULT_SPAWN_DENSITY_BIAS, SIM_PARAMS_BYTES, packSimParams,
  validatedKillBurstParticles, validatedSpawnBandWidth, validatedSpawnDensityBias,
} from './params.js';
import { Spawner } from './spawn.js';
import { defaultMatrix, defaultSpecies, normalizeShares, packSpeciesTable } from './species.js';
import { STATS_BYTES, STATS_PERSISTENT_OFFSET_BYTES, StatsPass, decodeStats } from './stats.js';
import { Steering } from './steer.js';

// PlayerShip's default radius (src/game/player.js).
const DEFAULT_PLAYER_RADIUS = 0.12;

export class Simulation {
  static async create(gpu, {
    capacity,
    neighborRadius = 0.1,
    species = defaultSpecies(),
    matrix = defaultMatrix(),
    shares = normalizeShares(new Array(SPECIES_COUNT).fill(1)),
    particleCapacity = DEFAULT_PARTICLE_CAPACITY,
  }) {
    const agentBytes = agentBufferBytes(capacity);
    if (agentBytes > gpu.limits.maxStorageBufferBindingSize) {
      throw new Error(`Simulation capacity ${capacity} needs ${agentBytes} bytes per agent buffer; this device binds at most ${gpu.limits.maxStorageBufferBindingSize}`);
    }
    const common = substituteConstants(await loadShader('common'), SHADER_CONSTANTS);
    // createBuffer does not throw when memory runs out; it returns an invalid buffer. The scope
    // turns that into a rejection here, before a caller (recreateWithCapacity) touches anything.
    gpu.device.pushErrorScope('out-of-memory');
    const simulation = new Simulation(gpu, { capacity, neighborRadius, species, matrix, shares, particleCapacity }, common);
    const memoryError = await gpu.device.popErrorScope();
    if (memoryError) {
      simulation.destroy();
      throw new Error(`Simulation capacity ${capacity} ran out of GPU memory: ${memoryError.message}`);
    }
    await Promise.all([
      simulation.grid.initialize(),
      simulation.field.initialize(),
      simulation.steering.initialize(),
      simulation.spawner.initialize(),
      simulation.statsPass.initialize(),
      simulation.killPass.initialize(),
      simulation.killAllPass.initialize(),
      simulation.playerContactPass.initialize(),
      simulation.particlePoolValue.initialize(),
    ]);
    return simulation;
  }

  // Use Simulation.create; the constructor only allocates.
  constructor(gpu, { capacity, neighborRadius, species, matrix, shares, particleCapacity }, common) {
    this.gpu = gpu;
    this.device = gpu.device;
    this.common = common;
    this.capacityValue = capacity;
    this.neighborRadius = neighborRadius;
    this.dimensions = gridDimensions(neighborRadius);
    this.grid = new SpatialGrid(gpu, { columns: this.dimensions.columns, rows: this.dimensions.rows, capacity, common });
    this.field = new CoarseField(gpu, { grid: this.grid, common });
    this.steering = new Steering(gpu, { common });
    this.spawner = new Spawner(gpu, { common });
    this.statsPass = new StatsPass(gpu, { common });
    this.killPass = new DebugKillPass(gpu, { common });
    this.killAllPass = new KillAllPass(gpu, { common });
    this.playerContactPass = new PlayerContactPass(gpu, { common });
    this.particlePoolValue = new ParticlePool(gpu, { capacity: particleCapacity, common });
    // New buffers are zero-filled, so every slot starts dead.
    this.agentBuffers = [0, 1].map((index) => createStorageBuffer(this.device, agentBufferBytes(capacity), 'agents-' + index));
    this.inputIndex = 0;
    this.speciesTableBufferValue = createStorageBuffer(this.device, packSpeciesTable(species, matrix).byteLength, 'species-table');
    this.paramsBufferValue = createUniformBuffer(this.device, SIM_PARAMS_BYTES, 'sim-params');
    this.statsBufferValue = createStorageBuffer(this.device, STATS_BYTES, 'stats');
    this.stagingRing = new StagingRing(this.device, STATS_BYTES);
    this.playerPosition = [ARENA_WIDTH / 2, ARENA_HEIGHT / 2];
    // Contact is off until the first setPlayerState, so the Plan A demo's pointer never hits.
    this.playerContact = null;
    this.acknowledgedHitSequence = 0;
    this.killAllRequested = false;
    // { x, y, radius } for the next step's radial kill (the pickup blast), or null.
    this.radialKill = null;
    this.debugKillPosition = [0, 0];
    this.debugKillRadius = 0;
    this.frameSequenceValue = 0;
    this.timeValue = 0;
    this.lastKillsTotal = 0;
    this.sameSpeciesCohesion = true;
    // Multiplier on every species' seek weight; the game sets it from SpawnPressure every step.
    this.seekScale = 1;
    // Minimum spawn distance from the player, a fraction of the arena width (also from SpawnPressure).
    this.spawnDistanceFraction = 0.25;
    // Lab knobs (task C0b): particles per kill, wall band depth and spawn density bias.
    this.killBurstParticles = DEFAULT_KILL_BURST_PARTICLES;
    this.spawnBandWidth = DEFAULT_SPAWN_BAND_WIDTH;
    this.spawnDensityBias = DEFAULT_SPAWN_DENSITY_BIAS;
    this.registeredPasses = [];
    this.setSpecies(species, matrix);
    this.setShares(shares);
  }

  get capacity() { return this.capacityValue; }
  get agentsBuffer() { return this.agentBuffers[this.inputIndex]; }
  // The last step's input (with that step's spawns), so the glyph pass can interpolate from it
  // to agentsBuffer at half simulation rate. Zero-filled until a new instance's first step.
  get previousAgentsBuffer() { return this.agentBuffers[1 - this.inputIndex]; }
  get fieldBuffer() { return this.field.buffers.blurred; }
  get statsBuffer() { return this.statsBufferValue; }
  get gridBuffers() { return this.grid.buffers; }
  get particlePool() { return this.particlePoolValue; }
  get speciesTableBuffer() { return this.speciesTableBufferValue; }
  get paramsBuffer() { return this.paramsBufferValue; }
  get frameSequence() { return this.frameSequenceValue; }
  get time() { return this.timeValue; }
  get shares() { return this.sharesValue; }

  // Moves the player (the seek target) without touching the contact state.
  setPlayer(x, y) {
    this.playerPosition = [x, y];
  }

  // Moves the player and turns contact on with this radius and invulnerability; the game calls
  // it every step.
  setPlayerState({ x, y, radius = DEFAULT_PLAYER_RADIUS, invulnerable = false }) {
    this.playerPosition = [x, y];
    this.playerContact = { radius, invulnerable: Boolean(invulnerable) };
  }

  // Releases the hit latch once the GPU's playerHitSequence is at or below frameSequence. Never
  // moves backwards.
  acknowledgeHit(frameSequence) {
    this.acknowledgedHitSequence = Math.max(this.acknowledgedHitSequence, frameSequence);
  }

  // Kills every agent, spawning ones included, in the next step only; those kills land in
  // killsUnscored.
  requestKillAll() {
    this.killAllRequested = true;
  }

  // Kills every agent within radius of (x, y), spawning ones included, in the next step only,
  // through the kill-all pass; those kills land in killsUnscored. A later request in the same
  // step replaces it, and a kill-all requested for that step wins over it.
  requestRadialKill(x, y, radius) {
    this.radialKill = { x, y, radius };
  }

  // Arms a kill for the next step only (step consumes it); radius 0 disarms.
  setDebugKill(x, y, radius) {
    this.debugKillPosition = [x, y];
    this.debugKillRadius = radius;
  }

  setSpecies(rows, matrix) {
    this.species = rows;
    this.matrix = matrix;
    this.device.queue.writeBuffer(this.speciesTableBufferValue, 0, packSpeciesTable(rows, matrix));
  }

  // Adds encodeFunction(encoder, context) to every step after integrate and before the debug
  // kill (see the header for context). Returns a function that removes it; the list is shared
  // with instances built by recreateWithCapacity, so the remover keeps working after a rebuild.
  registerPass(encodeFunction) {
    const passes = this.registeredPasses;
    passes.push(encodeFunction);
    return () => {
      const index = passes.indexOf(encodeFunction);
      if (index !== -1) passes.splice(index, 1);
    };
  }

  setSameSpeciesCohesion(enabled) {
    this.sameSpeciesCohesion = Boolean(enabled);
  }

  setShares(shares) {
    this.sharesValue = normalizeShares(shares);
  }

  // scale multiplies every species' seek weight from the next step on (1 is full seek).
  setSeekScale(scale) {
    this.seekScale = scale;
  }

  // Spawns from the next step on land at least fraction * ARENA_WIDTH from the player.
  setSpawnDistanceFraction(fraction) {
    this.spawnDistanceFraction = fraction;
  }

  // Particles per kill from the next step on, an integer in [0, MAXIMUM_KILL_BURST_PARTICLES]
  // (params.js); the kill passes scale bursts down only when a step's kills outrun the free
  // particle slots. Throws RangeError and changes nothing when out of range.
  setKillBurstParticles(count) {
    this.killBurstParticles = validatedKillBurstParticles(count);
  }

  // Depth in world units of the wall band new agents spawn in, in (0, ARENA_HEIGHT / 2]; half the
  // arena height spawns anywhere. Throws RangeError when out of range.
  setSpawnBandWidth(width) {
    this.spawnBandWidth = validatedSpawnBandWidth(width);
  }

  // 0 to 1: the chance a spawn takes the densest of its candidate positions. Throws RangeError
  // when out of range.
  setSpawnDensityBias(bias) {
    this.spawnDensityBias = validatedSpawnDensityBias(bias);
  }

  // spawnPerSpecies: SPECIES_COUNT counts for this frame, usually from SpawnPressure.update.
  step(encoder, deltaSeconds, spawnPerSpecies = new Uint32Array(SPECIES_COUNT)) {
    this.frameSequenceValue += 1;
    this.timeValue += deltaSeconds;
    this.writeParams(deltaSeconds, spawnPerSpecies);
    const killRadius = this.debugKillRadius;
    this.debugKillRadius = 0;
    const killAll = this.killAllRequested;
    const radialKill = killAll ? null : this.radialKill;
    this.killAllRequested = false;
    this.radialKill = null;
    this.spawner.writeBudget(spawnPerSpecies);
    encoder.clearBuffer(this.statsBufferValue, 0, STATS_PERSISTENT_OFFSET_BYTES);
    this.particlePoolValue.encodeBeginStep(encoder);
    const agentsIn = this.agentBuffers[this.inputIndex];
    const agentsOut = this.agentBuffers[1 - this.inputIndex];
    const params = this.paramsBufferValue;
    this.spawner.encode(encoder, agentsIn, params, this.field.buffers.blurred);
    this.grid.encode(encoder, agentsIn, params);
    this.field.encode(encoder, agentsIn, this.grid.buffers, params);
    this.steering.encode(encoder, agentsIn, agentsOut, this.grid.buffers, this.field.buffers.blurred, this.speciesTableBufferValue, params);
    const killBuffers = {
      agentsBuffer: agentsOut,
      statsBuffer: this.statsBufferValue,
      particleBuffers: this.particlePoolValue.buffers,
      threatAccumulator: this.field.buffers.threatAccumulator,
      speciesTableBuffer: this.speciesTableBufferValue,
      paramsBuffer: params,
    };
    if (killAll || radialKill !== null) this.killAllPass.encode(encoder, killBuffers, radialKill);
    if (this.registeredPasses.length > 0) {
      const context = {
        agentsBuffer: agentsOut,
        gridBuffers: this.grid.buffers,
        fieldBuffers: this.field.buffers,
        particlePool: this.particlePoolValue,
        statsBuffer: this.statsBufferValue,
        paramsBuffer: params,
        speciesTableBuffer: this.speciesTableBufferValue,
      };
      this.registeredPasses.forEach((encodeFunction) => encodeFunction(encoder, context));
    }
    if (this.playerContact !== null) this.playerContactPass.encode(encoder, { ...killBuffers, gridBuffers: this.grid.buffers });
    if (killRadius > 0) this.killPass.encode(encoder, killBuffers);
    this.particlePoolValue.encodeStep(encoder, params);
    this.statsPass.encode(encoder, agentsOut, this.statsBufferValue, params);
    this.stagingRing.copyFrom(encoder, this.statsBufferValue);
    this.inputIndex = 1 - this.inputIndex;
  }

  // Queues the SimParams uniform for the current state (step, and commitCapacity with dt 0).
  writeParams(deltaSeconds, spawnPerSpecies) {
    this.device.queue.writeBuffer(this.paramsBufferValue, 0, packSimParams({
      dt: deltaSeconds,
      time: this.timeValue,
      playerPosition: this.playerPosition,
      neighborRadius: this.neighborRadius,
      gridColumns: this.dimensions.columns,
      gridRows: this.dimensions.rows,
      cellSize: this.dimensions.cellSize,
      capacity: this.capacityValue,
      debugKillPosition: this.debugKillPosition,
      debugKillRadius: this.debugKillRadius,
      spawnPerSpecies: Array.from(spawnPerSpecies),
      frameSequence: this.frameSequenceValue,
      sameSpeciesCohesion: this.sameSpeciesCohesion ? 1 : 0,
      seekScale: this.seekScale,
      spawnDistanceFraction: this.spawnDistanceFraction,
      killBurstParticles: this.killBurstParticles,
      spawnBandWidth: this.spawnBandWidth,
      spawnDensityBias: this.spawnDensityBias,
      playerRadius: this.playerContact?.radius ?? 0,
      playerInvulnerable: this.playerContact?.invulnerable ? 1 : 0,
      acknowledgedHitSequence: this.acknowledgedHitSequence,
      killAllRequested: this.killAllRequested || this.radialKill !== null ? 1 : 0,
    }));
  }

  // Call immediately after device.queue.submit for the command buffer that holds step().
  afterSubmit() {
    this.stagingRing.markSubmitted();
  }

  // Synchronous: every ready frame's stats, oldest first (empty when none has mapped yet). Each
  // carries killsSinceLastRead, the kills since the previous frame this instance returned (the
  // difference of the cumulative GPU counter), so no kill is lost to a skipped readback.
  readAllStats() {
    return this.stagingRing.readAll().map((bytes) => {
      const stats = decodeStats(bytes);
      stats.killsSinceLastRead = (stats.killsTotal - this.lastKillsTotal) >>> 0;
      this.lastKillsTotal = stats.killsTotal;
      return stats;
    });
  }

  // Synchronous: drains every ready frame and returns the newest one's stats, with
  // killsSinceLastRead summed over all of them; null when no ring slot has mapped yet.
  readStats() {
    const frames = this.readAllStats();
    if (frames.length === 0) return null;
    const newest = frames[frames.length - 1];
    return { ...newest, killsSinceLastRead: frames.reduce((sum, stats) => sum + stats.killsSinceLastRead, 0) };
  }

  // Builds a Simulation with the same settings at newCapacity (and optionally a new neighbor
  // radius, so grid resolution, and particle budget), carries the alive agents over and destroys
  // this one: prepareCapacity then commitCapacity. On a rejection (allocation or pipeline
  // failure) this instance is untouched and still usable.
  async recreateWithCapacity(newCapacity, options = {}) {
    return this.commitCapacity(await this.prepareCapacity(newCapacity, options));
  }

  // The slow half of a capacity change: allocates the new instance and builds every pipeline,
  // including the compaction one. This instance may keep stepping meanwhile; nothing is copied
  // yet. Resolves with a prepared change for commitCapacity (or discardCapacity).
  async prepareCapacity(newCapacity, { neighborRadius = this.neighborRadius, particleCapacity = this.particlePoolValue.capacity } = {}) {
    const next = await Simulation.create(this.gpu, {
      capacity: newCapacity,
      neighborRadius,
      species: this.species,
      matrix: this.matrix,
      shares: this.sharesValue,
      particleCapacity,
    });
    try {
      const compaction = await AgentCompaction.create(this.gpu, { common: this.common });
      return { next, compaction };
    } catch (error) {
      next.destroy();
      throw error;
    }
  }

  // Releases a prepared change that will not be committed.
  discardCapacity({ next, compaction }) {
    next.destroy();
    compaction.destroy();
  }

  // The fast half, synchronous: encodes the copy of this instance's newest state into the
  // prepared instance, submits it, carries the CPU state and destroys this instance. Queue order
  // puts the copy after every step already submitted and before any step of the new instance, so
  // no await is needed and no frame is skipped; WebGPU defers freeing the destroyed buffers until
  // the submitted copy has finished with them. The caller must step only the returned instance
  // from here on.
  // The alive agents are compacted into the first slots of the new buffer: the grid is rebuilt on
  // the newest agents and compact.wgsl copies its listed agents in grid order, so a shrink keeps
  // every alive agent that fits. The stats persistent tail (cumulative kills, hit latch and
  // playerHitSequence) is copied too, and lastKillsTotal carries, so kills in stats frames this
  // instance never read back are counted by the new instance's first read. Registered passes,
  // player state, acknowledged hit sequence, a pending kill-all, species, matrix, shares, seek
  // scale, spawn distance, kill burst size, spawn band, density bias and the cohesion mode carry
  // over, read now so edits made while the
  // change was prepared are not lost. Live particles are not copied. The same submission builds
  // the new instance's grid and coarse field on the copied agents (with its params at dt 0), so
  // the renderer can draw it before its first step. Stats resume after the new instance's next
  // step.
  commitCapacity({ next, compaction }) {
    this.carryStateInto(next);
    const nextAgents = next.agentBuffers[next.inputIndex];
    next.writeParams(0, new Uint32Array(SPECIES_COUNT));
    const encoder = this.device.createCommandEncoder({ label: 'simulation-recreate' });
    this.grid.encode(encoder, this.agentsBuffer, this.paramsBufferValue);
    compaction.encode(encoder, {
      paramsBuffer: this.paramsBufferValue,
      gridBuffers: this.grid.buffers,
      agentsIn: this.agentsBuffer,
      agentsOut: nextAgents,
      targetCapacity: next.capacity,
    });
    encoder.copyBufferToBuffer(this.statsBufferValue, STATS_PERSISTENT_OFFSET_BYTES, next.statsBufferValue, STATS_PERSISTENT_OFFSET_BYTES, STATS_BYTES - STATS_PERSISTENT_OFFSET_BYTES);
    next.grid.encode(encoder, nextAgents, next.paramsBufferValue);
    next.field.encode(encoder, nextAgents, next.grid.buffers, next.paramsBufferValue);
    this.device.queue.submit([encoder.finish()]);
    compaction.destroy();
    this.destroy();
    return next;
  }

  carryStateInto(next) {
    next.setSpecies(this.species, this.matrix);
    next.setShares(this.sharesValue);
    next.setSameSpeciesCohesion(this.sameSpeciesCohesion);
    next.setSeekScale(this.seekScale);
    next.setSpawnDistanceFraction(this.spawnDistanceFraction);
    next.setKillBurstParticles(this.killBurstParticles);
    next.setSpawnBandWidth(this.spawnBandWidth);
    next.setSpawnDensityBias(this.spawnDensityBias);
    next.registeredPasses = this.registeredPasses;
    next.frameSequenceValue = this.frameSequenceValue;
    next.timeValue = this.timeValue;
    next.setPlayer(...this.playerPosition);
    next.playerContact = this.playerContact === null ? null : { ...this.playerContact };
    next.acknowledgedHitSequence = this.acknowledgedHitSequence;
    // The kills counter came over with the tail, so differences continue from the last read.
    next.lastKillsTotal = this.lastKillsTotal;
    next.killAllRequested = this.killAllRequested;
    next.radialKill = this.radialKill === null ? null : { ...this.radialKill };
    next.setDebugKill(...this.debugKillPosition, this.debugKillRadius);
  }

  // Browser checks only, never the game loop: resolves with a copy of the blurred coarse field as
  // a Float32Array of COARSE_COLUMNS * COARSE_ROWS cells, COARSE_CHANNELS floats each (species
  // densities 0..4, threat, padding), as of the last submitted step.
  async readCoarseField() {
    const source = this.field.buffers.blurred;
    const staging = this.device.createBuffer({ label: 'coarse-field-readback', size: source.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder({ label: 'coarse-field-readback' });
    encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(staging.getMappedRange().slice(0));
    staging.destroy();
    return values;
  }

  // Destroys every GPU buffer this instance created, including the passes' internal buffers.
  destroy() {
    this.agentBuffers.forEach((buffer) => buffer.destroy());
    [this.speciesTableBufferValue, this.paramsBufferValue, this.statsBufferValue].forEach((buffer) => buffer.destroy());
    this.stagingRing.destroy();
    this.spawner.destroy();
    this.killAllPass.destroy();
    this.particlePoolValue.destroy();
    this.grid.destroy();
    this.field.destroy();
  }
}
