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

function neutralReading() {
  return { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: false, bomb: false };
}

// The one per-pad reader: sticks through the dead zone, the right stick's push fires, any bomb button bombs.
function readPad(gamepad, deadZone) {
  const left = readStick(gamepad, 0, deadZone);
  const right = readStick(gamepad, 2, deadZone);
  return {
    move: { x: left.x, y: left.y },
    aim: { x: right.x, y: right.y },
    firing: right.magnitude > FIRE_THRESHOLD,
    bomb: BOMB_BUTTON_INDICES.some((index) => gamepad.buttons[index]?.pressed),
  };
}

function padList(navigatorObject) {
  return navigatorObject.getGamepads?.() ?? [];
}

// The first connected pad whose index is not excludeIndex (null excludes none).
function firstPad(navigatorObject, excludeIndex) {
  for (const gamepad of padList(navigatorObject)) {
    if (gamepad && gamepad.index !== excludeIndex) return gamepad;
  }
  return null;
}

export function firstPadIndex(navigatorObject, excludeIndex = null) {
  return firstPad(navigatorObject, excludeIndex)?.index ?? null;
}

export function readGamepad(navigatorObject, { deadZone = configuredDeadZone, excludeIndex = null } = {}) {
  const gamepad = firstPad(navigatorObject, excludeIndex);
  return gamepad ? readPad(gamepad, deadZone) : neutralReading();
}

export function readGamepadAt(navigatorObject, padIndex, { deadZone = configuredDeadZone } = {}) {
  for (const gamepad of padList(navigatorObject)) {
    if (gamepad && gamepad.index === padIndex) return readPad(gamepad, deadZone);
  }
  return neutralReading();
}
