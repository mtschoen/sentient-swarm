// Glyph pass (glyphs.wgsl): one instanced triangle strip per agent slot, additively blended into the
// scene target. Bindings: view uniform, SimParams uniform, agents, coarse field, species table (3
// storage buffers). Bind groups are cached per agent buffer, which ping-pongs every step.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createUniformBuffer } from '../gpu/buffers.js';
import { SCENE_FORMAT, loadRenderShader } from './render-shaders.js';

export const GLYPH_VIEW_BYTES = 48;
const VERTICES_PER_GLYPH = 4;
const ADDITIVE = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };

// Matches the GlyphView table in glyphs.wgsl. World to clip is affine, so two worldToClip samples
// give its scale and offset (inspectZoom included); the glyph size also grows with the zoom.
export function packGlyphView({ viewport, settings, alpha, time }) {
  const origin = viewport.worldToClip(0, 0);
  const unit = viewport.worldToClip(1, 1);
  return new Float32Array([
    unit.x - origin.x, unit.y - origin.y,
    origin.x, origin.y,
    2 / viewport.canvasWidth, 2 / viewport.canvasHeight,
    settings.glyphDevicePixels * viewport.inspectZoom, settings.glowScale,
    alpha, time,
    0, 0,
  ]);
}

export class GlyphPass {
  constructor(gpu, { common }) {
    this.device = gpu.device;
    this.common = common;
    this.pipeline = null;
    this.viewBuffer = createUniformBuffer(this.device, GLYPH_VIEW_BYTES, 'glyph-view');
    this.bindGroupCache = new BindGroupCache((buffers) => this.device.createBindGroup({
      label: 'glyph-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const module = this.device.createShaderModule({ label: 'glyphs', code: await loadRenderShader('glyphs', this.common) });
    this.pipeline = await this.device.createRenderPipelineAsync({
      label: 'glyphs',
      layout: 'auto',
      vertex: { module, entryPoint: 'glyphVertex' },
      fragment: {
        module,
        entryPoint: 'glyphFragment',
        targets: [{ format: SCENE_FORMAT, blend: { color: ADDITIVE, alpha: ADDITIVE } }],
      },
      primitive: { topology: 'triangle-strip' },
    });
  }

  // Draws into an open render pass whose color target is a scene texture.
  draw(pass, { simulation, viewport, settings, alpha, time }) {
    this.device.queue.writeBuffer(this.viewBuffer, 0, packGlyphView({ viewport, settings, alpha, time }));
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroupCache.get([
      this.viewBuffer, simulation.paramsBuffer, simulation.agentsBuffer, simulation.fieldBuffer, simulation.speciesTableBuffer,
    ]));
    pass.draw(VERTICES_PER_GLYPH, simulation.capacity);
  }

  destroy() {
    this.viewBuffer.destroy();
  }
}
