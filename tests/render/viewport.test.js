import test from 'node:test';
import assert from 'node:assert/strict';
import { Viewport } from '../../src/render/viewport.js';

test('a wide canvas letterboxes the arena to width 1777 centered', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(2000, 1000);
  assert.deepEqual(viewport.arenaRectDevicePixels, { x: 111, y: 0, width: 1777, height: 1000 });
});

test('a square canvas letterboxes the arena to height 562', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(1000, 1000);
  const rect = viewport.arenaRectDevicePixels;
  assert.equal(rect.width, 1000);
  assert.equal(rect.height, 562);
  assert.equal(rect.x, 0);
  assert.equal(rect.y, 219);
});

function assertNear(actual, expected, tolerance = 1e-9) {
  const close = Math.abs(actual.x - expected.x) < tolerance && Math.abs(actual.y - expected.y) < tolerance;
  assert.ok(close, `${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`);
}

// Device pixels (y down) of a clip-space point on a canvas of the viewport's size.
function clipToDevice(viewport, clip) {
  return { x: (clip.x + 1) / 2 * viewport.canvasWidth, y: (1 - clip.y) / 2 * viewport.canvasHeight };
}

test('screenToWorld maps the canvas center to the arena center (8, 4.5)', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(2000, 1000);
  assertNear(viewport.screenToWorld(1000, 500), { x: 8, y: 4.5 });
});

test('screenToWorld uses CSS pixels scaled by the device pixel ratio', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(2000, 1000, 2);
  assertNear(viewport.screenToWorld(500, 250), { x: 8, y: 4.5 });
  // The arena's left edge sits 111.5 device pixels in (1777 wide, centered on 2000).
  assertNear(viewport.screenToWorld(111.5 / 2, 0), { x: 0, y: 0 });
});

test('the center stays at (8, 4.5) under 4x inspect zoom', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(1280, 720);
  viewport.inspectZoom = 4;
  assertNear(viewport.screenToWorld(640, 360), { x: 8, y: 4.5 });
});

test('under 4x zoom the arena corner pixel maps to the corner of the quarter-size window around the center', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(1280, 720);
  viewport.inspectZoom = 4;
  // The visible window is a quarter of the arena wide and high: x 6 to 10, y 3.375 to 5.625.
  assertNear(viewport.screenToWorld(0, 0), { x: 8 - 16 / 8, y: 4.5 - 9 / 8 });
  assertNear(viewport.screenToWorld(1280, 720), { x: 8 + 16 / 8, y: 4.5 + 9 / 8 });
  // The reviewer's case: x = 960 on a 1280 canvas is world x 9 at 4x, not 12.
  assert.ok(Math.abs(viewport.screenToWorld(960, 360).x - 9) < 1e-9);
});

test('screenToWorld inverts worldToClip at 1x and 4x zoom, letterboxed, at ratio 1.5', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(1000, 1000, 1.5);
  for (const zoom of [1, 4]) {
    viewport.inspectZoom = zoom;
    for (const point of [{ x: 0, y: 0 }, { x: 3.25, y: 7.5 }, { x: 16, y: 9 }, { x: 9, y: 4 }]) {
      const device = clipToDevice(viewport, viewport.worldToClip(point.x, point.y));
      assertNear(viewport.screenToWorld(device.x / 1.5, device.y / 1.5), point, 1e-6);
    }
  }
});

test('setCanvasSize stores a 1 by 1 minimum, so zero sizes give finite transforms', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(0, 0, 0);
  assert.equal(viewport.canvasWidth, 1);
  assert.equal(viewport.canvasHeight, 1);
  assert.equal(viewport.devicePixelRatio, 1);
  const rect = viewport.arenaRectDevicePixels;
  assert.ok(rect.width >= 1 && rect.height >= 1);
  const world = viewport.screenToWorld(0, 0);
  const clip = viewport.worldToClip(4, 4);
  assert.ok([world.x, world.y, clip.x, clip.y].every(Number.isFinite));
});

test('a point in the letterbox band lands outside the arena', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(1000, 1000);
  const world = viewport.screenToWorld(500, 10);
  assert.ok(world.y < 0 || world.y > 9);
});

test('worldToClip maps the center to the origin and honors inspectZoom', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(2000, 1000);
  const center = viewport.worldToClip(8, 4.5);
  assert.ok(Math.abs(center.x) < 1e-9 && Math.abs(center.y) < 1e-9);
  const normal = viewport.worldToClip(16, 0);
  viewport.inspectZoom = 4;
  const zoomed = viewport.worldToClip(16, 0);
  assert.ok(Math.abs(zoomed.x - normal.x * 4) < 1e-9);
  assert.ok(Math.abs(zoomed.y - normal.y * 4) < 1e-9);
});

test('the inspect zoom is off until the lab enables it, and disabling it drops a held zoom', () => {
  const viewport = new Viewport();
  assert.equal(viewport.inspectZoomEnabled, false);
  viewport.setInspectZoomEnabled(true);
  assert.equal(viewport.inspectZoomEnabled, true);
  viewport.inspectZoom = 4;
  viewport.setInspectZoomEnabled(false);
  assert.equal(viewport.inspectZoomEnabled, false);
  assert.equal(viewport.inspectZoom, 1);
});
