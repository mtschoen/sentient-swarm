// GPU particle pool: a fixed ring of 32-byte particles plus a spawn cursor. Passes that kill
// agents claim slots with an atomicAdd on the cursor (wrapping modulo capacity) and write
// particles directly; encodeStep ages, moves and drags the live ones (particles_step.wgsl).
// Particle: position vec2f, velocity vec2f, color u32 (rgba8, r low byte), age f32, lifetime f32,
// padding f32. A slot with lifetime <= 0 or age >= lifetime is dead; new buffers are all dead.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createStorageBuffer } from '../gpu/buffers.js';
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { SHADER_CONSTANTS, WORKGROUP_SIZE } from './layout.js';

export const PARTICLE_STRIDE_BYTES = 32;
export const DEFAULT_PARTICLE_CAPACITY = 65536;

export class ParticlePool {
  constructor(gpu, { capacity = DEFAULT_PARTICLE_CAPACITY, common }) {
    this.device = gpu.device;
    this.capacity = capacity;
    this.common = common;
    this.pipeline = null;
    this.buffers = {
      particles: createStorageBuffer(this.device, capacity * PARTICLE_STRIDE_BYTES, 'particles'),
      cursor: createStorageBuffer(this.device, 4, 'particle-cursor'),
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
