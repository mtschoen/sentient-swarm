import { ARENA_WIDTH, ARENA_HEIGHT, FULL_ARENA_BOUNDS, arenaBoundsForAspect } from '../sim/layout.js';

// Maps the playable arena (the largest rectangle of the canvas aspect centered in the 16 by 9 world,
// `arenaBounds`) onto the whole canvas, so the game fills the window at any aspect between 1:4 and
// 4:1 (beyond that it letterboxes), and converts between screen, world and clip space.
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
    this.arenaBounds = FULL_ARENA_BOUNDS;
    this.arenaRectDevicePixels = { x: 0, y: 0, width: 1, height: 1 };
  }

  // Sizes below 1 device pixel (a collapsed canvas) are stored as 1, so no transform divides by zero.
  setCanvasSize(widthDevicePixels, heightDevicePixels, devicePixelRatio = 1) {
    const canvasWidth = Math.max(1, widthDevicePixels || 0);
    const canvasHeight = Math.max(1, heightDevicePixels || 0);
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
    this.devicePixelRatio = devicePixelRatio > 0 ? devicePixelRatio : 1;
    const bounds = arenaBoundsForAspect(canvasWidth / canvasHeight);
    this.arenaBounds = bounds;
    const scale = Math.min(canvasWidth / bounds.width, canvasHeight / bounds.height);
    const width = Math.min(canvasWidth, Math.max(1, Math.round(bounds.width * scale)));
    const height = Math.min(canvasHeight, Math.max(1, Math.round(bounds.height * scale)));
    this.arenaRectDevicePixels = {
      x: Math.floor((canvasWidth - width) / 2),
      y: Math.floor((canvasHeight - height) / 2),
      width,
      height,
    };
  }

  // Device pixels per world unit at zoom 1.
  get pixelsPerWorldUnit() {
    return this.arenaRectDevicePixels.width / this.arenaBounds.width;
  }

  // The whole 16 by 9 world in device pixels; it exceeds the canvas when the bounds are a sub-rectangle.
  get worldRectDevicePixels() {
    const scale = this.pixelsPerWorldUnit;
    return { width: this.arenaWidth * scale, height: this.arenaHeight * scale };
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
  // inspectZoom about the arena center. The arena is drawn centered on the canvas center, so this
  // maps through clip space rather than through the floored arenaRect origin.
  screenToWorld(cssX, cssY) {
    const rect = this.arenaRectDevicePixels;
    const clipX = ((cssX * this.devicePixelRatio) / this.canvasWidth) * 2 - 1;
    const clipY = 1 - ((cssY * this.devicePixelRatio) / this.canvasHeight) * 2;
    const normalizedX = clipX / ((rect.width / this.canvasWidth) * this.effectiveZoom);
    const normalizedY = clipY / ((rect.height / this.canvasHeight) * this.effectiveZoom);
    return {
      x: this.arenaBounds.minX + (normalizedX / 2 + 0.5) * this.arenaBounds.width,
      y: this.arenaBounds.minY + (0.5 - normalizedY / 2) * this.arenaBounds.height,
    };
  }

  // World y grows downward (like screen y); clip y grows upward.
  worldToClip(x, y) {
    const rect = this.arenaRectDevicePixels;
    const bounds = this.arenaBounds;
    const normalizedX = ((x - bounds.minX) / bounds.width - 0.5) * 2;
    const normalizedY = (0.5 - (y - bounds.minY) / bounds.height) * 2;
    return {
      x: normalizedX * (rect.width / this.canvasWidth) * this.effectiveZoom,
      y: normalizedY * (rect.height / this.canvasHeight) * this.effectiveZoom,
    };
  }
}
