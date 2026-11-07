// Mouse input: world position, primary button, and right-button temporary zoom.
export const INSPECT_ZOOM = 4;

export function createPointerSource(canvas, viewport, windowObject) {
  const source = { world: null, primaryDown: false, dispose };

  function updateWorld(event) {
    const bounds = canvas.getBoundingClientRect();
    source.world = viewport.screenToWorld(event.clientX - bounds.left, event.clientY - bounds.top);
  }

  function onMove(event) {
    if (event.pointerType === 'touch') return;
    updateWorld(event);
  }

  function onDown(event) {
    if (event.pointerType === 'touch') return;
    updateWorld(event);
    if (event.button === 0) source.primaryDown = true;
    if (event.button === 2) viewport.inspectZoom = INSPECT_ZOOM;
  }

  function onUp(event) {
    if (event.pointerType === 'touch') return;
    if (event.button === 0) source.primaryDown = false;
    if (event.button === 2) viewport.inspectZoom = 1;
  }

  function onContextMenu(event) {
    event.preventDefault();
  }

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('contextmenu', onContextMenu);
  windowObject.addEventListener('pointerup', onUp);

  function dispose() {
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('contextmenu', onContextMenu);
    windowObject.removeEventListener('pointerup', onUp);
  }

  return source;
}
