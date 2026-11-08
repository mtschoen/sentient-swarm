import { ARENA_WIDTH, ARENA_HEIGHT } from '../sim/layout.js';

// Letterboxes the fixed-aspect arena into the canvas and converts between screen, world and clip space.
export class Viewport {
  constructor({ arenaWidth = ARENA_WIDTH, arenaHeight = ARENA_HEIGHT } = {}) {
    this.arenaWidth = arenaWidth;
    this.arenaHeight = arenaHeight;
    this.canvasWidth = 1;
    this.canvasHeight = 1;
    this.devicePixelRatio = 1;
    this.inspectZoom = 1;
    // The right-button inspect zoom is a lab feature (owner ruling R7): off in play, where the right
    // button only bombs; the lab turns it on (setInspectZoomEnabled).
    this.inspectZoomEnabled = false;
    this.arenaRectDevicePixels = { x: 0, y: 0, width: 1, height: 1 };
  }

  // Sizes below 1 device pixel (a collapsed canvas) are stored as 1, so no transform divides by zero.
  setCanvasSize(widthDevicePixels, heightDevicePixels, devicePixelRatio = 1) {
    const canvasWidth = Math.max(1, widthDevicePixels || 0);
    const canvasHeight = Math.max(1, heightDevicePixels || 0);
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
    this.devicePixelRatio = devicePixelRatio > 0 ? devicePixelRatio : 1;
    const scale = Math.min(canvasWidth / this.arenaWidth, canvasHeight / this.arenaHeight);
    const width = Math.max(1, Math.floor(this.arenaWidth * scale));
    const height = Math.max(1, Math.floor(this.arenaHeight * scale));
    this.arenaRectDevicePixels = {
      x: Math.floor((canvasWidth - width) / 2),
      y: Math.floor((canvasHeight - height) / 2),
      width,
      height,
    };
  }

  // Turning the zoom off also drops a zoom held at that moment.
  setInspectZoomEnabled(enabled) {
    this.inspectZoomEnabled = Boolean(enabled);
    if (!this.inspectZoomEnabled) this.inspectZoom = 1;
  }

  // A zoom of 0 or less (never set by the app) is treated as 1 rather than dividing by it.
  get effectiveZoom() {
    return this.inspectZoom > 0 ? this.inspectZoom : 1;
  }

  // CSS pixels relative to the canvas to world units: the exact inverse of worldToClip, including
  // inspectZoom about the arena center. The world is drawn centered on the canvas center, so this
  // maps through clip space rather than through the floored arenaRect origin.
  screenToWorld(cssX, cssY) {
    const rect = this.arenaRectDevicePixels;
    const clipX = ((cssX * this.devicePixelRatio) / this.canvasWidth) * 2 - 1;
    const clipY = 1 - ((cssY * this.devicePixelRatio) / this.canvasHeight) * 2;
    const normalizedX = clipX / ((rect.width / this.canvasWidth) * this.effectiveZoom);
    const normalizedY = clipY / ((rect.height / this.canvasHeight) * this.effectiveZoom);
    return {
      x: (normalizedX / 2 + 0.5) * this.arenaWidth,
      y: (0.5 - normalizedY / 2) * this.arenaHeight,
    };
  }

  // World y grows downward (like screen y); clip y grows upward.
  worldToClip(x, y) {
    const rect = this.arenaRectDevicePixels;
    const normalizedX = (x / this.arenaWidth - 0.5) * 2;
    const normalizedY = (0.5 - y / this.arenaHeight) * 2;
    return {
      x: normalizedX * (rect.width / this.canvasWidth) * this.effectiveZoom,
      y: normalizedY * (rect.height / this.canvasHeight) * this.effectiveZoom,
    };
  }
}
