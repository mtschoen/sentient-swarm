// Particle pass (particles.wgsl): one instanced 4-vertex triangle strip per particle pool slot,
// additively blended into the scene target after the glyphs, so particles leave trails like
// glyphs do. Dead slots collapse to a degenerate quad. The pool is passed at draw time and never
// stored (a capacity change builds a new Simulation and so a new pool); bind groups are cached per
// particle buffer and cleared by Renderer.setSimulation.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createUniformBuffer } from '../gpu/buffers.js';
import { SCENE_FORMAT, loadQuadShader } from './render-shaders.js';

export const PARTICLE_VIEW_BYTES = 32;
const PARTICLE_VIEW_FLOATS = PARTICLE_VIEW_BYTES / Float32Array.BYTES_PER_ELEMENT;
export const PARTICLE_DEVICE_PIXELS = 4;
// Lab range for setParticleDevicePixels (the burst particle size, task C0b2).
export const MINIMUM_PARTICLE_DEVICE_PIXELS = 1;
export const MAXIMUM_PARTICLE_DEVICE_PIXELS = 16;
const VERTICES_PER_PARTICLE = 4;
const ADDITIVE = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };

// Matches the ParticleView table in particles.wgsl. Same affine world-to-clip sampling as
// packShipView, so the inspect zoom applies; the quad size also grows with the zoom. Fills target
// (a new array by default) and returns it.
export function packParticleView(
  { viewport, particleDevicePixels = PARTICLE_DEVICE_PIXELS, emissionScale = 1 },
  target = new Float32Array(PARTICLE_VIEW_FLOATS),
) {
  const origin = viewport.worldToClip(0, 0);
  const unit = viewport.worldToClip(1, 1);
  target.set([
    unit.x - origin.x, unit.y - origin.y,
    origin.x, origin.y,
    2 / viewport.canvasWidth, 2 / viewport.canvasHeight,
    particleDevicePixels * viewport.effectiveZoom, emissionScale,
  ]);
  return target;
}

export class ParticleRenderer {
  constructor(gpu, { viewport, common }) {
    this.device = gpu.device;
    this.viewport = viewport;
    this.common = common;
    this.pipeline = null;
    this.viewBuffer = createUniformBuffer(this.device, PARTICLE_VIEW_BYTES, 'particle-view');
    this.viewFloats = new Float32Array(PARTICLE_VIEW_FLOATS);
    this.particleDevicePixels = PARTICLE_DEVICE_PIXELS;
    this.bindGroupCache = new BindGroupCache((buffers) => this.device.createBindGroup({
      label: 'particle-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const module = this.device.createShaderModule({ label: 'particles', code: await loadQuadShader('particles', this.common) });
    this.pipeline = await this.device.createRenderPipelineAsync({
      label: 'particles',
      layout: 'auto',
      vertex: { module, entryPoint: 'particleVertex' },
      fragment: {
        module,
        entryPoint: 'particleFragment',
        targets: [{ format: SCENE_FORMAT, blend: { color: ADDITIVE, alpha: ADDITIVE } }],
      },
      primitive: { topology: 'triangle-strip' },
    });
  }

  // The base quad size in device pixels at 1x zoom (sparks; fragments and the early burst scale
  // it up), in [MINIMUM_PARTICLE_DEVICE_PIXELS, MAXIMUM_PARTICLE_DEVICE_PIXELS]. Throws RangeError
  // and changes nothing when out of range. The renderer outlives capacity swaps, so it carries.
  setParticleDevicePixels(pixels) {
    if (!(pixels >= MINIMUM_PARTICLE_DEVICE_PIXELS && pixels <= MAXIMUM_PARTICLE_DEVICE_PIXELS)) {
      throw new RangeError(`particleDevicePixels must lie in [${MINIMUM_PARTICLE_DEVICE_PIXELS}, ${MAXIMUM_PARTICLE_DEVICE_PIXELS}], got ${pixels}`);
    }
    this.particleDevicePixels = pixels;
  }

  // Draws into an open render pass whose color target is a scene texture; Renderer passes
  // simulation.particlePool every frame.
  encode(pass, pool, emissionScale = 1) {
    const { viewport, particleDevicePixels } = this;
    this.device.queue.writeBuffer(this.viewBuffer, 0, packParticleView({ viewport, particleDevicePixels, emissionScale }, this.viewFloats));
    pool.registerBindGroupCache(this.bindGroupCache);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroupCache.get([this.viewBuffer, pool.buffers.particles]));
    pass.draw(VERTICES_PER_PARTICLE, pool.capacity);
  }

  destroy() {
    this.viewBuffer.destroy();
  }
}
