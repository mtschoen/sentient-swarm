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
