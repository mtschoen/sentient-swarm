// GPU projectiles: a ring of 48-byte Projectile slots (common.wgsl) stepped and collided on the
// GPU each Simulation step. Register with simulation.registerPass so encode runs after integrate:
//   simulation.registerPass((encoder, context) => projectiles.encode(encoder, context));
// The CPU only writes: queueSpawn assigns slots round-robin (slot 0 is reserved for the beam)
// and encode writes the queued spawns with one queue.writeBuffer per contiguous run of slots (a
// second run only when the cursor wraps in that frame); setBeam keeps slot 0 rewritten every
// frame while firing and clears it once afterwards. The GPU clears a slot's alive bit when its
// lifetime expires or it leaves the arena (projectiles_step.wgsl) and kills agents through the
// spatial grid (projectiles_collide.wgsl, which adds to the stats kills index like the debug kill).
// A spawn that lands on a still-alive slot replaces it.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createStorageBuffer, createUniformBuffer } from '../gpu/buffers.js';
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { SHADER_CONSTANTS, SPECIES_COUNT, WORKGROUP_SIZE } from '../sim/layout.js';
import { SPECIES_FIELDS } from '../sim/species.js';

export const PROJECTILE_STRIDE_BYTES = 48;
export const DEFAULT_PROJECTILE_CAPACITY = 8192;
export const BEAM_SLOT = 0;
// Matches PROJECTILE_KIND_BEAM and PROJECTILE_FLAG_ALIVE in common.wgsl.
const BEAM_KIND = 6;
const FLAG_ALIVE = 1;
// The beam's lifetime is never read: the step pass leaves the beam slot alone.
const BEAM_LIFETIME = 1;
const BYTES_PER_FLOAT = 4;
// SpeciesHues in projectiles_collide.wgsl: two vec4f.
const HUES_UNIFORM_BYTES = 32;
const SPECIES_ROW_BYTES = SPECIES_FIELDS.length * BYTES_PER_FLOAT;
const HUE_FIELD_BYTES = SPECIES_FIELDS.indexOf('hue') * BYTES_PER_FLOAT;

// Writes one Projectile at byteOffset: position and previousPosition both (x, y), alive.
export function packProjectile(view, byteOffset, { x, y, velocityX, velocityY, radius, lifetime, kind, seed = 0, extra = 0 }) {
  const floats = [x, y, x, y, velocityX, velocityY, radius, lifetime];
  floats.forEach((value, index) => view.setFloat32(byteOffset + index * BYTES_PER_FLOAT, value, true));
  view.setUint32(byteOffset + 32, kind, true);
  view.setUint32(byteOffset + 36, FLAG_ALIVE, true);
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

// The beam as a Projectile spawn, or null for no beam (or a zero direction).
export function beamSpawn(beam) {
  if (beam === null) return null;
  const length = Math.hypot(beam.directionX, beam.directionY);
  if (!(length > 0)) return null;
  return {
    x: beam.x,
    y: beam.y,
    velocityX: beam.directionX / length,
    velocityY: beam.directionY / length,
    radius: beam.halfWidth,
    lifetime: BEAM_LIFETIME,
    kind: BEAM_KIND,
  };
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
    this.beam = null;
    this.beamWritten = false;
    // New buffers are zero-filled, so every slot starts dead.
    this.bufferValue = createStorageBuffer(this.device, capacity * PROJECTILE_STRIDE_BYTES, 'projectiles');
    this.huesBuffer = createUniformBuffer(this.device, HUES_UNIFORM_BYTES, 'projectile-species-hues');
    this.pipelines = null;
    this.stepBindGroupCache = new BindGroupCache(([paramsBuffer, fieldBuffer]) => this.device.createBindGroup({
      label: 'projectiles-step-bindings',
      layout: this.pipelines.step.getBindGroupLayout(0),
      entries: [paramsBuffer, this.bufferValue, fieldBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
    this.collideBindGroupCache = new BindGroupCache(([paramsBuffer, ...storage]) => this.device.createBindGroup({
      label: 'projectiles-collide-bindings',
      layout: this.collideLayout,
      entries: [paramsBuffer, this.huesBuffer, this.bufferValue, ...storage].map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  get buffer() { return this.bufferValue; }
  get capacity() { return this.capacityValue; }

  async initialize() {
    const module = async (name) => this.device.createShaderModule({
      label: name,
      code: prependCommon(substituteConstants(await loadShader(name), SHADER_CONSTANTS), this.common),
    });
    const [stepModule, collideModule] = await Promise.all([module('projectiles_step'), module('projectiles_collide')]);
    const entry = (binding, type) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    // Shared by the main and beam entry points: params, hues, projectiles, agents, cellCounts,
    // cellOffsets, sortedIndices, particles, threatAccumulator, stats.
    this.collideLayout = this.device.createBindGroupLayout({
      label: 'projectiles-collide-layout',
      entries: [
        entry(0, 'uniform'), entry(1, 'uniform'), entry(2, 'read-only-storage'), entry(3, 'storage'),
        entry(4, 'read-only-storage'), entry(5, 'read-only-storage'), entry(6, 'read-only-storage'),
        entry(7, 'storage'), entry(8, 'storage'), entry(9, 'storage'),
      ],
    });
    const collidePipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.collideLayout] });
    const [step, collide, beam] = await Promise.all([
      this.device.createComputePipelineAsync({ label: 'projectiles-step', layout: 'auto', compute: { module: stepModule, entryPoint: 'main' } }),
      this.device.createComputePipelineAsync({ label: 'projectiles-collide', layout: collidePipelineLayout, compute: { module: collideModule, entryPoint: 'main' } }),
      this.device.createComputePipelineAsync({ label: 'projectiles-beam', layout: collidePipelineLayout, compute: { module: collideModule, entryPoint: 'beam' } }),
    ]);
    this.pipelines = { step, collide, beam };
  }

  // Queues a projectile for the next encode and returns the slot it will occupy.
  queueSpawn(spawn) {
    const slot = this.slots.next();
    this.pending.push({ slot, spawn });
    return slot;
  }

  // { x, y, directionX, directionY, halfWidth } fires the beam from the next encode on; null stops it.
  setBeam(beam) {
    this.beam = beam === null ? null : { ...beam };
  }

  // Kills every projectile now (queue.writeBuffer, ahead of any later submit) and drops queued
  // spawns and the beam. The slot cursor keeps going.
  clear() {
    this.device.queue.writeBuffer(this.bufferValue, 0, new Uint8Array(this.bufferValue.size));
    this.pending = [];
    this.beam = null;
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
    const beam = beamSpawn(this.beam);
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
    pass.setBindGroup(0, this.stepBindGroupCache.get([paramsBuffer, fieldBuffers.blurred]));
    pass.dispatchWorkgroups(workgroups);
    pass.setPipeline(this.pipelines.collide);
    pass.setBindGroup(0, collideBindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.setPipeline(this.pipelines.beam);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  destroy() {
    this.bufferValue.destroy();
    this.huesBuffer.destroy();
  }
}
