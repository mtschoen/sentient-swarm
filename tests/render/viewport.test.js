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

test('screenToWorld maps the arena center to (8, 4.5)', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(2000, 1000);
  const rect = viewport.arenaRectDevicePixels;
  const world = viewport.screenToWorld(rect.x + rect.width / 2, rect.y + rect.height / 2);
  assert.ok(Math.abs(world.x - 8) < 1e-9);
  assert.ok(Math.abs(world.y - 4.5) < 1e-9);
});

test('screenToWorld uses CSS pixels scaled by the device pixel ratio', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(2000, 1000, 2);
  const world = viewport.screenToWorld(500, 250);
  assert.ok(Math.abs(world.x - ((1000 - 111) / 1777) * 16) < 1e-9);
  assert.ok(Math.abs(world.y - 4.5) < 1e-9);
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
