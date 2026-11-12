import test from 'node:test';
import assert from 'node:assert/strict';
import { LOADING_STAGES, LoadProgress, WarmUp, createLoadingScreen } from '../../src/ui/loading.js';

function createFakeLoadingElement() {
  const classes = new Set();
  const listeners = {};
  const fill = { style: { width: '' } };
  const bar = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const status = { textContent: 'Loading' };
  const parts = { '.loading-bar-fill': fill, '.loading-bar': bar, '.loading-status': status };
  return {
    hidden: false, fill, bar, status, classes,
    classList: { add: (name) => classes.add(name), contains: (name) => classes.has(name) },
    querySelector: (selector) => parts[selector],
    addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
    fire(type) { (listeners[type] ?? []).forEach((listener) => listener()); },
  };
}

test('the stages are frozen, ordered and weigh one', () => {
  assert.deepEqual(LOADING_STAGES.map((stage) => stage.name), ['device', 'simulation', 'renderer', 'game', 'warmUp']);
  assert.ok(Object.isFrozen(LOADING_STAGES));
  assert.ok(Object.isFrozen(LOADING_STAGES[0]));
  const total = LOADING_STAGES.reduce((sum, stage) => sum + stage.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('LoadProgress weights stages, completes earlier ones and never decreases', () => {
  const progress = new LoadProgress();
  assert.equal(progress.fraction, 0);
  assert.equal(progress.label, 'Starting WebGPU');
  progress.report('simulation', 5, 10);
  assert.ok(Math.abs(progress.fraction - (0.05 + 0.15)) < 1e-9);
  assert.equal(progress.label, 'Building the swarm');
  progress.report('simulation', 2, 10);
  assert.ok(Math.abs(progress.fraction - 0.2) < 1e-9);
  progress.report('game', 0, 1);
  assert.ok(Math.abs(progress.fraction - 0.65) < 1e-9);
  assert.equal(progress.label, 'Arming weapons');
  progress.report('renderer', 1, 1);
  assert.equal(progress.label, 'Arming weapons');
  progress.report('warmUp', 1, 1);
  assert.ok(Math.abs(progress.fraction - 1) < 1e-9);
});

test('LoadProgress clamps ratios and rejects an unknown stage', () => {
  const progress = new LoadProgress();
  progress.report('device', 9, 3);
  assert.ok(Math.abs(progress.fraction - 0.05) < 1e-9);
  progress.report('simulation', -4, 3);
  progress.report('renderer', 1, 0);
  assert.ok(Math.abs(progress.fraction - (0.05 + 0.3 + 0.3)) < 1e-9);
  progress.report('game', Number.NaN, 1);
  assert.throws(() => progress.report('bogus', 1, 1), RangeError);
});

test('WarmUp is done after the minimum frames once the latest frames are settled', () => {
  const warmUp = new WarmUp();
  for (let frame = 1; frame < 30; frame += 1) assert.equal(warmUp.frame(0.016), false);
  assert.equal(warmUp.frame(0.016), true);
  assert.equal(warmUp.progress, 1);
  assert.equal(warmUp.frame(1), true);
});

test('WarmUp waits while recent frames are slow, then settles', () => {
  const slow = new WarmUp({ maximumSeconds: 100 });
  for (let frame = 0; frame < 40; frame += 1) assert.equal(slow.frame(frame % 2 === 0 ? 0.05 : 0.01), false);
  for (let frame = 0; frame < 8; frame += 1) assert.equal(slow.frame(0.02), false);
  assert.equal(slow.frame(0.034), true);
});

test('WarmUp stops at the time cap even when frames stay slow', () => {
  const warmUp = new WarmUp();
  assert.equal(warmUp.frame(1), false);
  assert.equal(warmUp.frame(1), false);
  assert.equal(warmUp.frame(1), true);
  assert.equal(warmUp.done, true);
});

test('WarmUp progress is monotonic, below one until done', () => {
  const warmUp = new WarmUp({ maximumSeconds: 100 });
  const seen = [];
  for (let frame = 0; frame < 35; frame += 1) {
    seen.push(warmUp.progress);
    warmUp.frame(frame < 5 ? 0.1 : 0.01);
  }
  for (let index = 1; index < seen.length; index += 1) assert.ok(seen[index] >= seen[index - 1]);
  assert.equal(seen.filter((value) => value === 1).length, 5);
  assert.ok(seen.slice(0, 30).every((value) => value < 1));
});

test('the loading screen shows progress and the label', () => {
  const element = createFakeLoadingElement();
  const screen = createLoadingScreen({ element, setTimer: () => {} });
  assert.equal(screen.visible, true);
  screen.update(0.456, 'Building the swarm');
  assert.equal(element.fill.style.width, '45.6%');
  assert.equal(element.bar.attributes['aria-valuenow'], '46');
  assert.equal(element.status.textContent, 'Building the swarm');
});

test('finish fills the bar, fades, and hides on transitionend or the fallback timer, once', () => {
  const element = createFakeLoadingElement();
  const timers = [];
  const screen = createLoadingScreen({ element, setTimer: (callback, milliseconds) => timers.push({ callback, milliseconds }) });
  screen.finish();
  assert.equal(element.fill.style.width, '100%');
  assert.equal(element.bar.attributes['aria-valuenow'], '100');
  assert.ok(element.classes.has('loading-done'));
  assert.equal(element.hidden, false);
  assert.equal(timers[0].milliseconds, 400);
  element.fire('transitionend');
  assert.equal(element.hidden, true);
  assert.equal(screen.visible, false);
  screen.finish();
  screen.update(0.2, 'late');
  assert.equal(element.fill.style.width, '100%');
  assert.equal(element.status.textContent, 'Loading');
  assert.equal(timers.length, 1);
  timers[0].callback();
  assert.equal(element.hidden, true);
});

test('finish hides on the fallback timer when no transition ends', () => {
  const element = createFakeLoadingElement();
  const timers = [];
  const screen = createLoadingScreen({ element, setTimer: (callback) => timers.push(callback) });
  screen.finish();
  timers[0]();
  assert.equal(element.hidden, true);
});

test('fail hides at once and later calls do nothing', () => {
  const element = createFakeLoadingElement();
  const timers = [];
  const screen = createLoadingScreen({ element, setTimer: (callback) => timers.push(callback) });
  screen.fail();
  assert.equal(element.hidden, true);
  screen.finish();
  screen.update(0.5, 'x');
  assert.equal(timers.length, 0);
  assert.equal(element.classes.has('loading-done'), false);
  assert.equal(element.status.textContent, 'Loading');
  screen.fail();
});
