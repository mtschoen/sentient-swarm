import test from 'node:test';
import assert from 'node:assert/strict';
import { Viewport } from '../../src/render/viewport.js';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../../src/sim/layout.js';

// Most tests look at the view with the camera on (8, 4.5), the center of a 16 by 9 view whose
// corner is the world origin.
function oneScreenViewport() {
  const viewport = new Viewport();
  viewport.setCamera({ centerX: 8, centerY: 4.5 });
  return viewport;
}

test('a new viewport looks at the world center', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(1600, 900);
  assert.deepEqual(viewport.viewBounds, { minX: WORLD_WIDTH / 2 - 8, minY: WORLD_HEIGHT / 2 - 4.5, maxX: WORLD_WIDTH / 2 + 8, maxY: WORLD_HEIGHT / 2 + 4.5, width: 16, height: 9 });
});

test('a 16:9 canvas sees a 16 by 9 view', () => {
  const viewport = oneScreenViewport();
  viewport.setCanvasSize(1600, 900);
  assert.deepEqual(viewport.arenaRectDevicePixels, { x: 0, y: 0, width: 1600, height: 900 });
  assert.deepEqual(viewport.viewBounds, { minX: 0, minY: 0, maxX: 16, maxY: 9, width: 16, height: 9 });
  assertNear(viewport.worldToClip(0, 0), { x: -1, y: 1 });
  assertNear(viewport.worldToClip(16, 9), { x: 1, y: -1 });
  assert.equal(viewport.pixelsPerWorldUnit, 100);
});

test('a wide canvas fills the window with a 16 by 8 view centered on the camera', () => {
  const viewport = oneScreenViewport();
  viewport.setCanvasSize(2000, 1000);
  assert.deepEqual(viewport.arenaRectDevicePixels, { x: 0, y: 0, width: 2000, height: 1000 });
  const bounds = viewport.viewBounds;
  assert.equal(bounds.width, 16);
  assert.equal(bounds.height, 8);
  assert.equal(bounds.minY, 0.5);
  assert.equal(viewport.pixelsPerWorldUnit, 125);
});

test('a square canvas fills the window with 9 by 9 bounds', () => {
  const viewport = oneScreenViewport();
  viewport.setCanvasSize(1000, 1000);
  assert.deepEqual(viewport.arenaRectDevicePixels, { x: 0, y: 0, width: 1000, height: 1000 });
  assert.equal(viewport.viewBounds.width, 9);
  assert.equal(viewport.viewBounds.height, 9);
  assert.equal(viewport.viewBounds.minX, 3.5);
});

test('beyond 4:1 the arena letterboxes at the clamped aspect', () => {
  const viewport = oneScreenViewport();
  viewport.setCanvasSize(5000, 1000);
  assert.deepEqual(viewport.arenaRectDevicePixels, { x: 500, y: 0, width: 4000, height: 1000 });
  assert.equal(viewport.viewBounds.width, 16);
  assert.equal(viewport.viewBounds.height, 4);
});

test('odd canvas sizes leave no one-pixel band from rounding', () => {
  const viewport = oneScreenViewport();
  for (const [width, height] of [[844, 390], [915, 412], [1001, 777], [721, 1283]]) {
    viewport.setCanvasSize(width, height);
    assert.deepEqual(viewport.arenaRectDevicePixels, { x: 0, y: 0, width, height });
  }
});

function assertNear(actual, expected, tolerance = 1e-9) {
  const close = Math.abs(actual.x - expected.x) < tolerance && Math.abs(actual.y - expected.y) < tolerance;
  assert.ok(close, `${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`);
}

// Device pixels (y down) of a clip-space point on a canvas of the viewport's size.
function clipToDevice(viewport, clip) {
  return { x: (clip.x + 1) / 2 * viewport.canvasWidth, y: (1 - clip.y) / 2 * viewport.canvasHeight };
}

test('screenToWorld maps the canvas center to the world center (8, 4.5)', () => {
  const viewport = oneScreenViewport();
  viewport.setCanvasSize(2000, 1000);
  assertNear(viewport.screenToWorld(1000, 500), { x: 8, y: 4.5 });
});

test('screenToWorld uses CSS pixels scaled by the device pixel ratio', () => {
  const viewport = oneScreenViewport();
  viewport.setCanvasSize(2000, 1000, 2);
  assertNear(viewport.screenToWorld(500, 250), { x: 8, y: 4.5 });
  // The top-left canvas corner is the bounds corner (0, 0.5) at aspect 2.
  assertNear(viewport.screenToWorld(0, 0), { x: 0, y: 0.5 });
});

