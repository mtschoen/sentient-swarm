// Plan D task D2: the instanced quad shaders share quad.wgsl (prepended by loadQuadHeader) instead
// of each carrying its own copy of the corner, feather and segment helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readShader = (name) => readFileSync(new URL(`../../src/render/shaders/${name}.wgsl`, import.meta.url), 'utf8');
const QUAD_SHADERS = ['gates', 'glyphs', 'ships', 'particles', 'pickups', 'projectiles', 'ship'];
const CORNER_EXPRESSION = 'vec2f(f32(vertexIndex & 1u), f32(vertexIndex >> 1u)) * 2.0 - vec2f(1.0)';

test('quad.wgsl defines the shared quad helpers once', () => {
  const header = readShader('quad');
  for (const declaration of ['const PIXEL_FEATHER: f32', 'fn quadCorner(', 'fn worldFeather(', 'fn segmentDistance(']) {
    assert.equal(header.split(declaration).length - 1, 1, declaration);
  }
  assert.ok(header.includes(CORNER_EXPRESSION));
});

test('no quad shader redeclares a helper from quad.wgsl or inlines the corner', () => {
  for (const name of QUAD_SHADERS) {
    const source = readShader(name);
    for (const declaration of ['const PIXEL_FEATHER', 'fn quadCorner(', 'fn worldFeather(', 'fn segmentDistance(']) {
      assert.ok(!source.includes(declaration), `${name}.wgsl declares ${declaration}`);
    }
    assert.ok(!source.includes(CORNER_EXPRESSION), `${name}.wgsl inlines the quad corner`);
  }
});
