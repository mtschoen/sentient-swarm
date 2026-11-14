// Warp grid (warpgrid.wgsl): a line list of columns by rows cells over the whole world, drawn into
// its own rgba16float layer that composite adds under the scene, so trail decay never copies
// (smears) it. WORLD_WARP_LATTICE keeps the one-screen spacing (WARP_LINES_PER_WORLD_UNIT, 96 by 54
// lines per 16 by 9 view) over the world; PHONE_WARP_LATTICE spreads 96 by 54 lines over the world
// (twice the spacing), the line budget a phone drew for one screen. The off-view lines are clipped.
// No vertex or index buffer: the vertex shader derives each line end from vertex_index (see
// warpGridLatticePoint, which mirrors it) and displaces it along the gradient of
// density * densityWeight + threat * threatWeight sampled from the blurred coarse field, plus a
// radial push from each shockwave impulse (ImpulseSet.toUniformArray, impulses.js).
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createUniformBuffer } from '../gpu/buffers.js';
import { substituteConstants } from '../gpu/shaders.js';
import { DEFAULT_IMPULSE_CAPACITY, DEFAULT_IMPULSE_DURATION_SECONDS, FLOATS_PER_IMPULSE } from './impulses.js';
import { SCENE_FORMAT, loadRenderShader } from './render-shaders.js';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../sim/layout.js';

export const WARP_IMPULSE_CAPACITY = DEFAULT_IMPULSE_CAPACITY;
// Substituted into warpgrid.wgsl, so the shader's impulse array and lifetime follow ImpulseSet.
export const WARP_SHADER_CONSTANTS = Object.freeze({
  IMPULSE_CAPACITY: WARP_IMPULSE_CAPACITY,
  IMPULSE_DURATION_SECONDS: DEFAULT_IMPULSE_DURATION_SECONDS,
});
const WARP_VIEW_HEADER_BYTES = 48;
const IMPULSE_BYTES = 16;
export const WARP_VIEW_BYTES = WARP_VIEW_HEADER_BYTES + WARP_IMPULSE_CAPACITY * IMPULSE_BYTES;
const NO_IMPULSES = new Float32Array(WARP_IMPULSE_CAPACITY * FLOATS_PER_IMPULSE);
const ADDITIVE = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
export const WARP_LINES_PER_WORLD_UNIT = 6;
export const WORLD_WARP_LATTICE = Object.freeze({ columns: WORLD_WIDTH * WARP_LINES_PER_WORLD_UNIT, rows: WORLD_HEIGHT * WARP_LINES_PER_WORLD_UNIT });
export const PHONE_WARP_LATTICE = Object.freeze({ columns: 96, rows: 54 });

// Horizontal lines: rows + 1 lines of columns segments; vertical lines: columns + 1 lines of rows segments.
export function warpGridSegmentCount(columns, rows) {
  return (rows + 1) * columns + (columns + 1) * rows;
}

// Lattice coordinate (0..columns, 0..rows) of a line-list vertex; warpgrid.wgsl does the same.
export function warpGridLatticePoint(vertexIndex, columns, rows) {
  const segment = Math.floor(vertexIndex / 2);
  const end = vertexIndex % 2;
  const horizontalSegments = (rows + 1) * columns;
  if (segment < horizontalSegments) {
    return { column: (segment % columns) + end, row: Math.floor(segment / columns) };
  }
  const vertical = segment - horizontalSegments;
  return { column: Math.floor(vertical / rows), row: (vertical % rows) + end };
}

// The bytes of one WarpView and float and word views over them, for packWarpView to fill.
export function createWarpViewData() {
  const bytes = new ArrayBuffer(WARP_VIEW_BYTES);
  return { bytes, floats: new Float32Array(bytes), words: new Uint32Array(bytes) };
}

// Matches the WarpView table in warpgrid.wgsl. impulses: WARP_IMPULSE_CAPACITY * 4 floats of
// [x, y, age, strength] (ImpulseSet.toUniformArray), none when omitted. Fills target (a
// createWarpViewData, a new one by default) and returns its bytes.
export function packWarpView(
  { viewport, columns, rows, densityWeight, threatWeight, time, impulses = NO_IMPULSES },
  target = createWarpViewData(),
) {
  const origin = viewport.worldToClip(0, 0);
  const unit = viewport.worldToClip(1, 1);
  target.floats.set([unit.x - origin.x, unit.y - origin.y, origin.x, origin.y, densityWeight, threatWeight, time, 0]);
  target.words.set([columns, rows, 0, 0], 8);
  target.floats.set(impulses, WARP_VIEW_HEADER_BYTES / Float32Array.BYTES_PER_ELEMENT);
  return target.bytes;
}

export class WarpGrid {
  constructor(gpu, { columns = WORLD_WARP_LATTICE.columns, rows = WORLD_WARP_LATTICE.rows, viewport, common }) {
    this.device = gpu.device;
    this.columns = columns;
    this.rows = rows;
    this.viewport = viewport;
    this.common = common;
    this.pipeline = null;
    this.viewBuffer = createUniformBuffer(this.device, WARP_VIEW_BYTES, 'warp-view');
    this.viewData = createWarpViewData();
    this.bindGroupCache = new BindGroupCache((buffers) => this.device.createBindGroup({
      label: 'warp-grid-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const code = substituteConstants(await loadRenderShader('warpgrid', this.common), WARP_SHADER_CONSTANTS);
    const module = this.device.createShaderModule({ label: 'warp-grid', code });
    this.pipeline = await this.device.createRenderPipelineAsync({
      label: 'warp-grid',
      layout: 'auto',
      vertex: { module, entryPoint: 'warpVertex' },
      fragment: {
        module,
        entryPoint: 'warpFragment',
        targets: [{ format: SCENE_FORMAT, blend: { color: ADDITIVE, alpha: ADDITIVE } }],
      },
      primitive: { topology: 'line-list' },
    });
  }

  // Draws into an open render pass whose color target is the grid layer.
  encode(pass, fieldBuffer, time, { densityWeight, threatWeight, impulses }) {
    const { columns, rows, viewport } = this;
    const view = packWarpView({ viewport, columns, rows, densityWeight, threatWeight, time, impulses }, this.viewData);
    this.device.queue.writeBuffer(this.viewBuffer, 0, view);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroupCache.get([this.viewBuffer, fieldBuffer]));
    pass.draw(2 * warpGridSegmentCount(columns, rows));
  }

  destroy() {
    this.viewBuffer.destroy();
  }
}
