// Page wiring for audio. Browsers start audio only inside a user activation, and iOS Safari needs
// the AudioContext created or resumed synchronously inside the input event handler (a call from
// requestAnimationFrame is too late). So the one unlock path, unlock(), runs inside the very
// gestures that start the run: pointerdown and touchstart on the canvas (gestureTarget, where
// pointer.js and touch.js listen) and keydown on the window, plus touchend on the canvas, because
// iOS counts only a touchend as activation and resumes a context the touchstart left suspended.
// A start button (the menu's onStart) calls unlock() itself. Once the context reports 'running'
// the canvas listeners are removed. A gamepad press is not a user activation in browsers: a
// gamepad start leaves audio locked until the next pointer or key gesture.
// The music starts when the context is created; ProceduralMusic drives its own scheduling timer so
// the beat does not depend on the frame loop. M mutes or resumes everything (music and effects;
// the sequencer keeps running so it comes back on the beat). The audio is suspended while the page
// is hidden and resumed when it is shown or the window regains focus. cues is what the Game calls
// (effects and music cues together); update(), called every fixed step, drives the intensity.
// dispose() removes every listener and stops the timer.
import { AudioEngine } from './audio.js';
import { IntensityTracker } from './intensity.js';
import { ProceduralMusic } from './music.js';
import { EffectsSynth } from './sfx.js';

const MUTE_KEY_CODE = 'KeyM';
const GESTURE_EVENTS = ['pointerdown', 'touchstart', 'touchend'];
const HINT_STYLE = 'position:fixed;left:10px;bottom:8px;z-index:5;pointer-events:none;'
  + 'color:#cfe8ff;opacity:0.55;font:12px/1.4 system-ui,sans-serif;';

function isTextEntry(target) {
  const tag = target?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

export function installAudio({ windowObject = window, documentObject = document, gestureTarget = null, contextFactory } = {}) {
  const engine = new AudioEngine(contextFactory ? { contextFactory } : {});
  const music = new ProceduralMusic(engine, { timers: windowObject });
  const effects = new EffectsSynth(engine);
  const intensity = new IntensityTracker();
  let listening = true;

  const hint = documentObject.createElement('div');
  hint.id = 'audio-hint';
  hint.setAttribute('style', HINT_STYLE);
  documentObject.body.appendChild(hint);
  const showHint = () => {
    if (listening) hint.textContent = 'tap, click or press a key for sound';
    else if (engine.context === null) hint.textContent = '';
    else hint.textContent = engine.muted ? 'M to unmute' : 'M to mute';
  };
  showHint();

  const setMuted = (value) => {
    engine.setMuted(value);
    showHint();
  };

  const stopListening = () => {
    if (!listening) return;
    listening = false;
    for (const name of GESTURE_EVENTS) gestureTarget?.removeEventListener(name, onGesture);
    showHint();
  };

  const checkRunning = () => {
    if (engine.context?.state === 'running') stopListening();
  };

  // Creates the context (once) and starts the music, or resumes a suspended context. Returns the
  // context, or null when audio is unavailable. Must run inside a user gesture's event handler.
  function unlock() {
    const firstTime = engine.context === null;
    const context = engine.unlock();
    if (context === null) {
      stopListening();
      return null;
    }
    if (firstTime) music.start();
    checkRunning();
    engine.pendingResume.then(checkRunning);
    return context;
  }

  function onGesture() {
    if (listening) unlock();
  }

  // The gesture runs before the mute check, so M as the very first key starts everything muted.
  const onKeyDown = (event) => {
    onGesture();
    if (event.code === MUTE_KEY_CODE && !event.repeat && !isTextEntry(event.target) && engine.context !== null) {
      setMuted(!engine.muted);
    }
  };

  const onVisibilityChange = () => {
    if (engine.context === null) return;
    if (documentObject.hidden) engine.suspend();
    else engine.resume();
  };

  const onFocus = () => {
    if (engine.context !== null && !documentObject.hidden) engine.resume();
  };

  for (const name of GESTURE_EVENTS) gestureTarget?.addEventListener(name, onGesture);
  windowObject.addEventListener('keydown', onKeyDown);
  windowObject.addEventListener('focus', onFocus);
  documentObject.addEventListener('visibilitychange', onVisibilityChange);

  // What the Game calls: each plays its effect and the matching music cue.
  const cues = {
    weaponFire: (kind, tier) => effects.weaponFire(kind, tier),
    kills: (count) => effects.kills(count),
    // A time warp pickup (owner ruling R31) plays its falling cue; the warp itself slows the
    // music through update's timeScale, so the rising music riser stays out.
    pickup: (type = null) => {
      effects.pickup(type);
      if (type !== 'timewarp') music.cue('pickup');
    },
    expiry: () => {
      effects.expiry();
      music.cue('expiry');
    },
    bomb: () => {
      effects.bomb();
      music.cue('bomb');
    },
    death: () => {
      effects.death();
      music.cue('death');
      intensity.onDeath();
    },
  };

  // Called every fixed update with the game's phase, multiplier and time scale (the time warp's
  // simulation speed, 1 without one). freshStats is the stats read back this update, or null. A run starting (Ready or GameOver to Playing) restarts the build;
  // kills while Playing play the kill splash and a melodic hit.
  let previousPhase = null;
  const update = ({ fixedStep, freshStats, capacity, phase = 'playing', multiplier = 1, timeScale = 1 }) => {
    music.setTimeScale(timeScale);
    const playing = phase === 'playing';
    if (playing && (previousPhase === 'ready' || previousPhase === 'gameOver')) intensity.reset();
    previousPhase = phase;
    const killsThisFrame = playing ? freshStats?.killsSinceLastRead ?? 0 : 0;
    music.setIntensity(intensity.update({ fixedStep, playing, multiplier, killsThisFrame, capacity }));
    if (killsThisFrame > 0) {
      effects.kills(killsThisFrame);
      music.hit(killsThisFrame);
    }
  };

  const dispose = () => {
    stopListening();
    for (const name of GESTURE_EVENTS) gestureTarget?.removeEventListener(name, onGesture);
    windowObject.removeEventListener('keydown', onKeyDown);
    windowObject.removeEventListener('focus', onFocus);
    documentObject.removeEventListener('visibilitychange', onVisibilityChange);
    music.stop();
    hint.remove?.();
  };

  // The pause menu ducks the music (a lowpass and a gain ramp, about 150 ms); false restores it.
  const setPaused = (paused) => music.setPaused(paused);
  // Every run start and restart (title, game over, the pause menu's Restart run) starts the build
  // over; update() alone misses a restart that goes Playing to Playing while paused.
  const restartRun = () => intensity.reset();

  return {
    engine, music, effects, intensity, cues, unlock, update, setMuted, setPaused, restartRun, dispose,
    get muted() { return engine.muted; },
    get listening() { return listening; },
  };
}
