// Projectile pass (projectiles.wgsl): one instanced quad per projectile slot, read straight from
// the projectile storage buffer. Drawn between the glyphs and the particles. The slot count is
// the projectile buffer's, so a dead slot costs one degenerate quad.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createUniformBuffer } from '../gpu/buffers.js';
import { PROJECTILE_STRIDE_BYTES } from '../game/projectiles.js';
import { PROJECTILE_KINDS, WEAPON_HUES } from '../game/weaponTypes.js';
import { MAX_BLEND, WORLD_VIEW_FLOATS, packWorldView } from './world-view.js';
import { SCENE_FORMAT, loadRenderShader } from './render-shaders.js';

export const PROJECTILE_VIEW_BYTES = 64;
const VERTICES_PER_QUAD = 4;

// The weapon whose palette entry colors each projectile kind.
const KIND_WEAPONS = Object.freeze({
  [PROJECTILE_KINDS.bullet]: 'base',
  [PROJECTILE_KINDS.scatter]: 'scatter',
  [PROJECTILE_KINDS.rail]: 'rail',
  [PROJECTILE_KINDS.pulseOrb]: 'pulse',
  [PROJECTILE_KINDS.pulseRing]: 'pulse',
  [PROJECTILE_KINDS.sidewinder]: 'sidewinders',
  [PROJECTILE_KINDS.beam]: 'beam',
});

// Matches the ProjectileView table in projectiles.wgsl: the world view, then one hue per kind.
export function packProjectileView({ viewport, time }) {
  const floats = new Float32Array(PROJECTILE_VIEW_BYTES / Float32Array.BYTES_PER_ELEMENT);
  packWorldView(viewport, time, floats);
  Object.entries(KIND_WEAPONS).forEach(([kind, weapon]) => {
    floats[WORLD_VIEW_FLOATS + Number(kind)] = WEAPON_HUES[weapon];
  });
  return floats;
}

export class ProjectileRenderer {
  // projectiles (a Projectiles) may be omitted and passed to encode instead.
  constructor(gpu, { projectiles = null, viewport, common }) {
    this.device = gpu.device;
    this.projectiles = projectiles;
    this.viewport = viewport;
    this.common = common;
    this.pipeline = null;
    this.viewBuffer = createUniformBuffer(this.device, PROJECTILE_VIEW_BYTES, 'projectile-view');
    this.bindGroupCache = new BindGroupCache((buffers) => this.device.createBindGroup({
      label: 'projectile-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const module = this.device.createShaderModule({ label: 'projectiles', code: await loadRenderShader('projectiles', this.common) });
    this.pipeline = await this.device.createRenderPipelineAsync({
      label: 'projectiles',
      layout: 'auto',
      vertex: { module, entryPoint: 'projectileVertex' },
      fragment: { module, entryPoint: 'projectileFragment', targets: [{ format: SCENE_FORMAT, blend: MAX_BLEND }] },
      primitive: { topology: 'triangle-strip' },
    });
  }

  // Draws into an open render pass whose color target is a scene texture.
  encode(pass, time, projectiles = this.projectiles) {
    if (projectiles === null) return;
    this.device.queue.writeBuffer(this.viewBuffer, 0, packProjectileView({ viewport: this.viewport, time }));
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroupCache.get([this.viewBuffer, projectiles.buffer]));
    pass.draw(VERTICES_PER_QUAD, projectiles.capacity);
  }

  destroy() {
    this.viewBuffer.destroy();
  }
}
