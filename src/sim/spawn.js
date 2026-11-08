// GPU spawner: dead agent slots claim units from the per-species spawn budget and come alive in
// the wall band away from the player, optionally near dense coarse field cells (spawn.wgsl). The budget buffer holds SPECIES_COUNT u32 counters; the caller
// refills it every frame with writeBudget before encode.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createStorageBuffer } from '../gpu/buffers.js';
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { AGENT_STRIDE_BYTES, SHADER_CONSTANTS, SPECIES_COUNT, WORKGROUP_SIZE } from './layout.js';

const BYTES_PER_COUNTER = 4;

export class Spawner {
  constructor(gpu, { common }) {
    this.device = gpu.device;
    this.common = common;
    this.budgetBuffer = createStorageBuffer(this.device, SPECIES_COUNT * BYTES_PER_COUNTER, 'spawn-budget');
    this.pipeline = null;
    this.bindGroupCache = new BindGroupCache(([agentsBuffer, paramsBuffer, fieldBuffer]) => this.device.createBindGroup({
      label: 'spawn-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [paramsBuffer, agentsBuffer, this.budgetBuffer, fieldBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const source = prependCommon(substituteConstants(await loadShader('spawn'), SHADER_CONSTANTS), this.common);
    const module = this.device.createShaderModule({ label: 'spawn', code: source });
    this.pipeline = await this.device.createComputePipelineAsync({ label: 'spawn', layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  // spawnPerSpecies: SPECIES_COUNT counts for this frame (a Uint32Array(5)).
  writeBudget(spawnPerSpecies) {
    this.device.queue.writeBuffer(this.budgetBuffer, 0, Uint32Array.from({ length: SPECIES_COUNT }, (unused, species) => spawnPerSpecies[species] ?? 0));
  }

  // fieldBuffer: the blurred coarse field (CoarseField buffers.blurred) the density bias reads.
  encode(encoder, agentsBuffer, paramsBuffer, fieldBuffer) {
    if (this.pipeline === null) throw new Error('Spawner.initialize() must finish before encode()');
    const pass = encoder.beginComputePass({ label: 'spawn' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroupCache.get([agentsBuffer, paramsBuffer, fieldBuffer]));
    pass.dispatchWorkgroups(Math.ceil(agentsBuffer.size / AGENT_STRIDE_BYTES / WORKGROUP_SIZE));
    pass.end();
  }

  destroy() {
    this.budgetBuffer.destroy();
  }
}
