// Player swarm pass (swarm.wgsl, player-swarm spike): each seat's swarm ships and the controlled
// point's marker, uploaded each frame into one uniform array, one instance per ship plus the marker.
import { createUniformBuffer } from '../gpu/buffers.js';
import { WEAPON_HUES } from '../game/weaponTypes.js';
import { MAXIMUM_SWARM_SHIPS } from '../sim/layout.js';
import { SWARM_SHIP_SIZE } from '../game/player-swarm.js';
import { SEAT_COLORS } from '../game/seat-colors.js';
import { SHIP_ZOOM_EXPONENT } from './glyphs.js';
import { MAX_BLEND, WORLD_VIEW_FLOATS, packWorldView } from './world-view.js';
import { SCENE_FORMAT, loadQuadShader } from './render-shaders.js';

const HEADER_FLOATS = 12;
const FLOATS_PER_SHIP = 4;
const VIEW_FLOATS = WORLD_VIEW_FLOATS + HEADER_FLOATS + MAXIMUM_SWARM_SHIPS * FLOATS_PER_SHIP;
export const SWARM_VIEW_BYTES = VIEW_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const VERTICES_PER_QUAD = 4;

// Matches SwarmView in swarm.wgsl; fills floats (a new array by default) and returns it with the
// ship count drawn. Slots past the count keep their old values.
export function packSwarmView({ viewport, time, ships, facing, pointX, pointY, pointShown, armed, bodyColor = [1, 1, 1] }, floats = new Float32Array(VIEW_FLOATS)) {
  packWorldView(viewport, time, floats);
  const count = Math.min(ships.length, MAXIMUM_SWARM_SHIPS);
  // On-screen ship size follows the glyphs' square-root law: exactly SWARM_SHIP_SIZE at zoom 1.
  const shipSize = SWARM_SHIP_SIZE * viewport.cameraZoom ** (SHIP_ZOOM_EXPONENT - 1);
  floats.set([facing, pointX, pointY, pointShown ? 1 : 0, WEAPON_HUES[armed] ?? WEAPON_HUES.base, count, shipSize, 0, bodyColor[0], bodyColor[1], bodyColor[2], 0], WORLD_VIEW_FLOATS);
  const first = WORLD_VIEW_FLOATS + HEADER_FLOATS;
  for (let index = 0; index < count; index += 1) {
    const ship = ships[index];
    const offset = first + index * FLOATS_PER_SHIP;
    floats[offset] = ship.x;
    floats[offset + 1] = ship.y;
    floats[offset + 2] = ship.age;
    floats[offset + 3] = ship.heading ?? 0;
  }
  return { floats, count };
}

export class SwarmRenderer {
  constructor(gpu, { viewport, common }) {
    this.device = gpu.device;
    this.viewport = viewport;
    this.common = common;
    this.pipeline = null;
    // One view buffer, float array and bind group per seat color.
    this.bindGroups = [];
    this.viewBuffers = SEAT_COLORS.map((color, index) => createUniformBuffer(this.device, SWARM_VIEW_BYTES, 'swarm-view-' + index));
    this.viewFloats = SEAT_COLORS.map(() => new Float32Array(VIEW_FLOATS));
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
    this.bindGroups = this.viewBuffers.map((buffer, index) => this.device.createBindGroup({
      label: 'swarm-bindings-' + index,
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer } }],
    }));
  }

  // swarms: Game.scene().swarms, one entry per seat drawn (entries past the view buffers are
  // ignored). Draws into an open render pass whose target is a scene texture.
  encode(pass, swarms, time) {
    const drawn = Math.min(swarms.length, this.viewBuffers.length);
    for (let index = 0; index < drawn; index += 1) {
      const { floats, count } = packSwarmView({ viewport: this.viewport, time, ...swarms[index] }, this.viewFloats[index]);
      this.device.queue.writeBuffer(this.viewBuffers[index], 0, floats);
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroups[index]);
      pass.draw(VERTICES_PER_QUAD, count + 1);
    }
  }

  destroy() {
    this.viewBuffers.forEach((buffer) => buffer.destroy());
  }
}
