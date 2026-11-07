import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPACITY_OPTIONS, DEFAULT_CAPACITY, FramesPerSecond, RENDER_SLIDERS, SPECIES_SLIDERS, capacityFromSearch, describeStats } from '../../src/ui/panelModel.js';
import { SPECIES_FIELDS, defaultSpecies } from '../../src/sim/species.js';
import { DEFAULT_RENDER_SETTINGS } from '../../src/render/renderer.js';

test('capacityFromSearch accepts exactly the panel choices', () => {
  for (const capacity of CAPACITY_OPTIONS) {
    assert.equal(capacityFromSearch('?capacity=' + capacity), capacity);
  }
  for (const search of ['', '?capacity=1000', '?capacity=abc', '?capacity=', '?other=65536']) {
    assert.equal(capacityFromSearch(search), DEFAULT_CAPACITY);
  }
});

test('FramesPerSecond averages injected timestamps over its window', () => {
  const meter = new FramesPerSecond(4);
  assert.equal(meter.value, 0);
  [0, 10, 20, 30].forEach((timestamp) => meter.record(timestamp));
  assert.equal(Math.round(meter.value), 100);
  // The window slides: only the last four timestamps count, now 20 ms apart.
  [50, 70, 90].forEach((timestamp) => meter.record(timestamp));
  assert.equal(Math.round(meter.value), 50);
  meter.reset();
  assert.equal(meter.value, 0);
});

test('describeStats formats counts and handles missing stats', () => {
  const text = describeStats({ aliveTotal: 1500, alivePerSpecies: Uint32Array.from([1, 2, 3, 4, 1490]) }, 59.96);
  assert.match(text, /frames per second: 60\.0/);
  assert.match(text, /alive: 1,500/);
  assert.match(text, /Predator: 1,490/);
  assert.match(describeStats(null, 0), /waiting for stats/);
});

test('slider specs name real species fields and render settings, defaults inside range', () => {
  const rows = defaultSpecies();
  for (const spec of SPECIES_SLIDERS) {
    assert.ok(SPECIES_FIELDS.includes(spec.key), spec.key);
    for (const row of rows) {
      assert.ok(row[spec.key] >= spec.minimum && row[spec.key] <= spec.maximum, spec.key + ' ' + row.name);
    }
  }
  for (const spec of RENDER_SLIDERS) {
    const value = DEFAULT_RENDER_SETTINGS[spec.key];
    assert.ok(value >= spec.minimum && value <= spec.maximum, spec.key);
  }
});
