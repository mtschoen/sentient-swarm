// GPU projectiles: a ring of 48-byte Projectile slots (common.wgsl) stepped and collided on the
// GPU each Simulation step. Register with simulation.registerPass so encode runs after integrate:
//   simulation.registerPass((encoder, context) => projectiles.encode(encoder, context));
// The CPU only writes: queueSpawn assigns slots round-robin (slot 0 is reserved for the beam)
// and encode writes the queued spawns with one queue.writeBuffer per contiguous run of slots (a
// second run only when the cursor wraps in that frame); setBeam keeps slot 0 rewritten every
// frame while firing and clears it once afterwards; it also carries the previous step's aim, so the
// beam kills and draws the whole sector swept between two steps. The GPU clears a slot's alive bit when its
// lifetime expires or it leaves the arena (projectiles_step.wgsl) and kills agents through the
// spatial grid (projectiles_collide.wgsl, which adds to the stats kills index like the debug kill).
// The step pass counts pulse ring detonations into the stats ringsThisFrame index.
// A spawn that lands on a still-alive slot replaces it.
// Lab knobs (task C6b, both off by default): setBaseKillBudget writes a kill budget into every
// base bullet's extra (the collide pass spends it and kills the bullet at 0); setBeamSweepThreshold
// shrinks the beam's kill reach on fast turns through the beam slot's lifetime (its reach scale,
// 1 = to the arena edge; nothing else reads a beam's lifetime).
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createStorageBuffer, createUniformBuffer } from '../gpu/buffers.js';
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { PROJECTILE_FLAG_ALIVE, SHADER_CONSTANTS, SPECIES_COUNT, WORKGROUP_SIZE } from '../sim/layout.js';
import { SPECIES_FIELDS } from '../sim/species.js';
import {
  BEAM_SWEEP_MINIMUM_REACH_SCALE, DEFAULT_BASE_KILL_BUDGET, DEFAULT_BEAM_SWEEP_THRESHOLD_DEGREES, MAXIMUM_BASE_KILL_BUDGET,
  MAXIMUM_BEAM_SWEEP_THRESHOLD_DEGREES, PROJECTILE_KINDS,
} from './weaponTypes.js';

export const PROJECTILE_STRIDE_BYTES = 48;
export const DEFAULT_PROJECTILE_CAPACITY = 8192;
export const BEAM_SLOT = 0;
// The beam's lifetime is its kill reach scale (the step pass leaves the beam slot alone): 1 is full.
const FULL_BEAM_REACH = 1;
const DEGREES_PER_RADIAN = 180 / Math.PI;
const BYTES_PER_FLOAT = 4;
// Workgroups of the rings entry (projectiles_collide.wgsl): every one scans the slots, then their
// 8192 threads share the pulse rings' cells (8 rings of RING_CELL_BUDGET cells without overlap).
// Measured with 3 rings in a wall-pinned mass (worst frame of the projectiles pass): 0.35 ms at
// 262144 agents and 1.3 ms at 1048576, against 9.3 and 35 ms with one thread per ring.
export const RING_WORKGROUP_COUNT = 32;
// SpeciesHues in projectiles_collide.wgsl: two vec4f.
const HUES_UNIFORM_BYTES = 32;
const SPECIES_ROW_BYTES = SPECIES_FIELDS.length * BYTES_PER_FLOAT;
const HUE_FIELD_BYTES = SPECIES_FIELDS.indexOf('hue') * BYTES_PER_FLOAT;

// Writes one Projectile at byteOffset: position and previousPosition both (x, y), alive.
export function packProjectile(view, byteOffset, { x, y, velocityX, velocityY, radius, lifetime, kind, seed = 0, extra = 0 }) {
  const floats = [x, y, x, y, velocityX, velocityY, radius, lifetime];
  floats.forEach((value, index) => view.setFloat32(byteOffset + index * BYTES_PER_FLOAT, value, true));
  view.setUint32(byteOffset + 32, kind, true);
  view.setUint32(byteOffset + 36, PROJECTILE_FLAG_ALIVE, true);
  view.setFloat32(byteOffset + 40, seed, true);
  view.setFloat32(byteOffset + 44, extra, true);
}

// Round-robin slot cursor over 1 .. capacity - 1 (cursor = (cursor + 1) % capacity, skipping the
// beam slot).
export class ProjectileSlots {
  constructor(capacity) {
    if (capacity < 2) throw new Error(`Projectiles need at least 2 slots (slot ${BEAM_SLOT} is the beam); got ${capacity}`);
    this.capacity = capacity;
    this.cursor = BEAM_SLOT;
  }

