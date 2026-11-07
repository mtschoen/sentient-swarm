import test from 'node:test';
import assert from 'node:assert/strict';
import { applyControlsToSimulation, DEBUG_KILL_RADIUS, movePlayer } from '../../src/game/controls.js';
import { createInput, DEBUG_KILL_AIM_DISTANCE, killTargetFor } from '../../src/input/input.js';

function createFakeCanvas(width = 1000, height = 500) {
  const canvas = new EventTarget();
  canvas.clientWidth = width;
  canvas.clientHeight = height;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
  return canvas;
}

function createFixture() {
  const canvas = createFakeCanvas();
  const windowObject = new EventTarget();
  const gamepads = [null];
  const navigatorObject = { getGamepads: () => gamepads };
  const viewport = { inspectZoom: 1, screenToWorld: (x, y) => ({ x: x / 100, y: y / 100 }) };
  const input = createInput(canvas, viewport, { windowObject, navigatorObject });
  return { canvas, windowObject, gamepads, input };
}

function createFakeSimulation() {
  return {
    player: null,
    kills: [],
    setPlayer(x, y) { this.player = { x, y }; },
    setDebugKill(x, y, radius) { this.kills.push({ x, y, radius }); },
  };
}

function touchEvent(type, touches) {
  const event = new Event(type, { cancelable: true });
  event.changedTouches = touches;
  event.touches = touches;
  return event;
}

function pointerEvent(type, fields) {
  return Object.assign(new Event(type, { cancelable: true }), { pointerType: 'mouse', pointerId: 1, ...fields });
}

function assertNear(actual, expected) {
  const close = Math.abs(actual.x - expected.x) < 1e-9 && Math.abs(actual.y - expected.y) < 1e-9;
  assert.ok(close, `${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`);
}

test('killTargetFor is null when nothing fires', () => {
  const state = { pointerPrimaryDown: false, pointerWorld: { x: 1, y: 1 }, firing: false, aim: { x: 1, y: 0 } };
  assert.equal(killTargetFor(state, { x: 8, y: 4.5 }), null);
});

test('killTargetFor prefers the held mouse pointer over the aim', () => {
  const state = { pointerPrimaryDown: true, pointerWorld: { x: 3, y: 2 }, firing: true, aim: { x: 1, y: 0 } };
  assertNear(killTargetFor(state, { x: 8, y: 4.5 }), { x: 3, y: 2 });
});

test('killTargetFor puts a firing aim DEBUG_KILL_AIM_DISTANCE along the aim, or at the player for a zero aim', () => {
  const player = { x: 8, y: 4.5 };
  const firing = (aim) => ({ pointerPrimaryDown: false, pointerWorld: null, firing: true, aim });
  assertNear(killTargetFor(firing({ x: 0, y: -1 }), player), { x: 8, y: 4.5 - DEBUG_KILL_AIM_DISTANCE });
  assertNear(killTargetFor(firing({ x: 0, y: 0 }), player), player);
});

test('a right-half touch arms the debug kill on the simulation, along the dragged aim', () => {
  const { canvas, input } = createFixture();
  const simulation = createFakeSimulation();
  const player = { x: 8, y: 4.5 };
  canvas.dispatchEvent(touchEvent('touchstart', [{ identifier: 2, clientX: 700, clientY: 250 }]));
  input.update();
  applyControlsToSimulation(simulation, input.state, player);
  assert.deepEqual(simulation.kills, [{ x: 8, y: 4.5, radius: DEBUG_KILL_RADIUS }]);
  // Dragging one stick radius (60 pixels) right is a full-length aim along +x.
  canvas.dispatchEvent(touchEvent('touchmove', [{ identifier: 2, clientX: 760, clientY: 250 }]));
  input.update();
  applyControlsToSimulation(simulation, input.state, player);
  assertNear(simulation.kills[1], { x: 8 + DEBUG_KILL_AIM_DISTANCE, y: 4.5 });
  canvas.dispatchEvent(touchEvent('touchend', [{ identifier: 2, clientX: 760, clientY: 250 }]));
  input.update();
  applyControlsToSimulation(simulation, input.state, player);
  assert.equal(simulation.kills.length, 2);
  assert.deepEqual(simulation.player, player);
});

test('a firing gamepad right stick arms the debug kill along the stick', () => {
  const { gamepads, input } = createFixture();
  const simulation = createFakeSimulation();
  gamepads[0] = { axes: [0, 0, 0, 0.8], buttons: [] };
  input.update();
  applyControlsToSimulation(simulation, input.state, { x: 8, y: 4.5 });
  assertNear(simulation.kills[0], { x: 8, y: 4.5 + 0.8 * DEBUG_KILL_AIM_DISTANCE });
});

test('a held left mouse button arms the debug kill at the pointer', () => {
  const { canvas, input } = createFixture();
  const simulation = createFakeSimulation();
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 300, clientY: 100, button: 0, buttons: 1 }));
  input.update();
  applyControlsToSimulation(simulation, input.state, { x: 8, y: 4.5 });
  assertNear(simulation.kills[0], { x: 3, y: 1 });
});

test('movePlayer clamps the player to the arena', () => {
  const player = { x: 15.99, y: 0.01 };
  movePlayer(player, { move: { x: 1, y: -1 } }, 1);
  assert.deepEqual(player, { x: 16, y: 0 });
});
