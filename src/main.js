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
import { pinnedCapacityFromSearch, probeDisabledFromSearch } from './ui/panelModel.js';
import { PRESETS } from './settings/presets.js';
import { FrameTimeProbe } from './settings/probe.js';
import { SettingsStore } from './settings/storage.js';
import { QualityController, adapterKeyFrom, detectMobile, resolveInitialPreset } from './game/quality.js';
import { createFrameTimer, frameTimerKindFromSearch } from './gpu/frame-timer.js';
import { installAudio } from './audio/audio-hook.js';
import { createHud } from './ui/hud.js';
import { createTouchOverlay, withHaptics } from './ui/touchOverlay.js';
import { STICK_RADIUS } from './input/touch.js';
import { setGamepadDeadZone } from './input/gamepad.js';
import { createLifeWatcher, createRumble } from './input/rumble.js';
import {
  bloomStrengthFor, createSettingsPanel, killBurstParticlesFor, shakeMultiplierFor, trailDecayFor,
} from './ui/settings.js';

const SETTINGS_KEY_CODE = 'KeyO';
const GAMEPAD_TOAST_MAXIMUM_ID_LENGTH = 40;

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
  const hud = createHud(document.getElementById('hud'));
  let renderer = null;
  // The HUD lives in CSS pixels; the viewport rectangle is in device pixels.
  const layoutHud = () => {
    const scale = 1 / viewport.devicePixelRatio;
    const rect = viewport.arenaRectDevicePixels;
    hud.layout(
      { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale },
      { width: viewport.canvasWidth * scale, height: viewport.canvasHeight * scale },
    );
  };
  const resizeCanvas = ({ width, height, devicePixelRatio }) => {
    canvas.width = width;
    canvas.height = height;
    viewport.setCanvasSize(width, height, devicePixelRatio);
    renderer?.resize(width, height);
    layoutHud();
  };
  // Sized explicitly before the first frame; the observer then keeps it current.
  const sizeCanvasNow = observeCanvasSize(canvas, resizeCanvas);
  sizeCanvasNow();

  // Quality: start at the stored preset for this adapter, else a conservative one for the device
  // type (resolveInitialPreset); ?capacity=N pins the capacity and keeps the Simulation defaults
  // for the rest, and turns the probe off, as ?probe=off does (the browser checks use both).
  const pinnedCapacity = pinnedCapacityFromSearch(location.search);
  const probeEnabled = !probeDisabledFromSearch(location.search);
  const store = new SettingsStore();
  const settings = store.load();
  const adapterKey = adapterKeyFrom(gpu.adapter.info);
  const initialPreset = resolveInitialPreset({
    settings,
    adapterKey,
    isMobile: detectMobile(),
    maxStorageBufferBindingSize: gpu.limits.maxStorageBufferBindingSize,
  });
  const preset = PRESETS[initialPreset.name];
  const simulation = await Simulation.create(gpu, pinnedCapacity !== null
    ? { capacity: pinnedCapacity }
    : { capacity: preset.capacity, neighborRadius: preset.neighborRadius, particleCapacity: preset.particleCapacity });
  renderer = await Renderer.create(gpu, { simulation, viewport });
  const input = createInput(canvas, viewport);
  // Read by the browser checks (the mobile smoke asserts on the aim vector).
  window.__murmuration.input = input;
  // Audio unlocks inside the gesture that starts the run (canvas pointerdown or touchstart, or a
  // key); a start button calls audio.unlock() from its own click handler.
  const audio = installAudio({ gestureTarget: canvas });
  audio.engine.setMusicVolume(settings.music / 100);
  audio.engine.setEffectsVolume(settings.effectsVolume / 100);
  window.__murmuration.audio = audio;
  // Frame times reach the quality controller once each frame's GPU work is done (frame-timer.js).
  let quality = null;
  const frameTimer = probeEnabled
    ? createFrameTimer(gpu, { kind: frameTimerKindFromSearch(location.search), now: () => performance.now(), onFrame: (milliseconds) => quality?.onFrame(milliseconds, performance.now() / 1000) })
    : null;
  // The game waits in Ready, the swarm running without player contact, until the first gesture.
  // Gamepad rumble follows the stored setting (read live); extra lives have no cue, so a watcher
  // on the game state rumbles them.
  let liveSettings = settings;
  const rumble = createRumble({ isEnabled: () => liveSettings.rumble });
  const lifeWatcher = createLifeWatcher(rumble);
  const game = await Game.create({ gpu, simulation, renderer, input, capacity: simulation.capacity, effects: withHaptics(audio.cues, undefined, rumble), frameTimer });
  quality = new QualityController({ game, store, probe: new FrameTimeProbe(), adapterKey, ceiling: initialPreset.ceiling });
  if (pinnedCapacity === null) quality.start(initialPreset.name, { allowUp: initialPreset.allowUp });
  window.__murmuration.quality = quality;
  window.__murmuration.game = game;

  // The settings panel applies every stored setting live: volumes, renderer effects, shake, trails,
  // kill-burst particles (Effects and reduced motion), and the stick tuning for touch and gamepad.
  const applySettings = (current) => {
    liveSettings = current;
    audio.engine.setMusicVolume(current.music / 100);
    audio.engine.setEffectsVolume(current.effectsVolume / 100);
    renderer.settings.trailDecay = trailDecayFor(current);
    renderer.settings.bloomStrength = bloomStrengthFor(current);
    renderer.impulses.strengthMultiplier = shakeMultiplierFor(current);
    game.simulation.setKillBurstParticles(killBurstParticlesFor(current));
    input.touch.setTuning({ deadZone: current.stickDeadZone, radius: STICK_RADIUS * current.stickRadius });
    setGamepadDeadZone(current.stickDeadZone);
  };
  applySettings(settings);
  // The select shows the preset in effect (the stored one is null until the probe settles).
  const panelStore = { load: () => ({ ...store.load(), preset: quality.current ?? store.load().preset }), save: (value) => store.save(value) };
  let lastPreset = quality.current;
  const settingsPanel = createSettingsPanel({
    store: panelStore,
    presets: Object.entries(PRESETS).map(([name, value]) => ({ name, ...value })),
    canChangePreset: pinnedCapacity === null,
    onRerunProbe: () => quality.rerunProbe(),
    onChange: (current) => {
      applySettings(current);
      if (current.preset && current.preset !== lastPreset && pinnedCapacity === null) {
        lastPreset = current.preset;
        // A capacity swap carries the burst size over, but re-apply once it has settled.
        quality.apply(current.preset).then(() => applySettings(current), () => {});
      }
    },
  });
  document.body.append(settingsPanel.element);
  hud.settingsButton.addEventListener('click', () => settingsPanel.open());
  window.addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (event.code === SETTINGS_KEY_CODE && !event.repeat) {
      if (settingsPanel.isOpen) settingsPanel.close();
      else settingsPanel.open();
    } else if (event.code === 'Escape') settingsPanel.close();
  });
  window.addEventListener('gamepadconnected', (event) => {
    hud.showToast(`Gamepad connected: ${String(event.gamepad?.id ?? 'controller').slice(0, GAMEPAD_TOAST_MAXIMUM_ID_LENGTH)}`);
  });
  window.__murmuration.settings = settingsPanel;

  // The game steps the simulation; stats carry the latest read-back frame plus the game state. The
  // audio follows the run: phase, multiplier and the kills read this update drive the intensity.
  const update = (fixedStep) => {
    game.update(fixedStep);
    if (game.latestStats) window.__murmuration.stats = { ...game.latestStats, ...game.state };
    audio.update({ fixedStep, freshStats: game.freshStats, capacity: game.simulation.capacity, phase: game.run.phase, multiplier: game.score.multiplier });
  };

  const touchOverlay = createTouchOverlay(document.getElementById('touch-overlay'), { touch: input.touch, canvas });
  let gameOverShown = false;
  const render = (alpha, deltaSeconds) => {
    game.render(alpha, deltaSeconds);
    const state = game.state;
    hud.update(state);
    touchOverlay.update(state);
    lifeWatcher.update(state);
    const isGameOver = state.phase === 'gameOver';
    if (isGameOver && !gameOverShown) hud.showGameOver(state.score, () => {
      audio.unlock();
      game.restart();
    });
    else if (!isGameOver && gameOverShown) hud.hideGameOver();
    gameOverShown = isGameOver;
    window.__murmuration.frame = loop.frameCount;
    window.__murmuration.ready = true;
  };

  installCaptureHook({ viewport, renderer });

  // The capacity swap goes through the game, one at a time (the panel also disables its controls
  // meanwhile); play continues on the old simulation until the new one is in place.
  const onCapacityChange = (capacity) => game.setCapacity(capacity);
  createDebugPanel({ getSimulation: () => game.simulation, renderer, onCapacityChange, onArmWeapon: (type, tier) => game.debugArm(type, tier) });

  const loop = new FrameLoop({ update, render });
  loop.start();
}

boot();
