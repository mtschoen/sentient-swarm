// Player swarm pass (swarm.wgsl, player-swarm spike): the white swarm ships and the controlled
// point's marker, uploaded each frame into one uniform array, one instance per ship plus the marker.
import { createUniformBuffer } from '../gpu/buffers.js';
import { WEAPON_HUES } from '../game/weaponTypes.js';
import { MAXIMUM_SWARM_SHIPS } from '../sim/layout.js';
import { MAX_BLEND, WORLD_VIEW_FLOATS, packWorldView } from './world-view.js';
import { SCENE_FORMAT, loadQuadShader } from './render-shaders.js';

const HEADER_FLOATS = 8;
const FLOATS_PER_SHIP = 4;
const VIEW_FLOATS = WORLD_VIEW_FLOATS + HEADER_FLOATS + MAXIMUM_SWARM_SHIPS * FLOATS_PER_SHIP;
export const SWARM_VIEW_BYTES = VIEW_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const VERTICES_PER_QUAD = 4;

// Matches SwarmView in swarm.wgsl; fills floats (a new array by default) and returns it with the
// ship count drawn. Slots past the count keep their old values.
export function packSwarmView({ viewport, time, ships, facing, pointX, pointY, pointShown, armed }, floats = new Float32Array(VIEW_FLOATS)) {
  packWorldView(viewport, time, floats);
  const count = Math.min(ships.length, MAXIMUM_SWARM_SHIPS);
  floats.set([facing, pointX, pointY, pointShown ? 1 : 0, WEAPON_HUES[armed] ?? WEAPON_HUES.base, count, 0, 0], WORLD_VIEW_FLOATS);
  const first = WORLD_VIEW_FLOATS + HEADER_FLOATS;
  for (let index = 0; index < count; index += 1) {
    const ship = ships[index];
    const offset = first + index * FLOATS_PER_SHIP;
    floats[offset] = ship.x;
    floats[offset + 1] = ship.y;
    floats[offset + 2] = ship.age;
    floats[offset + 3] = 0;
  }
  return { floats, count };
}

export class SwarmRenderer {
  constructor(gpu, { viewport, common }) {
    this.device = gpu.device;
    this.viewport = viewport;
    this.common = common;
    this.pipeline = null;
    this.bindGroup = null;
    this.viewBuffer = createUniformBuffer(this.device, SWARM_VIEW_BYTES, 'swarm-view');
    this.viewFloats = new Float32Array(VIEW_FLOATS);
  }

  async initialize() {
    // MAXIMUM_SWARM_SHIPS comes from the substituted common header.
    const code = await loadQuadShader('swarm', this.common);
    const module = this.device.createShaderModule({ label: 'swarm', code });
    this.pipeline = await this.device.createRenderPipelineAsync({
      label: 'swarm',
      layout: 'auto',
      vertex: { module, entryPoint: 'swarmVertex' },
      fragment: { module, entryPoint: 'swarmFragment', targets: [{ format: SCENE_FORMAT, blend: MAX_BLEND }] },
      primitive: { topology: 'triangle-strip' },
    });
    this.bindGroup = this.device.createBindGroup({
      label: 'swarm-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.viewBuffer } }],
    });
  }

  // swarm: Game.scene().swarm. Draws into an open render pass whose target is a scene texture.
  encode(pass, swarm, time) {
    const { floats, count } = packSwarmView({ viewport: this.viewport, time, ...swarm }, this.viewFloats);
    this.device.queue.writeBuffer(this.viewBuffer, 0, floats);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(VERTICES_PER_QUAD, count + 1);
  }

  destroy() {
    this.viewBuffer.destroy();
  }
}
