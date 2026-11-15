import test from 'node:test';
import assert from 'node:assert/strict';
import { ZOOM_FAR_VIEW_FACTOR, ZOOM_NEAR_RADIUS, ZOOM_SAMPLE_POINTS, sampleZoomPressure, smoothstep } from '../../src/game/zoom-pressure.js';

const BOUNDS = { minX: 0, minY: 0, maxX: 32, maxY: 18 };
const BASE = { focusX: 16, focusY: 9, viewWidth: 16, viewHeight: 9, bounds: BOUNDS, capacityScale: 1, crowdReference: 1 };

function distanceFromFocus(x, y) {
  return Math.hypot(x - BASE.focusX, y - BASE.focusY);
}

test('an empty map gives zero pressure', () => {
  assert.deepEqual(sampleZoomPressure({ ...BASE, densityAt: () => 0 }), { near: 0, far: 0 });
});

test('near ignores a crowd outside the near circle but far sees it', () => {
  const halfDiagonal = Math.hypot(BASE.viewWidth, BASE.viewHeight) / 2;
  const densityAt = (x, y) => (distanceFromFocus(x, y) > 5 ? 5 : 0);
  const pressure = sampleZoomPressure({ ...BASE, densityAt });
  assert.equal(pressure.near, 0);
  assert.ok(pressure.far > 0);
  assert.ok(ZOOM_FAR_VIEW_FACTOR * halfDiagonal > 5);
});

test('near sees a crowd at the focus', () => {
  const densityAt = (x, y) => (distanceFromFocus(x, y) <= ZOOM_NEAR_RADIUS + 1e-9 ? 5 : 0);
  const pressure = sampleZoomPressure({ ...BASE, densityAt });
  assert.ok(pressure.near > 0.9, `near ${pressure.near}`);
  assert.equal(pressure.far, 0);
});

test('pressure is preset invariant', () => {
  const field = (x, y) => 0.6 + 0.1 * Math.sin(x + y);
  const full = sampleZoomPressure({ ...BASE, densityAt: field });
  const quarter = sampleZoomPressure({ ...BASE, capacityScale: 0.25, densityAt: (x, y) => field(x, y) * 0.25 });
  assert.ok(Math.abs(full.near - quarter.near) < 1e-9);
  assert.ok(Math.abs(full.far - quarter.far) < 1e-9);
  assert.ok(full.near > 0 && full.near < 1);
});

test('crowdReference scales the response', () => {
  const densityAt = () => 0.7;
  const single = sampleZoomPressure({ ...BASE, densityAt });
  const doubled = sampleZoomPressure({ ...BASE, crowdReference: 2, densityAt });
  assert.ok(doubled.near < single.near);
});

test('far points outside the world are skipped, and an all-outside ring gives far 0', () => {
  let calls = 0;
  const corner = { ...BASE, focusX: 0, focusY: 0, viewWidth: 4, viewHeight: 2.25 };
  sampleZoomPressure({ ...corner, densityAt: () => { calls += 1; return 1; } });
  const nearCalls = ZOOM_SAMPLE_POINTS + 1;
  assert.ok(calls - nearCalls < ZOOM_SAMPLE_POINTS, `far calls ${calls - nearCalls}`);
  const huge = sampleZoomPressure({ ...corner, viewWidth: 400, viewHeight: 225, densityAt: () => 1 });
  assert.equal(huge.far, 0);
  assert.ok(Number.isFinite(huge.near));
});

test('a non-positive normalizer is rejected', () => {
  assert.throws(() => sampleZoomPressure({ ...BASE, capacityScale: 0, densityAt: () => 0 }), RangeError);
  assert.throws(() => sampleZoomPressure({ ...BASE, crowdReference: 0, densityAt: () => 0 }), RangeError);
});

test('smoothstep edges', () => {
  assert.equal(smoothstep(0.25, 1, 0.25), 0);
  assert.equal(smoothstep(0.25, 1, 1), 1);
  assert.equal(smoothstep(0.25, 1, -3), 0);
  assert.equal(smoothstep(0.25, 1, 9), 1);
  assert.ok(Math.abs(smoothstep(0.25, 1, 0.625) - 0.5) < 1e-12);
});
