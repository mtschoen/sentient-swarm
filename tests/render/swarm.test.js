import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packSwarmView, SWARM_VIEW_BYTES } from '../../src/render/swarm.js';
import { WORLD_VIEW_FLOATS } from '../../src/render/world-view.js';
import { SWARM_SHIP_SIZE } from '../../src/game/player-swarm.js';
import { Viewport } from '../../src/render/viewport.js';
import { WEAPON_HUES } from '../../src/game/weaponTypes.js';

function viewportAtZoom(zoom) {
  const viewport = new Viewport();
  viewport.setCanvasSize(1280, 720);
  viewport.setCamera({ centerX: 16, centerY: 9, zoom });
  return viewport;
}

const SHIPS = [{ x: 1, y: 2, age: 3, heading: 4 }];

function pack(viewport, extra = {}, floats) {
  return packSwarmView({ viewport, time: 0, ships: SHIPS, facing: 0, pointX: 0, pointY: 0, pointShown: false, armed: 'base', ...extra }, floats);
}

test('packSwarmView writes a white body by default at float 16 and ships from float 20', () => {
  assert.equal(WORLD_VIEW_FLOATS + 8, 16);
  const { floats } = pack(viewportAtZoom(1));
  assert.deepEqual(Array.from(floats.slice(16, 19)), [1, 1, 1]);
  assert.deepEqual(Array.from(floats.slice(20, 24)), [1, 2, 3, 4]);
  assert.equal(SWARM_VIEW_BYTES, 80 + 256 * 16 + 256 * 4);
  assert.equal(SWARM_VIEW_BYTES, floats.byteLength);
  const green = pack(viewportAtZoom(1), { bodyColor: [0.45, 1, 0.55] }).floats;
  assert.deepEqual(Array.from(green.slice(16, 19)), [Math.fround(0.45), 1, Math.fround(0.55)]);
});

test('the drawn ship size is SWARM_SHIP_SIZE at camera zoom 1 and times sqrt(2) at 0.5', () => {
  const sizeIndex = WORLD_VIEW_FLOATS + 6;
  assert.equal(pack(viewportAtZoom(1)).floats[sizeIndex], Math.fround(SWARM_SHIP_SIZE));
  assert.ok(Math.abs(pack(viewportAtZoom(0.5)).floats[sizeIndex] - SWARM_SHIP_SIZE * Math.SQRT2) < 1e-5);
});

const MARKS_FIRST = WORLD_VIEW_FLOATS + 12 + 256 * 4;

function shipAt(gunnerIndex) {
  const ship = { x: 1, y: 2, age: 3, heading: 4 };
  if (gunnerIndex !== undefined) {
    ship.gunnerIndex = gunnerIndex;
  }
  return ship;
}

test('packSwarmView marks gunner ships', () => {
  const { floats } = pack(viewportAtZoom(1), { ships: [shipAt(-1), shipAt(3), shipAt(0), shipAt(undefined)] });
  assert.deepEqual(Array.from(floats.slice(MARKS_FIRST, MARKS_FIRST + 4)), [0, 1, 1, 0]);
});

test('packSwarmView marks are rewritten each call', () => {
  const viewport = viewportAtZoom(1);
  const first = pack(viewport, { ships: [shipAt(-1), shipAt(3), shipAt(0)] });
  assert.equal(first.floats[MARKS_FIRST + 1], 1);
  const second = pack(viewport, { ships: [shipAt(-1), shipAt(-1), shipAt(-1)] }, first.floats);
  assert.deepEqual(Array.from(second.floats.slice(MARKS_FIRST, MARKS_FIRST + 3)), [0, 0, 0]);
  const third = pack(viewport, { ships: [shipAt(-1), shipAt(2)] }, first.floats);
  assert.deepEqual(Array.from(third.floats.slice(MARKS_FIRST, MARKS_FIRST + 3)), [0, 1, 0]);
});

test('packSwarmView carries the rail hue', () => {
  const { floats } = pack(viewportAtZoom(1));
  assert.equal(floats[WORLD_VIEW_FLOATS + 7], Math.fround(WEAPON_HUES.rail));
});

test('swarm.wgsl pins the gunner ring at 0.17 inside a 0.22 gunner quad, and other ships keep the 0.16 quad', () => {
  const source = readFileSync(new URL('../../src/render/shaders/swarm.wgsl', import.meta.url), 'utf8');
  assert.match(source, /const GUNNER_RING_RADIUS: f32 = 0\.17;/);
  assert.match(source, /const GUNNER_HALF_EXTENT: f32 = 0\.22;/);
  assert.match(source, /const SHIP_HALF_EXTENT: f32 = 0\.16;/);
  assert.match(source, /select\(SHIP_HALF_EXTENT, GUNNER_HALF_EXTENT, gunnerMark > 0\.5\)/);
});