  next() {
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.cursor === BEAM_SLOT) this.cursor = (this.cursor + 1) % this.capacity;
    return this.cursor;
  }
}

// Splits slots, in queue order, into runs of consecutive slots: [{ firstSlot, startIndex, count }].
export function contiguousRuns(slots) {
  const runs = [];
  slots.forEach((slot, index) => {
    const last = runs[runs.length - 1];
    if (last !== undefined && slot === last.firstSlot + last.count) last.count += 1;
    else runs.push({ firstSlot: slot, startIndex: index, count: 1 });
  });
  return runs;
}

export function validatedBaseKillBudget(count) {
  if (!(Number.isInteger(count) && count >= 0 && count <= MAXIMUM_BASE_KILL_BUDGET)) {
    throw new RangeError(`baseKillBudget must be an integer in [0, ${MAXIMUM_BASE_KILL_BUDGET}], got ${count}`);
  }
  return count;
}

export function validatedBeamSweepThreshold(degrees) {
  if (!(degrees >= 0 && degrees <= MAXIMUM_BEAM_SWEEP_THRESHOLD_DEGREES)) {
    throw new RangeError(`beamSweepThresholdDegrees must lie in [0, ${MAXIMUM_BEAM_SWEEP_THRESHOLD_DEGREES}], got ${degrees}`);
  }
  return degrees;
}

// The spawn with the base gun's kill budget in extra (a copy), or the spawn itself when the budget
// is 0 (unlimited) or the kind is not the base bullet.
export function withKillBudget(spawn, budget) {
  if (budget === 0 || spawn.kind !== PROJECTILE_KINDS.bullet) return spawn;
  return { ...spawn, extra: budget };
}

// Kill reach scale for a beam turning from previous to current (unit directions) in one step:
// clamp(threshold / swept, BEAM_SWEEP_MINIMUM_REACH_SCALE, 1) in degrees, 1 when the threshold is 0
// (off) or there is no previous direction.
export function beamReachScale(previous, current, thresholdDegrees) {
  if (!(thresholdDegrees > 0) || previous === null) return FULL_BEAM_REACH;
  const cosine = Math.min(1, Math.max(-1, previous.x * current.x + previous.y * current.y));
  const sweptDegrees = Math.acos(cosine) * DEGREES_PER_RADIAN;
  if (sweptDegrees <= thresholdDegrees) return FULL_BEAM_REACH;
  return Math.max(BEAM_SWEEP_MINIMUM_REACH_SCALE, thresholdDegrees / sweptDegrees);
}

// The beam as a Projectile spawn, or null for no beam (or a zero direction). The beam slot's seed
// and extra hold the previous step's unit direction (previousDirection { x, y }; a missing or zero
// one means the current direction, a line), so the collide and render passes cover the sector swept
// between the two steps. sweepThresholdDegrees (0, off, by default) sets the lifetime, the reach
// scale (beamReachScale).
export function beamSpawn(beam, previousDirection = null, sweepThresholdDegrees = DEFAULT_BEAM_SWEEP_THRESHOLD_DEGREES) {
  if (beam === null) return null;
  const length = Math.hypot(beam.directionX, beam.directionY);
  if (!(length > 0)) return null;
  const velocityX = beam.directionX / length;
  const velocityY = beam.directionY / length;
  const previousLength = previousDirection === null ? 0 : Math.hypot(previousDirection.x, previousDirection.y);
  const hasPrevious = previousLength > 0;
  const previousUnit = hasPrevious ? { x: previousDirection.x / previousLength, y: previousDirection.y / previousLength } : null;
  return {
    x: beam.x,
    y: beam.y,
    velocityX,
    velocityY,
    radius: beam.halfWidth,
    lifetime: beamReachScale(previousUnit, { x: velocityX, y: velocityY }, sweepThresholdDegrees),
    kind: PROJECTILE_KINDS.beam,
    seed: hasPrevious ? previousUnit.x : velocityX,
    extra: hasPrevious ? previousUnit.y : velocityY,
  };
}

