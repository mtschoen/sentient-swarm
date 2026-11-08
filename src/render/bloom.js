// Bloom: downsample the scene plus the warp grid layer to half resolution (bloom_downsample.wgsl),
// so threat-lit grid ripples glow too, then blur it separably
// (bloom_blur.wgsl): horizontal from first into second, vertical from second back into first.
// outputTexture holds the result after encode. Bloom quality sets the blur resolution: the scene
// divided by BLOOM_DIVISORS[quality] (high is half resolution); a lower resolution blurs fewer
// texels for a wider, softer glow.
import { createUniformBuffer } from '../gpu/buffers.js';
import { SCENE_FORMAT, createFullscreenPipeline, loadRenderShader } from './render-shaders.js';

const BLUR_UNIFORM_BYTES = 16;
export const BLOOM_DIVISORS = Object.freeze({ high: 2, medium: 3, low: 4 });

// Blur texture size for a scene of width by height device pixels at quality.
export function bloomTextureSize(widthDevicePixels, heightDevicePixels, quality) {
  const divisor = BLOOM_DIVISORS[quality];
  if (divisor === undefined) throw new Error(`Unknown bloom quality: ${quality}`);
  return [Math.max(1, Math.floor(widthDevicePixels / divisor)), Math.max(1, Math.floor(heightDevicePixels / divisor))];
}

function fullscreenDraw(encoder, label, view, pipeline, bindGroup) {
  const pass = encoder.beginRenderPass({
    label,
    colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
}

export class BloomPass {
  constructor(gpu, { fullscreenHeader }) {
    this.device = gpu.device;
    this.fullscreenHeader = fullscreenHeader;
    this.downsamplePipeline = null;
    this.blurPipeline = null;
    this.sampler = this.device.createSampler({ label: 'bloom-linear', magFilter: 'linear', minFilter: 'linear' });
    this.horizontalBuffer = createUniformBuffer(this.device, BLUR_UNIFORM_BYTES, 'bloom-blur-horizontal');
    this.verticalBuffer = createUniformBuffer(this.device, BLUR_UNIFORM_BYTES, 'bloom-blur-vertical');
    this.device.queue.writeBuffer(this.horizontalBuffer, 0, new Int32Array([1, 0, 0, 0]));
    this.device.queue.writeBuffer(this.verticalBuffer, 0, new Int32Array([0, 1, 0, 0]));
    this.textures = [];
    this.quality = 'high';
  }

  async initialize() {
    const [downsampleSource, blurSource] = await Promise.all([
      loadRenderShader('bloom_downsample', this.fullscreenHeader),
      loadRenderShader('bloom_blur', this.fullscreenHeader),
    ]);
    const downsampleModule = this.device.createShaderModule({ label: 'bloom-downsample', code: downsampleSource });
    const blurModule = this.device.createShaderModule({ label: 'bloom-blur', code: blurSource });
    [this.downsamplePipeline, this.blurPipeline] = await Promise.all([
      createFullscreenPipeline(this.device, { label: 'bloom-downsample', module: downsampleModule, fragmentEntryPoint: 'downsampleFragment', format: SCENE_FORMAT }),
      createFullscreenPipeline(this.device, { label: 'bloom-blur', module: blurModule, fragmentEntryPoint: 'blurFragment', format: SCENE_FORMAT }),
    ]);
  }

  get outputTexture() { return this.textures[0]; }

  // Recreates both blur textures (sized by this.quality) and every bind group that references a
  // texture. The caller sets quality before calling it.
  resize(sceneTextures, gridTexture, widthDevicePixels, heightDevicePixels) {
    this.destroyTextures();
    const size = bloomTextureSize(widthDevicePixels, heightDevicePixels, this.quality);
    this.textures = [0, 1].map((index) => this.device.createTexture({
      label: 'bloom-' + index,
      size,
      format: SCENE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    }));
    this.views = this.textures.map((texture) => texture.createView());
    const gridView = gridTexture.createView();
    this.downsampleBindGroups = sceneTextures.map((texture, index) => this.device.createBindGroup({
      label: 'bloom-downsample-' + index,
      layout: this.downsamplePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: this.sampler }, { binding: 2, resource: gridView }],
    }));
    const blurBindGroup = (label, buffer, view) => this.device.createBindGroup({
      label,
      layout: this.blurPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer } }, { binding: 1, resource: view }],
    });
    this.horizontalBindGroup = blurBindGroup('bloom-blur-horizontal', this.horizontalBuffer, this.views[0]);
    this.verticalBindGroup = blurBindGroup('bloom-blur-vertical', this.verticalBuffer, this.views[1]);
  }

  encode(encoder, sceneIndex) {
    fullscreenDraw(encoder, 'bloom-downsample', this.views[0], this.downsamplePipeline, this.downsampleBindGroups[sceneIndex]);
    fullscreenDraw(encoder, 'bloom-blur-horizontal', this.views[1], this.blurPipeline, this.horizontalBindGroup);
    fullscreenDraw(encoder, 'bloom-blur-vertical', this.views[0], this.blurPipeline, this.verticalBindGroup);
  }

  destroyTextures() {
    this.textures.forEach((texture) => texture.destroy());
    this.textures = [];
  }

  destroy() {
    this.destroyTextures();
    this.horizontalBuffer.destroy();
    this.verticalBuffer.destroy();
  }
}
