import test from 'node:test';
import assert from 'node:assert/strict';
import { createGpuContext, describeUnsupported, WebGpuUnavailableError } from '../../src/gpu/device.js';

test('createGpuContext rejects with WebGpuUnavailableError when navigator.gpu is missing', async () => {
  await assert.rejects(createGpuContext({}, { navigatorObject: {} }), WebGpuUnavailableError);
});

test('describeUnsupported names WebGPU and the supported browsers', () => {
  const text = describeUnsupported(new WebGpuUnavailableError('x'));
  assert.match(text, /WebGPU/);
  assert.match(text, /Safari on iOS 26/);
});
