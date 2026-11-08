// Agent kill passes on the freshly integrated agents. Each adds to the stats kill words, spawns
// splash particles into the pool (cursor in its header) and, except player contact, adds threat to
// the coarse field accumulator.
// - DebugKillPass (kill_debug.wgsl): agents inside params.debugKillRadius of
//   params.debugKillPosition, counted in kills. Storage buffers: agents, stats, particles, threat
//   accumulator, species table (5), plus the params uniform.
// - KillAllPass (kill_all.wgsl): every alive agent, spawning ones included, or with an area
//   (the pickup blast) only those within its radius of its center, counted in killsUnscored. A
//   countAlive dispatch first counts them into the particle pool header, so the bursts can be
//   thinned evenly when the clear would outrun the free particle slots. Storage buffers: agents,
//   stats, particles, threat accumulator, species table (5), plus the params and area uniforms
//   (countAlive binds only params, agents, particles and area).
// Every kill asks for params.killBurstParticles particles from one budget per step: the slots
// free after the last particle step (ParticlePool.encodeBeginStep zeroes the step's claims).
// - PlayerContactPass (player_collide.wgsl, one workgroup): the hit latch and the one agent that
//   touches the player, counted in killsUnscored. Storage buffers: agents, cellCounts,
//   cellOffsets, sortedIndices, stats, particles, species table (7), plus the params uniform.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createUniformBuffer } from '../gpu/buffers.js';
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

// KillArea in kill_all.wgsl: center vec2f, radius f32, radial u32.
const KILL_AREA_BYTES = 16;

// The KillArea uniform for a kill-all (area null) or a radial kill ({ x, y, radius }).
export function packKillArea(area) {
  const bytes = new ArrayBuffer(KILL_AREA_BYTES);
  const view = new DataView(bytes);
  if (area !== null) {
    view.setFloat32(0, area.x, true);
    view.setFloat32(4, area.y, true);
    view.setFloat32(8, area.radius, true);
    view.setUint32(12, 1, true);
  }
  return bytes;
}

// The six buffers, in binding order, that the debug kill and kill-all shaders share (the params
// uniform at 0, then the storage buffers); kill-all appends its area uniform.
function killBuffers({ agentsBuffer, statsBuffer, particleBuffers, threatAccumulator, speciesTableBuffer, paramsBuffer }) {
  return [paramsBuffer, agentsBuffer, statsBuffer, particleBuffers.particles, threatAccumulator, speciesTableBuffer];
}

function agentWorkgroups(agentsBuffer) {
  return Math.ceil(agentsBuffer.size / AGENT_STRIDE_BYTES / WORKGROUP_SIZE);
}

export class DebugKillPass extends ComputePass {
  constructor(gpu, { common }) {
    super(gpu, { common, shaderName: 'kill_debug', label: 'kill-debug' });
  }

  encode(encoder, context) {
    this.dispatch(encoder, killBuffers(context), agentWorkgroups(context.agentsBuffer));
  }
}

export class KillAllPass extends ComputePass {
  constructor(gpu, { common }) {
    super(gpu, { common, shaderName: 'kill_all', label: 'kill-all' });
    this.countPipeline = null;
    this.areaBuffer = createUniformBuffer(this.device, KILL_AREA_BYTES, 'kill-all-area');
    this.countBindGroupCache = new BindGroupCache(([paramsBuffer, agentsBuffer, particlesBuffer]) => this.device.createBindGroup({
      label: 'kill-all-count-bindings',
      layout: this.countPipeline.getBindGroupLayout(0),
      entries: [[0, paramsBuffer], [1, agentsBuffer], [3, particlesBuffer], [6, this.areaBuffer]].map(([binding, buffer]) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const source = prependCommon(substituteConstants(await loadShader(this.shaderName), SHADER_CONSTANTS), this.common);
    const module = this.device.createShaderModule({ label: this.label, code: source });
    const pipeline = (entryPoint) => this.device.createComputePipelineAsync({ label: this.label + '-' + entryPoint, layout: 'auto', compute: { module, entryPoint } });
    [this.countPipeline, this.pipeline] = await Promise.all([pipeline('countAlive'), pipeline('main')]);
  }

  // area: null kills every alive agent; { x, y, radius } only those within radius of (x, y). It
  // is written with queue.writeBuffer, so one kill-all per submission.
  encode(encoder, context, area = null) {
    const { agentsBuffer, particleBuffers, paramsBuffer } = context;
    if (this.countPipeline === null) throw new Error('KillAllPass.initialize() must finish before encode()');
    this.device.queue.writeBuffer(this.areaBuffer, 0, packKillArea(area));
    const workgroups = agentWorkgroups(agentsBuffer);
    const pass = encoder.beginComputePass({ label: this.label + '-count' });
    pass.setPipeline(this.countPipeline);
    pass.setBindGroup(0, this.countBindGroupCache.get([paramsBuffer, agentsBuffer, particleBuffers.particles]));
    pass.dispatchWorkgroups(workgroups);
    pass.end();
    this.dispatch(encoder, [...killBuffers(context), this.areaBuffer], workgroups);
  }

  destroy() {
    this.areaBuffer.destroy();
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
