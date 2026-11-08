// Gamepad polling: left stick moves, right stick aims and fires, any face button or trigger bombs.
// The settings panel's stick dead zone replaces this default through setGamepadDeadZone.
export const DEAD_ZONE = 0.2;
export const FIRE_THRESHOLD = 0.5;
// Standard mapping: 0 to 3 are the face buttons, 6 and 7 the left and right triggers.
const BOMB_BUTTON_INDICES = [0, 1, 2, 3, 6, 7];

let configuredDeadZone = DEAD_ZONE;

export function setGamepadDeadZone(deadZone) {
  configuredDeadZone = deadZone;
}

function readStick(gamepad, horizontalIndex, deadZone) {
  const x = gamepad.axes[horizontalIndex] ?? 0;
  const y = gamepad.axes[horizontalIndex + 1] ?? 0;
  const magnitude = Math.hypot(x, y);
  if (magnitude < deadZone) return { x: 0, y: 0, magnitude: 0 };
  const scale = magnitude > 1 ? 1 / magnitude : 1;
  return { x: x * scale, y: y * scale, magnitude: Math.min(magnitude, 1) };
}

export function readGamepad(navigatorObject, { deadZone = configuredDeadZone } = {}) {
  const result = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: false, bomb: false };
  const gamepads = navigatorObject.getGamepads?.() ?? [];
  for (const gamepad of gamepads) {
    if (!gamepad) continue;
    const left = readStick(gamepad, 0, deadZone);
    const right = readStick(gamepad, 2, deadZone);
    result.move = { x: left.x, y: left.y };
    result.aim = { x: right.x, y: right.y };
    result.firing = right.magnitude > FIRE_THRESHOLD;
    if (BOMB_BUTTON_INDICES.some((index) => gamepad.buttons[index]?.pressed)) result.bomb = true;
    break;
  }
  return result;
}
