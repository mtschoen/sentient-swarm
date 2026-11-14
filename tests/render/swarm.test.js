import test from 'node:test';
import assert from 'node:assert/strict';
import { packSwarmView, SWARM_VIEW_BYTES } from '../../src/render/swarm.js';
import { WORLD_VIEW_FLOATS } from '../../src/render/world-view.js';
import { SWARM_SHIP_SIZE } from '../../src/game/player-swarm.js';
import { Viewport } from '../../src/render/viewport.js';

function viewportAtZoom(zoom) {
  const viewport = new Viewport();
  viewport.setCanvasSize(1280, 720);
  viewport.setCamera({ centerX: 16, centerY: 9, zoom });
  return viewport;
}

const SHIPS = [{ x: 1, y: 2, age: 3, heading: 4 }];

function pack(viewport, extra = {}) {
  return packSwarmView({ viewport, time: 0, ships: SHIPS, facing: 0, pointX: 0, pointY: 0, pointShown: false, armed: 'base', ...extra });
}

test('packSwarmView writes a white body by default at float 16 and ships from float 20', () => {
  assert.equal(WORLD_VIEW_FLOATS + 8, 16);
  const { floats } = pack(viewportAtZoom(1));
  assert.deepEqual(Array.from(floats.slice(16, 19)), [1, 1, 1]);
  assert.deepEqual(Array.from(floats.slice(20, 24)), [1, 2, 3, 4]);
  assert.equal(SWARM_VIEW_BYTES, 80 + 256 * 16);
  assert.equal(SWARM_VIEW_BYTES, floats.byteLength);
  const green = pack(viewportAtZoom(1), { bodyColor: [0.45, 1, 0.55] }).floats;
  assert.deepEqual(Array.from(green.slice(16, 19)), [Math.fround(0.45), 1, Math.fround(0.55)]);
});

test('the drawn ship size is SWARM_SHIP_SIZE at camera zoom 1 and times sqrt(2) at 0.5', () => {
  const sizeIndex = WORLD_VIEW_FLOATS + 6;
  assert.equal(pack(viewportAtZoom(1)).floats[sizeIndex], Math.fround(SWARM_SHIP_SIZE));
  assert.ok(Math.abs(pack(viewportAtZoom(0.5)).floats[sizeIndex] - SWARM_SHIP_SIZE * Math.SQRT2) < 1e-5);
});
