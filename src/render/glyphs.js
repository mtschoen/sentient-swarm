// Glyph pass (glyphs.wgsl): one instanced triangle strip per agent slot, additively blended into the
// scene target. Bindings: view uniform, SimParams uniform, agents, coarse field, species table (3
// storage buffers). Bind groups are cached per agent buffer, which ping-pongs every step.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createUniformBuffer } from '../gpu/buffers.js';
import { COARSE_COLUMNS, COARSE_ROWS } from '../sim/layout.js';
import { SCENE_FORMAT, loadRenderShader } from './render-shaders.js';

export const GLYPH_VIEW_BYTES = 48;
const VERTICES_PER_GLYPH = 4;
const ADDITIVE = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };

// Device-pixel area of one glyph body divided by the device-pixel area of one coarse cell, at
// any zoom (both scale with its square). Times the coarse density (agents per cell) it gives the
// fraction of a cell the glyph bodies cover, so density attenuation follows what is on screen: a
// smaller arena packs more fixed-size glyph pixels into each cell and attenuates more.
export function glyphCoverageScale(viewport, glyphDevicePixels) {
  const rect = viewport.arenaRectDevicePixels;
  const cellArea = (rect.width / COARSE_COLUMNS) * (rect.height / COARSE_ROWS);
  return (glyphDevicePixels * glyphDevicePixels) / Math.max(cellArea, 1e-6);
}

// Matches the GlyphView table in glyphs.wgsl. World to clip is affine, so two worldToClip samples
// give its scale and offset (inspectZoom included); the glyph size also grows with the zoom.
// emissionScale comes from trailFrameFactors.
export function packGlyphView({ viewport, settings, alpha, time, emissionScale = 1 }) {
  const origin = viewport.worldToClip(0, 0);
  const unit = viewport.worldToClip(1, 1);
  return new Float32Array([
    unit.x - origin.x, unit.y - origin.y,
    origin.x, origin.y,
    2 / viewport.canvasWidth, 2 / viewport.canvasHeight,
    settings.glyphDevicePixels * viewport.effectiveZoom, settings.glowScale,
    alpha, time,
    glyphCoverageScale(viewport, settings.glyphDevicePixels), emissionScale,
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
  draw(pass, { simulation, viewport, settings, alpha, time, emissionScale }) {
    this.device.queue.writeBuffer(this.viewBuffer, 0, packGlyphView({ viewport, settings, alpha, time, emissionScale }));
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
