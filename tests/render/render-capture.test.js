// The comparison rules of tests/browser/render-capture.mjs (Plan D task D2): mean absolute
// per-channel difference at most 0.5 and every channel within 4, in 0..255 units.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAXIMUM_CHANNEL_DIFFERENCE, MAXIMUM_MEAN_DIFFERENCE, compareFrames, parseArguments, withinLimits,
} from '../browser/render-capture.mjs';

test('compareFrames reports the mean and largest absolute channel difference', () => {
  assert.deepEqual(compareFrames(new Uint8Array([10, 20, 30, 255]), new Uint8Array([10, 20, 30, 255])), { mean: 0, maximum: 0 });
  assert.deepEqual(compareFrames(new Uint8Array([10, 20, 30, 255]), new Uint8Array([12, 20, 26, 255])), { mean: 1.5, maximum: 4 });
  assert.throws(() => compareFrames(new Uint8Array(4), new Uint8Array(8)), /frame sizes differ/);
});

test('withinLimits holds at the limits and fails just past either one', () => {
  assert.equal(MAXIMUM_MEAN_DIFFERENCE, 0.5);
  assert.equal(MAXIMUM_CHANNEL_DIFFERENCE, 4);
  assert.equal(withinLimits({ mean: 0.5, maximum: 4 }), true);
  assert.equal(withinLimits({ mean: 0.51, maximum: 0 }), false);
  assert.equal(withinLimits({ mean: 0, maximum: 5 }), false);
});

test('parseArguments needs --out and takes an optional --compare', () => {
  assert.deepEqual(parseArguments(['--out', 'a']), { out: 'a', compare: null });
  assert.deepEqual(parseArguments(['--out', 'a', '--compare', 'b']), { out: 'a', compare: 'b' });
  assert.throws(() => parseArguments([]), /--out <directory> is required/);
  assert.throws(() => parseArguments(['--out']), /--out needs a directory/);
  assert.throws(() => parseArguments(['--out', 'a', '--frames', '3']), /unknown argument --frames/);
});
