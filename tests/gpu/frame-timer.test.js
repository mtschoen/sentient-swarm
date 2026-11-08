import test from 'node:test';
import assert from 'node:assert/strict';
import { CpuFrameTimer, TimestampFrameTimer, createFrameTimer, frameTimerKindFromSearch, sumSectionNanoseconds } from '../../src/gpu/frame-timer.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, QUERY_RESOLVE: 512 };
globalThis.GPUMapMode ??= { READ: 1 };

test('the CPU timer reports from the first section to the queue finishing the frame', async () => {
  let milliseconds = 100;
  let finishWork;
  const queue = { onSubmittedWorkDone: () => new Promise((resolve) => { finishWork = resolve; }) };
  const reported = [];
  const timer = new CpuFrameTimer({ queue, now: () => milliseconds, onFrame: (value) => reported.push(value) });
  timer.beginSection({});
  milliseconds = 103;
  timer.beginSection({});
  timer.endSection({});
  timer.endFrame({});
  timer.afterFrameSubmit();
  milliseconds = 109;
  finishWork();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(reported, [9]);
  // The next frame starts fresh.
  timer.beginSection({});
  milliseconds = 111;
  timer.afterFrameSubmit();
  finishWork();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(reported, [9, 2]);
});

test('section sums skip pairs whose end does not follow the begin', () => {
  assert.equal(sumSectionNanoseconds(new BigUint64Array([10n, 30n, 50n, 40n, 60n, 65n]), 3), 25);
  assert.equal(sumSectionNanoseconds(new BigUint64Array([10n, 30n, 50n, 90n]), 1), 20);
});

function fakeDevice() {
  const log = { passes: [], resolves: [], copies: [], maps: [] };
  const buffer = (descriptor) => ({
    ...descriptor,
    mapAsync(mode, offset, size) {
      return new Promise((resolve) => log.maps.push({ buffer: this, size, resolve }));
    },
    getMappedRange: (offset, size) => new BigUint64Array([1000n, 3000n, 5000n, 9000n]).buffer.slice(0, size),
    unmap() {},
    destroy() {},
  });
  return {
    log,
    createQuerySet: (descriptor) => ({ ...descriptor, destroy() {} }),
    createBuffer: buffer,
  };
}

function fakeEncoder(log) {
  return {
    beginComputePass: (descriptor) => {
      log.passes.push(descriptor.timestampWrites);
      return { end() {} };
    },
    resolveQuerySet: (querySet, first, count) => log.resolves.push({ first, count }),
    copyBufferToBuffer: (source, sourceOffset, destination, destinationOffset, size) => log.copies.push(size),
  };
}

test('the timestamp timer writes a timestamp pair per section and reports the summed GPU time', async () => {
  const device = fakeDevice();
  const reported = [];
  const timer = new TimestampFrameTimer({ device, onFrame: (value) => reported.push(value) });
  const simulationEncoder = fakeEncoder(device.log);
  timer.beginSection(simulationEncoder);
  timer.endSection(simulationEncoder);
  const renderEncoder = fakeEncoder(device.log);
  timer.beginSection(renderEncoder);
  timer.endSection(renderEncoder);
  timer.endFrame(renderEncoder);
  assert.deepEqual(device.log.passes.map((writes) => writes.beginningOfPassWriteIndex ?? writes.endOfPassWriteIndex), [0, 1, 2, 3]);
  assert.deepEqual(device.log.resolves, [{ first: 0, count: 4 }]);
  assert.deepEqual(device.log.copies, [32]);
  timer.afterFrameSubmit();
  device.log.maps[0].resolve();
  await Promise.resolve();
  await Promise.resolve();
  // (3000 - 1000) + (9000 - 5000) nanoseconds.
  assert.deepEqual(reported, [0.006]);
});

test('the timestamp timer drops a frame when every readback slot is still mapping', () => {
  const device = fakeDevice();
  const timer = new TimestampFrameTimer({ device, onFrame: () => {} });
  for (let frame = 0; frame < 4; frame += 1) {
    const encoder = fakeEncoder(device.log);
    timer.beginSection(encoder);
    timer.endSection(encoder);
    timer.endFrame(encoder);
    timer.afterFrameSubmit();
  }
  assert.equal(device.log.resolves.length, 3);
  assert.equal(device.log.maps.length, 3);
});

test('createFrameTimer uses timestamps only when the device has the feature', () => {
  const device = { ...fakeDevice(), queue: {} };
  assert.ok(createFrameTimer({ device, hasTimestampQuery: true }, { now: () => 0, onFrame() {} }) instanceof TimestampFrameTimer);
  assert.ok(createFrameTimer({ device, hasTimestampQuery: false }, { now: () => 0, onFrame() {} }) instanceof CpuFrameTimer);
});

test('createFrameTimer uses the CPU timer when the kind is cpu, even with timestamps', () => {
  const device = { ...fakeDevice(), queue: {} };
  assert.ok(createFrameTimer({ device, hasTimestampQuery: true }, { now: () => 0, onFrame() {}, kind: 'cpu' }) instanceof CpuFrameTimer);
  assert.ok(createFrameTimer({ device, hasTimestampQuery: true }, { now: () => 0, onFrame() {}, kind: 'auto' }) instanceof TimestampFrameTimer);
});

test('?timer=cpu forces the CPU timer; anything else picks automatically', () => {
  assert.equal(frameTimerKindFromSearch('?timer=cpu'), 'cpu');
  assert.equal(frameTimerKindFromSearch('?probe=on&timer=cpu'), 'cpu');
  assert.equal(frameTimerKindFromSearch(''), 'auto');
  assert.equal(frameTimerKindFromSearch('?timer=gpu'), 'auto');
});
