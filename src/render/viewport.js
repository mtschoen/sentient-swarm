import { WORLD_HEIGHT, WORLD_WIDTH, boundsAround, viewSizeForAspect } from '../sim/layout.js';

// Maps the view (what the camera shows: a rectangle of the canvas aspect, viewSizeForAspect in
// world.js, centered on the camera) onto the whole canvas, so the game fills the window at any
// aspect between 1:4 and 4:1 (beyond that it letterboxes), and converts between screen, world and
// clip space. The camera (setCamera: center and zoom, from Camera.sample in src/game/camera.js)
// drives the transform; it starts at the world center. The lab's inspect zoom multiplies the
// camera zoom about the view center.
export class Viewport {
  constructor() {
    this.canvasWidth = 1;
    this.canvasHeight = 1;
    this.devicePixelRatio = 1;
    this.inspectZoom = 1;
    // The right-button inspect zoom is a lab feature (owner ruling R7): off in play, where the right
    // button only bombs; the lab turns it on (setInspectZoomEnabled).
    this.inspectZoomEnabled = false;
    this.cameraX = WORLD_WIDTH / 2;
    this.cameraY = WORLD_HEIGHT / 2;
    this.cameraZoom = 1;
    this.viewSize = viewSizeForAspect(16 / 9);
    this.viewBounds = boundsAround(this.cameraX, this.cameraY, this.viewSize.width, this.viewSize.height);
    this.arenaRectDevicePixels = { x: 0, y: 0, width: 1, height: 1 };
  }

  // Sizes below 1 device pixel (a collapsed canvas) are stored as 1, so no transform divides by zero.
  setCanvasSize(widthDevicePixels, heightDevicePixels, devicePixelRatio = 1) {
    const canvasWidth = Math.max(1, widthDevicePixels || 0);
    const canvasHeight = Math.max(1, heightDevicePixels || 0);
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
    this.devicePixelRatio = devicePixelRatio > 0 ? devicePixelRatio : 1;
    const view = viewSizeForAspect(canvasWidth / canvasHeight);
    this.viewSize = view;
    this.viewBounds = boundsAround(this.cameraX, this.cameraY, view.width, view.height);
    const scale = Math.min(canvasWidth / view.width, canvasHeight / view.height);
    const width = Math.min(canvasWidth, Math.max(1, Math.round(view.width * scale)));
    const height = Math.min(canvasHeight, Math.max(1, Math.round(view.height * scale)));
    this.arenaRectDevicePixels = {
      x: Math.floor((canvasWidth - width) / 2),
      y: Math.floor((canvasHeight - height) / 2),
      width,
      height,
    };
  }

  // The camera's center in world units and its zoom (1 shows viewSize; a zoom of 0 or less is 1).
  setCamera({ centerX, centerY, zoom = 1 }) {
    this.cameraX = centerX;
    this.cameraY = centerY;
    this.cameraZoom = zoom > 0 ? zoom : 1;
    this.viewBounds = boundsAround(centerX, centerY, this.viewSize.width, this.viewSize.height);
  }

  // Device pixels per world unit at zoom 1.
  get pixelsPerWorldUnit() {
    return this.arenaRectDevicePixels.width / this.viewSize.width;
  }

  // Turning the zoom off also drops a zoom held at that moment.
  setInspectZoomEnabled(enabled) {
    this.inspectZoomEnabled = Boolean(enabled);
    if (!this.inspectZoomEnabled) this.inspectZoom = 1;
  }

  // The camera zoom times the inspect zoom; an inspect zoom of 0 or less (never set by the app)
  // is treated as 1 rather than dividing by it.
  get effectiveZoom() {
    return this.cameraZoom * (this.inspectZoom > 0 ? this.inspectZoom : 1);
  }

  // The world rectangle on screen: the view around the camera scaled by the effective zoom
  // (viewBounds stays the unzoomed rectangle the transforms scale about).
  get visibleBounds() {
    return boundsAround(this.cameraX, this.cameraY, this.viewSize.width / this.effectiveZoom, this.viewSize.height / this.effectiveZoom);
  }

  // CSS pixels relative to the canvas to world units: the exact inverse of worldToClip, including
  // the zoom about the view center. The view is drawn centered on the canvas center, so this maps
  // through clip space rather than through the floored arenaRect origin.
  screenToWorld(cssX, cssY) {
    const rect = this.arenaRectDevicePixels;
    const bounds = this.viewBounds;
    const clipX = ((cssX * this.devicePixelRatio) / this.canvasWidth) * 2 - 1;
    const clipY = 1 - ((cssY * this.devicePixelRatio) / this.canvasHeight) * 2;
    const normalizedX = clipX / ((rect.width / this.canvasWidth) * this.effectiveZoom);
    const normalizedY = clipY / ((rect.height / this.canvasHeight) * this.effectiveZoom);
    return {
      x: bounds.minX + (normalizedX / 2 + 0.5) * bounds.width,
      y: bounds.minY + (0.5 - normalizedY / 2) * bounds.height,
    };
  }

  // World y grows downward (like screen y); clip y grows upward.
  worldToClip(x, y) {
    const rect = this.arenaRectDevicePixels;
    const bounds = this.viewBounds;
    const normalizedX = ((x - bounds.minX) / bounds.width - 0.5) * 2;
    const normalizedY = (0.5 - (y - bounds.minY) / bounds.height) * 2;
    return {
      x: normalizedX * (rect.width / this.canvasWidth) * this.effectiveZoom,
      y: normalizedY * (rect.height / this.canvasHeight) * this.effectiveZoom,
    };
  }
}
