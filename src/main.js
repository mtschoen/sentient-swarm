import { createGpuContext, describeUnsupported, WebGpuUnavailableError } from './gpu/device.js';
import { Simulation } from './sim/simulation.js';
import { SpawnPressure } from './sim/spawner.js';
import { FrameLoop } from './game/loop.js';
import { applyControlsToSimulation, movePlayer } from './game/controls.js';
import { CapacitySwap } from './game/capacity-swap.js';
import { createInput } from './input/input.js';
import { Viewport } from './render/viewport.js';
import { Renderer } from './render/renderer.js';
import { observeCanvasSize } from './render/canvas-size.js';
import { installCaptureHook } from './render/capture-hook.js';
import { createDebugPanel } from './ui/debugPanel.js';
import { capacityFromSearch } from './ui/panelModel.js';
import { ARENA_WIDTH, ARENA_HEIGHT } from './sim/layout.js';

window.__murmuration = { ready: false, frame: 0, stats: null };

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
  const resizeCanvas = ({ width, height, devicePixelRatio }) => {
    canvas.width = width;
    canvas.height = height;
    viewport.setCanvasSize(width, height, devicePixelRatio);
    renderer?.resize(width, height);
  };
  // Sized explicitly before the first frame; the observer then keeps it current.
  const sizeCanvasNow = observeCanvasSize(canvas, resizeCanvas);
  sizeCanvasNow();

  const initialCapacity = capacityFromSearch(location.search);
  let simulation = await Simulation.create(gpu, { capacity: initialCapacity });
  renderer = await Renderer.create(gpu, { simulation, viewport });
  const spawnPressure = new SpawnPressure({ capacity: initialCapacity });
  const input = createInput(canvas, viewport);

  const player = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
  let lastStats = null;

  // A capacity change pauses stepping from its request until the new simulation is installed
  // (see CapacitySwap); one change at a time, and the panel disables its controls meanwhile.
  // install runs synchronously in the recreate's continuation, so no frame sees a destroyed
  // simulation. SpawnPressure keeps its ramp across the change.
  const capacitySwap = new CapacitySwap({
    getCapacity: () => simulation.capacity,
    recreate: (capacity) => simulation.recreateWithCapacity(capacity),
    install: (next) => {
      simulation = next;
      renderer.setSimulation(next);
      spawnPressure.setCapacity(next.capacity);
    },
  });

  const update = (fixedStep) => {
    input.update();
    movePlayer(player, input.state, fixedStep);
    if (capacitySwap.simulationPaused) return;
    applyControlsToSimulation(simulation, input.state, player);
    const spawnPerSpecies = spawnPressure.update(fixedStep, lastStats, simulation.shares, simulation.frameSequence + 1);
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

  installCaptureHook({ viewport, renderer });

  createDebugPanel({ getSimulation: () => simulation, renderer, onCapacityChange: (capacity) => capacitySwap.request(capacity) });

  const loop = new FrameLoop({ update, render });
  loop.start();
}

boot();
