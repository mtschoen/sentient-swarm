// Trail decay pass (trails_decay.wgsl): the first draw of the scene pass writes the previous scene
// target times trailDecay into the current one, so glyphs leave fading trails.
import { createUniformBuffer } from '../gpu/buffers.js';
import { SCENE_FORMAT, createFullscreenPipeline, loadRenderShader } from './render-shaders.js';

const DECAY_UNIFORM_BYTES = 16;

export class TrailDecayPass {
  constructor(gpu, { fullscreenHeader }) {
    this.device = gpu.device;
    this.fullscreenHeader = fullscreenHeader;
    this.pipeline = null;
    this.decayBuffer = createUniformBuffer(this.device, DECAY_UNIFORM_BYTES, 'trail-decay');
    this.bindGroups = [];
  }

  async initialize() {
    const module = this.device.createShaderModule({ label: 'trails-decay', code: await loadRenderShader('trails_decay', this.fullscreenHeader) });
    this.pipeline = await createFullscreenPipeline(this.device, { label: 'trails-decay', module, fragmentEntryPoint: 'decayFragment', format: SCENE_FORMAT });
  }

  // bindGroups[index] reads sceneTextures[index] as the previous scene.
  setSceneTextures(sceneTextures) {
    this.bindGroups = sceneTextures.map((texture, index) => this.device.createBindGroup({
      label: 'trails-decay-' + index,
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.decayBuffer } },
        { binding: 1, resource: texture.createView() },
      ],
    }));
  }

  draw(pass, previousIndex, trailDecay) {
    this.device.queue.writeBuffer(this.decayBuffer, 0, new Float32Array([trailDecay, 0, 0, 0]));
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[previousIndex]);
    pass.draw(3);
  }

  destroy() {
    this.decayBuffer.destroy();
  }
}
