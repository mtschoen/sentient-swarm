import test from 'node:test';
import assert from 'node:assert/strict';
import { trackEach } from '../../src/gpu/track-progress.js';

test('trackEach reports each resolution in completion order and returns the values in input order', async () => {
  const calls = [];
  const resolvers = [];
  const promises = [0, 1, 2].map((index) => new Promise((resolve) => { resolvers[index] = () => resolve(`value${index}`); }));
  const all = trackEach(promises, (completed, total) => calls.push([completed, total]));
  resolvers[2]();
  resolvers[0]();
  resolvers[1]();
  assert.deepEqual(await all, ['value0', 'value1', 'value2']);
  assert.deepEqual(calls, [[1, 3], [2, 3], [3, 3]]);
});

test('trackEach works without a callback and with no promises', async () => {
  assert.deepEqual(await trackEach([Promise.resolve(1), Promise.resolve(2)]), [1, 2]);
  assert.deepEqual(await trackEach([], () => assert.fail('no progress for no promises')), []);
});

test('trackEach rejects when a promise rejects', async () => {
  await assert.rejects(trackEach([Promise.resolve(1), Promise.reject(new Error('boom'))], () => {}), /boom/);
});
