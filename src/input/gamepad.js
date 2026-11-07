// Gamepad polling: left stick moves, right stick aims and fires, any face button bombs.
export const DEAD_ZONE = 0.2;
export const FIRE_THRESHOLD = 0.5;
const FACE_BUTTON_COUNT = 4;

function readStick(gamepad, horizontalIndex) {
  const x = gamepad.axes[horizontalIndex] ?? 0;
  const y = gamepad.axes[horizontalIndex + 1] ?? 0;
  const magnitude = Math.hypot(x, y);
  if (magnitude < DEAD_ZONE) return { x: 0, y: 0, magnitude: 0 };
  const scale = magnitude > 1 ? 1 / magnitude : 1;
  return { x: x * scale, y: y * scale, magnitude: Math.min(magnitude, 1) };
}

export function readGamepad(navigatorObject) {
  const result = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: false, bomb: false };
  const gamepads = navigatorObject.getGamepads?.() ?? [];
  for (const gamepad of gamepads) {
    if (!gamepad) continue;
    const left = readStick(gamepad, 0);
    const right = readStick(gamepad, 2);
    result.move = { x: left.x, y: left.y };
    result.aim = { x: right.x, y: right.y };
    result.firing = right.magnitude > FIRE_THRESHOLD;
    for (let index = 0; index < FACE_BUTTON_COUNT; index += 1) {
      if (gamepad.buttons[index]?.pressed) result.bomb = true;
    }
    break;
  }
  return result;
}
