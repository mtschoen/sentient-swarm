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
// alive counters are cleared (kills stay cumulative); spawn on agentsIn; grid and coarse field on agentsIn; steer agentsIn to
// agentsOut plus integrate; debug kill on agentsOut (skipped when no kill is armed; the arm lasts
// one step, so callers re-arm every frame while the button is held); particle step; stats on agentsOut; copy stats
// into the staging ring; swap, so agentsBuffer is the newest output.
import { StagingRing, createStorageBuffer, createUniformBuffer } from '../gpu/buffers.js';
import { loadShader, substituteConstants } from '../gpu/shaders.js';
import { AgentCompaction } from './compact.js';
import { CoarseField } from './field.js';
import { SpatialGrid } from './grid.js';
import { DebugKillPass } from './kill.js';
import { DEFAULT_PARTICLE_CAPACITY, ParticlePool } from './particles.js';
import { ARENA_HEIGHT, ARENA_WIDTH, SHADER_CONSTANTS, SPECIES_COUNT, agentBufferBytes, gridDimensions } from './layout.js';
import { SIM_PARAMS_BYTES, packSimParams } from './params.js';
import { Spawner } from './spawn.js';
import { defaultMatrix, defaultSpecies, normalizeShares, packSpeciesTable } from './species.js';
import { STATS_BYTES, STATS_CLEARED_BYTES, StatsPass, decodeStats } from './stats.js';
import { Steering } from './steer.js';

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
    this.particlePoolValue = new ParticlePool(gpu, { capacity: particleCapacity, common });
    // New buffers are zero-filled, so every slot starts dead.
    this.agentBuffers = [0, 1].map((index) => createStorageBuffer(this.device, agentBufferBytes(capacity), 'agents-' + index));
    this.inputIndex = 0;
    this.speciesTableBufferValue = createStorageBuffer(this.device, packSpeciesTable(species, matrix).byteLength, 'species-table');
    this.paramsBufferValue = createUniformBuffer(this.device, SIM_PARAMS_BYTES, 'sim-params');
    this.statsBufferValue = createStorageBuffer(this.device, STATS_BYTES, 'stats');
    this.stagingRing = new StagingRing(this.device, STATS_BYTES);
    this.playerPosition = [ARENA_WIDTH / 2, ARENA_HEIGHT / 2];
    this.debugKillPosition = [0, 0];
    this.debugKillRadius = 0;
    this.frameSequenceValue = 0;
    this.timeValue = 0;
    this.lastKillsTotal = 0;
    this.sameSpeciesCohesion = true;
    this.setSpecies(species, matrix);
    this.setShares(shares);
  }

  get capacity() { return this.capacityValue; }
  get agentsBuffer() { return this.agentBuffers[this.inputIndex]; }
  get fieldBuffer() { return this.field.buffers.blurred; }
  get statsBuffer() { return this.statsBufferValue; }
  get gridBuffers() { return this.grid.buffers; }
  get particlePool() { return this.particlePoolValue; }
  get speciesTableBuffer() { return this.speciesTableBufferValue; }
  get paramsBuffer() { return this.paramsBufferValue; }
  get frameSequence() { return this.frameSequenceValue; }
  get time() { return this.timeValue; }
  get shares() { return this.sharesValue; }

  setPlayer(x, y) {
    this.playerPosition = [x, y];
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

  setSameSpeciesCohesion(enabled) {
    this.sameSpeciesCohesion = Boolean(enabled);
  }

  setShares(shares) {
    this.sharesValue = normalizeShares(shares);
  }

  // spawnPerSpecies: SPECIES_COUNT counts for this frame, usually from SpawnPressure.update.
  step(encoder, deltaSeconds, spawnPerSpecies = new Uint32Array(SPECIES_COUNT)) {
    this.frameSequenceValue += 1;
    this.timeValue += deltaSeconds;
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
    }));
    const killRadius = this.debugKillRadius;
    this.debugKillRadius = 0;
    this.spawner.writeBudget(spawnPerSpecies);
    encoder.clearBuffer(this.statsBufferValue, 0, STATS_CLEARED_BYTES);
    const agentsIn = this.agentBuffers[this.inputIndex];
    const agentsOut = this.agentBuffers[1 - this.inputIndex];
    const params = this.paramsBufferValue;
    this.spawner.encode(encoder, agentsIn, params);
    this.grid.encode(encoder, agentsIn, params);
    this.field.encode(encoder, agentsIn, this.grid.buffers, params);
    this.steering.encode(encoder, agentsIn, agentsOut, this.grid.buffers, this.field.buffers.blurred, this.speciesTableBufferValue, params);
    if (killRadius > 0) {
      this.killPass.encode(encoder, {
        agentsBuffer: agentsOut,
        statsBuffer: this.statsBufferValue,
        particleBuffers: this.particlePoolValue.buffers,
        threatAccumulator: this.field.buffers.threatAccumulator,
        speciesTableBuffer: this.speciesTableBufferValue,
        paramsBuffer: params,
      });
    }
    this.particlePoolValue.encodeStep(encoder, params);
    this.statsPass.encode(encoder, agentsOut, this.statsBufferValue, params);
    this.stagingRing.copyFrom(encoder, this.statsBufferValue);
    this.inputIndex = 1 - this.inputIndex;
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

  // Builds a Simulation with the same settings at newCapacity, carries the alive agents over and
  // destroys this one. The caller must not step this instance while the promise is pending
  // (main.js pauses stepping through CapacitySwap), so the carried state is the final one.
  // The alive agents are compacted into the first slots of the new buffer: the grid is rebuilt on
  // the newest agents and compact.wgsl copies its listed agents in grid order, so a shrink keeps
  // every alive agent that fits. Species, matrix, shares and the cohesion mode are read again
  // after the awaits, so edits made meanwhile are not lost. On a rejection (allocation or
  // pipeline failure) this instance is untouched and still usable. Stats resume after the new
  // instance's next step.
  async recreateWithCapacity(newCapacity) {
    const next = await Simulation.create(this.gpu, {
      capacity: newCapacity,
      neighborRadius: this.neighborRadius,
      species: this.species,
      matrix: this.matrix,
      shares: this.sharesValue,
      particleCapacity: this.particlePoolValue.capacity,
    });
    let compaction;
    try {
      compaction = await AgentCompaction.create(this.gpu, { common: this.common });
    } catch (error) {
      next.destroy();
      throw error;
    }
    const encoder = this.device.createCommandEncoder({ label: 'simulation-recreate' });
    this.grid.encode(encoder, this.agentsBuffer, this.paramsBufferValue);
    compaction.encode(encoder, {
      paramsBuffer: this.paramsBufferValue,
      gridBuffers: this.grid.buffers,
      agentsIn: this.agentsBuffer,
      agentsOut: next.agentBuffers[next.inputIndex],
      targetCapacity: newCapacity,
    });
    this.device.queue.submit([encoder.finish()]);
    await this.device.queue.onSubmittedWorkDone();
    compaction.destroy();
    next.setSpecies(this.species, this.matrix);
    next.setShares(this.sharesValue);
    next.setSameSpeciesCohesion(this.sameSpeciesCohesion);
    next.frameSequenceValue = this.frameSequenceValue;
    next.timeValue = this.timeValue;
    next.setPlayer(...this.playerPosition);
    next.setDebugKill(...this.debugKillPosition, this.debugKillRadius);
    this.destroy();
    return next;
  }

  // Destroys every GPU buffer this instance created, including the passes' internal buffers.
  destroy() {
    this.agentBuffers.forEach((buffer) => buffer.destroy());
    [this.speciesTableBufferValue, this.paramsBufferValue, this.statsBufferValue].forEach((buffer) => buffer.destroy());
    this.stagingRing.destroy();
    this.spawner.destroy();
    this.particlePoolValue.destroy();
    this.grid.destroy();
    this.field.destroy();
  }
}
