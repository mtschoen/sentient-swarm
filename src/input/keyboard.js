// Keyboard movement: WASD or arrow keys, in the same screen-down convention as the gamepad stick.
// Keys typed into a form field (the debug panel's number inputs) are ignored.
const DIRECTIONS = {
  w: { x: 0, y: -1 },
  arrowup: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  arrowdown: { x: 0, y: 1 },
  a: { x: -1, y: 0 },
  arrowleft: { x: -1, y: 0 },
  d: { x: 1, y: 0 },
  arrowright: { x: 1, y: 0 },
};

function isFormField(target) {
  const tagName = target?.tagName;
  return tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA';
}

export function createKeyboardSource(windowObject) {
  const held = new Set();
  const source = { move: { x: 0, y: 0 }, dispose };

  function refresh() {
    let x = 0;
    let y = 0;
    for (const key of held) {
      x += DIRECTIONS[key].x;
      y += DIRECTIONS[key].y;
    }
    const length = Math.hypot(x, y);
    source.move = length > 1 ? { x: x / length, y: y / length } : { x, y };
  }

  function onKeyDown(event) {
    const key = event.key?.toLowerCase();
    if (!(key in DIRECTIONS) || isFormField(event.target)) return;
    held.add(key);
    refresh();
  }

  function onKeyUp(event) {
    const key = event.key?.toLowerCase();
    if (held.delete(key)) refresh();
  }

  // A key released while the window was unfocused never sends keyup.
  function onBlur() {
    held.clear();
    refresh();
  }

  windowObject.addEventListener('keydown', onKeyDown);
  windowObject.addEventListener('keyup', onKeyUp);
  windowObject.addEventListener('blur', onBlur);

  function dispose() {
    windowObject.removeEventListener('keydown', onKeyDown);
    windowObject.removeEventListener('keyup', onKeyUp);
    windowObject.removeEventListener('blur', onBlur);
  }

  return source;
}
