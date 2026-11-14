import { createGpuContext, describeUnsupported, WebGpuUnavailableError } from './gpu/device.js';
import { Simulation } from './sim/simulation.js';
import { FrameLoop } from './game/loop.js';
import { Game, RESTART_GUARD_SECONDS } from './game/game.js';
import { createInput } from './input/input.js';
import { Viewport } from './render/viewport.js';
import { Renderer } from './render/renderer.js';
import { observeCanvasSize } from './render/canvas-size.js';
import { installCaptureHook } from './render/capture-hook.js';
import { createLabPanel } from './ui/labPanel.js';
import { LabMode } from './ui/lab.js';
import { capacityOptionsUpTo, pinnedCapacityFromSearch, probeDisabledFromSearch } from './ui/panelModel.js';
import { feelFromSearch, feelToSearchMerged } from './game/swarm-feel.js';
import { createSwarmFeelGroup } from './ui/swarm-feel-panel.js';
import { PRESETS } from './settings/presets.js';
import { FrameTimeProbe } from './settings/probe.js';
import { SettingsStore } from './settings/storage.js';
import { QualityController, adapterKeyFrom, detectMobile, detectTouchDevice, resolveInitialPreset, settleApply } from './game/quality.js';
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
import { LoadProgress, WarmUp, createLoadingScreen } from './ui/loading.js';
import { createMenu, createPauseMenu } from './ui/menu.js';
import { createRotateOverlay } from './ui/rotateOverlay.js';
import { createFullscreenController } from './ui/fullscreen.js';
import { createMenuInput } from './input/menuInput.js';
import { createRotateBackHandler, createSettingsOpener, routeMenuActions, routeSettingsKey } from './ui/menuRouting.js';

const GAMEPAD_TOAST_MAXIMUM_ID_LENGTH = 40;

window.__murmuration = { ready: false, frame: 0, stats: null, loading: { done: false } };

