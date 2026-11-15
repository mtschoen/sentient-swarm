import test from 'node:test';
import assert from 'node:assert/strict';
import { createHiveReadout, hiveReadoutView } from '../../src/ui/hud-hives.js';
import { SEAT_COLORS } from '../../src/game/seat-colors.js';

const neutral = { owner: null, capturer: null, progress: 0 };

test('hiveReadoutView hides outside hives and colors each pip by owner, then by capture progress', () => {
  assert.equal(hiveReadoutView(null).shown, false);
  const view = hiveReadoutView({ hives: [{ owner: 0, capturer: null, progress: 0 }, { owner: null, capturer: 1, progress: 0.4 }, neutral], holder: null, holdRemainingSeconds: null });
  assert.equal(view.shown, true);
  assert.deepEqual(view.pips[0], { border: SEAT_COLORS[0].css, background: SEAT_COLORS[0].css });
  assert.equal(view.pips[1].background, `conic-gradient(${SEAT_COLORS[1].css} 40%, transparent 0)`);
  assert.equal(view.pips[2].background, 'transparent');
  assert.equal(view.countdown.visible, false);
});

test('the countdown names the holder in its color and rounds the seconds up', () => {
  const view = hiveReadoutView({ hives: [{ owner: 1 }, { owner: 1 }, { owner: 1 }].map((hive) => ({ ...neutral, ...hive })), holder: 1, holdRemainingSeconds: 11.2 });
  assert.deepEqual(view.countdown, { text: 'P2 WINS IN 12', color: SEAT_COLORS[1].css, visible: true });
});

function fakeMake(tagName, className, textContent = '') {
  return {
    tagName, className, textContent, hidden: false, style: {}, children: [], attributes: {},
    append(...nodes) { this.children.push(...nodes); },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}

test('the readout is laid out for a hives run only and its countdown line stays reserved', () => {
  const readout = createHiveReadout(fakeMake);
  const [pipRow, countdown] = readout.element.children;
  assert.equal(readout.element.hidden, true);
  assert.equal(pipRow.children.length, 3);
  readout.update({ hives: [neutral, neutral, neutral], holder: null, holdRemainingSeconds: null });
  assert.equal(readout.element.hidden, false);
  assert.equal(countdown.style.visibility, 'hidden');
  assert.ok(countdown.textContent.length > 0, 'the hidden countdown keeps a text so its line is laid out');
  readout.update({ hives: [{ ...neutral, owner: 0 }, { ...neutral, owner: 0 }, { ...neutral, owner: 0 }], holder: 0, holdRemainingSeconds: 20 });
  assert.equal(countdown.style.visibility, 'visible');
  assert.equal(countdown.textContent, 'P1 WINS IN 20');
  assert.equal(pipRow.children[0].style.background, SEAT_COLORS[0].css);
  readout.update(null);
  assert.equal(readout.element.hidden, true);
});

test('every hive row gets an edge indicator in its owner color; plain gates only when telegraphed', async () => {
  const { edgeIndicatorTargets } = await import('../../src/ui/edgeIndicators.js');
  const targets = edgeIndicatorTargets([], [
    { x: 1, y: 2, telegraph: 0, hive: { owner: 1, capturer: null, progress: 0 } },
    { x: 3, y: 4, telegraph: 0, hive: { owner: null, capturer: null, progress: 0 } },
    { x: 5, y: 6, telegraph: 0 },
  ]);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].color, SEAT_COLORS[1].css);
  assert.deepEqual([targets[1].x, targets[1].y], [3, 4]);
});
