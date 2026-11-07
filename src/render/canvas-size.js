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

// Observes the canvas and calls onResize({ width, height, devicePixelRatio }) for every non-empty
// change of the device-pixel size or of the device pixel ratio. A pure ratio change (desktop
// browser zoom keeps the device-pixel size of a full-window canvas) fires no ResizeObserver
// callback, so a matchMedia('(resolution: Xdppx)') query for the current ratio is watched and
// re-armed on every change; it re-reports the last size with the new ratio.
// Returns a function that reads the current size once, for the initial sizing before the first frame.
export function observeCanvasSize(canvas, onResize, {
  ResizeObserverClass = globalThis.ResizeObserver,
  getDevicePixelRatio = () => globalThis.devicePixelRatio ?? 1,
  matchMediaFunction = globalThis.matchMedia ? (query) => globalThis.matchMedia(query) : null,
} = {}) {
  let last = { width: 0, height: 0, devicePixelRatio: 0 };
  const apply = (size) => {
    if (size.width <= 0 || size.height <= 0) return;
    if (size.width === last.width && size.height === last.height && size.devicePixelRatio === last.devicePixelRatio) return;
    last = size;
    onResize(size);
  };
  const observer = new ResizeObserverClass((entries) => {
    const entry = entries[entries.length - 1];
    const devicePixelRatio = getDevicePixelRatio();
    apply({ ...canvasSizeFromEntry(entry, devicePixelRatio), devicePixelRatio });
  });
  try {
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    observer.observe(canvas);
  }

  let ratioQuery = null;
  const onRatioChange = () => {
    watchRatio();
    apply({ width: last.width, height: last.height, devicePixelRatio: getDevicePixelRatio() });
  };
  const watchRatio = () => {
    ratioQuery?.removeEventListener('change', onRatioChange);
    ratioQuery = matchMediaFunction ? matchMediaFunction(`(resolution: ${getDevicePixelRatio()}dppx)`) : null;
    ratioQuery?.addEventListener('change', onRatioChange);
  };
  watchRatio();

  return () => {
    const devicePixelRatio = getDevicePixelRatio();
    apply({
      width: Math.round(canvas.clientWidth * devicePixelRatio),
      height: Math.round(canvas.clientHeight * devicePixelRatio),
      devicePixelRatio,
    });
  };
}
