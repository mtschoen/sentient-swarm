// WebGPU probe: prints the adapter vendor and architecture, runs one compute dispatch that
// doubles 1M u32 values and checks the readback.
// Usage: node tests/browser/webgpu-probe.mjs   (WEBGPU_ADAPTER=fallback forces the software adapter)
// Exit codes: 0 pass, 1 compute or readback failure, 2 no adapter.
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_NO_ADAPTER = 2;

async function probeInPage() {
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  if (!adapter) return { adapter: false };
  const info = adapter.info ?? {};
  const device = await adapter.requestDevice();
  const count = 1 << 20;
  const byteLength = count * 4;
  const input = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) input[index] = index;
  const storage = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const staging = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  device.queue.writeBuffer(storage, 0, input);
  const module = device.createShaderModule({
    code: `@group(0) @binding(0) var<storage, read_write> values: array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < arrayLength(&values)) { values[id.x] = values[id.x] * 2u; }
}`,
  });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: storage } }] });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(count / 256);
  pass.end();
  encoder.copyBufferToBuffer(storage, 0, staging, 0, byteLength);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const output = new Uint32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  let mismatches = 0;
  for (let index = 0; index < count; index += 1) if (output[index] !== (index * 2) >>> 0) mismatches += 1;
  return {
    adapter: true,
    vendor: info.vendor ?? '',
    architecture: info.architecture ?? '',
    description: info.description ?? '',
    isFallbackAdapter: adapter.isFallbackAdapter ?? info.isFallbackAdapter ?? false,
    count,
    mismatches,
  };
}

async function run() {
  let server = null;
  let browser = null;
  try {
    server = await startServer();
    const launched = await launchWebGpuBrowser();
    browser = launched.browser;
    const { page } = launched;
    await page.goto(server.url);
    const result = await page.evaluate(probeInPage);
    if (!result.adapter) {
      console.error('webgpu-probe: no WebGPU adapter available (navigator.gpu missing or requestAdapter returned null)');
      return EXIT_NO_ADAPTER;
    }
    console.log(`webgpu-probe: vendor=${result.vendor || 'unknown'} architecture=${result.architecture || 'unknown'} fallback=${result.isFallbackAdapter}`);
    if (result.description) console.log(`webgpu-probe: description=${result.description}`);
    if (result.mismatches !== 0) {
      console.error(`webgpu-probe: FAIL ${result.mismatches} of ${result.count} doubled values wrong`);
      return EXIT_FAILURE;
    }
    console.log(`webgpu-probe: ok doubled ${result.count} u32 values`);
    return EXIT_OK;
  } catch (error) {
    console.error(`webgpu-probe: ${error.message}`);
    return EXIT_FAILURE;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop();
  }
}

process.exitCode = await run();
