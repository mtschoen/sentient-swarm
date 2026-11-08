import test from 'node:test';
import assert from 'node:assert/strict';
import { CapacitySwap } from '../../src/game/capacity-swap.js';

// A prepare whose promise the test settles by hand, and a log of every commit, install and discard.
function createFixture(initial = { capacity: 262144, neighborRadius: 0.1, particleCapacity: 65536 }) {
  const fixture = { configuration: { ...initial }, events: [], pendingPrepares: [], commitError: null, milliseconds: 0 };
  fixture.swap = new CapacitySwap({
    now: () => fixture.milliseconds,
    getConfiguration: () => fixture.configuration,
    prepare: (change) => new Promise((resolve, reject) => fixture.pendingPrepares.push({ change, resolve, reject })),
    commit: (prepared) => {
      fixture.events.push(['commit', prepared]);
      if (fixture.commitError) throw fixture.commitError;
      return { ...fixture.configuration, ...prepared.change };
    },
    install: (simulation) => {
      fixture.events.push(['install', simulation]);
      fixture.configuration = simulation;
    },
    discard: (prepared) => fixture.events.push(['discard', prepared]),
  });
  return fixture;
}

test('nothing is committed or installed while the change is prepared; both run together once it is', async () => {
  const fixture = createFixture();
  assert.equal(fixture.swap.pending, false);
  const request = fixture.swap.request({ capacity: 1048576 });
  assert.equal(fixture.swap.pending, true);
  assert.deepEqual(fixture.events, []);
  const { change, resolve } = fixture.pendingPrepares[0];
  assert.deepEqual(change, { capacity: 1048576 });
  resolve({ change });
  assert.equal(await request, true);
  assert.equal(fixture.swap.pending, false);
  assert.deepEqual(fixture.events.map(([name]) => name), ['commit', 'install']);
  assert.equal(fixture.configuration.capacity, 1048576);
});

test('a request while one is pending, or matching the installed configuration, is ignored', async () => {
  const fixture = createFixture();
  assert.equal(await fixture.swap.request({ capacity: 262144 }), false);
  assert.equal(await fixture.swap.request({ capacity: 262144, neighborRadius: 0.1, particleCapacity: 65536 }), false);
  const first = fixture.swap.request({ capacity: 65536 });
  assert.equal(await fixture.swap.request({ capacity: 4194304 }), false);
  assert.equal(fixture.pendingPrepares.length, 1);
  fixture.pendingPrepares[0].resolve({ change: { capacity: 65536 } });
  assert.equal(await first, true);
  assert.equal(fixture.configuration.capacity, 65536);
});

test('the same capacity with a new neighbor radius or particle budget is a change', async () => {
  const fixture = createFixture();
  const request = fixture.swap.request({ capacity: 262144, particleCapacity: 32768 });
  assert.equal(fixture.pendingPrepares.length, 1);
  fixture.pendingPrepares[0].resolve({ change: { particleCapacity: 32768 } });
  assert.equal(await request, true);
  assert.equal(fixture.configuration.particleCapacity, 32768);
});

test('a rejected prepare installs nothing and rethrows; a later request runs normally', async () => {
  const fixture = createFixture();
  const request = fixture.swap.request({ capacity: 4194304 });
  fixture.pendingPrepares[0].reject(new Error('out of memory'));
  await assert.rejects(request, /out of memory/);
  assert.equal(fixture.swap.pending, false);
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.configuration.capacity, 262144);
  const retry = fixture.swap.request({ capacity: 1048576 });
  fixture.pendingPrepares[1].resolve({ change: { capacity: 1048576 } });
  assert.equal(await retry, true);
});

test('a throwing commit discards the prepared change, installs nothing and rethrows', async () => {
  const fixture = createFixture();
  fixture.commitError = new Error('device lost');
  const request = fixture.swap.request({ capacity: 65536 });
  const prepared = { change: { capacity: 65536 } };
  fixture.pendingPrepares[0].resolve(prepared);
  await assert.rejects(request, /device lost/);
  assert.deepEqual(fixture.events, [['commit', prepared], ['discard', prepared]]);
  assert.equal(fixture.swap.pending, false);
  assert.equal(fixture.configuration.capacity, 262144);
});

test('a prepare that never settles rejects with CapacitySwapTimeout after timeoutMilliseconds and clears pending', async () => {
  const fixture = createFixture();
  const request = fixture.swap.request({ capacity: 1048576 });
  fixture.milliseconds = 9999;
  fixture.swap.expire();
  assert.equal(fixture.swap.pending, true, 'not yet expired');
  fixture.milliseconds = 10100;
  fixture.swap.expire();
  assert.equal(fixture.swap.pending, false);
  await assert.rejects(request, (error) => error.name === 'CapacitySwapTimeout');
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.configuration.capacity, 262144);
  // A later request runs normally.
  const retry = fixture.swap.request({ capacity: 65536 });
  fixture.pendingPrepares[1].resolve({ change: { capacity: 65536 } });
  assert.equal(await retry, true);
  assert.equal(fixture.configuration.capacity, 65536);
});

test('a prepare resolving after the timeout is discarded once and never installed', async () => {
  const fixture = createFixture();
  const request = fixture.swap.request({ capacity: 1048576 });
  fixture.milliseconds = 10100;
  fixture.swap.expire();
  await assert.rejects(request, (error) => error.name === 'CapacitySwapTimeout');
  const late = { change: { capacity: 1048576 } };
  fixture.pendingPrepares[0].resolve(late);
  await new Promise((resolve) => setImmediate(resolve));
  fixture.swap.expire();
  const count = (name) => fixture.events.filter(([eventName]) => eventName === name).length;
  assert.equal(count('discard'), 1);
  assert.equal(count('commit'), 0);
  assert.equal(count('install'), 0);
  assert.equal(fixture.configuration.capacity, 262144);
  assert.equal(fixture.swap.pending, false);
});

test('a prepare rejecting after the timeout is ignored and does not disturb a newer request', async () => {
  const fixture = createFixture();
  const request = fixture.swap.request({ capacity: 1048576 });
  fixture.milliseconds = 10100;
  fixture.swap.expire();
  await assert.rejects(request, (error) => error.name === 'CapacitySwapTimeout');
  const newer = fixture.swap.request({ capacity: 65536 });
  fixture.pendingPrepares[0].reject(new Error('out of memory'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.swap.pending, true, 'the newer request is still in flight');
  fixture.pendingPrepares[1].resolve({ change: { capacity: 65536 } });
  assert.equal(await newer, true);
  assert.deepEqual(fixture.events.map(([name]) => name), ['commit', 'install']);
});

test('a rejected prepare still rethrows and clears pending', async () => {
  const fixture = createFixture();
  const request = fixture.swap.request({ capacity: 4194304 });
  assert.equal(fixture.swap.pending, true);
  fixture.pendingPrepares[0].reject(new Error('out of memory'));
  await assert.rejects(request, /out of memory/);
  assert.equal(fixture.swap.pending, false);
  fixture.milliseconds = 20000;
  fixture.swap.expire();
  assert.deepEqual(fixture.events, []);
});
