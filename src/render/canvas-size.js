// Maps a ResizeObserver entry to a canvas size in device pixels. Prefers the exact
// devicePixelContentBoxSize; falls back to the CSS content rect times the device pixel ratio.
export function canvasSizeFromEntry(entry, devicePixelRatio = 1) {
  const deviceBox = entry.devicePixelContentBoxSize?.[0];
  if (deviceBox) {
    return { width: Math.round(deviceBox.inlineSize), height: Math.round(deviceBox.blockSize) };
  }
  const { width, height } = entry.contentRect;
  return { width: Math.round(width * devicePixelRatio), height: Math.round(height * devicePixelRatio) };
}

// Observes the canvas and calls onResize({ width, height }) for every non-empty size change.
// Returns a function that reads the current size once, for the initial sizing before the first frame.
export function observeCanvasSize(canvas, onResize) {
  let last = { width: 0, height: 0 };
  const apply = (size) => {
    if (size.width <= 0 || size.height <= 0) return;
    if (size.width === last.width && size.height === last.height) return;
    last = size;
    onResize(size);
  };
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    apply(canvasSizeFromEntry(entry, devicePixelRatio));
  });
  try {
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    observer.observe(canvas);
  }
  return () => apply({
    width: Math.round(canvas.clientWidth * devicePixelRatio),
    height: Math.round(canvas.clientHeight * devicePixelRatio),
  });
}
