// GPU particle pool: one buffer holding a 16-byte header, whose first u32 is the spawn cursor,
// then a fixed ring of 32-byte particles (the ParticlePool struct in common.wgsl). Passes that
// kill agents claim slots with an atomicAdd on the cursor (wrapping modulo capacity) and write
// particles directly; encodeStep ages, moves and drags the live ones (particles_step.wgsl).
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

  encodeStep(encoder, paramsBuffer) {
    if (this.pipeline === null) throw new Error('ParticlePool.initialize() must finish before encodeStep()');
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
