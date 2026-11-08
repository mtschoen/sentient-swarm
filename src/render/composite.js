// Composite pass (composite.wgsl): scene plus warp grid layer plus bloom, tonemapped, into the swapchain, with black
// letterbox bands outside the arena rect. timeWarp (0 to 1, the time warp strength) blends toward a
// cold desaturated blue, at most TIME_WARP_TINT_MAXIMUM in the shader (owner ruling R31).
import { createUniformBuffer } from '../gpu/buffers.js';
import { createFullscreenPipeline, loadRenderShader } from './render-shaders.js';

const COMPOSITE_UNIFORM_BYTES = 32;
// The shipped scene radiance scale ahead of the tonemap; the renderer's exposure setting (1 by
// default, the lab slider) multiplies it.
export const BASE_EXPOSURE = 0.15;

export function packCompositeUniform({ arenaRect, bloomStrength, exposure = 1, timeWarp = 0 }) {
  const warp = Math.min(1, Math.max(0, timeWarp));
  return new Float32Array([arenaRect.x, arenaRect.y, arenaRect.width, arenaRect.height, bloomStrength, BASE_EXPOSURE * exposure, warp, 0]);
}

export class CompositePass {
  constructor(gpu, { fullscreenHeader }) {
    this.device = gpu.device;
    this.format = gpu.format;
    this.fullscreenHeader = fullscreenHeader;
    this.pipeline = null;
    this.sampler = this.device.createSampler({ label: 'composite-linear', magFilter: 'linear', minFilter: 'linear' });
    this.uniformBuffer = createUniformBuffer(this.device, COMPOSITE_UNIFORM_BYTES, 'composite');
    this.bindGroups = [];
  }

  async initialize() {
    const module = this.device.createShaderModule({ label: 'composite', code: await loadRenderShader('composite', this.fullscreenHeader) });
    this.pipeline = await createFullscreenPipeline(this.device, { label: 'composite', module, fragmentEntryPoint: 'compositeFragment', format: this.format });
  }

  // bindGroups[index] composites sceneTextures[index] with the bloom output and the grid layer.
  setTextures(sceneTextures, bloomTexture, gridTexture) {
    const bloomView = bloomTexture.createView();
    const gridView = gridTexture.createView();
    this.bindGroups = sceneTextures.map((texture, index) => this.device.createBindGroup({
      label: 'composite-' + index,
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: bloomView },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: gridView },
      ],
    }));
  }

  encode(encoder, targetView, sceneIndex, { arenaRect, bloomStrength, exposure = 1, timeWarp = 0 }) {
    this.device.queue.writeBuffer(this.uniformBuffer, 0, packCompositeUniform({ arenaRect, bloomStrength, exposure, timeWarp }));
    const pass = encoder.beginRenderPass({
      label: 'composite',
      colorAttachments: [{ view: targetView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[sceneIndex]);
    pass.draw(3);
    pass.end();
  }

  destroy() {
    this.uniformBuffer.destroy();
  }
}
