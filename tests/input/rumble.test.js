import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifeWatcher, createRumble } from '../../src/input/rumble.js';
import { readGamepad, setGamepadDeadZone, DEAD_ZONE } from '../../src/input/gamepad.js';

function fakeActuator(effects, { rejectTrigger = false } = {}) {
  const calls = [];
  return {
    calls,
    effects,
    type: 'dual-rumble',
    playEffect(type, parameters) {
      calls.push({ type, parameters });
      return type === 'trigger-rumble' && rejectTrigger ? Promise.reject(new Error('no')) : Promise.resolve('complete');
    },
  };
}

const navigatorWith = (...gamepads) => ({ getGamepads: () => gamepads });

test('bomb plays a strong 250 ms dual rumble', () => {
  const actuator = fakeActuator(['dual-rumble']);
  createRumble({ navigatorObject: navigatorWith({ vibrationActuator: actuator }) }).bomb();
  assert.equal(actuator.calls.length, 1);
  assert.equal(actuator.calls[0].type, 'dual-rumble');
  assert.equal(actuator.calls[0].parameters.duration, 250);
  assert.ok(actuator.calls[0].parameters.strongMagnitude >= 0.8);
});

test('death is strong for 400 ms; pickup and extra life are light', () => {
  const actuator = fakeActuator(['dual-rumble']);
  const rumble = createRumble({ navigatorObject: navigatorWith({ vibrationActuator: actuator }) });
  rumble.death();
  rumble.pickup();
  rumble.extraLife();
  const [death, pickup, extraLife] = actuator.calls.map((call) => call.parameters);
  assert.equal(death.duration, 400);
  assert.ok(death.strongMagnitude >= 0.8);
  assert.equal(pickup.duration, 80);
  assert.ok(pickup.strongMagnitude < 0.5);
  assert.ok(extraLife.strongMagnitude < 0.8);
});

test('trigger-rumble is tried first when listed, with dual-rumble as the fallback on rejection', async () => {
  const actuator = fakeActuator(['dual-rumble', 'trigger-rumble'], { rejectTrigger: true });
  createRumble({ navigatorObject: navigatorWith({ vibrationActuator: actuator }) }).bomb();
  assert.equal(actuator.calls[0].type, 'trigger-rumble');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(actuator.calls.map((call) => call.type), ['trigger-rumble', 'dual-rumble']);
});

test('a resolved trigger-rumble does not also play dual-rumble', async () => {
  const actuator = fakeActuator(['dual-rumble', 'trigger-rumble']);
  createRumble({ navigatorObject: navigatorWith({ vibrationActuator: actuator }) }).death();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(actuator.calls.map((call) => call.type), ['trigger-rumble']);
});

test('disabled, missing actuator and missing getGamepads are all silent', () => {
  const actuator = fakeActuator(['dual-rumble']);
  createRumble({ navigatorObject: navigatorWith({ vibrationActuator: actuator }), isEnabled: () => false }).bomb();
  assert.equal(actuator.calls.length, 0);
  assert.doesNotThrow(() => createRumble({ navigatorObject: navigatorWith(null, {}) }).bomb());
  assert.doesNotThrow(() => createRumble({ navigatorObject: {} }).bomb());
  const unsupported = fakeActuator(['something-else']);
  unsupported.type = 'other';
  createRumble({ navigatorObject: navigatorWith({ vibrationActuator: unsupported }) }).bomb();
  assert.equal(unsupported.calls.length, 0);
});

test('the life watcher rumbles only when lives rise while playing', () => {
  const rumbled = [];
  const watcher = createLifeWatcher({ extraLife: () => rumbled.push('life') });
  watcher.update({ phase: 'ready', lives: 3 });
  watcher.update({ phase: 'playing', lives: 3 });
  watcher.update({ phase: 'playing', lives: 4 });
  watcher.update({ phase: 'playing', lives: 3 });
  watcher.update({ phase: 'gameOver', lives: 0 });
  watcher.update({ phase: 'playing', lives: 3 });
  assert.deepEqual(rumbled, ['life']);
});

test('the gamepad dead zone follows the setting', () => {
  const pad = (x) => navigatorWith({ axes: [x, 0, 0, 0], buttons: [] });
  assert.equal(readGamepad(pad(0.3)).move.x, 0.3);
  assert.equal(readGamepad(pad(0.3), { deadZone: 0.4 }).move.x, 0);
  setGamepadDeadZone(0.5);
  assert.equal(readGamepad(pad(0.4)).move.x, 0);
  assert.equal(readGamepad(pad(0.4), { deadZone: 0.1 }).move.x, 0.4);
  setGamepadDeadZone(DEAD_ZONE);
  assert.equal(readGamepad(pad(0.4)).move.x, 0.4);
});

test('rumble survives a synchronous playEffect throw', () => {
  const actuator = {
    effects: ['dual-rumble'],
    playEffect() { throw new Error('actuator gone'); },
  };
  const rumble = createRumble({ navigatorObject: navigatorWith({ vibrationActuator: actuator }) });
  assert.doesNotThrow(() => { rumble.bomb(); rumble.death(); rumble.pickup(); rumble.extraLife(); });
  const triggerOnly = {
    effects: ['trigger-rumble', 'dual-rumble'],
    playEffect() { throw new Error('actuator gone'); },
  };
  assert.doesNotThrow(() => createRumble({ navigatorObject: navigatorWith({ vibrationActuator: triggerOnly }) }).bomb());
});

test('rumble with a pad index plays only on that pad; null plays nothing', () => {
  const first = fakeActuator(['dual-rumble']);
  const second = fakeActuator(['dual-rumble']);
  const rumble = createRumble({ navigatorObject: navigatorWith({ index: 0, vibrationActuator: first }, { index: 1, vibrationActuator: second }) });
  rumble.bomb(1);
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 1);
  rumble.death(0);
  assert.equal(first.calls.length, 1);
  rumble.pickup(null);
  rumble.bomb(7);
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  rumble.bomb();
  assert.equal(first.calls.length, 2, 'undefined still plays on the first pad with an actuator');
});
