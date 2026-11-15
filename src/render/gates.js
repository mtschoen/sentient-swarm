// Spawn gate pass (gates.wgsl, owner ruling R14, task C0b2): one instanced quad per gate in the
// simulation's last gate table (Simulation.spawnGates, from SpawnDirector.spawnGates), so the
// player can read where waves come from. A gate is a rotating dashed ring in its favored species'
// hue that fades with its open amount, brightens while it is telegraphed as the next wave's gate
// and flares while it emits. Drawn with max blending into the scene target, like the pickups.
// Hives (stage 3): when the table's rows carry a hive ({ owner, capturer, progress }, hive-seats.js)
// the same quads are drawn by the hive pipeline (hiveFragment in gates.wgsl, with the HiveView
// uniform at binding 1): a neutral hive is a pale dashed ring, an owned one a solid ring and haze in
// its seat's color, and capture progress an arc around it in the capturer's color, filling clockwise
// from the top. Any other table draws exactly the gates above.
import { createUniformBuffer } from '../gpu/buffers.js';
import { MAXIMUM_SPAWN_GATES } from '../sim/spawn-director.js';
import { MAX_BLEND, WORLD_VIEW_FLOATS, packWorldView } from './world-view.js';
import { SCENE_FORMAT, loadQuadShader } from './render-shaders.js';
import { SEAT_COLORS } from '../game/seat-colors.js';

const FLOATS_PER_GATE = 8;
const VIEW_FLOATS = WORLD_VIEW_FLOATS + MAXIMUM_SPAWN_GATES * FLOATS_PER_GATE;
export const GATE_VIEW_BYTES = VIEW_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const VERTICES_PER_QUAD = 4;
// HiveView in gates.wgsl: two seat colors (rgb, 0), then per gate row (hive, owner, progress,
// capturer) with owner and capturer as seat plus 1 (0 none).
const HIVE_VIEW_FLOATS = 2 * 4 + MAXIMUM_SPAWN_GATES * 4;
export const HIVE_VIEW_BYTES = HIVE_VIEW_FLOATS * Float32Array.BYTES_PER_ELEMENT;

// Whether a gate table holds hive rows (hives mode), which the hive pipeline draws.
export function isHiveTable(spawnGates) {
  return (spawnGates?.gates ?? []).some((gate) => gate.hive !== undefined);
}

// Packs HiveView for the table's rows (in packGateView's order); rows without a hive get zeros.
export function packHiveView(spawnGates, floats = new Float32Array(HIVE_VIEW_FLOATS)) {
  floats.fill(0);
  SEAT_COLORS.forEach(({ body }, seat) => floats.set(body, seat * 4));
  const seatField = (seat) => (seat === null || seat === undefined ? 0 : seat + 1);
  (spawnGates?.gates ?? []).slice(0, MAXIMUM_SPAWN_GATES).forEach(({ hive }, index) => {
    if (hive === undefined) return;
    floats.set([1, seatField(hive.owner), hive.progress, seatField(hive.capturer)], 8 + index * 4);
  });
  return floats;
}

// Matches the GateView table in gates.wgsl. spawnGates: { gates: [{ x, y, radius, species, open,
// emit, telegraph }] } or null; species: the species rows (for the hue). Returns the packed floats
// and the gate count. Fills floats (a new array by default); slots past the count keep their old
// values.
export function packGateView({ viewport, time, spawnGates, species }, floats = new Float32Array(VIEW_FLOATS)) {
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
    this.viewFloats = new Float32Array(VIEW_FLOATS);
    this.hivePipeline = null;
    this.hiveBindGroup = null;
    this.hiveBuffer = createUniformBuffer(this.device, HIVE_VIEW_BYTES, 'hive-view');
    this.hiveFloats = new Float32Array(HIVE_VIEW_FLOATS);
  }

  async initialize() {
    const module = this.device.createShaderModule({ label: 'gates', code: await loadQuadShader('gates', this.common) });
    const pipelineFor = (label, fragmentEntry) => this.device.createRenderPipelineAsync({
      label,
      layout: 'auto',
      vertex: { module, entryPoint: 'gateVertex' },
      fragment: { module, entryPoint: fragmentEntry, targets: [{ format: SCENE_FORMAT, blend: MAX_BLEND }] },
      primitive: { topology: 'triangle-strip' },
    });
    [this.pipeline, this.hivePipeline] = await Promise.all([pipelineFor('gates', 'gateFragment'), pipelineFor('hives', 'hiveFragment')]);
    this.bindGroup = this.device.createBindGroup({
      label: 'gate-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.viewBuffer } }],
    });
    this.hiveBindGroup = this.device.createBindGroup({
      label: 'hive-bindings',
      layout: this.hivePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.viewBuffer } }, { binding: 1, resource: { buffer: this.hiveBuffer } }],
    });
  }

  // Draws into an open render pass whose target is a scene texture.
  encode(pass, simulation, time) {
    const { spawnGates, species } = simulation;
    const { floats, count } = packGateView({ viewport: this.viewport, time, spawnGates, species }, this.viewFloats);
    if (count === 0) return;
    this.device.queue.writeBuffer(this.viewBuffer, 0, floats);
    if (isHiveTable(spawnGates)) {
      this.device.queue.writeBuffer(this.hiveBuffer, 0, packHiveView(spawnGates, this.hiveFloats));
      pass.setPipeline(this.hivePipeline);
      pass.setBindGroup(0, this.hiveBindGroup);
    } else {
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
    }
    pass.draw(VERTICES_PER_QUAD, count);
  }

  destroy() {
    this.viewBuffer.destroy();
    this.hiveBuffer.destroy();
  }
}
