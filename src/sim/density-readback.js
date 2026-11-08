// Density readback for pickup placement: every DENSITY_READBACK_INTERVAL steps a small compute pass
// sums the five species density channels of the blurred coarse field into one f32 per coarse cell
// (64 by 36, about 9 KB; threat and padding channels are never read), copies it into its own
// staging ring (three buffers) and the CPU samples the newest mapped map with densityAt. The ring
// never blocks: a busy ring skips the copy and a map arrives a few frames later. Before the first
// map arrives densityAt returns 0. The shader is shaders/density_sum.wgsl.
import { createStorageBuffer, StagingRing } from '../gpu/buffers.js';
import { loadShader, substituteConstants } from '../gpu/shaders.js';
import { ARENA_HEIGHT, ARENA_WIDTH, COARSE_COLUMNS, COARSE_ROWS, SHADER_CONSTANTS, WORKGROUP_SIZE } from './layout.js';

export const DENSITY_READBACK_INTERVAL = 15;
const CELL_COUNT = COARSE_COLUMNS * COARSE_ROWS;
const MAP_BYTES = CELL_COUNT * 4;
const RING_DEPTH = 3;

export class DensityReadback {
  constructor(device) {
    this.device = device;
    this.density = createStorageBuffer(device, MAP_BYTES, 'density-sum');
    this.ring = new StagingRing(device, MAP_BYTES, RING_DEPTH);
    this.pipeline = null;
    this.bindGroup = null;
    this.bindGroupField = null;
    this.stepCount = 0;
    // Maps received so far (a sequence number: it only grows) and the newest one, or null.
    this.mapsReceived = 0;
    this.map = null;
  }

  // fetchFunction is passed through to loadShader (tests inject one; the browser uses fetch).
  async initialize({ fetchFunction } = {}) {
    const code = substituteConstants(await loadShader('density_sum', { fetchFunction }), SHADER_CONSTANTS);
    const module = this.device.createShaderModule({ label: 'density-sum', code });
    this.pipeline = await this.device.createComputePipelineAsync({ label: 'density-sum', layout: 'auto', compute: { module, entryPoint: 'sum' } });
  }

  // Call once per simulation step with the blurred coarse field; does work only on every
  // DENSITY_READBACK_INTERVAL-th call (the first call included).
  encode(encoder, fieldBuffer) {
    if (this.pipeline === null) throw new Error('DensityReadback.initialize() must finish before encode()');
    const due = this.stepCount % DENSITY_READBACK_INTERVAL === 0;
    this.stepCount += 1;
    if (!due) return;
    if (this.bindGroupField !== fieldBuffer) {
      this.bindGroup = this.device.createBindGroup({
        label: 'density-sum-bindings',
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: fieldBuffer } }, { binding: 1, resource: { buffer: this.density } }],
      });
      this.bindGroupField = fieldBuffer;
    }
    const pass = encoder.beginComputePass({ label: 'density-sum' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(CELL_COUNT / WORKGROUP_SIZE));
    pass.end();
    this.ring.copyFrom(encoder, this.density);
  }

  afterSubmit() {
    this.ring.markSubmitted();
  }

  // Drains every ready map and keeps the newest.
  poll() {
    for (const bytes of this.ring.readAll()) {
      this.map = new Float32Array(bytes);
      this.mapsReceived += 1;
    }
  }

  // Carries the newest map over from the instance a capacity swap replaces.
  adopt(other) {
    this.map = other.map;
    this.mapsReceived = other.mapsReceived;
  }

  // Bilinear sample of the newest map at world position (x, y), clamped to the arena; 0 before the first map.
  densityAt(x, y) {
    if (this.map === null) return 0;
    const column = Math.min(COARSE_COLUMNS - 1, Math.max(0, (x / ARENA_WIDTH) * COARSE_COLUMNS - 0.5));
    const row = Math.min(COARSE_ROWS - 1, Math.max(0, (y / ARENA_HEIGHT) * COARSE_ROWS - 0.5));
    const column0 = Math.floor(column);
    const row0 = Math.floor(row);
    const column1 = Math.min(COARSE_COLUMNS - 1, column0 + 1);
    const row1 = Math.min(COARSE_ROWS - 1, row0 + 1);
    const columnWeight = column - column0;
    const rowWeight = row - row0;
    const at = (c, r) => this.map[r * COARSE_COLUMNS + c];
    const top = at(column0, row0) * (1 - columnWeight) + at(column1, row0) * columnWeight;
    const bottom = at(column0, row1) * (1 - columnWeight) + at(column1, row1) * columnWeight;
    return top * (1 - rowWeight) + bottom * rowWeight;
  }

  destroy() {
    this.density.destroy();
    this.ring.destroy();
  }
}
