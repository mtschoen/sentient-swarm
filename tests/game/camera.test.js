import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_DEAD_ZONE_FRACTION, CAMERA_OVERSHOOT_FRACTION, CAMERA_SMOOTH_SECONDS, Camera, criticallyDampedStep } from '../../src/game/camera.js';

const STEP = 1 / 60;
const BOUNDS = { minX: 0, minY: 0, maxX: 32, maxY: 18 };
const VIEW = { viewWidth: 16, viewHeight: 9, bounds: BOUNDS };

function run(camera, seconds, focusX, focusY, step = STEP, onStep = () => {}) {
  const steps = Math.round(seconds / step);
  for (let index = 0; index < steps; index += 1) {
    camera.update(step, { focusX, focusY, ...VIEW });
    onStep(camera);
  }
}

test('the defaults are the 0.30 s smooth time and the 10 percent dead zone', () => {
  assert.equal(CAMERA_SMOOTH_SECONDS, 0.3);
  assert.equal(CAMERA_DEAD_ZONE_FRACTION, 0.1);
});

test('a step change converges in the smooth time without overshoot', () => {
  const camera = new Camera({ centerX: 10, centerY: 9 });
  // The target is the focus less the dead zone: 20 - 1.6 = 18.4 on x.
  const target = 20 - CAMERA_DEAD_ZONE_FRACTION * 16;
  let previous = camera.centerX;
  const fractionAt = (camera) => (camera.centerX - 10) / (target - 10);
  run(camera, CAMERA_SMOOTH_SECONDS, 20, 9, STEP, (stepped) => {
    assert.ok(stepped.centerX >= previous - 1e-12, 'moves one way only');
    assert.ok(stepped.centerX <= target + 1e-9, 'never past the target');
    previous = stepped.centerX;
  });
  // Critically damped from rest: 1 - (1 + 2) e^-2 of the way after one smooth time.
  assert.ok(Math.abs(fractionAt(camera) - (1 - 3 * Math.exp(-2))) < 1e-6, `fraction ${fractionAt(camera)}`);
  run(camera, 2 * CAMERA_SMOOTH_SECONDS, 20, 9, STEP, (stepped) => {
    assert.ok(stepped.centerX <= target + 1e-9, 'never past the target');
  });
  assert.ok(fractionAt(camera) > 0.98, `fraction ${fractionAt(camera)}`);
  assert.equal(camera.centerY, 9);
});

test('the closed form is frame-rate independent', () => {
  const sixty = new Camera({ centerX: 10, centerY: 9 });
  const thirty = new Camera({ centerX: 10, centerY: 9 });
  // The focus stays outside the dead zone of both cameras, so both chase the same moving target
  // only while it is constant: use one far focus.
  run(sixty, 0.5, 25, 9, 1 / 60);
  run(thirty, 0.5, 25, 9, 1 / 30);
  assert.ok(Math.abs(sixty.centerX - thirty.centerX) < 1e-9, `${sixty.centerX} vs ${thirty.centerX}`);
  const [value, velocity] = criticallyDampedStep(0, 0, 1, 2 / 0.3, 0);
  assert.deepEqual([value, velocity], [0, 0]);
});

test('a focus inside the dead zone does not move the camera', () => {
  const camera = new Camera({ centerX: 16, centerY: 9 });
  run(camera, 1, 16 + 0.1 * 16 - 0.01, 9 - 0.1 * 9 + 0.01);
  assert.equal(camera.centerX, 16);
  assert.equal(camera.centerY, 9);
  assert.equal(camera.velocityX, 0);
});

// The center that puts the world's edge OVERSHOOT_FRACTION of the view in from the screen edge.
const LEFT_LIMIT = 8 - CAMERA_OVERSHOOT_FRACTION * 16;
const BOTTOM_LIMIT = 18 - 4.5 + CAMERA_OVERSHOOT_FRACTION * 9;

test('the overshoot is 12 percent of the view by default', () => {
  assert.equal(CAMERA_OVERSHOOT_FRACTION, 0.12);
});

