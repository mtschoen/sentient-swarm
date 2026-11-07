// Coarse species field: per coarse cell, the density of each species (agents per coarse cell)
// plus a decaying threat channel, downsampled from the sorted fine grid every frame and blurred.
// Writers add threat in fixed point (1 unit = 1 / THREAT_FIXED_POINT_SCALE) with atomicAdd into
// buffers.threatAccumulator; the convert step folds it into channel 5 and zeroes it.
import { BindGroupCache } from '../gpu/bind-group-cache.js';
import { createStorageBuffer } from '../gpu/buffers.js';
import { loadShader, prependCommon, substituteConstants } from '../gpu/shaders.js';
import { COARSE_CHANNELS, COARSE_COLUMNS, COARSE_ROWS, SHADER_CONSTANTS, SPECIES_COUNT, WORKGROUP_SIZE } from './layout.js';

const BYTES_PER_FLOAT = 4;
const COARSE_CELL_COUNT = COARSE_COLUMNS * COARSE_ROWS;

function workgroupsFor(itemCount) {
  return Math.ceil(itemCount / WORKGROUP_SIZE);
}

export class CoarseField {
  // grid is the SpatialGrid whose buffers encode receives; its capacity sizes the dispatch.
  constructor(gpu, { grid, common }) {
    this.device = gpu.device;
    this.capacity = grid.capacity;
    this.common = common;
    const fieldBytes = COARSE_CELL_COUNT * COARSE_CHANNELS * BYTES_PER_FLOAT;
    this.buffers = {
      raw: createStorageBuffer(this.device, fieldBytes, 'coarse-field-raw'),
      blurred: createStorageBuffer(this.device, fieldBytes, 'coarse-field-blurred'),
      threatAccumulator: createStorageBuffer(this.device, COARSE_CELL_COUNT * BYTES_PER_FLOAT, 'coarse-field-threat-accumulator'),
    };
    this.densityAccumulator = createStorageBuffer(this.device, COARSE_CELL_COUNT * SPECIES_COUNT * BYTES_PER_FLOAT, 'coarse-field-density-accumulator');
    this.pipelines = null;
    this.bindGroupCache = new BindGroupCache(([agentsBuffer, cellCounts, cellOffsets, sortedIndices, paramsBuffer]) =>
      this.createBindGroups(agentsBuffer, { cellCounts, cellOffsets, sortedIndices }, paramsBuffer));
  }

  async createModule(name) {
    const source = prependCommon(substituteConstants(await loadShader(name), SHADER_CONSTANTS), this.common);
    return this.device.createShaderModule({ label: name, code: source });
  }

  async initialize() {
    const [downsampleModule, blurModule] = await Promise.all([this.createModule('field_downsample'), this.createModule('field_blur')]);
    const pipeline = (module, entryPoint) => this.device.createComputePipelineAsync({
      label: 'coarse-field-' + entryPoint,
      layout: 'auto',
      compute: { module, entryPoint },
    });
    const [accumulate, convert, blur] = await Promise.all([
      pipeline(downsampleModule, 'accumulate'),
      pipeline(downsampleModule, 'convert'),
      pipeline(blurModule, 'blur'),
    ]);
    this.pipelines = { accumulate, convert, blur };
  }

  createBindGroups(agentsBuffer, gridBuffers, paramsBuffer) {
    const { raw, blurred, threatAccumulator } = this.buffers;
    const bindGroup = (name, entries) => this.device.createBindGroup({
      label: 'coarse-field-' + name + '-bindings',
      layout: this.pipelines[name].getBindGroupLayout(0),
      entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
    });
    return {
      accumulate: bindGroup('accumulate', [
        [0, paramsBuffer], [1, agentsBuffer], [2, gridBuffers.cellCounts], [3, gridBuffers.cellOffsets],
        [4, gridBuffers.sortedIndices], [5, this.densityAccumulator],
      ]),
      convert: bindGroup('convert', [[5, this.densityAccumulator], [6, threatAccumulator], [7, raw]]),
      blur: bindGroup('blur', [[0, raw], [1, blurred]]),
    };
  }

  encode(encoder, agentsBuffer, gridBuffers, paramsBuffer) {
    if (this.pipelines === null) throw new Error('CoarseField.initialize() must finish before encode()');
    const bindGroups = this.bindGroupCache.get([agentsBuffer, gridBuffers.cellCounts, gridBuffers.cellOffsets, gridBuffers.sortedIndices, paramsBuffer]);
    encoder.clearBuffer(this.densityAccumulator);
    const cellWorkgroups = workgroupsFor(COARSE_CELL_COUNT);
    const pass = encoder.beginComputePass({ label: 'coarse-field' });
    pass.setPipeline(this.pipelines.accumulate);
    pass.setBindGroup(0, bindGroups.accumulate);
    pass.dispatchWorkgroups(workgroupsFor(this.capacity));
    pass.setPipeline(this.pipelines.convert);
    pass.setBindGroup(0, bindGroups.convert);
    pass.dispatchWorkgroups(cellWorkgroups);
    pass.setPipeline(this.pipelines.blur);
    pass.setBindGroup(0, bindGroups.blur);
    pass.dispatchWorkgroups(cellWorkgroups);
    pass.end();
  }

  destroy() {
    Object.values(this.buffers).forEach((buffer) => buffer.destroy());
    this.densityAccumulator.destroy();
  }
}
