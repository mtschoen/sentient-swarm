import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAR_CLOSE_HALF_DIAGONALS, RING_INNER_HALF_DIAGONALS, RING_OUTER_HALF_DIAGONALS, SpawnDirector,
} from '../../src/sim/spawn-director.js';
import { WORLD_BOUNDS, WORLD_HEIGHT, WORLD_WIDTH } from '../../src/sim/layout.js';

// Gates open in a ring just outside the camera's view and inside the world (the follow-camera step).

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const VIEW_SIZE = { width: 16, height: 9 };
const HALF_DIAGONAL = Math.hypot(16, 9) / 2;
const insideView = (point, view) => Math.abs(point.x - view.centerX) < view.width / 2 && Math.abs(point.y - view.centerY) < view.height / 2;
const insideWorld = (point, inset) => point.x >= inset && point.x <= WORLD_WIDTH - inset && point.y >= inset && point.y <= WORLD_HEIGHT - inset;

function contextAt(centerX, centerY, overrides = {}) {
  const view = { centerX, centerY, ...VIEW_SIZE };
  return { playerX: centerX, playerY: centerY, safeDistance: 4, shares: [], aimX: 0, aimY: 0, bounds: WORLD_BOUNDS, view, ...overrides };
}

test('the ring spans 1 to 1.4 view half-diagonals and far gates close past 2', () => {
  assert.equal(RING_INNER_HALF_DIAGONALS, 1);
  assert.equal(RING_OUTER_HALF_DIAGONALS, 1.4);
  assert.equal(FAR_CLOSE_HALF_DIAGONALS, 2);
});

test('gates placed for a view at the center, at an edge and in a corner lie outside the view and inside the world', () => {
  const inset = 0.15 + 0.8;
  for (const [centerX, centerY] of [[16, 9], [8, 9], [24, 13.5], [8, 4.5], [24, 4.5]]) {
    const director = new SpawnDirector({ random: seededRandom(centerX * 31 + centerY) });
    const context = contextAt(centerX, centerY);
    for (let draw = 0; draw < 200; draw += 1) {
      const point = director.placeGate(context);
      const distance = Math.hypot(point.x - centerX, point.y - centerY);
      assert.ok(!insideView(point, context.view), `(${point.x}, ${point.y}) inside the view at (${centerX}, ${centerY})`);
      assert.ok(insideWorld(point, inset - 1e-9), `(${point.x}, ${point.y}) outside the world`);
      assert.ok(distance >= RING_INNER_HALF_DIAGONALS * HALF_DIAGONAL - 1e-9 && distance <= RING_OUTER_HALF_DIAGONALS * HALF_DIAGONAL + 1e-9, `distance ${distance}`);
    }
  }
});

test('the initial gates of a run ring the view', () => {
  const director = new SpawnDirector({ random: seededRandom(7) });
  const context = contextAt(9, 6);
  director.update(1 / 60, context);
  assert.equal(director.gates.length, 3);
  for (const gate of director.gates) assert.ok(!insideView(gate, context.view) && insideWorld(gate, 0.95 - 1e-9));
});

test('with no ring point inside the world the gates place in the wall band and interior as without a view', () => {
  const director = new SpawnDirector({ random: seededRandom(3) });
  // A view as large as the world: the whole ring lies outside it.
  const context = contextAt(16, 9, { view: { centerX: 16, centerY: 9, width: 32, height: 18 } });
  for (let draw = 0; draw < 50; draw += 1) assert.ok(insideWorld(director.placeGate(context), 0.95 - 1e-9));
});

test('a gate left more than two view half-diagonals behind the view closes and a new one opens on the ring', () => {
  const director = new SpawnDirector({ random: seededRandom(11) });
  director.update(1 / 60, contextAt(8, 4.5));
  const first = [...director.gates];
  // The camera has moved to the far corner of the world.
  const far = contextAt(24, 13.5);
  director.update(1 / 60, far);
  for (const gate of first) {
    const distance = Math.hypot(gate.x - 24, gate.y - 13.5);
    if (distance > FAR_CLOSE_HALF_DIAGONALS * HALF_DIAGONAL) assert.equal(gate.closing, true, `gate at distance ${distance}`);
  }
  const opened = director.gates.filter((gate) => !gate.closing && !first.includes(gate));
  assert.ok(opened.length > 0, 'replacement gates opened');
  for (const gate of opened) assert.ok(!insideView(gate, far.view));
});
