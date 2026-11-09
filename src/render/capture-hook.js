// Smoke-test readback of a composited frame, published as window.__murmuration.capture.
import { meanLuminance } from './capture.js';

// Frames rendered with a capture's overrides before the capture, so earlier trails fade (at a trailDecay
// of 0.9, 0.9^30 is 4 percent; at the default 0.6 nothing visible is left).
export const CAPTURE_SETTLE_FRAMES = 30;

function describeCapture(frame, arenaRect, regions) {
  const { width, height, pixels } = frame;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height), 0, 0);
  // The letterbox band (top strip, or left strip) exists only beyond the 1:4 to 4:1 aspect range; it is
  // empty (luminance 0) at ordinary aspects, and otherwise should stay black.
  const band = arenaRect.y > 0
    ? { x: 0, y: 0, width, height: arenaRect.y }
    : { x: 0, y: 0, width: arenaRect.x, height };
  return {
    width,
    height,
    arenaRect,
    meanLuminance: meanLuminance(pixels, width, arenaRect),
    bandLuminance: meanLuminance(pixels, width, band),
    regionLuminances: (regions ?? []).map((region) => meanLuminance(pixels, width, region)),
    pngDataUrl: canvas.toDataURL('image/png'),
  };
}

function waitAnimationFrames(count) {
  return new Promise((resolve) => {
    let remaining = count;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// With inspectZoom or renderer setting overrides (for example { trailDecay: 0 }), they hold for
// CAPTURE_SETTLE_FRAMES frames plus the captured one, then the previous values return. regions
// (device-pixel rects) add their means as regionLuminances, in order. Calls run one at a time in
// call order, so overlapping calls cannot save and restore each other's overrides. The arena rect
// is the one the captured frame was drawn with.
export function installCaptureHook({ viewport, renderer }) {
  // The arena rect in device pixels plus the world size, the playable bounds and the scale in world units, to place capture regions.
  window.__murmuration.arenaRect = () => ({
    ...viewport.arenaRectDevicePixels,
    arenaWidth: viewport.arenaWidth,
    arenaHeight: viewport.arenaHeight,
    arenaBounds: { ...viewport.arenaBounds },
    pixelsPerWorldUnit: viewport.pixelsPerWorldUnit,
  });
  let queue = Promise.resolve();
  window.__murmuration.capture = (options) => {
    const result = queue.then(() => captureOnce(options));
    queue = result.catch(() => {});
    return result;
  };
  const captureOnce = async ({ inspectZoom, settings, regions } = {}) => {
    const previousZoom = viewport.inspectZoom;
    const previousSettings = { ...renderer.settings };
    let frame;
    try {
      if (inspectZoom !== undefined || settings !== undefined) {
        viewport.inspectZoom = inspectZoom ?? previousZoom;
        Object.assign(renderer.settings, settings);
        await waitAnimationFrames(CAPTURE_SETTLE_FRAMES);
      }
      frame = await renderer.captureNextFrame();
    } finally {
      viewport.inspectZoom = previousZoom;
      Object.assign(renderer.settings, previousSettings);
    }
    return describeCapture(frame, frame.details.arenaRect, regions);
  };
}