// The beam request plus the direction last written to the GPU. set takes every Game update's
// request (null stops the beam and forgets the direction, so a restarted beam is a line); next
// runs once per Simulation step and sweeps from the last written direction, so several updates
// per step still sweep the whole turn.
export class BeamTracker {
  constructor() {
    // Lab beam sweep budget (Projectiles.setBeamSweepThreshold); 0 is off.
    this.sweepThresholdDegrees = DEFAULT_BEAM_SWEEP_THRESHOLD_DEGREES;
    this.clear();
  }

  set(beam) {
    if (beam === null) this.previousDirection = null;
    this.beam = beam === null ? null : { ...beam };
  }

  next() {
    const spawn = beamSpawn(this.beam, this.previousDirection, this.sweepThresholdDegrees);
    this.previousDirection = spawn === null ? null : { x: spawn.velocityX, y: spawn.velocityY };
    return spawn;
  }

  clear() {
    this.beam = null;
    this.previousDirection = null;
  }
}

export class Projectiles {
  // common: the substituted common.wgsl source (loaded when omitted).
  static async create(gpu, { capacity = DEFAULT_PROJECTILE_CAPACITY, common } = {}) {
    const header = common ?? substituteConstants(await loadShader('common'), SHADER_CONSTANTS);
    const projectiles = new Projectiles(gpu, { capacity, common: header });
    await projectiles.initialize();
    return projectiles;
  }

