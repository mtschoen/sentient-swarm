// Seeds a known agent layout, runs SpatialGrid.encode twice (the second run proves the
// per-encode clears) and checks counts, offsets and sorted indices against the CPU.
import { createGpuContext } from '/src/gpu/device.js';
import { createStorageBuffer, createUniformBuffer } from '/src/gpu/buffers.js';
import { loadShader, substituteConstants } from '/src/gpu/shaders.js';
import { AGENT_FLAG_ALIVE, AGENT_OFFSETS, AGENT_STRIDE_BYTES, SHADER_CONSTANTS, gridDimensions } from '/src/sim/layout.js';
import { SIM_PARAMS_BYTES, packSimParams } from '/src/sim/params.js';
import { SpatialGrid } from '/src/sim/grid.js';

const SEEDED_CELL_COUNT = 64;
// Seeded cell k holds k + 1 agents (1 to 64), so every cell count differs: a scatter or scan
// offset that is off by one cell lands agents in the wrong cell and the counts cannot match.
const ALIVE_COUNT = (SEEDED_CELL_COUNT * (SEEDED_CELL_COUNT + 1)) / 2;
const DEAD_COUNT = 16;
const CAPACITY = ALIVE_COUNT + DEAD_COUNT;

// Columns are distinct, rows spread across the grid so cells land in many scan blocks.
function seededCell(slot, dimensions) {
  const column = slot * 2 + 1;
  const row = (slot * 37) % dimensions.rows;
  return { column, row, index: column + row * dimensions.columns };
}

function seedAgents(dimensions) {
  const bytes = new ArrayBuffer(CAPACITY * AGENT_STRIDE_BYTES);
  const view = new DataView(bytes);
  const expectedCellOfAgent = new Int32Array(CAPACITY).fill(-1);
  const slotOfAlive = [];
  const withinOfAlive = [];
  for (let slot = 0; slot < SEEDED_CELL_COUNT; slot += 1) {
    for (let within = 0; within <= slot; within += 1) {
      slotOfAlive.push(slot);
      withinOfAlive.push(within);
    }
  }
  for (let agent = 0; agent < CAPACITY; agent += 1) {
    const alive = agent < ALIVE_COUNT;
    // Dead agents reuse seeded cells so a missing alive check would inflate counts.
    const cell = seededCell(alive ? slotOfAlive[agent] : agent % SEEDED_CELL_COUNT, dimensions);
    const within = alive ? withinOfAlive[agent] : 0;
    const fractionX = 0.25 + 0.5 * ((within % 8) / 8);
    const fractionY = 0.25 + 0.5 * (Math.floor(within / 8) / 8);
    const base = agent * AGENT_STRIDE_BYTES;
    view.setFloat32(base + AGENT_OFFSETS.position, (cell.column + fractionX) * dimensions.cellSize, true);
    view.setFloat32(base + AGENT_OFFSETS.position + 4, (cell.row + fractionY) * dimensions.cellSize, true);
    view.setUint32(base + AGENT_OFFSETS.species, agent % 5, true);
    view.setUint32(base + AGENT_OFFSETS.flags, alive ? AGENT_FLAG_ALIVE : 0, true);
    if (alive) expectedCellOfAgent[agent] = cell.index;
  }
  return { bytes, expectedCellOfAgent };
}

