import { createGpuContext, describeUnsupported, WebGpuUnavailableError } from './gpu/device.js';
import { Simulation } from './sim/simulation.js';
import { SpawnPressure } from './sim/spawner.js';
import { FrameLoop } from './game/loop.js';
import { createInput } from './input/input.js';
import { Viewport } from './render/viewport.js';
import { Renderer } from './render/renderer.js';
import { observeCanvasSize } from './render/canvas-size.js';
import { meanLuminance } from './render/capture.js';
import { ARENA_WIDTH, ARENA_HEIGHT } from './sim/layout.js';

const DESKTOP_CAPACITY = 262144;
const PLAYER_SPEED = 6;
const DEBUG_KILL_RADIUS = 0.6;
// Frames rendered with a capture's overrides before the capture, so earlier trails fade (0.9^30 is 4 percent).
const CAPTURE_SETTLE_FRAMES = 30;

window.__murmuration = { ready: false, frame: 0, stats: null };

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function describeCapture(frame, arenaRect, region) {
  const { width, height, pixels } = frame;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height), 0, 0);
  // The letterbox band (top strip, or left strip when the canvas is wider than the arena) should stay black.
  const band = arenaRect.y > 0
    ? { x: 0, y: 0, width, height: arenaRect.y }
    : { x: 0, y: 0, width: arenaRect.x, height };
  return {
    width,
    height,
    arenaRect,
    meanLuminance: meanLuminance(pixels, width, arenaRect),
    bandLuminance: meanLuminance(pixels, width, band),
    regionLuminance: region ? meanLuminance(pixels, width, region) : null,
    pngDataUrl: canvas.toDataURL('image/png'),
  };
}

function waitAnimationFrames(count) {
  return new Promise((resolve) => {
    let remaining = count;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function boot() {
  const canvas = document.getElementById('arena');
  let gpu;
  try {
    gpu = await createGpuContext(canvas);
  } catch (error) {
    if (error instanceof WebGpuUnavailableError) {
      const message = document.getElementById('message');
      message.textContent = describeUnsupported(error);
      message.hidden = false;
      return;
    }
    throw error;
  }

  const viewport = new Viewport();
  let renderer = null;
  const resizeCanvas = ({ width, height }) => {
    canvas.width = width;
    canvas.height = height;
    viewport.setCanvasSize(width, height, devicePixelRatio);
    renderer?.resize(width, height);
  };
  // Sized explicitly before the first frame; the observer then keeps it current.
  const sizeCanvasNow = observeCanvasSize(canvas, resizeCanvas);
  sizeCanvasNow();

  const simulation = await Simulation.create(gpu, { capacity: DESKTOP_CAPACITY });
  renderer = await Renderer.create(gpu, { simulation, viewport });
  const spawnPressure = new SpawnPressure({ capacity: DESKTOP_CAPACITY });
  const input = createInput(canvas, viewport);

  const player = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
  let lastStats = null;

  const update = (fixedStep) => {
    input.update();
    const { state } = input;
    player.x = clamp(player.x + state.move.x * PLAYER_SPEED * fixedStep, 0, ARENA_WIDTH);
    player.y = clamp(player.y + state.move.y * PLAYER_SPEED * fixedStep, 0, ARENA_HEIGHT);
    simulation.setPlayer(player.x, player.y);
    if (state.pointerPrimaryDown && state.pointerWorld) {
      simulation.setDebugKill(state.pointerWorld.x, state.pointerWorld.y, DEBUG_KILL_RADIUS);
    }
    const spawnPerSpecies = spawnPressure.update(fixedStep, lastStats?.aliveTotal ?? 0, simulation.shares);
    const encoder = gpu.device.createCommandEncoder();
    simulation.step(encoder, fixedStep, spawnPerSpecies);
    gpu.device.queue.submit([encoder.finish()]);
    simulation.afterSubmit();
    const stats = simulation.readStats();
    if (stats) {
      lastStats = stats;
      window.__murmuration.stats = stats;
    }
  };

  const render = (alpha) => {
    const encoder = gpu.device.createCommandEncoder();
    renderer.render(encoder, { alpha, time: simulation.time });
    gpu.device.queue.submit([encoder.finish()]);
    renderer.afterSubmit();
    window.__murmuration.frame = loop.frameCount;
    window.__murmuration.ready = true;
  };

  // Smoke-test readback of a composited frame. With inspectZoom or renderer setting overrides
  // (for example { trailDecay: 0 }), they hold for CAPTURE_SETTLE_FRAMES frames plus the captured
  // one, then the previous values return. region (a device-pixel rect) adds its mean as regionLuminance.
  window.__murmuration.capture = async ({ inspectZoom, settings, region } = {}) => {
    const previousZoom = viewport.inspectZoom;
    const previousSettings = { ...renderer.settings };
    let frame;
    try {
      if (inspectZoom !== undefined || settings !== undefined) {
        viewport.inspectZoom = inspectZoom ?? previousZoom;
        Object.assign(renderer.settings, settings);
        await waitAnimationFrames(CAPTURE_SETTLE_FRAMES);
      }
      frame = await renderer.captureNextFrame();
    } finally {
      viewport.inspectZoom = previousZoom;
      Object.assign(renderer.settings, previousSettings);
    }
    return describeCapture(frame, viewport.arenaRectDevicePixels, region);
  };

  const loop = new FrameLoop({ update, render });
  loop.start();
}

boot();
