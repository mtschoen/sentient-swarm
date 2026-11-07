import { createGpuContext, describeUnsupported, WebGpuUnavailableError } from './gpu/device.js';
import { Simulation } from './sim/simulation.js';
import { SpawnPressure } from './sim/spawner.js';
import { FrameLoop } from './game/loop.js';
import { createInput } from './input/input.js';
import { Viewport } from './render/viewport.js';
import { ARENA_WIDTH, ARENA_HEIGHT } from './sim/layout.js';

const DESKTOP_CAPACITY = 262144;
const PLAYER_SPEED = 6;
const DEBUG_KILL_RADIUS = 0.6;

window.__murmuration = { ready: false, frame: 0, stats: null };

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
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

  canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  const viewport = new Viewport();
  viewport.setCanvasSize(canvas.width, canvas.height, devicePixelRatio);

  const simulation = await Simulation.create(gpu, { capacity: DESKTOP_CAPACITY });
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

  const render = () => {
    window.__murmuration.frame = loop.frameCount;
    window.__murmuration.ready = true;
  };

  const loop = new FrameLoop({ update, render });
  loop.start();
}

boot();
