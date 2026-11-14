import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BORDER_CORE_HALF_PIXELS, BORDER_GLOW_PIXELS, BORDER_VERTEX_COUNT, BORDER_VIEW_BYTES, packWorldBorder,
} from '../../src/render/world-border.js';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../../src/sim/layout.js';
import { Viewport } from '../../src/render/viewport.js';

test('packWorldBorder fills the BorderView layout and matches viewport.worldToClip', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(2000, 1000);
  viewport.setCamera({ centerX: 20, centerY: 8, zoom: 1 });
  const packed = packWorldBorder(viewport);
  assert.equal(packed.byteLength, BORDER_VIEW_BYTES);
  for (const [x, y] of [[0, 0], [WORLD_WIDTH, WORLD_HEIGHT], [WORLD_WIDTH, 0]]) {
    const clip = viewport.worldToClip(x, y);
    assert.ok(Math.abs(x * packed[0] + packed[2] - clip.x) < 1e-5, `x of ${x},${y}`);
    assert.ok(Math.abs(y * packed[1] + packed[3] - clip.y) < 1e-5, `y of ${x},${y}`);
  }
  assert.ok(Math.abs(packed[4] - 2 / 2000) < 1e-9);
  assert.ok(Math.abs(packed[5] - 2 / 1000) < 1e-9);
});

test('the line width and glow are device pixels scaled by the device pixel ratio, not by the view', () => {
  const small = new Viewport();
  small.setCanvasSize(400, 300, 1);
  const large = new Viewport();
  large.setCanvasSize(3000, 1500, 1);
  const phone = new Viewport();
  phone.setCanvasSize(2400, 1080, 3);
  assert.deepEqual([...packWorldBorder(small).slice(6)], [BORDER_CORE_HALF_PIXELS, BORDER_GLOW_PIXELS]);
  assert.deepEqual([...packWorldBorder(large).slice(6)], [BORDER_CORE_HALF_PIXELS, BORDER_GLOW_PIXELS]);
  assert.deepEqual([...packWorldBorder(phone).slice(6)], [BORDER_CORE_HALF_PIXELS * 3, BORDER_GLOW_PIXELS * 3]);
});

test('a device pixel ratio below 1 is treated as 1 and the target is reused when given', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(800, 600, 0.5);
  const target = new Float32Array(8);
  assert.equal(packWorldBorder(viewport, target), target);
  assert.equal(target[6], BORDER_CORE_HALF_PIXELS);
});

test('the draw is one quad of two triangles over the whole outline, matching the shader', () => {
  assert.equal(BORDER_VERTEX_COUNT, 6);
  const source = readFileSync(new URL('../../src/render/shaders/worldborder.wgsl', import.meta.url), 'utf8');
  assert.match(source, /@vertex\s+fn borderVertex/);
  assert.match(source, /@fragment\s+fn borderFragment/);
  assert.match(source, /const CORNERS = array<vec2f, 6>/);
  assert.equal(source.includes('instance_index'), false, 'no per-edge instances, so corners are never lit twice');
  assert.match(source, /abs\(max\(beyond\.x, beyond\.y\)\)/, 'the core is the Chebyshev distance: square corners');
  assert.equal(source.includes('—'), false, 'no em-dashes');
});
