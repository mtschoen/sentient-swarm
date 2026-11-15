import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BEAM_SHARD_POINTER_INSET_CSS_PIXELS, BEAM_SHARD_POINTER_LAYER_Z_INDEX, BEAM_SHARD_POINTER_SLOTS, beamShardTargets, createBeamShardPointers,
} from '../../src/ui/beam-shard-pointer.js';

const VIEW = { minX: 10, minY: 5, maxX: 26, maxY: 14, width: 16, height: 9 };
const RECT = { x: 0, y: 0, width: 1600, height: 900 };

function fakeDocument() {
  const element = () => ({ style: {}, className: '', children: [], append(...items) { this.children.push(...items); } });
  return { createElement: element };
}

test('beamShardTargets returns only shards, in order, capped at the slot count', () => {
  const pickups = [{ x: 1, y: 2, type: 'beamshard' }, { x: 3, y: 4, type: 'scatter' }, { x: 5, y: 6, type: 'beamshard' }];
  assert.deepEqual(beamShardTargets(pickups), [{ x: 1, y: 2 }, { x: 5, y: 6 }]);
  const many = Array.from({ length: 20 }, (unused, index) => ({ x: index, y: 0, type: 'beamshard' }));
  assert.equal(beamShardTargets(many).length, BEAM_SHARD_POINTER_SLOTS);
  assert.equal(BEAM_SHARD_POINTER_SLOTS, 8);
});

test('eight slots persist; an off-screen shard shows, an on-screen one and unused slots stay at opacity 0', () => {
  const parent = { children: [], append(item) { this.children.push(item); } };
  const pointers = createBeamShardPointers(parent, { documentObject: fakeDocument() });
  assert.equal(parent.children.length, 1);
  const slots = pointers.element.children;
  assert.equal(slots.length, 8);
  assert.ok(slots.every((slot) => slot.children[0].className === 'beam-shard-pointer-chevron'));
  pointers.update([{ x: 30, y: 9.5 }, { x: 18, y: 9.5 }], VIEW, RECT);
  assert.equal(slots[0].style.opacity, '1');
  assert.match(slots[0].style.transform, /rotate\(/);
  assert.equal(slots[1].style.opacity, '0');
  assert.ok(slots.slice(2).every((slot) => slot.style.opacity === '0'));
  pointers.update([], VIEW, RECT);
  assert.equal(slots[0].style.opacity, '0');
  assert.equal(pointers.element.children.length, 8);
});

test('the pointer sits at the 64 pixel inset for a target straight right', () => {
  assert.equal(BEAM_SHARD_POINTER_INSET_CSS_PIXELS, 64);
  const pointers = createBeamShardPointers({ append() {} }, { documentObject: fakeDocument() });
  pointers.update([{ x: 30, y: 9.5 }], VIEW, RECT);
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(pointers.element.children[0].style.transform);
  const half = pointers.chevronSizeCssPixels / 2;
  assert.equal(Number(match[1]) + half, 1600 - 64);
  assert.equal(Number(match[2]) + half, 450);
});

const css = readFileSync(new URL('../../src/ui/beam-shard-pointer.css', import.meta.url), 'utf8');

test('the stylesheet throbs with compositor properties only and has the reduced motion overrides', () => {
  const keyframes = /@keyframes beam-shard-throb\s*\{([\s\S]*?\})\s*\}/.exec(css);
  assert.ok(keyframes, 'keyframes present');
  const body = keyframes[1];
  const properties = [...body.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1]);
  assert.ok(properties.length > 0);
  assert.ok(properties.every((property) => property === 'opacity' || property === 'transform'), properties.join());
  assert.ok(!/box-shadow|width|top|left/.test(body));
  assert.ok(!css.includes('box-shadow'));
  assert.match(css, /html\[data-reduced-motion\] \.beam-shard-pointer-chevron\s*\{\s*animation: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*animation: none/);
});

test('the layer is level with the edge indicators, under the HUD, and a shard straight above clears the pause button', () => {
  assert.equal(BEAM_SHARD_POINTER_LAYER_Z_INDEX, '4');
  const pointers = createBeamShardPointers({ append() {} }, { documentObject: fakeDocument() });
  assert.equal(pointers.element.style.zIndex, '4');
  const hudCss = readFileSync(new URL('../../src/ui/hud.css', import.meta.url), 'utf8');
  assert.match(hudCss, /#hud \{[^}]*z-index: 5/);
  pointers.update([{ x: 18, y: 0 }], VIEW, RECT);
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(pointers.element.children[0].style.transform);
  const half = pointers.chevronSizeCssPixels / 2;
  const PAUSE_BUTTON_BOTTOM_CSS_PIXELS = 38;
  const THROB_SCALE = 1.25;
  assert.ok(Number(match[2]) + half - half * THROB_SCALE > PAUSE_BUTTON_BOTTOM_CSS_PIXELS);
});
