// Page wiring for audio. The AudioContext is created on the first pointerdown or keydown on the
// window (browsers require a gesture), and the music starts then. The sequencer is fed from a timer
// at its schedule interval so the beat does not depend on the frame loop. M mutes or resumes the
// music (its gain only; the sequencer keeps running so it comes back on the beat). The audio is
// suspended while the page is hidden. Exposes { engine, music, effects } on window.__murmuration.audio.
import { AudioEngine } from './audio.js';
import { IntensityTracker } from './intensity.js';
import { ProceduralMusic } from './music.js';
import { EffectsSynth } from './sfx.js';

const MUTE_KEY_CODE = 'KeyM';
const HINT_STYLE = 'position:fixed;left:10px;bottom:8px;z-index:5;pointer-events:none;'
  + 'color:#cfe8ff;opacity:0.55;font:12px/1.4 system-ui,sans-serif;';

function isTextEntry(target) {
  const tag = target?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

export function installAudio({ windowObject = window, documentObject = document } = {}) {
  const engine = new AudioEngine();
  const music = new ProceduralMusic(engine);
  const effects = new EffectsSynth(engine);
  const intensity = new IntensityTracker();
  let unlocked = false;
  let muted = false;
  let timer = null;

  const hint = documentObject.createElement('div');
  hint.id = 'audio-hint';
  hint.setAttribute('style', HINT_STYLE);
  documentObject.body.appendChild(hint);
  const showHint = () => {
    if (!unlocked) hint.textContent = 'click or press a key for sound';
    else if (engine.context === null) hint.textContent = '';
    else hint.textContent = muted ? 'M to unmute' : 'M to mute';
  };
  showHint();

  const setMuted = (value) => {
    muted = value;
    engine.setMusicVolume(muted ? 0 : 1);
    showHint();
  };

  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    windowObject.removeEventListener('pointerdown', unlock);
    const context = engine.unlock();
    if (context !== null) {
      music.start();
      const tick = () => music.update(context.currentTime);
      tick();
      timer = windowObject.setInterval(tick, music.sequencer.scheduleIntervalSeconds * 1000);
    }
    showHint();
  };

  // The unlock runs before the mute check, so M as the very first key starts the music muted.
  const onKeyDown = (event) => {
    unlock();
    if (event.code === MUTE_KEY_CODE && !event.repeat && !isTextEntry(event.target) && engine.context !== null) {
      setMuted(!muted);
    }
  };

  windowObject.addEventListener('pointerdown', unlock);
  windowObject.addEventListener('keydown', onKeyDown);
  documentObject.addEventListener('visibilitychange', () => {
    if (engine.context === null) return;
    if (documentObject.hidden) engine.suspend();
    else engine.resume();
  });

  // Called every fixed update. freshStats is the stats read back this update, or null; the alive
  // count comes from the latest stats seen.
  let aliveTotal = 0;
  const update = ({ fixedStep, freshStats, capacity }) => {
    const killsThisFrame = freshStats?.killsSinceLastRead ?? 0;
    if (freshStats) aliveTotal = freshStats.aliveTotal;
    music.setIntensity(intensity.update({ fixedStep, aliveTotal, capacity, killsThisFrame }));
    if (killsThisFrame > 0) effects.kills(killsThisFrame);
  };

  const audio = { engine, music, effects, intensity, update, setMuted, get muted() { return muted; } };
  audio.dispose = () => { if (timer !== null) windowObject.clearInterval(timer); };
  return audio;
}
