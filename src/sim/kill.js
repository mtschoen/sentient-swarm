// Agent kill passes on the freshly integrated agents. Each adds to the stats kill words, spawns
// splash particles into the pool (cursor in its header) and, except player contact, adds threat to
// the coarse field accumulator.
// - DebugKillPass (kill_debug.wgsl): agents inside params.debugKillRadius of
//   params.debugKillPosition, counted in kills. Storage buffers: agents, stats, particles, threat
//   accumulator, species table (5), plus the params uniform.
// - KillAllPass (kill_all.wgsl): every alive agent, spawning ones included, counted in
//   killsUnscored. Storage buffers: agents, stats, particles, threat accumulator, species table
//   (5), plus the params uniform.
// - PlayerContactPass (player_collide.wgsl, one workgroup): the hit latch and the one agent that
//   touches the player, counted in killsUnscored. Storage buffers: agents, cellCounts,
//   cellOffsets, sortedIndices, stats, particles, species table (7), plus the params uniform.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { AGENT_STRIDE_BYTES, SHADER_CONSTANTS, WORKGROUP_SIZE } from './layout.js';

class ComputePass {
  constructor(gpu, { common, shaderName, label }) {
    this.device = gpu.device;
    this.common = common;
    this.shaderName = shaderName;
    this.label = label;
    this.pipeline = null;
    this.bindGroupCache = new BindGroupCache((buffers) => this.device.createBindGroup({
      label: label + '-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const source = prependCommon(substituteConstants(await loadShader(this.shaderName), SHADER_CONSTANTS), this.common);
    const module = this.device.createShaderModule({ label: this.label, code: source });
    this.pipeline = await this.device.createComputePipelineAsync({ label: this.label, layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  // buffers in binding order; workgroups is the dispatch size.
  dispatch(encoder, buffers, workgroups) {
    if (this.pipeline === null) throw new Error(`${this.constructor.name}.initialize() must finish before encode()`);
    const pass = encoder.beginComputePass({ label: this.label });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroupCache.get(buffers));
    pass.dispatchWorkgroups(workgroups);
    pass.end();
  }
}

function agentWorkgroups(agentsBuffer) {
  return Math.ceil(agentsBuffer.size / AGENT_STRIDE_BYTES / WORKGROUP_SIZE);
}

export class DebugKillPass extends ComputePass {
  constructor(gpu, { common }) {
    super(gpu, { common, shaderName: 'kill_debug', label: 'kill-debug' });
  }

  encode(encoder, { agentsBuffer, statsBuffer, particleBuffers, threatAccumulator, speciesTableBuffer, paramsBuffer }) {
    this.dispatch(encoder, [
      paramsBuffer, agentsBuffer, statsBuffer, particleBuffers.particles, threatAccumulator, speciesTableBuffer,
    ], agentWorkgroups(agentsBuffer));
  }
}

export class KillAllPass extends ComputePass {
  constructor(gpu, { common }) {
    super(gpu, { common, shaderName: 'kill_all', label: 'kill-all' });
  }

  encode(encoder, { agentsBuffer, statsBuffer, particleBuffers, threatAccumulator, speciesTableBuffer, paramsBuffer }) {
    this.dispatch(encoder, [
      paramsBuffer, agentsBuffer, statsBuffer, particleBuffers.particles, threatAccumulator, speciesTableBuffer,
    ], agentWorkgroups(agentsBuffer));
  }
}

export class PlayerContactPass extends ComputePass {
  constructor(gpu, { common }) {
    super(gpu, { common, shaderName: 'player_collide', label: 'player-collide' });
  }

  encode(encoder, { agentsBuffer, gridBuffers, statsBuffer, particleBuffers, speciesTableBuffer, paramsBuffer }) {
    this.dispatch(encoder, [
      paramsBuffer, agentsBuffer, gridBuffers.cellCounts, gridBuffers.cellOffsets, gridBuffers.sortedIndices,
      statsBuffer, particleBuffers.particles, speciesTableBuffer,
    ], 1);
  }
}
