// Menu navigation input (owner ruling R17): turns keyboard keys and gamepad buttons into a queue of
// edge-triggered actions for the title, pause and game-over menus. poll() returns and clears the
// actions since the last call, in order:
//   'up' 'down' 'left' 'right'  arrows, the d-pad (12 to 15) and the left stick past a threshold
//   'confirm'                   Enter, Space, or the south face button (0)
//   'altConfirm'                the other face buttons (1 to 3); the title menu starts play on them
//   'back'                      the east face button (1)
//   'pause'                     Escape, or Options/Start (standard mapping button 9)
// It reads navigator.getGamepads() itself and never touches gamepad.js (gameplay input). Buttons and
// stick directions fire on the press edge only; the first poll just records what is already held, so
// a button held down from before the menu opened does not fire.
const FACE_BUTTONS = [0, 1, 2, 3];
const OPTIONS_BUTTON = 9;
const DPAD_BUTTONS = Object.freeze({ 12: 'up', 13: 'down', 14: 'left', 15: 'right' });
const STICK_THRESHOLD = 0.6;
const KEY_ACTIONS = Object.freeze({
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'confirm',
  ' ': 'confirm',
  Escape: 'pause',
});

function isFormField(target) {
  const tagName = target?.tagName;
  return tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA';
}

export function createMenuInput({ windowObject = window, navigatorObject = navigator } = {}) {
  let queued = [];
  let held = new Set();
  let primed = false;
  let extraPad = null;

  const onKeyDown = (event) => {
    if (isFormField(event.target) || event.repeat) return;
    const action = KEY_ACTIONS[event.key];
    if (action) queued.push(action);
  };
  windowObject.addEventListener('keydown', onKeyDown);

  function addPadControls(now, gamepad, prefix) {
    gamepad.buttons.forEach((button, index) => { if (button?.pressed) now.add(`${prefix}button:${index}`); });
    const x = gamepad.axes[0] ?? 0;
    const y = gamepad.axes[1] ?? 0;
    if (y > STICK_THRESHOLD) now.add(`${prefix}stick:down`);
    if (y < -STICK_THRESHOLD) now.add(`${prefix}stick:up`);
    if (x > STICK_THRESHOLD) now.add(`${prefix}stick:right`);
    if (x < -STICK_THRESHOLD) now.add(`${prefix}stick:left`);
  }

  // The names of the controls pressed right now: 'button:<index>' and 'stick:<direction>'. With an
  // extra pad set, the first other pad and the extra pad both read, as 'pad<index>:button:<n>' and
  // 'pad<index>:stick:<direction>'.
  function readHeld() {
    const now = new Set();
    const gamepads = [...(navigatorObject.getGamepads?.() ?? [])].filter(Boolean);
    if (extraPad === null) {
      if (gamepads.length > 0) addPadControls(now, gamepads[0], '');
      return now;
    }
    const first = gamepads.find((gamepad) => gamepad.index !== extraPad);
    if (first) addPadControls(now, first, `pad${first.index}:`);
    const extra = gamepads.find((gamepad) => gamepad.index === extraPad);
    if (extra) addPadControls(now, extra, `pad${extra.index}:`);
    return now;
  }

  function gamepadActions(pressed) {
    const actions = [];
    for (const fullName of pressed) {
      const name = fullName.replace(/^pad\d+:/, '');
      if (name.startsWith('stick:')) {
        actions.push(name.slice('stick:'.length));
        continue;
      }
      const index = Number(name.slice('button:'.length));
      if (DPAD_BUTTONS[index]) actions.push(DPAD_BUTTONS[index]);
      if (index === 0) actions.push('confirm');
      if (index === 1) actions.push('back');
      if (FACE_BUTTONS.includes(index) && index !== 0) actions.push('altConfirm');
      if (index === OPTIONS_BUTTON) actions.push('pause');
    }
    return actions;
  }

  return {
    poll() {
      const now = readHeld();
      if (primed) {
        const fresh = [...now].filter((name) => !held.has(name));
        queued.push(...gamepadActions(fresh));
      }
      primed = true;
      held = now;
      const actions = queued;
      queued = [];
      return actions;
    },
    // Seat 2's pad reads too. Whatever is held when this changes counts as held, so the press that
    // joined never also confirms.
    setExtraPad(padIndex) {
      extraPad = padIndex;
      if (primed) held = readHeld();
    },
    dispose() {
      windowObject.removeEventListener('keydown', onKeyDown);
    },
  };
}
