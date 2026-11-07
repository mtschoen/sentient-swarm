// Debug kill pass (kill_debug.wgsl): kills agents inside params.debugKillRadius of
// params.debugKillPosition on the freshly integrated agents, adds to the kills stat, spawns splash
// particles into the pool and adds threat to the coarse field accumulator.
// Storage buffers bound: agents, stats, particles (cursor in its header), threat accumulator,
// species table (5), plus the params uniform.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { AGENT_STRIDE_BYTES, SHADER_CONSTANTS, WORKGROUP_SIZE } from './layout.js';

export class DebugKillPass {
  constructor(gpu, { common }) {
    this.device = gpu.device;
    this.common = common;
    this.pipeline = null;
    this.bindGroupCache = new BindGroupCache((buffers) => this.device.createBindGroup({
      label: 'kill-debug-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const source = prependCommon(substituteConstants(await loadShader('kill_debug'), SHADER_CONSTANTS), this.common);
    const module = this.device.createShaderModule({ label: 'kill-debug', code: source });
    this.pipeline = await this.device.createComputePipelineAsync({ label: 'kill-debug', layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  encode(encoder, { agentsBuffer, statsBuffer, particleBuffers, threatAccumulator, speciesTableBuffer, paramsBuffer }) {
    if (this.pipeline === null) throw new Error('DebugKillPass.initialize() must finish before encode()');
    const pass = encoder.beginComputePass({ label: 'kill-debug' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroupCache.get([
      paramsBuffer, agentsBuffer, statsBuffer, particleBuffers.particles, threatAccumulator, speciesTableBuffer,
    ]));
    pass.dispatchWorkgroups(Math.ceil(agentsBuffer.size / AGENT_STRIDE_BYTES / WORKGROUP_SIZE));
    pass.end();
  }
}
