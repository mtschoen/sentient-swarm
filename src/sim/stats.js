// Per-frame stats reduction (stats.wgsl): alive totals per species plus the frame sequence, into
// the STATS_WORD_COUNT u32 stats buffer laid out as STATS_INDICES (layout.js). The step clears
// only the per-frame prefix (STATS_PERSISTENT_OFFSET_BYTES bytes); the tail persists. The scored
// kills counter lives in the tail, so it is cumulative over the simulation's life (u32, wraps) and
// a frame whose readback is skipped loses no kill: readers take differences.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { AGENT_STRIDE_BYTES, SHADER_CONSTANTS, SPECIES_COUNT, STATS_INDICES, STATS_PERSISTENT_WORD, STATS_WORD_COUNT, SWARM_HIT_MASK_WORDS, WORKGROUP_SIZE } from './layout.js';

export { STATS_INDICES };
const BYTES_PER_WORD = 4;
export const STATS_BYTES = STATS_WORD_COUNT * BYTES_PER_WORD;
export const STATS_PERSISTENT_OFFSET_BYTES = STATS_PERSISTENT_WORD * BYTES_PER_WORD;

// Decodes a read-back stats buffer; killsTotal is the cumulative scored kills counter.
// hitLatch is 1 while a hit waits for its acknowledgement (unused by the player swarm, whose
// per-slot hits are swarmHitMask, SWARM_HIT_MASK_WORDS words with slot s at bit s % 32 of word s / 32). lastRingX and lastRingY are f32 bits,
// meaningful only when ringsThisFrame is nonzero.
export function decodeStats(bytes) {
  const values = new Uint32Array(bytes, 0, STATS_WORD_COUNT);
  const floats = new Float32Array(bytes, 0, STATS_WORD_COUNT);
  return {
    aliveTotal: values[STATS_INDICES.aliveTotal],
    alivePerSpecies: values.slice(STATS_INDICES.firstSpecies, STATS_INDICES.firstSpecies + SPECIES_COUNT),
    killsTotal: values[STATS_INDICES.kills],
    frameSequence: values[STATS_INDICES.frameSequence],
    killsUnscored: values[STATS_INDICES.killsUnscored],
    playerHitSequence: values[STATS_INDICES.playerHitSequence],
    hitLatch: values[STATS_INDICES.hitLatch],
    ringsThisFrame: values[STATS_INDICES.ringsThisFrame],
    lastRingX: floats[STATS_INDICES.lastRingX],
    lastRingY: floats[STATS_INDICES.lastRingY],
    swarmHitMask: values.slice(STATS_INDICES.swarmHitMask, STATS_INDICES.swarmHitMask + SWARM_HIT_MASK_WORDS),
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
