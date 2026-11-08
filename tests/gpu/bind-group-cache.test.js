import test from 'node:test';
import assert from 'node:assert/strict';
import { BindGroupCache } from '../../src/gpu/bind-group-cache.js';

test('BindGroupCache creates once per buffer set and reuses alternating sets', () => {
  const created = [];
  const cache = new BindGroupCache((buffers) => {
    created.push(buffers);
    return { buffers };
  });
  const first = { label: 'a' };
  const second = { label: 'b' };
  const shared = { label: 'shared' };
  const forward = cache.get([first, second, shared]);
  const backward = cache.get([second, first, shared]);
  assert.notEqual(forward, backward);
  assert.equal(cache.get([first, second, shared]), forward);
  assert.equal(cache.get([second, first, shared]), backward);
  assert.equal(cache.creationCount, 2);
  assert.equal(created.length, 2);
});

test('BindGroupCache.clear drops every entry, so the same buffers build new bind groups', () => {
  const cache = new BindGroupCache((buffers) => ({ buffers }));
  const buffer = { label: 'agents' };
  const before = cache.get([buffer]);
  cache.clear();
  assert.equal(cache.entries.size, 0);
  const after = cache.get([buffer]);
  assert.notEqual(after, before);
  assert.equal(cache.creationCount, 2);
  assert.equal(cache.get([buffer]), after);
});

test('BindGroupCache tells apart distinct buffers that share a label', () => {
  const cache = new BindGroupCache((buffers) => ({ buffers }));
  cache.get([{ label: 'same' }]);
  cache.get([{ label: 'same' }]);
  assert.equal(cache.creationCount, 2);
});

test('BindGroupCache.evict drops only the entries that name the buffer', () => {
  const cache = new BindGroupCache((buffers) => ({ buffers }));
  const params = { label: 'params' };
  const oldParticles = { label: 'particles' };
  const newParticles = { label: 'particles' };
  const keptEntry = cache.get([params, newParticles]);
  cache.get([params, oldParticles]);
  cache.get([oldParticles]);
  cache.evict(oldParticles);
  assert.equal(cache.entries.size, 1);
  assert.equal(cache.get([params, newParticles]), keptEntry);
});
