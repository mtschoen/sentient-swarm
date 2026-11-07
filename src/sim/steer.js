// Steering and integration: steer.wgsl turns neighbors and the coarse field into a new velocity
// (agentsIn to agentsOut), then integrate.wgsl moves agentsOut in place with soft walls.
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { AGENT_STRIDE_BYTES, SHADER_CONSTANTS, WORKGROUP_SIZE } from './layout.js';

export class Steering {
  constructor(gpu, { common }) {
    this.device = gpu.device;
    this.common = common;
    this.pipelines = null;
    this.bindGroups = null;
    this.boundBuffers = [];
  }

  async createModule(name) {
    const source = prependCommon(substituteConstants(await loadShader(name), SHADER_CONSTANTS), this.common);
    return this.device.createShaderModule({ label: name, code: source });
  }

  async initialize() {
    const [steerModule, integrateModule] = await Promise.all([this.createModule('steer'), this.createModule('integrate')]);
    const [steer, integrate] = await Promise.all([
      this.device.createComputePipelineAsync({ label: 'steer', layout: 'auto', compute: { module: steerModule, entryPoint: 'main' } }),
      this.device.createComputePipelineAsync({ label: 'integrate', layout: 'auto', compute: { module: integrateModule, entryPoint: 'main' } }),
    ]);
    this.pipelines = { steer, integrate };
  }

  createBindGroups(agentsIn, agentsOut, gridBuffers, fieldBuffer, speciesTableBuffer, paramsBuffer) {
    const bindGroup = (name, buffers) => this.device.createBindGroup({
      label: name + '-bindings',
      layout: this.pipelines[name].getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    return {
      steer: bindGroup('steer', [
        paramsBuffer, agentsIn, agentsOut, gridBuffers.cellCounts, gridBuffers.cellOffsets,
        gridBuffers.sortedIndices, fieldBuffer, speciesTableBuffer,
      ]),
      integrate: bindGroup('integrate', [paramsBuffer, agentsOut]),
    };
  }

  // fieldBuffer is CoarseField.buffers.blurred; gridBuffers come from SpatialGrid built on agentsIn.
  encode(encoder, agentsIn, agentsOut, gridBuffers, fieldBuffer, speciesTableBuffer, paramsBuffer) {
    if (this.pipelines === null) throw new Error('Steering.initialize() must finish before encode()');
    const buffers = [agentsIn, agentsOut, gridBuffers.cellCounts, gridBuffers.cellOffsets, gridBuffers.sortedIndices, fieldBuffer, speciesTableBuffer, paramsBuffer];
    if (buffers.some((buffer, index) => buffer !== this.boundBuffers[index])) {
      this.bindGroups = this.createBindGroups(agentsIn, agentsOut, gridBuffers, fieldBuffer, speciesTableBuffer, paramsBuffer);
      this.boundBuffers = buffers;
    }
    const workgroups = Math.ceil(agentsIn.size / AGENT_STRIDE_BYTES / WORKGROUP_SIZE);
    const pass = encoder.beginComputePass({ label: 'steering' });
    pass.setPipeline(this.pipelines.steer);
    pass.setBindGroup(0, this.bindGroups.steer);
    pass.dispatchWorkgroups(workgroups);
    pass.setPipeline(this.pipelines.integrate);
    pass.setBindGroup(0, this.bindGroups.integrate);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
  }
}
