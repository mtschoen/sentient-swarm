import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installAudio } from '../../src/audio/audio-hook.js';
import { FakeAudioContext } from './fake-audio-context.js';

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  count(name) { return this.listeners.get(name)?.size ?? 0; }
  dispatch(name, event = {}) { for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event); }
}

function fakePage() {
  const windowObject = new FakeEventTarget();
  windowObject.intervals = new Set();
  let nextIdentifier = 1;
  windowObject.setInterval = () => { windowObject.intervals.add(nextIdentifier); return nextIdentifier++; };
  windowObject.clearInterval = (identifier) => windowObject.intervals.delete(identifier);
  const documentObject = new FakeEventTarget();
  documentObject.hidden = false;
  documentObject.body = { appendChild: (element) => { documentObject.hint = element; } };
  documentObject.createElement = () => ({ textContent: '', setAttribute() {}, remove() {} });
  const canvas = new FakeEventTarget();
  return { windowObject, documentObject, canvas };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
// The canvas gestures that start a run (pointer.js, touch.js), plus touchend: iOS Safari only
// counts a touchend as user activation, so a touch start that leaves the context suspended is
// resumed when the finger lifts.
const CANVAS_GESTURES = ['pointerdown', 'touchstart', 'touchend'];

function install(contextFactory) {
  const page = fakePage();
  const audio = installAudio({ ...page, gestureTarget: page.canvas, contextFactory });
  return { ...page, audio };
}

test('only the run-start gestures on the canvas and keydown unlock; there are no window-wide pointer listeners', () => {
  const { windowObject, canvas, audio } = install(() => new FakeAudioContext());
  for (const name of CANVAS_GESTURES) assert.equal(canvas.count(name), 1, `canvas ${name}`);
  for (const name of ['pointerup', 'pointerdown', 'touchend', 'touchstart', 'click']) assert.equal(windowObject.count(name), 0, `window ${name}`);
  assert.equal(audio.engine.context, null);
  canvas.dispatch('pointermove');
  assert.equal(audio.engine.context, null, 'a hover is not a gesture');
});

for (const gesture of ['pointerdown', 'touchstart']) {
  test(`the ${gesture} that starts the run unlocks audio synchronously and starts the music`, () => {
    const { canvas, audio } = install(() => new FakeAudioContext());
    canvas.dispatch(gesture);
    assert.notEqual(audio.engine.context, null, 'the context exists before the handler returns');
    assert.equal(audio.music.started, true);
  });
}

test('a start key unlocks audio inside the keydown handler', () => {
  const { windowObject, audio } = install(() => new FakeAudioContext());
  windowObject.dispatch('keydown', { code: 'KeyW', repeat: false, target: null });
  assert.notEqual(audio.engine.context, null);
  assert.equal(audio.music.started, true);
});

test('audio.unlock() is the explicit path a start button calls', () => {
  const { audio } = install(() => new FakeAudioContext());
  assert.notEqual(audio.unlock(), null);
  assert.equal(audio.music.started, true);
  const nodeCount = audio.engine.context.nodes.length;
  audio.unlock();
  assert.equal(audio.engine.context.nodes.length, nodeCount, 'one graph however often it is called');
});

test('a context left suspended by the touchstart is resumed by the touchend, then the listeners go', async () => {
  const context = FakeAudioContext.suspendedUntilResumedTimes(2);
  const { canvas, windowObject, documentObject, audio } = install(() => context);
  canvas.dispatch('touchstart');
  await flush();
  assert.equal(context.state, 'suspended');
  assert.equal(audio.listening, true);
  for (const name of CANVAS_GESTURES) assert.equal(canvas.count(name), 1, `${name} still listening`);

  canvas.dispatch('touchend');
  await flush();
  assert.equal(context.state, 'running');
  assert.equal(audio.listening, false);
  for (const name of CANVAS_GESTURES) assert.equal(canvas.count(name), 0, `${name} removed`);
  assert.equal(windowObject.count('keydown'), 1, 'keydown stays for the mute key');
  assert.equal(documentObject.hint.textContent, 'M to mute');
});

test('M mutes and resumes music and effects together', async () => {
  const { windowObject, canvas, documentObject, audio } = install(() => new FakeAudioContext());
  canvas.dispatch('pointerdown');
  await flush();
  windowObject.dispatch('keydown', { code: 'KeyM', repeat: false, target: null });
  assert.equal(audio.muted, true);
  assert.equal(audio.engine.muteOutput.gain.events.at(-1).value, 0);
  assert.equal(documentObject.hint.textContent, 'M to unmute');
  windowObject.dispatch('keydown', { code: 'KeyM', repeat: true, target: null });
  assert.equal(audio.muted, true, 'a held key does not toggle');
  windowObject.dispatch('keydown', { code: 'KeyM', repeat: false, target: { tagName: 'INPUT' } });
  assert.equal(audio.muted, true, 'typing in a field does not toggle');
  windowObject.dispatch('keydown', { code: 'KeyM', repeat: false, target: null });
  assert.equal(audio.muted, false);
  assert.equal(audio.engine.muteOutput.gain.events.at(-1).value, 1);
});

test('dispose removes every listener and stops the scheduling timer', async () => {
  const { windowObject, canvas, documentObject, audio } = install(() => FakeAudioContext.suspendedUntilResumedTimes(99));
  canvas.dispatch('pointerdown');
  await flush();
  assert.equal(windowObject.intervals.size, 1);
  audio.dispose();
  for (const name of CANVAS_GESTURES) assert.equal(canvas.count(name), 0, `${name} removed`);
  for (const name of ['keydown', 'focus']) assert.equal(windowObject.count(name), 0, `${name} removed`);
  assert.equal(documentObject.count('visibilitychange'), 0);
  assert.equal(windowObject.intervals.size, 0);
});

test('hiding the page suspends audio, and showing it or focusing the window resumes', async () => {
  const { windowObject, canvas, documentObject, audio } = install(() => new FakeAudioContext());
  canvas.dispatch('pointerdown');
  await flush();
  documentObject.hidden = true;
  documentObject.dispatch('visibilitychange');
  assert.equal(audio.engine.context.state, 'suspended');
  documentObject.hidden = false;
  documentObject.dispatch('visibilitychange');
  assert.equal(audio.engine.context.state, 'running');
  audio.engine.context.state = 'suspended';
  windowObject.dispatch('focus');
  assert.equal(audio.engine.context.state, 'running');
});

test('the game cues play both the effect and the music cue, and a death feeds the intensity', () => {
  const notes = [];
  const { canvas, audio } = install(() => new FakeAudioContext());
  canvas.dispatch('pointerdown');
  audio.music.onNote = (note) => notes.push(note.voice);
  const started = () => audio.engine.context.started.length;
  for (const [cue, voice] of [['pickup', 'riser'], ['bomb', 'crash']]) {
    const before = started();
    audio.cues[cue]();
    assert.ok(started() > before, `${cue} plays an effect`);
    assert.ok(notes.includes(voice), `${cue} cues the music ${voice}`);
  }
  audio.cues.expiry();
  assert.ok(audio.music.dropUntilStep > 0, 'expiry drops the music');
  audio.intensity.survivalSeconds = 20;
  audio.cues.death();
  assert.ok(audio.music.muteUntilStep > 0, 'death drops the music out');
  assert.equal(audio.intensity.survivalSeconds, 10);
  assert.equal(audio.cues.weaponFire('scatter', 2), true);
});

test('update drives the intensity from multiplier, kills and survival, and kills while playing hit the melody', () => {
  const { canvas, audio } = install(() => new FakeAudioContext());
  canvas.dispatch('pointerdown');
  const hits = [];
  audio.music.hit = (count) => hits.push(count);
  const frame = (phase, kills, multiplier = 1) => audio.update({ fixedStep: 1 / 60, freshStats: { killsSinceLastRead: kills }, capacity: 262144, phase, multiplier });
  frame('ready', 5);
  assert.deepEqual(hits, [], 'no melodic hits outside play');
  for (let index = 0; index < 600; index += 1) frame('playing', index % 20 === 0 ? 4 : 0, 2);
  assert.ok(audio.music.intensity > 0.3, `intensity ${audio.music.intensity}`);
  assert.equal(hits.length, 30);
  frame('gameOver', 0);
  frame('playing', 0);
  assert.ok(audio.intensity.survivalSeconds < 0.1, 'a new run starts the build over');
});

test('setPaused ducks the music and works before the first unlock', () => {
  const { audio } = install(() => new FakeAudioContext());
  audio.setPaused(true);
  assert.equal(audio.music.paused, true);
  audio.unlock();
  audio.setPaused(false);
  assert.equal(audio.music.paused, false);
});
