// Glyph pass (glyphs.wgsl, with the ship shapes of ships.wgsl prepended after common.wgsl and
// quad.wgsl): one instanced triangle strip per agent slot, additively blended into the scene
// target. Bindings: view uniform, SimParams uniform, agents, coarse field, species table, previous agents (4
// storage buffers). Bind groups are cached per agent buffer pair, which ping-pongs every step.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createUniformBuffer } from '../gpu/buffers.js';
import { prependCommon } from '../gpu/shaders.js';
import { COARSE_COLUMNS, COARSE_ROWS } from '../sim/layout.js';
import { SCENE_FORMAT, loadQuadHeader, loadRenderShader } from './render-shaders.js';

export const GLYPH_VIEW_BYTES = 64;
const GLYPH_VIEW_FLOATS = GLYPH_VIEW_BYTES / Float32Array.BYTES_PER_ELEMENT;
const VERTICES_PER_GLYPH = 4;
const ADDITIVE = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };

// Smallest ship length in device pixels, so ships keep a readable silhouette on small arenas.
export const MINIMUM_SHIP_DEVICE_PIXELS = 8;
// Ships grow with the inspect zoom raised to this power, slower than the view, so zooming in
// separates a crowd instead of enlarging its overlap.
export const SHIP_ZOOM_EXPONENT = 0.5;

// On-screen ship length (the glyph body, local [-1, 1]) in device pixels: shipArenaFraction of the
// world height (9 units, so the ship's world size is the same at every aspect), at least MINIMUM_SHIP_DEVICE_PIXELS, times effectiveZoom ** SHIP_ZOOM_EXPONENT.
// A fraction of 0 or less hides the ships (the smoke's kill-flash check does this); a missing or
// non-numeric fraction throws instead of silently hiding them.
export function shipDevicePixels(viewport, shipArenaFraction) {
  if (typeof shipArenaFraction !== 'number' || Number.isNaN(shipArenaFraction)) {
    throw new TypeError(`shipArenaFraction must be a number, got ${shipArenaFraction}`);
  }
  if (shipArenaFraction <= 0) return 0;
  const unzoomed = Math.max(MINIMUM_SHIP_DEVICE_PIXELS, shipArenaFraction * viewport.worldRectDevicePixels.height);
  return unzoomed * viewport.effectiveZoom ** SHIP_ZOOM_EXPONENT;
}

// Device-pixel area of one on-screen ship body divided by the on-screen device-pixel area of one
// coarse cell (the field covers the whole world) (which grows with the square of the zoom). Times the coarse density (agents per
// cell) it gives the fraction of a cell the ship bodies cover, so density attenuation follows what
// is on screen: zooming in spreads the ships apart and attenuates less.
export function shipCoverageScale(viewport, shipPixels) {
  const rect = viewport.worldRectDevicePixels;
  const zoom = viewport.effectiveZoom;
  const cellArea = (rect.width / COARSE_COLUMNS) * (rect.height / COARSE_ROWS) * zoom * zoom;
  return (shipPixels * shipPixels) / Math.max(cellArea, 1e-6);
}

// Matches the GlyphView table in glyphs.wgsl. World to clip is affine, so two worldToClip samples
// give its scale and offset (inspectZoom included); the ship size comes from shipDevicePixels.
// emissionScale comes from trailFrameFactors; interpolate (half simulation rate) blends from the
// previous step's position to the newest by alpha instead of extrapolating by velocity. Fills
// target (a new array by default) and returns it.
export function packShipView(
  { viewport, settings, alpha, time, emissionScale = 1, interpolate = false },
  target = new Float32Array(GLYPH_VIEW_FLOATS),
) {
  const origin = viewport.worldToClip(0, 0);
  const unit = viewport.worldToClip(1, 1);
  const shipPixels = shipDevicePixels(viewport, settings.shipArenaFraction);
  target.set([
    unit.x - origin.x, unit.y - origin.y,
    origin.x, origin.y,
    2 / viewport.canvasWidth, 2 / viewport.canvasHeight,
    shipPixels, settings.glowScale,
    alpha, time,
    shipCoverageScale(viewport, shipPixels), emissionScale,
    interpolate ? 1 : 0, 0, 0, 0,
  ]);
  return target;
}

export class GlyphPass {
  constructor(gpu, { common }) {
    this.device = gpu.device;
    this.common = common;
    this.pipeline = null;
    this.viewBuffer = createUniformBuffer(this.device, GLYPH_VIEW_BYTES, 'glyph-view');
    this.viewFloats = new Float32Array(GLYPH_VIEW_FLOATS);
    this.bindGroupCache = new BindGroupCache((buffers) => this.device.createBindGroup({
      label: 'glyph-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const header = prependCommon(await loadRenderShader('ships'), await loadQuadHeader(this.common));
    const module = this.device.createShaderModule({ label: 'glyphs', code: await loadRenderShader('glyphs', header) });
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
  draw(pass, { simulation, viewport, settings, alpha, time, emissionScale, interpolate = false }) {
    const view = packShipView({ viewport, settings, alpha, time, emissionScale, interpolate }, this.viewFloats);
    this.device.queue.writeBuffer(this.viewBuffer, 0, view);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroupCache.get([
      this.viewBuffer, simulation.paramsBuffer, simulation.agentsBuffer, simulation.fieldBuffer, simulation.speciesTableBuffer,
      simulation.previousAgentsBuffer,
    ]));
    pass.draw(VERTICES_PER_GLYPH, simulation.capacity);
  }

  destroy() {
    this.viewBuffer.destroy();
  }
}