  // Use Projectiles.create; the constructor only allocates.
  constructor(gpu, { capacity, common }) {
    this.device = gpu.device;
    this.capacityValue = capacity;
    this.common = common;
    this.slots = new ProjectileSlots(capacity);
    this.pending = [];
    this.beamTracker = new BeamTracker();
    this.beamWritten = false;
    this.baseKillBudgetValue = DEFAULT_BASE_KILL_BUDGET;
    // New buffers are zero-filled, so every slot starts dead.
    this.bufferValue = createStorageBuffer(this.device, capacity * PROJECTILE_STRIDE_BYTES, 'projectiles');
    this.huesBuffer = createUniformBuffer(this.device, HUES_UNIFORM_BYTES, 'projectile-species-hues');
    this.pipelines = null;
    this.stepBindGroupCache = new BindGroupCache(([paramsBuffer, fieldBuffer, statsBuffer]) => this.device.createBindGroup({
      label: 'projectiles-step-bindings',
      layout: this.pipelines.step.getBindGroupLayout(0),
      entries: [paramsBuffer, this.bufferValue, fieldBuffer, statsBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
    this.collideBindGroupCache = new BindGroupCache(([paramsBuffer, ...storage]) => this.device.createBindGroup({
      label: 'projectiles-collide-bindings',
      layout: this.collideLayout,
      entries: [paramsBuffer, this.huesBuffer, this.bufferValue, ...storage].map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  get buffer() { return this.bufferValue; }
  get capacity() { return this.capacityValue; }
  get baseKillBudget() { return this.baseKillBudgetValue; }
  get beamSweepThresholdDegrees() { return this.beamTracker.sweepThresholdDegrees; }

  // Lab: kills per base bullet (0 unlimited), for spawns queued from now on. Throws RangeError.
  setBaseKillBudget(count) {
    this.baseKillBudgetValue = validatedBaseKillBudget(count);
  }

  // Lab: the beam sweep budget in degrees per step (0 off). Throws RangeError.
  setBeamSweepThreshold(degrees) {
    this.beamTracker.sweepThresholdDegrees = validatedBeamSweepThreshold(degrees);
  }

  async initialize() {
    const module = async (name) => this.device.createShaderModule({
      label: name,
      code: prependCommon(substituteConstants(await loadShader(name), SHADER_CONSTANTS), this.common),
    });
    const [stepModule, collideModule] = await Promise.all([module('projectiles_step'), module('projectiles_collide')]);
    const entry = (binding, type) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    // Shared by the main, rings and beam entry points: params, hues, projectiles, agents, cellCounts,
    // cellOffsets, sortedIndices, particles, threatAccumulator, stats.
    this.collideLayout = this.device.createBindGroupLayout({
      label: 'projectiles-collide-layout',
      // projectiles is writable: the base gun kill budget is spent in place (task C6b).
      entries: [
        entry(0, 'uniform'), entry(1, 'uniform'), entry(2, 'storage'), entry(3, 'storage'),
        entry(4, 'read-only-storage'), entry(5, 'read-only-storage'), entry(6, 'read-only-storage'),
        entry(7, 'storage'), entry(8, 'storage'), entry(9, 'storage'),
      ],
    });
    const collidePipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.collideLayout] });
    const [step, collide, rings, beam] = await Promise.all([
      this.device.createComputePipelineAsync({ label: 'projectiles-step', layout: 'auto', compute: { module: stepModule, entryPoint: 'main' } }),
      this.device.createComputePipelineAsync({ label: 'projectiles-collide', layout: collidePipelineLayout, compute: { module: collideModule, entryPoint: 'main' } }),
      this.device.createComputePipelineAsync({ label: 'projectiles-rings', layout: collidePipelineLayout, compute: { module: collideModule, entryPoint: 'rings' } }),
      this.device.createComputePipelineAsync({ label: 'projectiles-beam', layout: collidePipelineLayout, compute: { module: collideModule, entryPoint: 'beam' } }),
    ]);
    this.pipelines = { step, collide, rings, beam };
  }

  // Queues a projectile for the next encode and returns the slot it will occupy.
  queueSpawn(spawn) {
    const slot = this.slots.next();
    this.pending.push({ slot, spawn: withKillBudget(spawn, this.baseKillBudgetValue) });
    return slot;
  }

  // { x, y, directionX, directionY, halfWidth } fires the beam from the next encode on; null stops it
  // and resets the swept direction (BeamTracker).
  setBeam(beam) {
    this.beamTracker.set(beam);
  }

  // Kills every projectile now (queue.writeBuffer, ahead of any later submit) and drops queued
  // spawns and the beam. The slot cursor keeps going.
  clear() {
    this.device.queue.writeBuffer(this.bufferValue, 0, new Uint8Array(this.bufferValue.size));
    this.pending = [];
    this.beamTracker.clear();
    this.beamWritten = false;
  }

  writePending() {
    const runs = contiguousRuns(this.pending.map((entry) => entry.slot));
    for (const run of runs) {
      const bytes = new ArrayBuffer(run.count * PROJECTILE_STRIDE_BYTES);
      const view = new DataView(bytes);
      for (let index = 0; index < run.count; index += 1) {
        packProjectile(view, index * PROJECTILE_STRIDE_BYTES, this.pending[run.startIndex + index].spawn);
      }
      this.device.queue.writeBuffer(this.bufferValue, run.firstSlot * PROJECTILE_STRIDE_BYTES, bytes);
    }
    this.pending = [];
    const beam = this.beamTracker.next();
    if (beam === null && !this.beamWritten) return;
    const bytes = new ArrayBuffer(PROJECTILE_STRIDE_BYTES);
    if (beam !== null) packProjectile(new DataView(bytes), 0, beam);
    this.device.queue.writeBuffer(this.bufferValue, BEAM_SLOT * PROJECTILE_STRIDE_BYTES, bytes);
    this.beamWritten = beam !== null;
  }

  // Runs inside Simulation.step through registerPass (context as documented in simulation.js).
  encode(encoder, { agentsBuffer, gridBuffers, fieldBuffers, particlePool, statsBuffer, paramsBuffer, speciesTableBuffer }) {
    if (this.pipelines === null) throw new Error('Projectiles.initialize() must finish before encode()');
    this.writePending();
    for (let species = 0; species < SPECIES_COUNT; species += 1) {
      encoder.copyBufferToBuffer(speciesTableBuffer, species * SPECIES_ROW_BYTES + HUE_FIELD_BYTES, this.huesBuffer, species * BYTES_PER_FLOAT, BYTES_PER_FLOAT);
    }
    const workgroups = Math.ceil(this.capacityValue / WORKGROUP_SIZE);
    const collideBindGroup = this.collideBindGroupCache.get([
      paramsBuffer, agentsBuffer, gridBuffers.cellCounts, gridBuffers.cellOffsets, gridBuffers.sortedIndices,
      particlePool.buffers.particles, fieldBuffers.threatAccumulator, statsBuffer,
    ]);
    const pass = encoder.beginComputePass({ label: 'projectiles' });
    pass.setPipeline(this.pipelines.step);
    pass.setBindGroup(0, this.stepBindGroupCache.get([paramsBuffer, fieldBuffers.blurred, statsBuffer]));
    pass.dispatchWorkgroups(workgroups);
    pass.setPipeline(this.pipelines.collide);
    pass.setBindGroup(0, collideBindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.setPipeline(this.pipelines.rings);
    pass.dispatchWorkgroups(RING_WORKGROUP_COUNT);
    pass.setPipeline(this.pipelines.beam);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  destroy() {
    this.bufferValue.destroy();
    this.huesBuffer.destroy();
  }
}
