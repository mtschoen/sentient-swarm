// Warp grid (warpgrid.wgsl): a line list of columns by rows cells over the arena, drawn into its own
// rgba16float layer that composite adds under the scene, so trail decay never copies (smears) it.
// No vertex or index buffer: the vertex shader derives each line end from vertex_index (see
// warpGridLatticePoint, which mirrors it) and displaces it along the gradient of
// density * densityWeight + threat * threatWeight sampled from the blurred coarse field.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createUniformBuffer } from '../gpu/buffers.js';
import { SCENE_FORMAT, loadRenderShader } from './render-shaders.js';

export const WARP_VIEW_BYTES = 48;
const ADDITIVE = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };

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

// Matches the WarpView table in warpgrid.wgsl.
export function packWarpView({ viewport, columns, rows, densityWeight, threatWeight, time }) {
  const origin = viewport.worldToClip(0, 0);
  const unit = viewport.worldToClip(1, 1);
  const bytes = new ArrayBuffer(WARP_VIEW_BYTES);
  new Float32Array(bytes, 0, 8).set([unit.x - origin.x, unit.y - origin.y, origin.x, origin.y, densityWeight, threatWeight, time, 0]);
  new Uint32Array(bytes, 32, 4).set([columns, rows, 0, 0]);
  return bytes;
}

export class WarpGrid {
  constructor(gpu, { columns = 96, rows = 54, viewport, common }) {
    this.device = gpu.device;
    this.columns = columns;
    this.rows = rows;
    this.viewport = viewport;
    this.common = common;
    this.pipeline = null;
    this.viewBuffer = createUniformBuffer(this.device, WARP_VIEW_BYTES, 'warp-view');
    this.bindGroupCache = new BindGroupCache((buffers) => this.device.createBindGroup({
      label: 'warp-grid-bindings',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  async initialize() {
    const module = this.device.createShaderModule({ label: 'warp-grid', code: await loadRenderShader('warpgrid', this.common) });
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
  encode(pass, fieldBuffer, time, { densityWeight, threatWeight }) {
    const { columns, rows, viewport } = this;
    this.device.queue.writeBuffer(this.viewBuffer, 0, packWarpView({ viewport, columns, rows, densityWeight, threatWeight, time }));
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroupCache.get([this.viewBuffer, fieldBuffer]));
    pass.draw(2 * warpGridSegmentCount(columns, rows));
  }

  destroy() {
    this.viewBuffer.destroy();
  }
}