async function readBack(device, sources) {
  const encoder = device.createCommandEncoder({ label: 'grid-readback' });
  const staging = sources.map((source) => {
    const buffer = device.createBuffer({ size: source.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    encoder.copyBufferToBuffer(source, 0, buffer, 0, source.size);
    return buffer;
  });
  device.queue.submit([encoder.finish()]);
  return Promise.all(staging.map(async (buffer) => {
    await buffer.mapAsync(GPUMapMode.READ);
    const values = new Uint32Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    return values;
  }));
}

function verify(dimensions, expectedCellOfAgent, cellCounts, cellOffsets, sortedIndices) {
  const expectedCounts = new Uint32Array(dimensions.cellCount);
  for (const cell of expectedCellOfAgent) if (cell >= 0) expectedCounts[cell] += 1;
  let runningOffset = 0;
  for (let cell = 0; cell < dimensions.cellCount; cell += 1) {
    if (cellCounts[cell] !== expectedCounts[cell]) {
      return `cell ${cell} count ${cellCounts[cell]}, expected ${expectedCounts[cell]}`;
    }
    if (cellOffsets[cell] !== runningOffset) {
      return `cell ${cell} offset ${cellOffsets[cell]}, expected ${runningOffset}`;
    }
    runningOffset += expectedCounts[cell];
  }
  if (runningOffset !== ALIVE_COUNT) return `total ${runningOffset}, expected ${ALIVE_COUNT}`;
  const seen = new Uint8Array(CAPACITY);
  for (let cell = 0; cell < dimensions.cellCount; cell += 1) {
    for (let slot = cellOffsets[cell]; slot < cellOffsets[cell] + cellCounts[cell]; slot += 1) {
      const agent = sortedIndices[slot];
      if (agent >= CAPACITY) return `slot ${slot} holds out-of-range index ${agent}`;
      if (expectedCellOfAgent[agent] < 0) return `dead agent ${agent} appears at slot ${slot}`;
      if (expectedCellOfAgent[agent] !== cell) return `agent ${agent} listed under cell ${cell}, expected ${expectedCellOfAgent[agent]}`;
      if (seen[agent] !== 0) return `agent ${agent} appears more than once`;
      seen[agent] = 1;
    }
  }
  for (let agent = 0; agent < ALIVE_COUNT; agent += 1) {
    if (seen[agent] === 0) return `alive agent ${agent} missing from sortedIndices`;
  }
  return null;
}

async function runCheck() {
  const gpu = await createGpuContext(document.getElementById('canvas'));
  const { device } = gpu;
  const dimensions = gridDimensions(0.1);
  const common = substituteConstants(await loadShader('common'), SHADER_CONSTANTS);
  const grid = new SpatialGrid(gpu, { columns: dimensions.columns, rows: dimensions.rows, capacity: CAPACITY, common });
  await grid.initialize();

  const { bytes, expectedCellOfAgent } = seedAgents(dimensions);
  const agentsBuffer = createStorageBuffer(device, bytes.byteLength, 'grid-check-agents');
  device.queue.writeBuffer(agentsBuffer, 0, bytes);
  const paramsBuffer = createUniformBuffer(device, SIM_PARAMS_BYTES, 'grid-check-params');
  device.queue.writeBuffer(paramsBuffer, 0, packSimParams({
    neighborRadius: 0.1,
    gridColumns: dimensions.columns,
    gridRows: dimensions.rows,
    cellSize: dimensions.cellSize,
    capacity: CAPACITY,
  }));

  for (let run = 0; run < 2; run += 1) {
    const encoder = device.createCommandEncoder({ label: 'grid-check-encode' });
    grid.encode(encoder, agentsBuffer, paramsBuffer);
    device.queue.submit([encoder.finish()]);
  }
  const [cellCounts, cellOffsets, sortedIndices] = await readBack(device, [
    grid.buffers.cellCounts, grid.buffers.cellOffsets, grid.buffers.sortedIndices,
  ]);
  const failure = verify(dimensions, expectedCellOfAgent, cellCounts, cellOffsets, sortedIndices);
  return failure === null
    ? { pass: true, detail: `${ALIVE_COUNT} alive agents in ${SEEDED_CELL_COUNT} cells of 1 to ${SEEDED_CELL_COUNT} agents, ${DEAD_COUNT} dead skipped` }
    : { pass: false, detail: failure };
}

runCheck().then(
  (result) => { window.__gridCheck = result; },
  (error) => { window.__gridCheck = { pass: false, detail: `exception: ${error.message}` }; },
);
