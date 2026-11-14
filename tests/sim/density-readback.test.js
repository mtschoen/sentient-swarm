import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DENSITY_READBACK_INTERVAL, DensityReadback } from '../../src/sim/density-readback.js';
import { COARSE_CELL_SIZE, COARSE_COLUMNS, COARSE_ROWS } from '../../src/sim/layout.js';

globalThis.GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUMapMode = { READ: 1 };

const CELLS = COARSE_COLUMNS * COARSE_ROWS;

// Serves shader files from disk so the test never fetches a file: URL; records each requested URL.
function diskFetch(requested = []) {
  return async (url) => {
    requested.push(String(url));
    return { ok: true, text: async () => readFileSync(fileURLToPath(url), 'utf8') };
  };
}

function fakeDevice() {
  const device = {
    buffers: [],
    bindGroups: 0,
    mapValues: new Float32Array(CELLS),
    createBuffer(descriptor) {
      const buffer = {
        ...descriptor,
        mapAsync: () => Promise.resolve(),
        getMappedRange: () => device.mapValues.slice().buffer,
        unmap() {},
        destroy() {},
      };
      device.buffers.push(buffer);
      return buffer;
    },
    shaderCode: null,
    createShaderModule(descriptor) { device.shaderCode = descriptor.code; return {}; },
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup() { device.bindGroups += 1; return {}; },
  };
  return device;
}

function fakeEncoder() {
  return {
    passes: 0,
    copies: 0,
    beginComputePass() {
      this.passes += 1;
      return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
    },
    copyBufferToBuffer() { this.copies += 1; },
  };
}

async function ready(device = fakeDevice()) {
  const readback = new DensityReadback(device);
  await readback.initialize({ fetchFunction: diskFetch() });
  return { readback, device };
}

async function deliver(readback) {
  readback.encode(fakeEncoder(), {});
  readback.afterSubmit();
  await Promise.resolve();
  readback.poll();
}

test('encode runs on the first step and every 15th step only', async () => {
  const { readback } = await ready();
  const encoder = fakeEncoder();
  for (let step = 0; step < 31; step += 1) readback.encode(encoder, {});
  assert.equal(DENSITY_READBACK_INTERVAL, 15);
  assert.equal(encoder.passes, 3);
  assert.equal(encoder.copies, 3);
});

test('a busy ring skips the copy instead of blocking', async () => {
  const { readback } = await ready();
  const encoder = fakeEncoder();
  for (let step = 0; step < 15 * 6; step += 1) readback.encode(encoder, {});
  assert.equal(encoder.copies, 3);
  assert.equal(readback.ring.skippedCopies, 3);
});

test('densityAt is 0 before the first map and samples the newest map after', async () => {
  const { readback, device } = await ready();
  assert.equal(readback.densityAt(8, 4.5), 0);
  device.mapValues.fill(2);
  await deliver(readback);
  assert.equal(readback.mapsReceived, 1);
  assert.ok(Math.abs(readback.densityAt(8, 4.5) - 2) < 1e-6);
  assert.ok(Math.abs(readback.densityAt(-5, 99) - 2) < 1e-6);
});

test('densityAt interpolates between cell centers and follows a hot cell', async () => {
  const { readback, device } = await ready();
  device.mapValues[10 * COARSE_COLUMNS + 20] = 4;
  await deliver(readback);
  const cellWidth = COARSE_CELL_SIZE;
  const cellHeight = COARSE_CELL_SIZE;
  const centerX = (20 + 0.5) * cellWidth;
  const centerY = (10 + 0.5) * cellHeight;
  assert.ok(Math.abs(readback.densityAt(centerX, centerY) - 4) < 1e-6);
  assert.ok(Math.abs(readback.densityAt(centerX + cellWidth / 2, centerY) - 2) < 1e-6);
  assert.equal(readback.densityAt(1, 1), 0);
});

test('adopt carries the newest map to a replacement instance', async () => {
  const { readback, device } = await ready();
  device.mapValues.fill(3);
  await deliver(readback);
  const { readback: replacement } = await ready();
  replacement.adopt(readback);
  assert.ok(Math.abs(replacement.densityAt(4, 4) - 3) < 1e-6);
  assert.equal(replacement.mapsReceived, 1);
});

test('the field buffer is rebound only when it changes', async () => {
  const { readback, device } = await ready();
  const first = {};
  const second = {};
  const encoder = fakeEncoder();
  for (let step = 0; step < 31; step += 1) readback.encode(encoder, step < 16 ? first : second);
  assert.equal(device.bindGroups, 2);
});

test('the staging maps are one f32 per coarse cell, three deep', async () => {
  const { device } = await ready();
  const staging = device.buffers.filter((buffer) => buffer.usage === (1 | 8));
  assert.equal(staging.length, 3);
  assert.ok(staging.every((buffer) => buffer.size === CELLS * 4));
});

test('initialize loads density_sum.wgsl through the injected fetch with every constant substituted', async () => {
  const requested = [];
  const device = fakeDevice();
  const readback = new DensityReadback(device);
  await readback.initialize({ fetchFunction: diskFetch(requested) });
  assert.equal(requested.length, 1);
  assert.ok(requested[0].endsWith('/src/sim/shaders/density_sum.wgsl'));
  assert.ok(device.shaderCode.includes('fn sum('));
  assert.ok(device.shaderCode.includes('@workgroup_size(256)'));
  assert.ok(device.shaderCode.includes(`${COARSE_COLUMNS}u * ${COARSE_ROWS}u`));
  assert.ok(device.shaderCode.includes('species < 5u'));
  assert.ok(device.shaderCode.includes('cell * 8u + species'));
  assert.equal(device.shaderCode.match(/__[A-Z_]+__/), null);
});

test('initialize rejects when the shader fetch fails', async () => {
  const readback = new DensityReadback(fakeDevice());
  const failing = async () => ({ ok: false, status: 404 });
  await assert.rejects(readback.initialize({ fetchFunction: failing }), /density_sum: 404/);
  assert.equal(readback.pipeline, null);
});
