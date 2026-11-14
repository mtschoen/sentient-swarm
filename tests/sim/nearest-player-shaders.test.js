import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const occurrences = (text, needle) => text.split(needle).length - 1;

test('steer, spawn and glyphs read the players only through the common helpers', () => {
  for (const path of ['../../src/sim/shaders/steer.wgsl', '../../src/sim/shaders/spawn.wgsl', '../../src/render/shaders/glyphs.wgsl']) {
    assert.equal(occurrences(read(path), 'params.playerPosition'), 0, path);
  }
  const common = read('../../src/sim/shaders/common.wgsl');
  for (const name of ['nearestPlayerPosition', 'nearestPlayerDistance', 'playersCenter']) {
    assert.equal(occurrences(common, 'fn ' + name + '('), 1, name);
  }
});
