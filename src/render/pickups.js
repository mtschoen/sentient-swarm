// Pickup pass (pickups.wgsl): up to MAXIMUM_PICKUPS rotating hexagons, uploaded each frame into a
// small uniform array, one instance each.
import { createUniformBuffer } from '../gpu/buffers.js';
import { WEAPON_HUES } from '../game/weaponTypes.js';
import { MAX_BLEND, WORLD_VIEW_FLOATS, packWorldView } from './world-view.js';
import { SCENE_FORMAT, loadRenderShader } from './render-shaders.js';

export const MAXIMUM_PICKUPS = 32;
const FLOATS_PER_PICKUP = 4;
const VIEW_FLOATS = WORLD_VIEW_FLOATS + MAXIMUM_PICKUPS * FLOATS_PER_PICKUP;
export const PICKUP_VIEW_BYTES = VIEW_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const VERTICES_PER_QUAD = 4;

// Matches the PickupView table in pickups.wgsl; returns the packed floats and the pickup count.
export function packPickupView({ viewport, time, pickups }) {
  const floats = new Float32Array(VIEW_FLOATS);
  packWorldView(viewport, time, floats);
  const count = Math.min(pickups.length, MAXIMUM_PICKUPS);
  for (let index = 0; index < count; index += 1) {
    const { x, y, type, fade } = pickups[index];
    floats.set([x, y, WEAPON_HUES[type] ?? WEAPON_HUES.base, fade], WORLD_VIEW_FLOATS + index * FLOATS_PER_PICKUP);
  }
  return { floats, count };
}

export class PickupRenderer {
  constructor(gpu, { viewport, common }) {
    this.device = gpu.device;
    this.viewport = viewport;
    this.common = common;
    this.pipeline = null;
    this.bindGroup = null;
    this.viewBuffer = createUniformBuffer(this.device, PICKUP_VIEW_BYTES, 'pickup-view');
  }

  async initialize() {
    const module = this.device.createShaderModule({ label: 'pickups', code: await loadRenderShader('pickups', this.common) });
    this.pipeline = await this.device.createRenderPipelineAsync({
      label: 'pickups',
      layout: 'auto',
      vertex: { module, entryPoint: 'pickupVertex' },
      fragment: { module, entryPoint: 'pickupFragment', targets: [{ format: SCENE_FORMAT, blend: MAX_BLEND }] },
      primitive: { topology: 'triangle-strip' },
    });
    this.bindGroup = this.device.createBindGroup({
      label: 'pickup-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.viewBuffer } }],
    });
  }

  // pickups: [{ x, y, type, fade }]. Draws into an open render pass whose target is a scene texture.
  encode(pass, pickups, time) {
    const { floats, count } = packPickupView({ viewport: this.viewport, time, pickups });
    if (count === 0) return;
    this.device.queue.writeBuffer(this.viewBuffer, 0, floats);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(VERTICES_PER_QUAD, count);
  }

  destroy() {
    this.viewBuffer.destroy();
  }
}
