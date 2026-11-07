import test from 'node:test';
import assert from 'node:assert/strict';
import { GLYPH_VIEW_BYTES, packGlyphView } from '../../src/render/glyphs.js';
import { Viewport } from '../../src/render/viewport.js';

const settings = { glyphDevicePixels: 4, glowScale: 2, trailDecay: 0.9, bloomStrength: 0.8 };

function applyTransform(view, x, y) {
  return { x: view[0] * x + view[2], y: view[1] * y + view[3] };
}

test('packGlyphView fills the 48-byte GlyphView layout', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(1600, 900);
  const view = packGlyphView({ viewport, settings, alpha: 0.25, time: 3 });
  assert.equal(view.byteLength, GLYPH_VIEW_BYTES);
  assert.deepEqual(Array.from(view.slice(4)), Array.from(new Float32Array([2 / 1600, 2 / 900, 4, 2, 0.25, 3, 0, 0])));
});

test('packGlyphView world-to-clip transform matches viewport.worldToClip, zoom included', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(2000, 1000);
  viewport.inspectZoom = 4;
  const view = packGlyphView({ viewport, settings, alpha: 0, time: 0 });
  for (const [x, y] of [[0, 0], [16, 9], [3.5, 7.25]]) {
    const expected = viewport.worldToClip(x, y);
    const actual = applyTransform(view, x, y);
    assert.ok(Math.abs(actual.x - expected.x) < 1e-5);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-5);
  }
  assert.equal(view[6], 16, 'glyph size grows with the inspect zoom');
});
