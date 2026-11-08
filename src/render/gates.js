// Spawn gate pass (gates.wgsl, owner ruling R14, task C0b2): one instanced quad per gate in the
// simulation's last gate table (Simulation.spawnGates, from SpawnDirector.spawnGates), so the
// player can read where waves come from. A gate is a rotating dashed ring in its favored species'
// hue that fades with its open amount, brightens while it is telegraphed as the next wave's gate
// and flares while it emits. Drawn with max blending into the scene target, like the pickups.
import { createUniformBuffer } from '../gpu/buffers.js';
import { MAXIMUM_SPAWN_GATES } from '../sim/spawn-director.js';
import { MAX_BLEND, WORLD_VIEW_FLOATS, packWorldView } from './world-view.js';
import { SCENE_FORMAT, loadRenderShader } from './render-shaders.js';

const FLOATS_PER_GATE = 8;
const VIEW_FLOATS = WORLD_VIEW_FLOATS + MAXIMUM_SPAWN_GATES * FLOATS_PER_GATE;
export const GATE_VIEW_BYTES = VIEW_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const VERTICES_PER_QUAD = 4;

// Matches the GateView table in gates.wgsl. spawnGates: { gates: [{ x, y, radius, species, open,
// emit, telegraph }] } or null; species: the species rows (for the hue). Returns the packed floats
// and the gate count.
export function packGateView({ viewport, time, spawnGates, species }) {
  const floats = new Float32Array(VIEW_FLOATS);
  packWorldView(viewport, time, floats);
  const gates = (spawnGates?.gates ?? []).slice(0, MAXIMUM_SPAWN_GATES);
  gates.forEach((gate, index) => {
    const hue = species[gate.species]?.hue ?? 0;
    floats.set([gate.x, gate.y, gate.radius, gate.open, hue, gate.emit, gate.telegraph, index], WORLD_VIEW_FLOATS + index * FLOATS_PER_GATE);
  });
  return { floats, count: gates.length };
}

export class GateRenderer {
  constructor(gpu, { viewport, common }) {
    this.device = gpu.device;
    this.viewport = viewport;
    this.common = common;
    this.pipeline = null;
    this.bindGroup = null;
    this.viewBuffer = createUniformBuffer(this.device, GATE_VIEW_BYTES, 'gate-view');
  }

  async initialize() {
    const module = this.device.createShaderModule({ label: 'gates', code: await loadRenderShader('gates', this.common) });
    this.pipeline = await this.device.createRenderPipelineAsync({
      label: 'gates',
      layout: 'auto',
      vertex: { module, entryPoint: 'gateVertex' },
      fragment: { module, entryPoint: 'gateFragment', targets: [{ format: SCENE_FORMAT, blend: MAX_BLEND }] },
      primitive: { topology: 'triangle-strip' },
    });
    this.bindGroup = this.device.createBindGroup({
      label: 'gate-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.viewBuffer } }],
    });
  }

  // Draws into an open render pass whose target is a scene texture.
  encode(pass, simulation, time) {
    const { floats, count } = packGateView({ viewport: this.viewport, time, spawnGates: simulation.spawnGates, species: simulation.species });
    if (count === 0) return;
    this.device.queue.writeBuffer(this.viewBuffer, 0, floats);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(VERTICES_PER_QUAD, count);
  }

  destroy() {
    this.viewBuffer.destroy();
  }
}
