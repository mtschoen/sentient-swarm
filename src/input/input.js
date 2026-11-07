import { createPointerSource } from './pointer.js';
import { createTouchSource } from './touch.js';
import { readGamepad } from './gamepad.js';
import { createKeyboardSource } from './keyboard.js';

export class InputState {
  constructor() {
    this.move = { x: 0, y: 0 };
    this.aim = { x: 0, y: 0 };
    this.firing = false;
    this.bomb = false;
    this.pointerWorld = null;
    this.pointerPrimaryDown = false;
  }
}

function sumClamped(first, second) {
  const x = first.x + second.x;
  const y = first.y + second.y;
  const length = Math.hypot(x, y);
  const scale = length > 1 ? 1 / length : 1;
  return { x: x * scale, y: y * scale };
}

export function createInput(canvas, viewport, { windowObject = window, navigatorObject = navigator } = {}) {
  const state = new InputState();
  const pointer = createPointerSource(canvas, viewport, windowObject);
  const touch = createTouchSource(canvas);
  const keyboard = createKeyboardSource(windowObject);

  function update() {
    const gamepad = readGamepad(navigatorObject);
    state.move = sumClamped(sumClamped(gamepad.move, touch.move), keyboard.move);
    state.aim = sumClamped(gamepad.aim, touch.aim);
    state.firing = gamepad.firing || touch.firing;
    state.bomb = gamepad.bomb || keyboard.bomb || pointer.secondaryDown;
    pointer.update();
    state.pointerWorld = pointer.world;
    state.pointerPrimaryDown = pointer.primaryDown;
  }

  function dispose() {
    pointer.dispose();
    touch.dispose();
    keyboard.dispose();
  }

  return { state, update, dispose };
}
