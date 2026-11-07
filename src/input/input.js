import { createPointerSource } from './pointer.js';
import { createTouchSource } from './touch.js';
import { readGamepad } from './gamepad.js';
import { createKeyboardSource } from './keyboard.js';

// World distance from the player at which a touch or gamepad debug kill lands, along the aim.
export const DEBUG_KILL_AIM_DISTANCE = 1.5;

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

// Where this step's debug kill lands, or null when nothing fires. The mouse kills at the
// pointer's world point while the primary button is held. Touch (right half held) and gamepad
// (right stick past FIRE_THRESHOLD) publish firing and aim instead, so they kill at
// player + aim * DEBUG_KILL_AIM_DISTANCE; a zero aim (a fresh touch that has not moved yet) kills
// at the player position.
export function killTargetFor(state, player) {
  if (state.pointerPrimaryDown && state.pointerWorld) {
    return { x: state.pointerWorld.x, y: state.pointerWorld.y };
  }
  if (!state.firing) return null;
  return {
    x: player.x + state.aim.x * DEBUG_KILL_AIM_DISTANCE,
    y: player.y + state.aim.y * DEBUG_KILL_AIM_DISTANCE,
  };
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
    state.bomb = gamepad.bomb;
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
