import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EDGE_INDICATOR_INSET_CSS_PIXELS, EDGE_INDICATOR_SLOTS, createEdgeIndicators, edgeIndicatorPlacement, edgeIndicatorTargets,
} from '../../src/ui/edgeIndicators.js';

const VIEW = { minX: 10, minY: 5, maxX: 26, maxY: 14, width: 16, height: 9 };
const RECT = { x: 0, y: 0, width: 1600, height: 900 };
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

test('a target inside the view is hidden', () => {
  assert.equal(edgeIndicatorPlacement({ x: 18, y: 9.5 }, VIEW, RECT).visible, false);
  assert.equal(edgeIndicatorPlacement({ x: 10, y: 14 }, VIEW, RECT).visible, false);
});

test('a target straight right sits on the right edge, inset, pointing right', () => {
  const placement = edgeIndicatorPlacement({ x: 30, y: 9.5 }, VIEW, RECT);
  assert.equal(placement.visible, true);
  near(placement.left, 1600 - EDGE_INDICATOR_INSET_CSS_PIXELS, 'left');
  near(placement.top, 450, 'top');
  near(placement.angle, 0, 'angle');
});

test('a target above and to the left points along the ray from the center and stays inside the inset rectangle', () => {
  // 8 units left and 9 up of the view center (18, 9.5): 800 and 900 CSS pixels.
  const placement = edgeIndicatorPlacement({ x: 10, y: 0.5 }, VIEW, RECT);
  assert.equal(placement.visible, true);
  near(placement.angle, Math.atan2(-900, -800), 'angle');
  // The vertical limit binds first: 426 of 900 pixels up, so 426 * 800 / 900 left.
  near(placement.top, 450 - 426, 'top');
  near(placement.left, 800 - (426 * 800) / 900, 'left');
  const down = edgeIndicatorPlacement({ x: 18, y: 40 }, VIEW, RECT);
  near(down.angle, Math.PI / 2, 'straight down');
  near(down.left, 800, 'centered');
});

test('the rect offset and size map the view, as on a letterboxed canvas', () => {
  const rect = { x: 100, y: 0, width: 800, height: 450 };
  const placement = edgeIndicatorPlacement({ x: 30, y: 9.5 }, VIEW, rect);
  near(placement.left, 900 - EDGE_INDICATOR_INSET_CSS_PIXELS, 'left');
  near(placement.top, 225, 'top');
});

test('targets are every pickup, then every telegraphed gate, at most one per slot', () => {
  const pickups = [{ x: 1, y: 2, type: 'beam' }, { x: 3, y: 4, type: 'timewarp' }];
  const gates = [{ x: 5, y: 6, telegraph: 0 }, { x: 7, y: 8, telegraph: 0.4 }];
  const targets = edgeIndicatorTargets(pickups, gates);
  assert.deepEqual(targets.map(({ x, y }) => [x, y]), [[1, 2], [3, 4], [7, 8]]);
  assert.ok(targets.every((target) => target.color.startsWith('hsl(')));
  const many = Array.from({ length: 20 }, (unused, index) => ({ x: index, y: 0, type: 'rail' }));
  assert.equal(edgeIndicatorTargets(many, gates).length, EDGE_INDICATOR_SLOTS);
});

function fakeDocument() {
  const element = () => ({ style: {}, children: [], append(...items) { this.children.push(...items); } });
  return { createElement: element };
}

test('the slots persist and fade: an off-screen target shows its slot, the rest stay at opacity 0', () => {
  const parent = { children: [], append(item) { this.children.push(item); } };
  const indicators = createEdgeIndicators(parent, { documentObject: fakeDocument() });
  assert.equal(parent.children.length, 1);
  const slots = indicators.element.children;
  assert.equal(slots.length, EDGE_INDICATOR_SLOTS);
  indicators.update([{ x: 30, y: 9.5, color: 'red' }, { x: 18, y: 9.5, color: 'blue' }], VIEW, RECT);
  assert.equal(slots[0].style.opacity, '0.9');
  assert.equal(slots[0].style.borderLeftColor, 'red');
  assert.match(slots[0].style.transform, /rotate\(0rad\)/);
  assert.equal(slots[1].style.opacity, '0');
  assert.ok(slots.slice(2).every((slot) => slot.style.opacity === '0'));
  indicators.update([], VIEW, RECT);
  assert.equal(slots[0].style.opacity, '0');
  assert.equal(indicators.element.children.length, EDGE_INDICATOR_SLOTS);
});
