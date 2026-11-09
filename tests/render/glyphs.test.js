import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GLYPH_VIEW_BYTES, MINIMUM_SHIP_DEVICE_PIXELS, shipCoverageScale, packShipView, shipDevicePixels,
} from '../../src/render/glyphs.js';
import { DEFAULT_RENDER_SETTINGS } from '../../src/render/renderer.js';
import { Viewport } from '../../src/render/viewport.js';

const settings = { shipArenaFraction: 0.02, glowScale: 2, trailDecay: 0.9, bloomStrength: 0.8 };

function applyTransform(view, x, y) {
  return { x: view[0] * x + view[2], y: view[1] * y + view[3] };
}

function near(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${expected}, got ${actual}`);
}

test('packShipView fills the 64-byte GlyphView layout', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(1600, 900);
  const view = packShipView({ viewport, settings, alpha: 0.25, time: 3, emissionScale: 0.5 });
  assert.equal(view.byteLength, GLYPH_VIEW_BYTES);
  // A 900-pixel-tall arena gives an 18-pixel ship; its 25 by 25 pixel coarse cells give 324 / 625.
  assert.deepEqual(Array.from(view.slice(4)), Array.from(new Float32Array([2 / 1600, 2 / 900, 18, 2, 0.25, 3, 324 / 625, 0.5, 0, 0, 0, 0])));
  assert.equal(packShipView({ viewport, settings, alpha: 0.25, time: 3, interpolate: true })[12], 1);
});

test('ship size follows the world height, with a minimum, and a zero fraction hides ships', () => {
  const large = new Viewport();
  large.setCanvasSize(3840, 2160);
  const small = new Viewport();
  small.setCanvasSize(320, 180);
  near(shipDevicePixels(large, 0.018), 0.018 * 2160);
  assert.equal(shipDevicePixels(small, 0.018), MINIMUM_SHIP_DEVICE_PIXELS);
  assert.equal(shipDevicePixels(large, 0), 0);
  assert.equal(packShipView({ viewport: large, settings: { ...settings, shipArenaFraction: 0 }, alpha: 0, time: 0 })[6], 0);
});

test('the default ship size is visible and a missing setting throws instead of hiding ships', () => {
  assert.ok(DEFAULT_RENDER_SETTINGS.shipArenaFraction > 0);
  const viewport = new Viewport();
  viewport.setCanvasSize(1280, 720);
  assert.throws(() => shipDevicePixels(viewport, undefined), TypeError);
  assert.throws(() => packShipView({ viewport, settings: { glowScale: 2 }, alpha: 0, time: 0 }), TypeError);
});

test('the inspect zoom grows ships by its square root and lowers their coverage', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(1280, 720);
  const unzoomed = shipDevicePixels(viewport, 0.02);
  const coverageUnzoomed = shipCoverageScale(viewport, unzoomed);
  near(coverageUnzoomed, (14.4 * 14.4) / 400);
  viewport.inspectZoom = 4;
  const zoomed = shipDevicePixels(viewport, 0.02);
  near(zoomed, unzoomed * 2);
  // Ships grow 2x while cells grow 4x, so coverage drops to a quarter.
  near(shipCoverageScale(viewport, zoomed), coverageUnzoomed / 4);
  assert.equal(packShipView({ viewport, settings, alpha: 0, time: 0 })[10], Math.fround(coverageUnzoomed / 4));
});

test('glyph coverage follows the whole world in pixels, which a tall canvas enlarges past the canvas width', () => {
  const large = new Viewport();
  large.setCanvasSize(1280, 720);
  const small = new Viewport();
  small.setCanvasSize(800, 1200);
  // The 800 by 1200 canvas shows a 6 by 9 unit arena at 133.33 pixels per unit, so the 16 by 9
  // world is 2133.33 by 1200 pixels and a coarse cell is 33.33 by 33.33 against the large canvas's 20 by 20.
  near(shipCoverageScale(small, 10) / shipCoverageScale(large, 10), (1280 * 720) / ((1200 * 16 / 9) * 1200));
});

test('packShipView world-to-clip transform matches viewport.worldToClip, zoom included', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(2000, 1000);
  viewport.inspectZoom = 4;
  const view = packShipView({ viewport, settings, alpha: 0, time: 0 });
  for (const [x, y] of [[0, 0], [16, 9], [3.5, 7.25]]) {
    const expected = viewport.worldToClip(x, y);
    const actual = applyTransform(view, x, y);
    assert.ok(Math.abs(actual.x - expected.x) < 1e-5);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-5);
  }
  // The 2000 by 1000 canvas shows 16 by 8 world units at 125 pixels each, so the 9-unit world is
  // 1125 pixels tall; 4x zoom doubles the ship.
  near(view[6], Math.fround(0.02 * 1125 * 2), 1e-4);
});

test('the ship has the same world size at every aspect', () => {
  const wide = new Viewport();
  wide.setCanvasSize(1600, 900);
  const tall = new Viewport();
  tall.setCanvasSize(900, 1600);
  const worldSize = (viewport) => shipDevicePixels(viewport, 0.02) / viewport.pixelsPerWorldUnit;
  near(worldSize(wide), worldSize(tall));
});
