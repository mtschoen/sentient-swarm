// GPU spatial grid built by counting sort: count alive agents per cell, exclusive prefix sum
// of the counts, then scatter agent indices so each cell's agents are contiguous.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createStorageBuffer } from '../gpu/buffers.js';
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { SHADER_CONSTANTS, WORKGROUP_SIZE } from './layout.js';

const BYTES_PER_U32 = 4;
// Block sums are scanned by a single workgroup, so at most WORKGROUP_SIZE blocks of WORKGROUP_SIZE cells.
export const MAXIMUM_GRID_CELLS = WORKGROUP_SIZE * WORKGROUP_SIZE;

function workgroupsFor(itemCount) {
  return Math.ceil(itemCount / WORKGROUP_SIZE);
}

export class SpatialGrid {
  // columns and rows must match gridColumns and gridRows in the SimParams uniform passed to encode.
  constructor(gpu, { columns, rows, capacity, common }) {
    const cellCount = columns * rows;
    if (cellCount > MAXIMUM_GRID_CELLS) {
      throw new Error(`SpatialGrid supports at most ${MAXIMUM_GRID_CELLS} cells; ${columns} by ${rows} is ${cellCount}`);
    }
    this.device = gpu.device;
    this.cellCount = cellCount;
    this.capacity = capacity;
    this.common = common;
    this.buffers = {
      cellCounts: createStorageBuffer(this.device, cellCount * BYTES_PER_U32, 'grid-cell-counts'),
      cellOffsets: createStorageBuffer(this.device, cellCount * BYTES_PER_U32, 'grid-cell-offsets'),
      sortedIndices: createStorageBuffer(this.device, capacity * BYTES_PER_U32, 'grid-sorted-indices'),
      cellCursor: createStorageBuffer(this.device, cellCount * BYTES_PER_U32, 'grid-cell-cursor'),
    };
    this.blockSums = createStorageBuffer(this.device, WORKGROUP_SIZE * BYTES_PER_U32, 'grid-block-sums');
    this.pipelines = null;
    this.bindGroupCache = new BindGroupCache(([agentsBuffer, paramsBuffer]) => this.createBindGroups(agentsBuffer, paramsBuffer));
  }

  async createModule(name) {
    const source = prependCommon(substituteConstants(await loadShader(name), SHADER_CONSTANTS), this.common);
    return this.device.createShaderModule({ label: name, code: source });
  }

  async initialize() {
    const [countModule, scanModule, scatterModule] = await Promise.all(
      ['grid_count', 'grid_scan', 'grid_scatter'].map((name) => this.createModule(name)),
    );
    this.scanBindGroupLayout = this.device.createBindGroupLayout({
      label: 'grid-scan-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const scanLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.scanBindGroupLayout] });
    const scanPipeline = (entryPoint) => this.device.createComputePipelineAsync({
      label: 'grid-' + entryPoint,
      layout: scanLayout,
      compute: { module: scanModule, entryPoint },
    });
    const [count, scanBlocks, scanBlockSums, addBlockOffsets, scatter] = await Promise.all([
      this.device.createComputePipelineAsync({ label: 'grid-count', layout: 'auto', compute: { module: countModule, entryPoint: 'main' } }),
      scanPipeline('scanBlocks'),
      scanPipeline('scanBlockSums'),
      scanPipeline('addBlockOffsets'),
      this.device.createComputePipelineAsync({ label: 'grid-scatter', layout: 'auto', compute: { module: scatterModule, entryPoint: 'main' } }),
    ]);
    this.pipelines = { count, scanBlocks, scanBlockSums, addBlockOffsets, scatter };
  }

  createBindGroups(agentsBuffer, paramsBuffer) {
    const { cellCounts, cellOffsets, sortedIndices, cellCursor } = this.buffers;
    const entries = (buffers) => buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
    return {
      count: this.device.createBindGroup({
        label: 'grid-count-bindings',
        layout: this.pipelines.count.getBindGroupLayout(0),
        entries: entries([paramsBuffer, agentsBuffer, cellCounts]),
      }),
      scan: this.device.createBindGroup({
        label: 'grid-scan-bindings',
        layout: this.scanBindGroupLayout,
        entries: entries([paramsBuffer, cellCounts, cellOffsets, this.blockSums]),
      }),
      scatter: this.device.createBindGroup({
        label: 'grid-scatter-bindings',
        layout: this.pipelines.scatter.getBindGroupLayout(0),
        entries: entries([paramsBuffer, agentsBuffer, cellOffsets, cellCursor, sortedIndices]),
      }),
    };
  }

  encode(encoder, agentsBuffer, paramsBuffer) {
    if (this.pipelines === null) throw new Error('SpatialGrid.initialize() must finish before encode()');
    const bindGroups = this.bindGroupCache.get([agentsBuffer, paramsBuffer]);
    encoder.clearBuffer(this.buffers.cellCounts);
    encoder.clearBuffer(this.buffers.cellCursor);
    const agentWorkgroups = workgroupsFor(this.capacity);
    const cellWorkgroups = workgroupsFor(this.cellCount);
    const pass = encoder.beginComputePass({ label: 'spatial-grid' });
    pass.setPipeline(this.pipelines.count);
    pass.setBindGroup(0, bindGroups.count);
    pass.dispatchWorkgroups(agentWorkgroups);
    pass.setBindGroup(0, bindGroups.scan);
    pass.setPipeline(this.pipelines.scanBlocks);
    pass.dispatchWorkgroups(cellWorkgroups);
    pass.setPipeline(this.pipelines.scanBlockSums);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.pipelines.addBlockOffsets);
    pass.dispatchWorkgroups(cellWorkgroups);
    pass.setPipeline(this.pipelines.scatter);
    pass.setBindGroup(0, bindGroups.scatter);
    pass.dispatchWorkgroups(agentWorkgroups);
    pass.end();
  }

  destroy() {
    Object.values(this.buffers).forEach((buffer) => buffer.destroy());
    this.blockSums.destroy();
  }
}
