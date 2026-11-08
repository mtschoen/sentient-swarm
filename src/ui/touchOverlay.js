// Touch overlay: the floating stick bases and knobs drawn at the current touch origins, and the
// bomb button in the lower right. All plain DOM above the canvas. The stick visuals are
// pointer-events none; the bomb button is a real element marked data-touch-exclusive that
// captures its own touches, so the aim stick never starts under it (touch.js also skips touches
// that start on it). The button is shown only on coarse-pointer devices (hud.css) and only while
// playing.

const VIBRATE_MILLISECONDS = 10;

// Wraps the effects the game calls so the bomb and the death also buzz the phone, where the
// platform supports it, and rumble the gamepad (src/input/rumble.js) on bomb, death and pickup.
// Everything else passes through untouched.
export function withHaptics(effects, navigatorObject = typeof navigator === 'undefined' ? {} : navigator, rumble = null) {
  const buzz = () => navigatorObject.vibrate?.(VIBRATE_MILLISECONDS);
  return new Proxy(effects, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      if (property === 'bomb' || property === 'death') {
        return (...args) => {
          buzz();
          rumble?.[property]();
          return value.apply(target, args);
        };
      }
      if (property === 'pickup') {
        return (...args) => {
          rumble?.pickup();
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}

export function createTouchOverlay(rootElement, { touch, canvas, documentObject = document }) {
  const make = (className) => {
    const element = documentObject.createElement('div');
    element.className = className;
    return element;
  };
  const sticks = {};
  for (const role of ['move', 'aim']) {
    const base = make(`touch-stick-base touch-stick-${role}`);
    const knob = make(`touch-stick-knob touch-stick-${role}`);
    base.hidden = true;
    knob.hidden = true;
    rootElement.append(base, knob);
    sticks[role] = { base, knob };
  }
  const bombButton = documentObject.createElement('div');
  bombButton.className = 'touch-bomb';
  bombButton.setAttribute('data-touch-exclusive', '');
  bombButton.setAttribute('role', 'button');
  bombButton.setAttribute('aria-label', 'Bomb');
  bombButton.textContent = 'BOMB';
  bombButton.hidden = true;
  rootElement.append(bombButton);

  const press = (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    touch.pressBomb();
  };
  const release = (event) => {
    event.preventDefault?.();
    touch.releaseBomb();
  };
  bombButton.addEventListener('touchstart', press);
  bombButton.addEventListener('touchend', release);
  bombButton.addEventListener('touchcancel', release);

  const place = (element, x, y) => {
    element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
  };

  return {
    bombButton,
    // Called every rendered frame with the game state.
    update(state) {
      const bounds = canvas.getBoundingClientRect();
      for (const role of ['move', 'aim']) {
        const origin = touch.origins[role];
        const { base, knob } = sticks[role];
        base.hidden = origin === null;
        knob.hidden = origin === null;
        if (origin === null) continue;
        const value = touch[role];
        place(base, bounds.left + origin.x, bounds.top + origin.y);
        place(knob, bounds.left + origin.x + value.x * touch.radius, bounds.top + origin.y + value.y * touch.radius);
      }
      bombButton.hidden = state.phase !== 'playing';
      bombButton.classList.toggle('touch-bomb-empty', (state.bombs ?? 0) <= 0);
    },
  };
}
