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
    this.arenaRectDevicePixels = { x: 0, y: 0, width: 1, height: 1 };
  }

  setCanvasSize(widthDevicePixels, heightDevicePixels, devicePixelRatio = 1) {
    this.canvasWidth = widthDevicePixels;
    this.canvasHeight = heightDevicePixels;
    this.devicePixelRatio = devicePixelRatio;
    const scale = Math.min(widthDevicePixels / this.arenaWidth, heightDevicePixels / this.arenaHeight);
    const width = Math.floor(this.arenaWidth * scale);
    const height = Math.floor(this.arenaHeight * scale);
    this.arenaRectDevicePixels = {
      x: Math.floor((widthDevicePixels - width) / 2),
      y: Math.floor((heightDevicePixels - height) / 2),
      width,
      height,
    };
  }

  screenToWorld(px, py) {
    const rect = this.arenaRectDevicePixels;
    const deviceX = px * this.devicePixelRatio;
    const deviceY = py * this.devicePixelRatio;
    return {
      x: ((deviceX - rect.x) / rect.width) * this.arenaWidth,
      y: ((deviceY - rect.y) / rect.height) * this.arenaHeight,
    };
  }

  // World y grows downward (like screen y); clip y grows upward.
  worldToClip(x, y) {
    const rect = this.arenaRectDevicePixels;
    const normalizedX = (x / this.arenaWidth - 0.5) * 2;
    const normalizedY = (0.5 - y / this.arenaHeight) * 2;
    return {
      x: normalizedX * (rect.width / this.canvasWidth) * this.inspectZoom,
      y: normalizedY * (rect.height / this.canvasHeight) * this.inspectZoom,
    };
  }
}
