// Fire debug overlay (?debug=fire): shows the fire log (src/game/fire-log.js) on screen, for a
// device with no console at hand. Display only: hud.css keeps it out of the way of every touch.
export function createFireDebug({ documentObject = document } = {}) {
  const element = documentObject.createElement('pre');
  element.classList.add('fire-debug');
  let shown = '';
  return {
    element,
    // Called every rendered frame.
    update(fireLog) {
      const text = fireLog.lines().join('\n');
      if (text === shown) return;
      shown = text;
      element.textContent = text;
    },
  };
}