async function boot() {
  const canvas = document.getElementById('arena');
  // The loading screen covers boot and a short hidden warm-up (the first rendered frames).
  const loading = createLoadingScreen({ element: document.getElementById('loading') });
  const progress = new LoadProgress();
  const warmUp = new WarmUp();
  const showProgress = (stageName, completed, total) => {
    progress.report(stageName, completed, total);
    loading.update(progress.fraction, progress.label);
  };
  let gpu;
  try {
    gpu = await createGpuContext(canvas);
    showProgress('device', 1, 1);
  } catch (error) {
    if (error instanceof WebGpuUnavailableError) {
      loading.fail();
      const message = document.getElementById('message');
      message.textContent = describeUnsupported(error);
      message.hidden = false;
      return;
    }
    throw error;
  }

  const viewport = new Viewport();
  // The pause button asks for the same pause menu as Escape; requestPause is defined with the game.
  const hud = createHud(document.getElementById('hud'), { onPause: () => requestPause() });
  let renderer = null;
  // Created after the first resize, so resizeCanvas reaches it only once it exists (`let` hoists the name).
  let game = null;
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
    game?.setArenaBounds(viewport.arenaBounds);
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
    ? { capacity: pinnedCapacity, scaleDensityToCapacity: true, onProgress: (completed, total) => showProgress('simulation', completed, total) }
    : { capacity: preset.capacity, neighborRadius: preset.neighborRadius, particleCapacity: preset.particleCapacity, scaleDensityToCapacity: true, onProgress: (completed, total) => showProgress('simulation', completed, total) });
  renderer = await Renderer.create(gpu, { simulation, viewport, onProgress: (completed, total) => showProgress('renderer', completed, total) });
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
    ? createFrameTimer(gpu, {
      kind: frameTimerKindFromSearch(location.search),
      now: () => performance.now(),
      onFrame: (milliseconds) => quality?.onFrame(milliseconds, performance.now() / 1000),
    })
    : null;
  // The game waits in Ready, the swarm running without player contact, until the first gesture.
  // Gamepad rumble follows the stored setting (read live); extra lives have no cue, so a watcher
  // on the game state rumbles them.
  let liveSettings = settings;
  const rumble = createRumble({ isEnabled: () => liveSettings.rumble });
  const lifeWatcher = createLifeWatcher(rumble);
  game = await Game.create({
    gpu,
    simulation,
    renderer,
    input,
    capacity: simulation.capacity,
    effects: withHaptics(audio.cues, undefined, rumble),
    frameTimer,
  });
  showProgress('game', 1, 1);
  quality = new QualityController({ game, store, probe: new FrameTimeProbe(), adapterKey, ceiling: initialPreset.ceiling });
  if (pinnedCapacity === null) quality.start(initialPreset.name, { allowUp: initialPreset.allowUp });
  window.__murmuration.quality = quality;
  game.setArenaBounds(viewport.arenaBounds);
  // Player swarm spike: ?swarm=N starts every run with N ships (1 to the cap), for trying a big swarm.
  const swarmParameter = new URLSearchParams(location.search).get('swarm');
  if (swarmParameter !== null) game.setInitialSwarmShips(Number(swarmParameter));
  // Swarm feel dials (experiment): ?swarmAlignment=&swarmTightness=&swarmBuzz= over the bees default.
  const swarmFeel = feelFromSearch(location.search);
  game.setSwarmFeel(swarmFeel);
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
  const panelStore = {
    load: () => ({ ...store.load(), preset: quality.current ?? store.load().preset }),
    save: (value) => store.save(value),
  };
  const settlePreset = settleApply({ quality, liveSettings: () => liveSettings, applySettings });
  const settingsPanel = createSettingsPanel({
    store: panelStore,
    presets: Object.entries(PRESETS).map(([name, value]) => ({ name, ...value })),
    canChangePreset: pinnedCapacity === null,
    onRerunProbe: () => quality.rerunProbe(),
    onChange: (current) => {
      applySettings(current);
      if (pinnedCapacity === null) settlePreset(current, () => settingsPanel.refresh());
    },
  });
  document.body.append(settingsPanel.element);
  // The dials sit right under the panel's title, so they are the first thing a phone player sees.
  const swarmFeelGroup = createSwarmFeelGroup({
    feel: swarmFeel,
    onChange: (feel) => history.replaceState(null, '', `${location.pathname}${feelToSearchMerged(location.search, feel)}${location.hash}`),
  });
  settingsPanel.element.querySelector('.settings-header').after(swarmFeelGroup.element);
  window.__murmuration.swarmFeel = swarmFeel;
  hud.settingsButton.addEventListener('click', () => openSettings());
  // O toggles the panel. Escape (and the gamepad's back and Options) close it through the menu
  // action path in render (menuRouting.js), so that press never also pauses or resumes the run.
  window.addEventListener('keydown', (event) => routeSettingsKey(event, {
    settingsOpen: () => settingsPanel.isOpen,
    closeSettings: () => settingsPanel.close(),
    openSettings: () => openSettings(),
    dispatch: () => {},
  }));
  window.addEventListener('gamepadconnected', (event) => {
    hud.showToast(`Gamepad connected: ${String(event.gamepad?.id ?? 'controller').slice(0, GAMEPAD_TOAST_MAXIMUM_ID_LENGTH)}`);
  });
  window.__murmuration.settings = settingsPanel;

  // The game steps the simulation; stats carry the latest read-back frame plus the game state. The
  // audio follows the run: phase, multiplier and the kills read this update drive the intensity.
  // window.__murmuration.stats is merged on read, so the per-update object is not built every step.
  Object.defineProperty(window.__murmuration, 'stats', {
    configurable: true,
    enumerable: true,
    get: () => (game.latestStats ? { ...game.latestStats, ...game.state } : null),
  });
  const update = (fixedStep) => {
    game.update(fixedStep);
    if (game.paused) return;
    audio.update({
      fixedStep,
      freshStats: game.freshStats,
      capacity: game.simulation.capacity,
      phase: game.run.phase,
      multiplier: game.score.multiplier,
      timeScale: game.timeWarp.scale,
    });
  };

  const touchOverlay = createTouchOverlay(document.getElementById('touch-overlay'), { touch: input.touch, canvas });

  // Menus (owner ruling R17). The title menu is the one input from load to play: its buttons, a tap
  // on the arena, Enter, Space or a gamepad face button start the run, and audio unlocks inside
  // that same handler. While it shows the game does not start on stray movement (a menu cursor must
  // not start the run), and the swarm keeps running behind it. The pause menu (Escape, the HUD
  // button, Options, blur, a hidden tab) freezes the run and ducks the music; the rotate overlay
  // pauses the run too, without a menu, and resumes it when the phone turns back.
  // Opening Settings mid-run (O, the HUD button) pauses it under the pause menu first, so gameplay
  // keys never act behind the panel and closing it returns to the pause menu; from the title or the
  // pause menu it just opens over them (pauseForMenu does nothing in Ready, GameOver or when paused).
  const settingsOpen = () => settingsPanel.isOpen;
  const openSettings = createSettingsOpener({
    isRotateShowing: () => rotateShowing,
    pauseForMenu: () => pauseForMenu(),
    openPanel: () => settingsPanel.open(),
  });
  // The lab mode (task C6b) is created with the menus below; the title menu's Lab button enters it.
  const openLab = () => lab.enter();
  // On a phone or any touch-first device (a foldable or tablet does not report itself as mobile)
  // the run plays fullscreen (fullscreen.js): entered inside the gesture that starts, resumes or
  // restarts it, left when the title menu shows (render below). The pause menu and game over stay
  // fullscreen; leaving fullscreen by the back gesture mid-run pauses under the pause menu.
  // ?debug=fullscreen shows why a request was refused, for a device with no console at hand.
  const fullscreenDebug = new URLSearchParams(location.search).get('debug') === 'fullscreen';
  const fullscreen = createFullscreenController({
    enabled: detectMobile() || detectTouchDevice(),
    onExternalExit: () => pauseForMenu(),
    onRefused: (reason) => { if (fullscreenDebug) hud.showToast(`Fullscreen refused: ${reason}`); },
  });
  const startRun = () => {
    if (game.run.phase !== 'ready') return;
    fullscreen.enter();
    audio.unlock();
    audio.restartRun();
    game.start();
    menu.hide();
  };
  // Also the pause menu's Restart run, which goes Playing to Playing.
  const restartFromGameOver = () => {
    fullscreen.enter();
    audio.unlock();
    audio.restartRun();
    game.restart();
  };
  const resumeGame = () => {
    pausedByRotate = false;
    pauseMenu.hide();
    game.resume();
    audio.setPaused(false);
  };
  const pauseForMenu = () => {
    if (game.paused && !pausedByRotate) return;
    if (!game.paused && !game.pause()) return;
    pausedByRotate = false;
    audio.setPaused(true);
    pauseMenu.show();
  };
  const menu = createMenu({ onStart: startRun, onLab: openLab, onSettings: openSettings });
  const pauseMenu = createPauseMenu({
    onResume: () => {
      fullscreen.enter();
      resumeGame();
    },
    onSettings: openSettings,
    onRestart: () => {
      resumeGame();
      restartFromGameOver();
    },
    onQuit: () => {
      resumeGame();
      // Quitting a lab Play run leaves the lab too (it resets the run and shows the title itself).
      if (lab.active) {
        lab.leave();
        return;
      }
      game.quitToTitle();
      menu.show();
    },
  });
  pauseMenu.hide();
  document.getElementById('menu').append(menu.element, pauseMenu.element);
  const rotateOverlay = createRotateOverlay({ isMobile: detectMobile() });
  document.getElementById('rotate-overlay').append(rotateOverlay.element);
  const menuInput = createMenuInput();
  let pausedByRotate = false;
  let rotateShowing = false;
  // Settings opened over the rotate overlay: rotating back keeps the run paused under the pause menu.
  const onRotateBack = createRotateBackHandler({
    settingsOpen,
    resume: resumeGame,
    holdForMenu: () => {
      pausedByRotate = false;
      pauseMenu.show();
    },
  });

  function requestPause() {
    if (rotateShowing || settingsOpen()) return;
    if (game.paused && pauseMenu.visible) resumeGame();
    else pauseForMenu();
  }
  window.addEventListener('blur', pauseForMenu);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseForMenu(); });

  const dispatchMenuAction = (action, phase) => {
    if (action === 'pause') requestPause();
    else if (pauseMenu.visible) pauseMenu.handleAction(action);
    else if (menu.visible) menu.handleAction(action);
    else if (phase === 'gameOver' && (action === 'confirm' || action === 'altConfirm')
      && game.gameOverSeconds > RESTART_GUARD_SECONDS) restartFromGameOver();
  };

  let gameOverShown = false;
  const render = (alpha, deltaSeconds) => {
    game.render(alpha, deltaSeconds);
    const state = game.state;
    hud.update(state);
    touchOverlay.update(state);
    lifeWatcher.update(state);
    const isGameOver = state.phase === 'gameOver';
    if (isGameOver && !gameOverShown) hud.showGameOver(state.score, restartFromGameOver);
    else if (!isGameOver && gameOverShown) hud.hideGameOver();
    gameOverShown = isGameOver;

    const rotating = rotateOverlay.update();
    if (rotating && !rotateShowing && game.pause()) {
      pausedByRotate = true;
      audio.setPaused(true);
    } else if (!rotating && rotateShowing && pausedByRotate) {
      onRotateBack();
    }
    rotateShowing = rotating;
    if (state.phase !== 'ready' && menu.visible) menu.hide();
    // The title menu is never fullscreen, whichever way it came up (quit, leaving the lab).
    if (menu.visible) fullscreen.exit();
    const warming = !warmUp.done;
    game.startsOnGesture = !menu.visible && !warming;
    // Gamepad edges and key presses are consumed every frame so none go stale; only a free screen
    // acts on them, and none does while the loading screen is up.
    const actions = menuInput.poll();
    if (!rotating && !warming) {
      routeMenuActions(actions, {
        settingsOpen,
        closeSettings: () => settingsPanel.close(),
        dispatch: (action) => dispatchMenuAction(action, state.phase),
      });
    }

    window.__murmuration.frame = loop.frameCount;
    if (warming && warmUp.frame(deltaSeconds)) loading.finish();
    if (warming) showProgress('warmUp', warmUp.progress, 1);
    window.__murmuration.loading.done = warmUp.done;
    window.__murmuration.ready = warmUp.done;
  };

  installCaptureHook({ viewport, renderer });

  // The lab (task C6b): Watch, Play, mixes and the tuning panel. Capacity and neighbor radius swaps
  // go through the game, one at a time (the panel also disables its controls meanwhile); play
  // continues on the old simulation until the new one is in place. The capacity choices stop at
  // the quality probe's ceiling (plus the current one, which a ?capacity= pin may put above it).
  // Leaving restores the state captured on entry; the live settings then go back on top of it.
  const lab = new LabMode({ game, renderer, viewport, menu, audio, onLeave: () => applySettings(liveSettings) });
  const ceilingCapacity = PRESETS[initialPreset.ceiling]?.capacity ?? null;
  const capacityOptions = [...new Set([...capacityOptionsUpTo(ceilingCapacity), simulation.capacity])]
    .sort((first, second) => first - second);
  createLabPanel({
    lab,
    getSimulation: () => game.simulation,
    onCapacityChange: (capacity, options) => game.setCapacity(capacity, options),
    capacityOptions,
    onArmWeapon: (type, tier) => game.debugArm(type, tier),
    store: window.localStorage,
  });
  window.__murmuration.lab = lab;
  // A shared link (#mix=) opens the lab with its mix; a malformed one opens it on the defaults.
  lab.loadFromHash(location.hash);

  const loop = new FrameLoop({ update, render });
  loop.start();
}

boot();
