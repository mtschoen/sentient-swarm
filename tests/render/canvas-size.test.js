import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasSizeFromEntry } from '../../src/render/canvas-size.js';

test('device pixel content box wins over the content rect', () => {
  const entry = {
    devicePixelContentBoxSize: [{ inlineSize: 1921, blockSize: 1081 }],
    contentRect: { width: 960, height: 540 },
  };
  assert.deepEqual(canvasSizeFromEntry(entry, 2), { width: 1921, height: 1081 });
});

test('the content rect is scaled by the ratio and rounded when no device box exists', () => {
  const entry = { contentRect: { width: 800.4, height: 450.6 } };
  assert.deepEqual(canvasSizeFromEntry(entry, 1.5), { width: 1201, height: 676 });
});

test('the ratio defaults to 1', () => {
  assert.deepEqual(canvasSizeFromEntry({ contentRect: { width: 640, height: 360 } }), { width: 640, height: 360 });
});

test('an empty device box array falls back to the content rect', () => {
  const entry = { devicePixelContentBoxSize: [], contentRect: { width: 100, height: 50 } };
  assert.deepEqual(canvasSizeFromEntry(entry, 2), { width: 200, height: 100 });
});
