// World border (worldborder.wgsl): the world rectangle's edge as a bright line with a soft glow,
// one quad over the world rectangle drawn into the warp grid layer's pass right after the grid; the fragment shader lights the outline as a whole, so the corners are square and nothing is lit twice. That layer is
// cleared every frame, is never copied forward by the trail decay (so the line cannot smear while
// the camera moves) and feeds the bloom and the composite, so the line glows. The line's width and
// glow are device pixels scaled by the device pixel ratio, not world units, so they read the same
// on a phone and a desktop and do not vanish when the view shrinks.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createUniformBuffer } from '../gpu/buffers.js';
import { SCENE_FORMAT, loadRenderShader } from './render-shaders.js';

const ADDITIVE = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
// Half the core line's width and the glow's reach, in device pixels at a device pixel ratio of 1.
export const BORDER_CORE_HALF_PIXELS = 1.5;
export const BORDER_GLOW_PIXELS = 14;
export const BORDER_VIEW_BYTES = 32;
export const BORDER_VERTEX_COUNT = 6;

// The BorderView bytes (see worldborder.wgsl) for the viewport's current camera and canvas;
// fills target (a new Float32Array of 8 by default) and returns it.
export function packWorldBorder(viewport, target = new Float32Array(BORDER_VIEW_BYTES / Float32Array.BYTES_PER_ELEMENT)) {
  const origin = viewport.worldToClip(0, 0);
  const unit = viewport.worldToClip(1, 1);
  const pixelRatio = Math.max(1, viewport.devicePixelRatio);
  target.set([
    unit.x - origin.x, unit.y - origin.y, origin.x, origin.y,
    2 / viewport.canvasWidth, 2 / viewport.canvasHeight,
    BORDER_CORE_HALF_PIXELS * pixelRatio, BORDER_GLOW_PIXELS * pixelRatio,
  ]);
  return target;
}

export class WorldBorder {
  constructor(gpu, { viewport, common }) {
    this.device = gpu.device;
    this.viewport = viewport;
    this.common = common;
    this.pipeline = null;
    this.viewBuffer = createUniformBuffer(this.device, BORDER_VIEW_BYTES, 'world-border-view');
    this.viewData = new Float32Array(BORDER_VIEW_BYTES / Float32Array.BYTES_PER_ELEMENT);
    this.bindGroupCache = new BindGroupCache((buffers) => this.device.createBindGroup({
      label: 'world-border-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const code = await loadRenderShader('worldborder', this.common);
    const module = this.device.createShaderModule({ label: 'world-border', code });
    this.pipeline = await this.device.createRenderPipelineAsync({
      label: 'world-border',
      layout: 'auto',
      vertex: { module, entryPoint: 'borderVertex' },
      fragment: {
        module,
        entryPoint: 'borderFragment',
        targets: [{ format: SCENE_FORMAT, blend: { color: ADDITIVE, alpha: ADDITIVE } }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  // Draws into an open render pass whose color target is the grid layer.
  encode(pass) {
    this.device.queue.writeBuffer(this.viewBuffer, 0, packWorldBorder(this.viewport, this.viewData));
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroupCache.get([this.viewBuffer]));
    pass.draw(BORDER_VERTEX_COUNT);
  }

  destroy() {
    this.viewBuffer.destroy();
  }
}
