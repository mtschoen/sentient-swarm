import test from 'node:test';
import assert from 'node:assert/strict';
import { GATE_VIEW_BYTES, packGateView } from '../../src/render/gates.js';
import { MAXIMUM_SPAWN_GATES } from '../../src/sim/spawn-director.js';
import { Viewport } from '../../src/render/viewport.js';
import { WORLD_VIEW_FLOATS, packWorldView } from '../../src/render/world-view.js';

// gates.wgsl: the GateView uniform is the 8-float world header (32 bytes) followed by
// array<vec4f, 8>, two vec4f per gate: (x, y, radius, open) then (hue, emit, telegraph, index).
const WGSL_UNIFORM_BYTES = 160;
const WGSL_VEC4_COUNT = 8;
const VEC4_PER_GATE = 2;
const FLOATS_PER_GATE = 8;

function createViewport() {
  const viewport = new Viewport();
  viewport.setCanvasSize(1280, 720);
  return viewport;
}

const species = [{ hue: 0.1 }, { hue: 0.3 }, { hue: 0.5 }, { hue: 0.7 }, { hue: 0.9 }];

test('the gate view uniform is the size gates.wgsl declares', () => {
  assert.equal(MAXIMUM_SPAWN_GATES * VEC4_PER_GATE, WGSL_VEC4_COUNT);
  assert.equal(GATE_VIEW_BYTES, WGSL_UNIFORM_BYTES);
});

test('packGateView writes the world header then two vec4f per gate in the documented order', () => {
  const viewport = createViewport();
  const gates = [
    { x: 1, y: 2, radius: 0.5, species: 2, open: 0.25, emit: 0.75, telegraph: 0.125 },
    { x: -3, y: 4, radius: 0.75, species: 4, open: 1, emit: 0, telegraph: 1 },
  ];
  const { floats, count } = packGateView({ viewport, time: 3.5, spawnGates: { gates }, species });
  assert.equal(count, 2);
  assert.equal(floats.length * Float32Array.BYTES_PER_ELEMENT, WGSL_UNIFORM_BYTES);
  assert.deepEqual(Array.from(floats.subarray(0, WORLD_VIEW_FLOATS)), Array.from(packWorldView(viewport, 3.5)));
  assert.deepEqual(Array.from(floats.subarray(WORLD_VIEW_FLOATS, WORLD_VIEW_FLOATS + FLOATS_PER_GATE)),
    [1, 2, 0.5, 0.25, Math.fround(0.5), 0.75, 0.125, 0]);
  const second = WORLD_VIEW_FLOATS + FLOATS_PER_GATE;
  assert.deepEqual(Array.from(floats.subarray(second, second + FLOATS_PER_GATE)),
    [-3, 4, 0.75, 1, Math.fround(0.9), 0, 1, 1]);
});

test('packGateView reports zero gates for null and clamps to the maximum', () => {
  const viewport = createViewport();
  assert.equal(packGateView({ viewport, time: 0, spawnGates: null, species }).count, 0);
  const many = Array.from({ length: MAXIMUM_SPAWN_GATES + 3 }, (_, index) => ({ x: index, y: 0, radius: 1, species: 0, open: 1, emit: 0, telegraph: 0 }));
  const { floats, count } = packGateView({ viewport, time: 0, spawnGates: { gates: many }, species });
  assert.equal(count, MAXIMUM_SPAWN_GATES);
  assert.equal(floats.length, WORLD_VIEW_FLOATS + MAXIMUM_SPAWN_GATES * FLOATS_PER_GATE);
});

test('packGateView uses hue 0 for an unknown species and fills a supplied array in place', () => {
  const viewport = createViewport();
  const target = new Float32Array(GATE_VIEW_BYTES / Float32Array.BYTES_PER_ELEMENT);
  const gate = { x: 0, y: 0, radius: 1, species: 99, open: 1, emit: 0, telegraph: 0 };
  const result = packGateView({ viewport, time: 0, spawnGates: { gates: [gate] }, species }, target);
  assert.equal(result.floats, target);
  assert.equal(target[WORLD_VIEW_FLOATS + 4], 0);
});
