export class WebGpuUnavailableError extends Error {}

export async function createGpuContext(canvas, { navigatorObject = navigator } = {}) {
  const gpu = navigatorObject.gpu;
  if (!gpu) {
    throw new WebGpuUnavailableError('navigator.gpu is not available');
  }
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new WebGpuUnavailableError('No WebGPU adapter is available');
  }
  const hasTimestampQuery = adapter.features.has('timestamp-query');
  let device;
  try {
    device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
      requiredFeatures: hasTimestampQuery ? ['timestamp-query'] : [],
    });
  } catch (error) {
    throw new WebGpuUnavailableError(`WebGPU device request failed: ${error.message}`);
  }
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new WebGpuUnavailableError('Could not create a WebGPU canvas context');
  }
  const format = gpu.getPreferredCanvasFormat();
  // COPY_SRC lets the smoke test read back the composited frame (FrameCapture).
  context.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  return { adapter, device, context, format, limits: device.limits, hasTimestampQuery };
}

export function describeUnsupported() {
  return 'This game needs WebGPU. Use Chrome or Edge on desktop or Android, or Safari on iOS 26 or later.';
}
