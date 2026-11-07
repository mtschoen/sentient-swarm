import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameCapture, meanLuminance, paddedBytesPerRow, unpackRows } from '../../src/render/capture.js';

test('paddedBytesPerRow rounds four bytes per pixel up to 256', () => {
  assert.equal(paddedBytesPerRow(1), 256);
  assert.equal(paddedBytesPerRow(64), 256);
  assert.equal(paddedBytesPerRow(65), 512);
});

test('unpackRows drops row padding and keeps rgba order', () => {
  const bytes = new Uint8Array(512);
  bytes.set([1, 2, 3, 4], 0);
  bytes.set([5, 6, 7, 8], 256);
  const pixels = unpackRows(bytes, { width: 1, height: 2, bytesPerRow: 256, format: 'rgba8unorm' });
  assert.deepEqual(Array.from(pixels), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('unpackRows swaps blue and red for bgra8unorm', () => {
  const bytes = new Uint8Array(256);
  bytes.set([10, 20, 30, 40], 0);
  const pixels = unpackRows(bytes, { width: 1, height: 1, bytesPerRow: 256, format: 'bgra8unorm' });
  assert.deepEqual(Array.from(pixels), [30, 20, 10, 40]);
});

test('meanLuminance averages Rec. 709 luminance over the rect only', () => {
  // 2 by 1 image: left white, right black; the rect covers only the left pixel.
  const pixels = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]);
  assert.ok(Math.abs(meanLuminance(pixels, 2, { x: 0, y: 0, width: 1, height: 1 }) - 1) < 1e-9);
  assert.ok(Math.abs(meanLuminance(pixels, 2, { x: 0, y: 0, width: 2, height: 1 }) - 0.5) < 1e-9);
  assert.equal(meanLuminance(pixels, 2, { x: 0, y: 0, width: 0, height: 0 }), 0);
});

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUMapMode ??= { READ: 1 };

// A device whose capture buffers map when the test settles them by hand.
function createCaptureFixture() {
  const buffers = [];
  const device = {
    createBuffer: (descriptor) => {
      const buffer = { ...descriptor, destroyed: false, settle: null };
      buffer.destroy = () => { buffer.destroyed = true; };
      buffer.mapAsync = () => new Promise((resolve, reject) => { buffer.settle = { resolve, reject }; });
      buffer.getMappedRange = () => new Uint8Array(descriptor.size).fill(9).buffer;
      buffers.push(buffer);
      return buffer;
    },
  };
  const encoder = { copies: 0, copyTextureToBuffer() { encoder.copies += 1; } };
  return { capture: new FrameCapture(device, 'rgba8unorm'), buffers, encoder, texture: { width: 2, height: 1 } };
}

test('FrameCapture answers every request waiting at encode with one copy and its details', async () => {
  const { capture, buffers, encoder, texture } = createCaptureFixture();
  const first = capture.request();
  const second = capture.request();
  capture.encode(encoder, texture, { arenaRect: { x: 1, y: 0, width: 1, height: 1 } });
  capture.afterSubmit();
  buffers[0].settle.resolve();
  const [frameA, frameB] = await Promise.all([first, second]);
  assert.equal(encoder.copies, 1);
  assert.deepEqual(frameA, frameB);
  assert.deepEqual(frameA.details, { arenaRect: { x: 1, y: 0, width: 1, height: 1 } });
  assert.deepEqual(Array.from(frameA.pixels), [9, 9, 9, 9, 9, 9, 9, 9]);
  assert.equal(buffers[0].destroyed, true);
});

test('FrameCapture encodes nothing without a request or while a copy awaits submission', () => {
  const { capture, encoder, texture } = createCaptureFixture();
  capture.encode(encoder, texture);
  assert.equal(encoder.copies, 0);
  capture.request();
  capture.encode(encoder, texture);
  capture.request();
  capture.encode(encoder, texture);
  assert.equal(encoder.copies, 1);
});

test('a failed map destroys the buffer and rejects its requests', async () => {
  const { capture, buffers, encoder, texture } = createCaptureFixture();
  const request = capture.request();
  capture.encode(encoder, texture);
  capture.afterSubmit();
  buffers[0].settle.reject(new Error('device lost'));
  await assert.rejects(request, /device lost/);
  assert.equal(buffers[0].destroyed, true);
});

test('destroy rejects waiting and unsubmitted requests and frees the unsubmitted copy', async () => {
  const { capture, buffers, encoder, texture } = createCaptureFixture();
  const copied = capture.request();
  capture.encode(encoder, texture);
  const waiting = capture.request();
  capture.destroy();
  await assert.rejects(copied, /destroyed/);
  await assert.rejects(waiting, /destroyed/);
  assert.equal(buffers[0].destroyed, true);
  assert.equal(capture.copied, null);
});
