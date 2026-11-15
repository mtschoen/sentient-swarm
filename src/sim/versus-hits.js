// VersusHitPass (versus_hits.wgsl, one thread per projectile slot): owned projectiles against the
// opposing seat's swarm ships, claiming hit bits on the persistent swarm hit masks the contact pass
// keeps. Simulation runs it after player contact, only while versus projectiles are set
// (Simulation.setVersusProjectiles), so solo and co-op never dispatch it. It binds the contact
// pass's swarm uniform, already written for the step. Storage buffers: projectiles, stats (2), plus
// the params and swarm uniforms.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { SHADER_CONSTANTS, WORKGROUP_SIZE } from './layout.js';

// Bytes of one Projectile slot (common.wgsl); the dispatch covers every slot of the buffer.
const PROJECTILE_STRIDE_BYTES = 48;

export function versusHitWorkgroups(projectileBuffer) {
  return Math.ceil(projectileBuffer.size / PROJECTILE_STRIDE_BYTES / WORKGROUP_SIZE);
}

export class VersusHitPass {
  constructor(gpu, { common }) {
    this.device = gpu.device;
    this.common = common;
    this.pipeline = null;
    this.bindGroupCache = new BindGroupCache((buffers) => this.device.createBindGroup({
      label: 'versus-hits-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const source = prependCommon(substituteConstants(await loadShader('versus_hits'), SHADER_CONSTANTS), this.common);
    const module = this.device.createShaderModule({ label: 'versus-hits', code: source });
    this.pipeline = await this.device.createComputePipelineAsync({ label: 'versus-hits', layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  encode(encoder, { paramsBuffer, swarmBuffer, projectileBuffer, statsBuffer }) {
    if (this.pipeline === null) throw new Error('VersusHitPass.initialize() must finish before encode()');
    const pass = encoder.beginComputePass({ label: 'versus-hits' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroupCache.get([paramsBuffer, swarmBuffer, projectileBuffer, statsBuffer]));
    pass.dispatchWorkgroups(versusHitWorkgroups(projectileBuffer));
    pass.end();
  }
}
