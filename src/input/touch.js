// Twin-stick touch: left half of the canvas moves, right half aims; each stick floats at first contact.
export const STICK_RADIUS = 60;

export function createTouchSource(canvas) {
  // touching: some touch is active, including a stationary one that has not moved a stick yet.
  const source = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: false, touching: false, dispose };
  // Active touches keyed by identifier: { role, originX, originY }.
  const active = new Map();

  function localPosition(touch) {
    const bounds = canvas.getBoundingClientRect();
    return { x: touch.clientX - bounds.left, y: touch.clientY - bounds.top };
  }

  function stickValue(entry, position) {
    const horizontalDisplacement = (position.x - entry.originX) / STICK_RADIUS;
    const verticalDisplacement = (position.y - entry.originY) / STICK_RADIUS;
    const length = Math.hypot(horizontalDisplacement, verticalDisplacement);
    const scale = length > 1 ? 1 / length : 1;
    return { x: horizontalDisplacement * scale, y: verticalDisplacement * scale };
  }

  function roleInUse(role) {
    for (const entry of active.values()) if (entry.role === role) return true;
    return false;
  }

  function onStart(event) {
    event.preventDefault?.();
    for (const touch of event.changedTouches) {
      const position = localPosition(touch);
      const role = position.x < canvas.clientWidth / 2 ? 'move' : 'aim';
      if (roleInUse(role)) continue;
      active.set(touch.identifier, { role, originX: position.x, originY: position.y });
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
