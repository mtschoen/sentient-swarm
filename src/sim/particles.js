// GPU particle pool: one buffer holding a 16-byte header (the spawn cursor, liveCount,
// claimedThisStep and killAllAlive u32 words), then a fixed ring of 32-byte particles (the
// ParticlePool struct in common.wgsl). Passes that kill agents ask the step's shared budget for
// their burst (the slots free after the last particle step), claim the granted slots with an
// atomicAdd on the cursor (wrapping modulo capacity) and write particles directly.
// encodeBeginStep zeroes the step's claims before any kill pass; encodeStep ages, moves and drags
// the live ones and recounts liveCount (particles_step.wgsl).
// Folding the cursor into the particles buffer keeps the collide pass at 8 storage buffers.
// Particle: position vec2f, velocity vec2f, color u32 (rgba8, r low byte), age f32, lifetime f32,
// padding f32. A slot with lifetime <= 0 or age >= lifetime is dead; new buffers are all dead.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createStorageBuffer } from '../gpu/buffers.js';
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { SHADER_CONSTANTS, WORKGROUP_SIZE } from './layout.js';

export const PARTICLE_STRIDE_BYTES = 32;
export const PARTICLE_HEADER_BYTES = 16;
export const DEFAULT_PARTICLE_CAPACITY = 65536;
// Header word byte offsets (ParticlePool in common.wgsl).
export const PARTICLE_HEADER_OFFSETS = Object.freeze({ cursor: 0, liveCount: 4, claimedThisStep: 8, killAllAlive: 12 });
const HEADER_WORD_BYTES = 4;

export class ParticlePool {
  constructor(gpu, { capacity = DEFAULT_PARTICLE_CAPACITY, common }) {
    this.device = gpu.device;
    this.capacity = capacity;
    this.common = common;
    this.pipeline = null;
    this.buffers = {
      particles: createStorageBuffer(this.device, PARTICLE_HEADER_BYTES + capacity * PARTICLE_STRIDE_BYTES, 'particles'),
    };
    this.bindGroupCache = new BindGroupCache(([paramsBuffer]) => this.device.createBindGroup({
      label: 'particles-step-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [paramsBuffer, this.buffers.particles].map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const source = prependCommon(substituteConstants(await loadShader('particles_step'), SHADER_CONSTANTS), this.common);
    const module = this.device.createShaderModule({ label: 'particles-step', code: source });
    this.pipeline = await this.device.createComputePipelineAsync({ label: 'particles-step', layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  // Replaces the ring with an empty one of capacity slots (live particles are dropped). Every
  // shader takes the slot count from arrayLength, and every other bind group cache keys on the
  // buffer, so only this pool's own cache (keyed on the params buffer) needs clearing. The old
  // buffer is destroyed; WebGPU frees it after submitted work that uses it.
  resize(capacity) {
    if (capacity === this.capacity) return;
    const previous = this.buffers.particles;
    this.capacity = capacity;
    this.buffers.particles = createStorageBuffer(this.device, PARTICLE_HEADER_BYTES + capacity * PARTICLE_STRIDE_BYTES, 'particles');
    this.bindGroupCache.clear();
    previous.destroy();
  }

  // At the start of a simulation step: zeroes claimedThisStep and killAllAlive (adjacent words).
  encodeBeginStep(encoder) {
    encoder.clearBuffer(this.buffers.particles, PARTICLE_HEADER_OFFSETS.claimedThisStep, 2 * HEADER_WORD_BYTES);
  }

  encodeStep(encoder, paramsBuffer) {
    if (this.pipeline === null) throw new Error('ParticlePool.initialize() must finish before encodeStep()');
    encoder.clearBuffer(this.buffers.particles, PARTICLE_HEADER_OFFSETS.liveCount, HEADER_WORD_BYTES);
    const pass = encoder.beginComputePass({ label: 'particles-step' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroupCache.get([paramsBuffer]));
    pass.dispatchWorkgroups(Math.ceil(this.capacity / WORKGROUP_SIZE));
    pass.end();
  }

  destroy() {
    Object.values(this.buffers).forEach((buffer) => buffer.destroy());
  }
}
