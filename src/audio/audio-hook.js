// Page wiring for audio. Browsers start audio only from a user activation, and on touch a
// pointerdown is not one, so every pointerup, touchend, click and keydown on the window creates the
// AudioContext (once) and asks it to resume, until it reports 'running'; then the gesture listeners
// are removed. The music starts when the context is created; ProceduralMusic drives its own
// scheduling timer so the beat does not depend on the frame loop. M mutes or resumes everything
// (music and effects; the sequencer keeps running so it comes back on the beat). The audio is
// suspended while the page is hidden. dispose() removes every listener and stops the timer.
import { AudioEngine } from './audio.js';
import { IntensityTracker } from './intensity.js';
import { ProceduralMusic } from './music.js';
import { EffectsSynth } from './sfx.js';

const MUTE_KEY_CODE = 'KeyM';
const GESTURE_EVENTS = ['pointerup', 'touchend', 'click'];
const HINT_STYLE = 'position:fixed;left:10px;bottom:8px;z-index:5;pointer-events:none;'
  + 'color:#cfe8ff;opacity:0.55;font:12px/1.4 system-ui,sans-serif;';

function isTextEntry(target) {
  const tag = target?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

export function installAudio({ windowObject = window, documentObject = document, contextFactory } = {}) {
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
    for (const name of GESTURE_EVENTS) windowObject.removeEventListener(name, onGesture);
    showHint();
  };

  const checkRunning = () => {
    if (engine.context?.state === 'running') stopListening();
  };

  function onGesture() {
    if (!listening) return;
    const firstTime = engine.context === null;
    const context = engine.unlock();
    if (context === null) {
      stopListening();
      return;
    }
    if (firstTime) music.start();
    checkRunning();
    engine.pendingResume.then(checkRunning);
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

  for (const name of GESTURE_EVENTS) windowObject.addEventListener(name, onGesture);
  windowObject.addEventListener('keydown', onKeyDown);
  documentObject.addEventListener('visibilitychange', onVisibilityChange);

  // Called every fixed update. freshStats is the stats read back this update, or null; the alive
  // count comes from the latest stats seen.
  let aliveTotal = 0;
  const update = ({ fixedStep, freshStats, capacity }) => {
    const killsThisFrame = freshStats?.killsSinceLastRead ?? 0;
    if (freshStats) aliveTotal = freshStats.aliveTotal;
    music.setIntensity(intensity.update({ fixedStep, aliveTotal, capacity, killsThisFrame }));
    if (killsThisFrame > 0) effects.kills(killsThisFrame);
  };

  const dispose = () => {
    stopListening();
    windowObject.removeEventListener('keydown', onKeyDown);
    documentObject.removeEventListener('visibilitychange', onVisibilityChange);
    music.stop();
    hint.remove?.();
  };

  return {
    engine, music, effects, intensity, update, setMuted, dispose,
    get muted() { return engine.muted; },
    get listening() { return listening; },
  };
}
