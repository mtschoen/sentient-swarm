// Renders a one-pixel bright line into a scene texture at 16 offsets, runs BloomPass's downsample
// at each bloom quality and checks that the total energy it writes does not depend on where the
// line falls against the output texel grid (a thin moving feature must keep a steady glow).
import { createGpuContext } from '/src/gpu/device.js';
import { BLOOM_DIVISORS, BloomPass } from '/src/render/bloom.js';
import { SCENE_FORMAT, loadFullscreenHeader } from '/src/render/render-shaders.js';

const SCENE_WIDTH = 240;
const SCENE_HEIGHT = 48;
const OFFSET_COUNT = 16;
const LINE_START = 64;
const MAXIMUM_VARIATION = 0.1;
const BYTES_PER_PIXEL_SOURCE = 4;
const BYTES_PER_PIXEL_OUTPUT = 8;
const ROW_ALIGNMENT = 256;

function halfToFloat(bits) {
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  const sign = bits & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

// A scene whose pixels are all black except one full-height or full-width line of white.
function lineImage(axis, position) {
  const bytes = new Uint8Array(SCENE_WIDTH * SCENE_HEIGHT * BYTES_PER_PIXEL_SOURCE);
  for (let y = 0; y < SCENE_HEIGHT; y += 1) {
    for (let x = 0; x < SCENE_WIDTH; x += 1) {
      const onLine = axis === 'vertical' ? x === position : y === position;
      if (onLine) bytes.fill(255, (y * SCENE_WIDTH + x) * BYTES_PER_PIXEL_SOURCE, (y * SCENE_WIDTH + x + 1) * BYTES_PER_PIXEL_SOURCE);
    }
  }
  return bytes;
}

function createSource(device, label, bytes) {
  const texture = device.createTexture({
    label,
    size: [SCENE_WIDTH, SCENE_HEIGHT],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, bytes, { bytesPerRow: SCENE_WIDTH * BYTES_PER_PIXEL_SOURCE }, [SCENE_WIDTH, SCENE_HEIGHT]);
  return texture;
}

// Sum of the red channel over every output texel after one downsample pass.
async function downsampleEnergy(device, bloom, sceneTexture, gridTexture, quality) {
  bloom.quality = quality;
  bloom.resize([sceneTexture], gridTexture, SCENE_WIDTH, SCENE_HEIGHT);
  const [width, height] = [bloom.textures[0].width, bloom.textures[0].height];
  // The bloom textures cannot be copied from, so the pass draws into a readable twin.
  const target = device.createTexture({
    label: 'bloom-check-target',
    size: [width, height],
    format: SCENE_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const bytesPerRow = Math.ceil(width * BYTES_PER_PIXEL_OUTPUT / ROW_ALIGNMENT) * ROW_ALIGNMENT;
  const staging = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder({ label: 'bloom-check' });
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
  });
  pass.setPipeline(bloom.downsamplePipeline);
  pass.setBindGroup(0, bloom.downsampleBindGroups[0]);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow }, [width, height]);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const halves = new Uint16Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  target.destroy();
  let energy = 0;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      energy += halfToFloat(halves[(row * bytesPerRow + column * BYTES_PER_PIXEL_OUTPUT) / 2]);
    }
  }
  return energy;
}

async function runCheck() {
  const gpu = await createGpuContext(document.getElementById('canvas'));
  const { device } = gpu;
  const bloom = new BloomPass(gpu, { fullscreenHeader: await loadFullscreenHeader() });
  await bloom.initialize();
  const gridTexture = createSource(device, 'bloom-check-grid', new Uint8Array(SCENE_WIDTH * SCENE_HEIGHT * BYTES_PER_PIXEL_SOURCE));
  const lines = [];
  let pass = true;
  for (const quality of Object.keys(BLOOM_DIVISORS)) {
    for (const axis of ['vertical', 'horizontal']) {
      const energies = [];
      for (let offset = 0; offset < OFFSET_COUNT; offset += 1) {
        const sceneTexture = createSource(device, 'bloom-check-scene', lineImage(axis, LINE_START / (axis === 'vertical' ? 1 : 2) + offset));
        energies.push(await downsampleEnergy(device, bloom, sceneTexture, gridTexture, quality));
        sceneTexture.destroy();
      }
      const lowest = Math.min(...energies);
      const highest = Math.max(...energies);
      const variation = highest > 0 ? (highest - lowest) / highest : 1;
      if (!(variation < MAXIMUM_VARIATION)) pass = false;
      lines.push(`[${energies.map((value) => value.toFixed(3)).join(" ")}] ${quality}(divisor ${BLOOM_DIVISORS[quality]}) ${axis}: variation ${(variation * 100).toFixed(1)}%`);
    }
  }
  return { pass, detail: lines.join('; ') };
}

runCheck().then(
  (result) => { window.__bloomCheck = result; },
  (error) => { window.__bloomCheck = { pass: false, detail: `exception: ${error.message}` }; },
);
