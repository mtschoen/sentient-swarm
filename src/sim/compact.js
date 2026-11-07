// Agent compaction for recreateWithCapacity (compact.wgsl): copies the alive agents the spatial
// grid lists into the first slots of a new agent buffer. Built once per capacity change and
// destroyed after it. Storage buffers bound: cell counts, cell offsets, sorted indices, agents in,
// agents out (5), plus the params and limits uniforms.
import { createUniformBuffer } from '../gpu/buffers.js';
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { SHADER_CONSTANTS, WORKGROUP_SIZE } from './layout.js';

const LIMITS_BYTES = 16;

export class AgentCompaction {
  static async create(gpu, { common }) {
    const compaction = new AgentCompaction(gpu);
    const source = prependCommon(substituteConstants(await loadShader('compact'), SHADER_CONSTANTS), common);
    const module = compaction.device.createShaderModule({ label: 'compact', code: source });
    compaction.pipeline = await compaction.device.createComputePipelineAsync({ label: 'compact', layout: 'auto', compute: { module, entryPoint: 'main' } });
    return compaction;
  }

  // Use AgentCompaction.create; the constructor only allocates.
  constructor(gpu) {
    this.device = gpu.device;
    this.pipeline = null;
    this.limitsBuffer = createUniformBuffer(this.device, LIMITS_BYTES, 'compact-limits');
  }

  // gridBuffers must have been built from agentsIn with paramsBuffer in an earlier pass of encoder.
  encode(encoder, { paramsBuffer, gridBuffers, agentsIn, agentsOut, targetCapacity }) {
    this.device.queue.writeBuffer(this.limitsBuffer, 0, new Uint32Array([targetCapacity, 0, 0, 0]));
    const bindGroup = this.device.createBindGroup({
      label: 'compact-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [paramsBuffer, this.limitsBuffer, gridBuffers.cellCounts, gridBuffers.cellOffsets, gridBuffers.sortedIndices, agentsIn, agentsOut]
        .map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    const pass = encoder.beginComputePass({ label: 'compact' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(targetCapacity / WORKGROUP_SIZE));
    pass.end();
  }

  destroy() {
    this.limitsBuffer.destroy();
  }
}