test('the view overshoots the world edge by the overshoot fraction and no further', () => {
  const camera = new Camera({ centerX: 16, centerY: 9 });
  run(camera, 3, -5, 40, STEP, (stepped) => {
    assert.ok(stepped.centerX >= LEFT_LIMIT - 1e-9, `x ${stepped.centerX}`);
    assert.ok(stepped.centerY <= BOTTOM_LIMIT + 1e-9, `y ${stepped.centerY}`);
  });
  assert.ok(Math.abs(camera.centerX - LEFT_LIMIT) < 1e-3);
  assert.ok(Math.abs(camera.centerY - BOTTOM_LIMIT) < 1e-3);
  // The world edge then sits 12 percent of the view in from the screen edge: the left edge of the
  // view is 1.92 units past x = 0.
  assert.ok(Math.abs((camera.centerX - 8) - -CAMERA_OVERSHOOT_FRACTION * 16) < 1e-3);
});

test('the camera eases into the overshoot limit with no pop: speed falls to zero smoothly', () => {
  const camera = new Camera({ centerX: 16, centerY: 9 });
  let previousSpeed = Infinity;
  let reversed = false;
  run(camera, 4, -50, 9, STEP, (stepped) => {
    const speed = Math.abs(stepped.velocityX);
    if (stepped.centerX > LEFT_LIMIT + 1e-6 && stepped.centerX < 12) {
      if (speed > previousSpeed + 1) reversed = true;
      previousSpeed = speed;
    }
  });
  assert.equal(reversed, false);
  assert.ok(Math.abs(camera.velocityX) < 1e-2);
});

test('a focus at the world center leaves the camera there (the overshoot only widens the limit)', () => {
  const camera = new Camera({ centerX: 16, centerY: 9 });
  run(camera, 1, 16, 9);
  assert.equal(camera.centerX, 16);
  assert.equal(camera.centerY, 9);
});

test('a view larger than the world on an axis centers on the world on that axis', () => {
  const camera = new Camera({ centerX: 3, centerY: 3 });
  camera.update(STEP, { focusX: 1, focusY: 1, viewWidth: 40, viewHeight: 9, bounds: BOUNDS });
  assert.equal(camera.centerX, 16);
});

test('cut jumps to the clamped focus with no velocity and no easing', () => {
  const camera = new Camera({ centerX: 16, centerY: 9 });
  run(camera, 0.1, 30, 9);
  assert.ok(camera.velocityX > 0);
  camera.cut(1, 17, VIEW);
  assert.deepEqual([camera.centerX, camera.centerY, camera.velocityX, camera.velocityY], [LEFT_LIMIT, BOTTOM_LIMIT, 0, 0]);
  assert.deepEqual(camera.sample(1), { centerX: LEFT_LIMIT, centerY: BOTTOM_LIMIT, zoom: 1 });
});

test('sample extrapolates by alpha of the last step along the velocity, clamped to the overshoot limit', () => {
  const camera = new Camera({ centerX: 16, centerY: 9 });
  run(camera, 0.1, 30, 9);
  const { centerX: atStep } = camera.sample(0);
  const { centerX: ahead } = camera.sample(0.5);
  assert.equal(atStep, camera.centerX);
  assert.ok(Math.abs(ahead - (camera.centerX + camera.velocityX * 0.5 * STEP)) < 1e-12);
  const edge = new Camera({ centerX: LEFT_LIMIT + 0.001, centerY: 9 });
  edge.velocityX = -100;
  edge.lastDeltaSeconds = STEP;
  edge.lastView = VIEW;
  assert.equal(edge.sample(1).centerX, LEFT_LIMIT);
  assert.deepEqual(new Camera({ centerX: 2, centerY: 3 }).sample(1), { centerX: 2, centerY: 3, zoom: 1 });
});

test('invalid smooth times and dead zones throw RangeError', () => {
  assert.throws(() => new Camera({ smoothSeconds: 0 }), RangeError);
  assert.throws(() => new Camera({ deadZoneFraction: 0.5 }), RangeError);
  assert.throws(() => new Camera({ deadZoneFraction: -0.1 }), RangeError);
});
