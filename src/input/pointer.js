// Mouse input: world position, primary button, and right-button temporary zoom.
// Button state follows event.buttons on every pointer event, because a mouse sends pointerdown
// only for the first pressed button and pointerup only for the last released one (chord changes
// in between arrive as pointermove). pointercancel, lostpointercapture and window blur release
// both. The last canvas-relative CSS position is kept and converted to world space on every
// update(), so inspect zoom and resizes apply to a pointer that has not moved.
export const INSPECT_ZOOM = 4;
const PRIMARY_BUTTON_BIT = 1;
const SECONDARY_BUTTON_BIT = 2;

export function createPointerSource(canvas, viewport, windowObject) {
  const source = { world: null, primaryDown: false, update, dispose };
  let screenPosition = null;
  let zoomHeld = false;

  // Writes inspectZoom only on a change, so other writers (the capture hook) are not overridden.
  function setZoomHeld(held) {
    if (held === zoomHeld) return;
    zoomHeld = held;
    viewport.inspectZoom = held ? INSPECT_ZOOM : 1;
  }

  function applyButtons(buttons) {
    source.primaryDown = (buttons & PRIMARY_BUTTON_BIT) !== 0;
    setZoomHeld((buttons & SECONDARY_BUTTON_BIT) !== 0);
  }

  function release() {
    source.primaryDown = false;
    setZoomHeld(false);
  }

  function recordPosition(event) {
    const bounds = canvas.getBoundingClientRect();
    screenPosition = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function update() {
    source.world = screenPosition === null ? null : viewport.screenToWorld(screenPosition.x, screenPosition.y);
  }

  function onMove(event) {
    if (event.pointerType === 'touch') return;
    recordPosition(event);
    applyButtons(event.buttons ?? 0);
  }

  function onDown(event) {
    if (event.pointerType === 'touch') return;
    recordPosition(event);
    applyButtons(event.buttons ?? 0);
    // Capture keeps the release (and chord moves) coming to the canvas when the pointer leaves it.
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // An inactive pointer id throws; the window pointerup listener still sees the release.
    }
  }

  function onUp(event) {
    if (event.pointerType === 'touch') return;
    applyButtons(event.buttons ?? 0);
  }

  function onCancel(event) {
    if (event.pointerType === 'touch') return;
    release();
  }

  function onContextMenu(event) {
    event.preventDefault();
  }

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('lostpointercapture', onCancel);
  canvas.addEventListener('contextmenu', onContextMenu);
  windowObject.addEventListener('pointerup', onUp);
  windowObject.addEventListener('blur', release);

  function dispose() {
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointercancel', onCancel);
    canvas.removeEventListener('lostpointercapture', onCancel);
    canvas.removeEventListener('contextmenu', onContextMenu);
    windowObject.removeEventListener('pointerup', onUp);
    windowObject.removeEventListener('blur', release);
  }

  return source;
}
