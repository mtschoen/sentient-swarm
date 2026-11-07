// Ship pass (ship.wgsl): the player's spaceship and its charge ring, one instanced quad drawn
// after the particles so nothing hides it. The rendered heading eases toward the aim angle at a
// finite turn rate so turns read as turns; fire direction stays the exact aim (the game's job).
import { createUniformBuffer } from '../gpu/buffers.js';
import { WEAPON_HUES } from '../game/weaponTypes.js';
import { MAX_BLEND, WORLD_VIEW_FLOATS, packWorldView } from './world-view.js';
import { SCENE_FORMAT, loadRenderShader } from './render-shaders.js';

export const SHIP_VIEW_BYTES = 64;
// Radians per second: a half turn takes about a quarter second.
export const SHIP_TURN_RATE = 12;
export const BLINK_HERTZ = 8;
const BLINK_DIM_BRIGHTNESS = 0.15;
const MAXIMUM_EASE_SECONDS = 0.1;
const TWO_PI = Math.PI * 2;
const VERTICES_PER_QUAD = 4;

// Moves current toward target along the shortest arc by at most maximumStep radians.
export function easeAngle(current, target, maximumStep) {
  let difference = (target - current) % TWO_PI;
  if (difference > Math.PI) difference -= TWO_PI;
  if (difference < -Math.PI) difference += TWO_PI;
  if (Math.abs(difference) <= maximumStep) return target;
  return current + Math.sign(difference) * maximumStep;
}

// Matches the ShipView table in ship.wgsl.
export function packShipView({ viewport, time, x, y, facing, charge, armed, invulnerable }) {
  const floats = new Float32Array(SHIP_VIEW_BYTES / Float32Array.BYTES_PER_ELEMENT);
  packWorldView(viewport, time, floats);
  const blinkOn = (time * BLINK_HERTZ) % 1 < 0.5;
  floats.set([
    x, y,
    facing, Math.min(1, Math.max(0, charge)),
    WEAPON_HUES[armed] ?? WEAPON_HUES.base, armed === 'base' ? 0 : 1,
    invulnerable && !blinkOn ? BLINK_DIM_BRIGHTNESS : 1, 0,
  ], WORLD_VIEW_FLOATS);
  return floats;
}

export class ShipRenderer {
  constructor(gpu, { viewport, common }) {
    this.device = gpu.device;
    this.viewport = viewport;
    this.common = common;
    this.pipeline = null;
    this.bindGroup = null;
    this.viewBuffer = createUniformBuffer(this.device, SHIP_VIEW_BYTES, 'ship-view');
    this.renderedFacing = null;
    this.lastTime = null;
  }

  async initialize() {
    const module = this.device.createShaderModule({ label: 'ship', code: await loadRenderShader('ship', this.common) });
    this.pipeline = await this.device.createRenderPipelineAsync({
      label: 'ship',
      layout: 'auto',
      vertex: { module, entryPoint: 'shipVertex' },
      fragment: { module, entryPoint: 'shipFragment', targets: [{ format: SCENE_FORMAT, blend: MAX_BLEND }] },
      primitive: { topology: 'triangle-strip' },
    });
    this.bindGroup = this.device.createBindGroup({
      label: 'ship-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.viewBuffer } }],
    });
  }

  // The facing to draw: the first call snaps to the aim, later calls ease by the time elapsed
  // (a clock that stalls or runs backwards moves it by nothing).
  easedFacing(targetFacing, time) {
    if (this.renderedFacing === null) {
      this.renderedFacing = targetFacing;
    } else {
      const elapsed = Math.min(MAXIMUM_EASE_SECONDS, Math.max(0, time - this.lastTime));
      this.renderedFacing = easeAngle(this.renderedFacing, targetFacing, SHIP_TURN_RATE * elapsed);
    }
    this.lastTime = time;
    return this.renderedFacing;
  }

  // Draws into an open render pass whose color target is a scene texture. facing is the aim angle.
  encode(pass, { x, y, facing, charge, armed, invulnerable, time }) {
    const renderedFacing = this.easedFacing(facing, time);
    this.device.queue.writeBuffer(this.viewBuffer, 0, packShipView({
      viewport: this.viewport, time, x, y, facing: renderedFacing, charge, armed, invulnerable,
    }));
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(VERTICES_PER_QUAD, 1);
  }

  destroy() {
    this.viewBuffer.destroy();
  }
}
