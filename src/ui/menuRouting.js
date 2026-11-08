// Routes the menu actions polled each frame (menuInput.js). While the settings panel is open it
// owns them: 'pause' (Escape, Options) and 'back' (the east face button) close it, and every other
// action is dropped. That is the one way those keys close the panel, so the press that closes it
// never also pauses or resumes the run; what was under the panel (the pause menu or the title)
// shows again. With the panel closed each action goes to dispatch, in order.
const CLOSING_ACTIONS = ['pause', 'back'];

export function routeMenuActions(actions, { settingsOpen, closeSettings, dispatch }) {
  if (settingsOpen()) {
    if (actions.some((action) => CLOSING_ACTIONS.includes(action))) closeSettings();
    return;
  }
  for (const action of actions) dispatch(action);
}

// A control whose keys are text: a text-like input, a select (type-ahead) or a textarea. Range,
// checkbox, radio and button inputs take no text, so O and Escape mean the same thing on them.
const NON_TEXT_INPUT_TYPES = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

export function isTextEntry(target) {
  const tagName = target?.tagName;
  if (tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
  return tagName === 'INPUT' && !NON_TEXT_INPUT_TYPES.has(String(target.type ?? 'text').toLowerCase());
}

const isFormField = (target) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName);

// Window keydown for the settings panel. menuInput.js skips every form field, so with the panel open
// Escape from a focused control is routed here through the same routeMenuActions close path; O
// toggles the panel from anywhere but a text control. Other targets reach menuInput (Escape) as usual.
export function routeSettingsKey(event, { settingsOpen, closeSettings, openSettings, dispatch }) {
  if (event.repeat) return;
  if (event.key === 'Escape') {
    if (isFormField(event.target)) routeMenuActions(['pause'], { settingsOpen, closeSettings, dispatch });
    return;
  }
  if (event.code !== 'KeyO' || isTextEntry(event.target)) return;
  if (settingsOpen()) closeSettings();
  else openSettings();
}

// Opens the settings panel. While the rotate overlay pauses the run, the pause menu stays hidden
// (closing the panel returns to the overlay, and turning the phone back resumes the run); otherwise
// the run pauses under the pause menu first.
export function createSettingsOpener({ isRotateShowing, pauseForMenu, openPanel }) {
  return () => {
    if (!isRotateShowing()) pauseForMenu();
    openPanel();
  };
}
