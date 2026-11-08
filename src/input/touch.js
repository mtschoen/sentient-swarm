// Twin-stick touch: left half of the canvas moves, right half aims; each stick floats at first contact.
// Touches that start on (or inside the rectangle of) an element marked data-touch-exclusive never
// start a stick: the bomb button and the display-only HUD panels carry the mark.
export const STICK_RADIUS = 60;

export function createTouchSource(canvas) {
  // touching: some touch is active, including a stationary one that has not moved a stick yet.
  const source = {
    move: { x: 0, y: 0 },
    aim: { x: 0, y: 0 },
    firing: false,
    touching: false,
    // Where each floating stick started, in canvas-local pixels, or null; read by the overlay.
    origins: { move: null, aim: null },
    // The settings panel's stick dead zone (a fraction of the radius) and radius in pixels.
    radius: STICK_RADIUS,
    deadZone: 0,
    setTuning,
    pressBomb,
    releaseBomb,
    consumeBomb,
    dispose,
  };
  function setTuning({ deadZone = source.deadZone, radius = source.radius }) {
    source.deadZone = deadZone;
    source.radius = radius;
  }
  // The bomb button: held while a thumb is on it, plus a latch so a tap shorter than one input
  // sample still counts as one press.
  let bombHeld = false;
  let bombPending = false;
  function pressBomb() { bombHeld = true; bombPending = true; }
  function releaseBomb() { bombHeld = false; }
  function consumeBomb() {
    const pressed = bombHeld || bombPending;
    bombPending = false;
    return pressed;
  }
  // Active touches keyed by identifier: { role, originX, originY }.
  const active = new Map();

  function localPosition(touch) {
    const bounds = canvas.getBoundingClientRect();
    return { x: touch.clientX - bounds.left, y: touch.clientY - bounds.top };
  }

  function stickValue(entry, position) {
    const horizontalDisplacement = (position.x - entry.originX) / source.radius;
    const verticalDisplacement = (position.y - entry.originY) / source.radius;
    const length = Math.hypot(horizontalDisplacement, verticalDisplacement);
    if (length < source.deadZone || length === 0) return { x: 0, y: 0 };
    // Past the dead zone the response is rescaled so it still reaches 1 at the full radius.
    const rescaled = Math.min(1, (length - source.deadZone) / (1 - source.deadZone));
    const scale = rescaled / length;
    return { x: horizontalDisplacement * scale, y: verticalDisplacement * scale };
  }

  function roleInUse(role) {
    for (const entry of active.values()) if (entry.role === role) return true;
    return false;
  }

  function isExclusive(touch) {
    if (touch.target?.closest?.('[data-touch-exclusive]')) return true;
    const elements = canvas.ownerDocument?.querySelectorAll?.('[data-touch-exclusive]') ?? [];
    for (const element of elements) {
      const rectangle = element.getBoundingClientRect();
      if (rectangle.width <= 0 || rectangle.height <= 0) continue;
      if (touch.clientX >= rectangle.left && touch.clientX <= rectangle.right
        && touch.clientY >= rectangle.top && touch.clientY <= rectangle.bottom) return true;
    }
    return false;
  }

  function onStart(event) {
    event.preventDefault?.();
    for (const touch of event.changedTouches) {
      if (isExclusive(touch)) continue;
      const position = localPosition(touch);
      const role = position.x < canvas.clientWidth / 2 ? 'move' : 'aim';
      if (roleInUse(role)) continue;
      active.set(touch.identifier, { role, originX: position.x, originY: position.y });
      source.origins[role] = { x: position.x, y: position.y };
      if (role === 'aim') source.firing = true;
    }
    source.touching = active.size > 0;
  }

  function onMove(event) {
    event.preventDefault?.();
    for (const touch of event.changedTouches) {
      const entry = active.get(touch.identifier);
      if (!entry) continue;
      source[entry.role] = stickValue(entry, localPosition(touch));
    }
  }

  function onEnd(event) {
    for (const touch of event.changedTouches) {
      const entry = active.get(touch.identifier);
      if (!entry) continue;
      active.delete(touch.identifier);
      source[entry.role] = { x: 0, y: 0 };
      source.origins[entry.role] = null;
      if (entry.role === 'aim') source.firing = false;
    }
    source.touching = active.size > 0;
  }

  canvas.addEventListener('touchstart', onStart);
  canvas.addEventListener('touchmove', onMove);
  canvas.addEventListener('touchend', onEnd);
  canvas.addEventListener('touchcancel', onEnd);

  function dispose() {
    canvas.removeEventListener('touchstart', onStart);
    canvas.removeEventListener('touchmove', onMove);
    canvas.removeEventListener('touchend', onEnd);
    canvas.removeEventListener('touchcancel', onEnd);
  }

  return source;
}
