import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageBuffer, createUniformBuffer, StagingRing } from '../../src/gpu/buffers.js';

globalThis.GPUBufferUsage = {
  MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128,
};
globalThis.GPUMapMode = { READ: 1 };

function createFakeDevice() {
  const buffers = [];
  return {
    buffers,
    createBuffer(descriptor) {
      const buffer = {
        ...descriptor,
        unmapCount: 0,
        fillValue: 0,
        resolveMap: null,
        mapAsync() {
          return new Promise((resolve) => { buffer.resolveMap = resolve; });
        },
        getMappedRange() {
          return new Uint8Array(descriptor.size).fill(buffer.fillValue).buffer;
        },
        unmap() { buffer.unmapCount += 1; },
      };
      buffers.push(buffer);
      return buffer;
    },
  };
}

function createFakeEncoder() {
  return { copies: 0, copyBufferToBuffer() { this.copies += 1; } };
}

test('createStorageBuffer rounds size and sets usage and label', () => {
  const device = createFakeDevice();
  const withSource = createStorageBuffer(device, 20, 'agents');
  assert.equal(withSource.size, 32);
  assert.equal(withSource.label, 'agents');
  assert.equal(withSource.usage, 128 | 8 | 4);
  assert.equal(createStorageBuffer(device, 16, 'x', { copySource: false }).usage, 128 | 8);
});

test('createUniformBuffer rounds size and sets usage', () => {
  const buffer = createUniformBuffer(createFakeDevice(), 90, 'params');
  assert.equal(buffer.size, 96);
  assert.equal(buffer.usage, 64 | 8);
  assert.equal(buffer.label, 'params');
});

test('StagingRing returns data only after mapAsync resolves, once', async () => {
  const device = createFakeDevice();
  const ring = new StagingRing(device, 32);
  const encoder = createFakeEncoder();
  ring.copyFrom(encoder, {});
  ring.markSubmitted();
  assert.equal(ring.tryRead(), null);
  device.buffers[0].fillValue = 7;
  device.buffers[0].resolveMap();
  await Promise.resolve();
  const data = ring.tryRead();
  assert.ok(data instanceof ArrayBuffer);
  assert.equal(new Uint8Array(data)[0], 7);
  assert.equal(device.buffers[0].unmapCount, 1);
  assert.equal(ring.tryRead(), null);
});

test('StagingRing skips copyFrom when every slot is pending', () => {
  const device = createFakeDevice();
  const ring = new StagingRing(device, 32, 3);
  const encoder = createFakeEncoder();
  for (let frame = 0; frame < 3; frame += 1) {
    ring.copyFrom(encoder, {});
    ring.markSubmitted();
  }
  ring.copyFrom(encoder, {});
  assert.equal(encoder.copies, 3);
});

test('StagingRing reuses a slot after it is read', async () => {
  const device = createFakeDevice();
  const ring = new StagingRing(device, 32, 1);
  const encoder = createFakeEncoder();
  ring.copyFrom(encoder, {});
  ring.markSubmitted();
  device.buffers[0].resolveMap();
  await Promise.resolve();
  ring.tryRead();
  ring.copyFrom(encoder, {});
  assert.equal(encoder.copies, 2);
});
