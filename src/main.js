import { createGpuContext, describeUnsupported, WebGpuUnavailableError } from './gpu/device.js';
import { Simulation } from './sim/simulation.js';
import { FrameLoop } from './game/loop.js';
import { Game } from './game/game.js';
import { createInput } from './input/input.js';
import { Viewport } from './render/viewport.js';
import { Renderer } from './render/renderer.js';
import { observeCanvasSize } from './render/canvas-size.js';
import { installCaptureHook } from './render/capture-hook.js';
import { createDebugPanel } from './ui/debugPanel.js';
import { capacityFromSearch } from './ui/panelModel.js';
import { installAudio } from './audio/audio-hook.js';

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
  const simulation = await Simulation.create(gpu, { capacity: initialCapacity });
  renderer = await Renderer.create(gpu, { simulation, viewport });
  const input = createInput(canvas, viewport);
  const audio = installAudio();
  window.__murmuration.audio = audio;
  // The game waits in Ready, the swarm running without player contact, until the first gesture.
  const game = await Game.create({ gpu, simulation, renderer, input, capacity: initialCapacity });

  // The game steps the simulation; stats carry the latest read-back frame plus the game state.
  const update = (fixedStep) => {
    game.update(fixedStep);
    if (game.latestStats) window.__murmuration.stats = { ...game.latestStats, ...game.state };
    audio.update({ fixedStep, freshStats: game.freshStats, capacity: game.simulation.capacity });
  };

  const render = (alpha, deltaSeconds) => {
    game.render(alpha, deltaSeconds);
    window.__murmuration.frame = loop.frameCount;
    window.__murmuration.ready = true;
  };

  installCaptureHook({ viewport, renderer });

  // The capacity swap goes through the game, one at a time (the panel also disables its controls
  // meanwhile); stepping pauses until the new simulation is in place.
  const onCapacityChange = (capacity) => game.setCapacity(capacity);
  createDebugPanel({ getSimulation: () => game.simulation, renderer, onCapacityChange, onArmWeapon: (type, tier) => game.debugArm(type, tier) });

  const loop = new FrameLoop({ update, render });
  loop.start();
}

boot();
