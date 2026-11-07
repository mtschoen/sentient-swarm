import test from 'node:test';
import assert from 'node:assert/strict';
import { createGpuContext, describeUnsupported, WebGpuUnavailableError } from '../../src/gpu/device.js';

test('createGpuContext rejects with WebGpuUnavailableError when navigator.gpu is missing', async () => {
  await assert.rejects(createGpuContext({}, { navigatorObject: {} }), WebGpuUnavailableError);
});

test('createGpuContext rejects with WebGpuUnavailableError when no adapter is available', async () => {
  const navigatorObject = { gpu: { requestAdapter: async () => null } };
  await assert.rejects(createGpuContext({}, { navigatorObject }), (error) => error instanceof WebGpuUnavailableError && /adapter/.test(error.message));
});

test('createGpuContext wraps a requestDevice rejection in WebGpuUnavailableError', async () => {
  const adapter = {
    features: new Set(),
    limits: { maxStorageBufferBindingSize: 1, maxBufferSize: 1 },
    requestDevice: async () => { throw new Error('limits too high'); },
  };
  const navigatorObject = { gpu: { requestAdapter: async () => adapter } };
  await assert.rejects(createGpuContext({}, { navigatorObject }), (error) => error instanceof WebGpuUnavailableError && /limits too high/.test(error.message));
});

test('describeUnsupported names WebGPU and the supported browsers', () => {
  const text = describeUnsupported(new WebGpuUnavailableError('x'));
  assert.match(text, /WebGPU/);
  assert.match(text, /Safari on iOS 26/);
});
