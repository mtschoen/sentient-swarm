// Trail decay pass (trails_decay.wgsl): the first draw of the scene pass writes the previous scene
// target times the frame's decay into the current one, so glyphs leave fading trails.
import { createUniformBuffer } from '../gpu/buffers.js';
import { SCENE_FORMAT, createFullscreenPipeline, loadRenderShader } from './render-shaders.js';

const DECAY_UNIFORM_BYTES = 16;
// trailDecay is the fraction kept per 1/60 second, whatever the display refresh rate.
export const TRAIL_REFERENCE_FRAMES_PER_SECOND = 60;
// A longer frame (a stall, a background tab) decays as if this long, so it does not wipe trails.
export const MAXIMUM_TRAIL_DELTA_SECONDS = 0.1;

// Per-frame trail factors for a frame deltaSeconds long. decay = trailDecay ^ (deltaSeconds * 60)
// keeps the trail length in seconds fixed. Additive emission is scaled by
// (1 - decay) / (1 - trailDecay), the frame's share of one 1/60 second's steady-state input, so a
// 120 Hz display (twice the frames, each keeping more) holds the same steady-state brightness as
// 60 Hz. trailDecay 0 means no trails: decay 0 and emission 1 at any rate (single-frame captures).
export function trailFrameFactors(trailDecay, deltaSeconds) {
  if (!(trailDecay > 0)) return { decay: 0, emissionScale: 1 };
  const clampedSeconds = Math.min(Math.max(deltaSeconds, 0), MAXIMUM_TRAIL_DELTA_SECONDS);
  const referenceFrames = clampedSeconds * TRAIL_REFERENCE_FRAMES_PER_SECOND;
  const decay = Math.pow(trailDecay, referenceFrames);
  const emissionScale = trailDecay >= 1 ? referenceFrames : (1 - decay) / (1 - trailDecay);
  return { decay, emissionScale };
}

export class TrailDecayPass {
  constructor(gpu, { fullscreenHeader }) {
    this.device = gpu.device;
    this.fullscreenHeader = fullscreenHeader;
    this.pipeline = null;
    this.decayBuffer = createUniformBuffer(this.device, DECAY_UNIFORM_BYTES, 'trail-decay');
    this.decayFloats = new Float32Array(DECAY_UNIFORM_BYTES / Float32Array.BYTES_PER_ELEMENT);
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

  // decay is this frame's factor (trailFrameFactors), not the per-1/60-second setting.
  draw(pass, previousIndex, decay) {
    this.decayFloats[0] = decay;
    this.device.queue.writeBuffer(this.decayBuffer, 0, this.decayFloats);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[previousIndex]);
    pass.draw(3);
  }

  destroy() {
    this.decayBuffer.destroy();
  }
}
