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
  return { windowObject, documentObject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const GESTURES = ['pointerup', 'touchend', 'click'];

test('a context left suspended by the first gesture is resumed by the next one', async () => {
  const { windowObject, documentObject } = fakePage();
  const context = FakeAudioContext.suspendedUntilResumedTimes(2);
  const audio = installAudio({ windowObject, documentObject, contextFactory: () => context });
  for (const name of GESTURES) assert.equal(windowObject.count(name), 1);
  assert.equal(windowObject.count('pointerdown'), 0);

  windowObject.dispatch('touchend');
  await flush();
  assert.equal(context.state, 'suspended');
  assert.equal(audio.engine.context, context);
  assert.equal(audio.music.started, true);
  assert.equal(audio.listening, true);
  for (const name of GESTURES) assert.equal(windowObject.count(name), 1, `${name} still listening`);

  windowObject.dispatch('click');
  await flush();
  assert.equal(context.state, 'running');
  assert.equal(audio.listening, false);
  for (const name of GESTURES) assert.equal(windowObject.count(name), 0, `${name} removed`);
  assert.equal(windowObject.count('keydown'), 1, 'keydown stays for the mute key');
  assert.equal(documentObject.hint.textContent, 'M to mute');
});

test('M mutes and resumes music and effects together', async () => {
  const { windowObject, documentObject } = fakePage();
  const audio = installAudio({ windowObject, documentObject, contextFactory: () => new FakeAudioContext() });
  windowObject.dispatch('pointerup');
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
  const { windowObject, documentObject } = fakePage();
  const audio = installAudio({ windowObject, documentObject, contextFactory: () => FakeAudioContext.suspendedUntilResumedTimes(99) });
  windowObject.dispatch('pointerup');
  await flush();
  assert.equal(windowObject.intervals.size, 1);
  audio.dispose();
  for (const name of [...GESTURES, 'keydown']) assert.equal(windowObject.count(name), 0, `${name} removed`);
  assert.equal(documentObject.count('visibilitychange'), 0);
  assert.equal(windowObject.intervals.size, 0);
});

test('hiding the page suspends audio and showing it resumes', async () => {
  const { windowObject, documentObject } = fakePage();
  const audio = installAudio({ windowObject, documentObject, contextFactory: () => new FakeAudioContext() });
  windowObject.dispatch('click');
  await flush();
  documentObject.hidden = true;
  documentObject.dispatch('visibilitychange');
  assert.equal(audio.engine.context.state, 'suspended');
  documentObject.hidden = false;
  documentObject.dispatch('visibilitychange');
  assert.equal(audio.engine.context.state, 'running');
});
