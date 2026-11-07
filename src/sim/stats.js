// Per-frame stats reduction (stats.wgsl): alive totals per species plus the frame sequence, into
// an 8 u32 stats buffer laid out as STATS_INDICES. The caller clears the buffer each frame.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { AGENT_STRIDE_BYTES, SHADER_CONSTANTS, SPECIES_COUNT, WORKGROUP_SIZE } from './layout.js';

export const STATS_INDICES = { aliveTotal: 0, firstSpecies: 1, kills: 6, frameSequence: 7 };
export const STATS_BYTES = 8 * 4;

// Decodes a read-back stats buffer.
export function decodeStats(bytes) {
  const values = new Uint32Array(bytes, 0, STATS_BYTES / 4);
  return {
    aliveTotal: values[STATS_INDICES.aliveTotal],
    alivePerSpecies: values.slice(STATS_INDICES.firstSpecies, STATS_INDICES.firstSpecies + SPECIES_COUNT),
    killsThisFrame: values[STATS_INDICES.kills],
    frameSequence: values[STATS_INDICES.frameSequence],
  };
}

export class StatsPass {
  constructor(gpu, { common }) {
    this.device = gpu.device;
    this.common = common;
    this.pipeline = null;
    this.bindGroupCache = new BindGroupCache(([agentsBuffer, statsBuffer, paramsBuffer]) => this.device.createBindGroup({
      label: 'stats-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [paramsBuffer, agentsBuffer, statsBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const source = prependCommon(substituteConstants(await loadShader('stats'), SHADER_CONSTANTS), this.common);
    const module = this.device.createShaderModule({ label: 'stats', code: source });
    this.pipeline = await this.device.createComputePipelineAsync({ label: 'stats', layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  encode(encoder, agentsBuffer, statsBuffer, paramsBuffer) {
    if (this.pipeline === null) throw new Error('StatsPass.initialize() must finish before encode()');
    const pass = encoder.beginComputePass({ label: 'stats' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroupCache.get([agentsBuffer, statsBuffer, paramsBuffer]));
    pass.dispatchWorkgroups(Math.ceil(agentsBuffer.size / AGENT_STRIDE_BYTES / WORKGROUP_SIZE));
    pass.end();
  }
}