test('the center stays at (8, 4.5) under 4x inspect zoom', () => {
  const viewport = oneScreenViewport();
  viewport.setCanvasSize(1280, 720);
  viewport.inspectZoom = 4;
  assertNear(viewport.screenToWorld(640, 360), { x: 8, y: 4.5 });
});

test('under 4x zoom the arena corner pixel maps to the corner of the quarter-size window around the center', () => {
  const viewport = oneScreenViewport();
  viewport.setCanvasSize(1280, 720);
  viewport.inspectZoom = 4;
  // The visible window is a quarter of the arena wide and high: x 6 to 10, y 3.375 to 5.625.
  assertNear(viewport.screenToWorld(0, 0), { x: 8 - 16 / 8, y: 4.5 - 9 / 8 });
  assertNear(viewport.screenToWorld(1280, 720), { x: 8 + 16 / 8, y: 4.5 + 9 / 8 });
  // The reviewer's case: x = 960 on a 1280 canvas is world x 9 at 4x, not 12.
  assert.ok(Math.abs(viewport.screenToWorld(960, 360).x - 9) < 1e-9);
});

test('screenToWorld inverts worldToClip at 1x and 4x zoom, on a square canvas and a letterboxed one, at ratio 1.5', () => {
  const viewport = oneScreenViewport();
  for (const [width, height] of [[1000, 1000], [5000, 1000]]) {
    viewport.setCanvasSize(width, height, 1.5);
    for (const zoom of [1, 4]) {
      viewport.inspectZoom = zoom;
      for (const point of [{ x: 0, y: 0 }, { x: 3.25, y: 7.5 }, { x: 16, y: 9 }, { x: 9, y: 4 }]) {
        const device = clipToDevice(viewport, viewport.worldToClip(point.x, point.y));
        assertNear(viewport.screenToWorld(device.x / 1.5, device.y / 1.5), point, 1e-6);
      }
    }
  }
});

test('setCanvasSize stores a 1 by 1 minimum, so zero sizes give finite transforms', () => {
  const viewport = oneScreenViewport();
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
  const viewport = oneScreenViewport();
  viewport.setCanvasSize(5000, 1000);
  const world = viewport.screenToWorld(10, 500);
  assert.ok(world.x < 0 || world.x > 16);
});

test('worldToClip maps the center to the origin and honors inspectZoom', () => {
  const viewport = oneScreenViewport();
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
  const viewport = oneScreenViewport();
  assert.equal(viewport.inspectZoomEnabled, false);
  viewport.setInspectZoomEnabled(true);
  assert.equal(viewport.inspectZoomEnabled, true);
  viewport.inspectZoom = 4;
  viewport.setInspectZoomEnabled(false);
  assert.equal(viewport.inspectZoomEnabled, false);
  assert.equal(viewport.inspectZoom, 1);
});

test('the camera moves the view: its center maps to the canvas center and screenToWorld still inverts worldToClip', () => {
  const viewport = oneScreenViewport();
  viewport.setCanvasSize(1280, 720, 2);
  viewport.setCamera({ centerX: 3.5, centerY: 7.25 });
  assert.deepEqual(viewport.viewBounds, { minX: -4.5, minY: 2.75, maxX: 11.5, maxY: 11.75, width: 16, height: 9 });
  assertNear(viewport.worldToClip(3.5, 7.25), { x: 0, y: 0 });
  assertNear(viewport.screenToWorld(320, 180), { x: 3.5, y: 7.25 });
  for (const zoom of [1, 4]) {
    viewport.inspectZoom = zoom;
    for (const point of [{ x: 0, y: 0 }, { x: 5, y: 8 }]) {
      const device = clipToDevice(viewport, viewport.worldToClip(point.x, point.y));
      assertNear(viewport.screenToWorld(device.x / 2, device.y / 2), point, 1e-6);
    }
  }
  // A resize keeps the camera center.
  viewport.setCanvasSize(1000, 1000);
  assertNear(viewport.worldToClip(3.5, 7.25), { x: 0, y: 0 });
  assert.equal(viewport.viewBounds.width, 9);
});

test('the camera zoom multiplies the inspect zoom, and a zoom of 0 or less is 1', () => {
  const viewport = oneScreenViewport();
  viewport.setCanvasSize(1600, 900);
  viewport.setCamera({ centerX: 8, centerY: 4.5, zoom: 2 });
  viewport.inspectZoom = 4;
  assert.equal(viewport.effectiveZoom, 8);
  viewport.setCamera({ centerX: 8, centerY: 4.5, zoom: 0 });
  assert.equal(viewport.effectiveZoom, 4);
});
