import test from 'node:test';
import assert from 'node:assert/strict';
import { CapacitySwap } from '../../src/game/capacity-swap.js';

// A recreate whose promise the test settles by hand, and a log of every install.
function createFixture(initialCapacity = 262144) {
  const fixture = { capacity: initialCapacity, installed: [], pendingRecreates: [] };
  fixture.swap = new CapacitySwap({
    getCapacity: () => fixture.capacity,
    recreate: (capacity) => new Promise((resolve, reject) => fixture.pendingRecreates.push({ capacity, resolve, reject })),
    install: (simulation) => {
      fixture.installed.push(simulation);
      fixture.capacity = simulation.capacity;
    },
  });
  return fixture;
}

test('the simulation is paused from the request until the new simulation is installed', async () => {
  const fixture = createFixture();
  assert.equal(fixture.swap.simulationPaused, false);
  const request = fixture.swap.request(1048576);
  assert.equal(fixture.swap.simulationPaused, true);
  assert.equal(fixture.installed.length, 0);
  fixture.pendingRecreates[0].resolve({ capacity: 1048576 });
  assert.equal(await request, true);
  assert.equal(fixture.swap.simulationPaused, false);
  assert.deepEqual(fixture.installed, [{ capacity: 1048576 }]);
});

test('a request while one is pending, or for the current capacity, is ignored', async () => {
  const fixture = createFixture();
  assert.equal(await fixture.swap.request(262144), false);
  assert.equal(fixture.swap.simulationPaused, false);
  const first = fixture.swap.request(65536);
  assert.equal(await fixture.swap.request(4194304), false);
  assert.equal(fixture.pendingRecreates.length, 1);
  fixture.pendingRecreates[0].resolve({ capacity: 65536 });
  assert.equal(await first, true);
  assert.equal(fixture.capacity, 65536);
});

test('a rejected recreate clears the pause, installs nothing and rethrows', async () => {
  const fixture = createFixture();
  const request = fixture.swap.request(4194304);
  fixture.pendingRecreates[0].reject(new Error('out of memory'));
  await assert.rejects(request, /out of memory/);
  assert.equal(fixture.swap.simulationPaused, false);
  assert.deepEqual(fixture.installed, []);
  assert.equal(fixture.capacity, 262144);
  // A later request runs normally.
  const retry = fixture.swap.request(1048576);
  assert.equal(fixture.swap.simulationPaused, true);
  fixture.pendingRecreates[1].resolve({ capacity: 1048576 });
  assert.equal(await retry, true);
});
