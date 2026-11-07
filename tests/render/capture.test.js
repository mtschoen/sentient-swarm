import test from 'node:test';
import assert from 'node:assert/strict';
import { meanLuminance, paddedBytesPerRow, unpackRows } from '../../src/render/capture.js';

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
