import test from 'node:test';
import assert from 'node:assert/strict';
import { padStatusModel, createPadStatus, shortPadId, GAMEPAD_ID_MAXIMUM_LENGTH } from '../../src/ui/pad-status.js';
import { SEAT_COLORS } from '../../src/game/seat-colors.js';

function pad(index, { id = `Pad ${index}`, mapping = 'standard', pressed = [] } = {}) {
  const buttons = Array.from({ length: 17 }, (unused, button) => ({ pressed: pressed.includes(button) }));
  return { index, id, mapping, buttons, axes: [0, 0, 0, 0] };
}

function fakeDocument() {
  return {
    createElement: () => {
      const element = { hidden: false, className: '', style: {}, writes: 0 };
      let text = '';
      Object.defineProperty(element, 'textContent', {
        get: () => text,
        set: (value) => { text = value; element.writes += 1; },
      });
      return element;
    },
  };
}

test('no pads: both rows say none is detected, and P1 explains the first-press rule', () => {
  const model = padStatusModel({ pads: [] });
  assert.equal(
    model.one.text,
    'P1: NO CONTROLLER DETECTED. KEYBOARD AND MOUSE IN USE. A BROWSER LISTS A CONTROLLER ONLY AFTER A BUTTON IS PRESSED ON IT',
  );
  assert.equal(model.two.text, 'P2: NO SECOND CONTROLLER DETECTED');
  assert.equal(model.one.pressed, false);
  assert.deepEqual(padStatusModel({ pads: null }), model);
});

test('one standard pad shows its shortened id for P1 and no second controller', () => {
  const longId = 'x'.repeat(GAMEPAD_ID_MAXIMUM_LENGTH + 20);
  const model = padStatusModel({ pads: [pad(0, { id: longId })] });
  assert.equal(model.one.text, `P1: ${'x'.repeat(GAMEPAD_ID_MAXIMUM_LENGTH)}`);
  assert.equal(model.two.text, 'P2: NO SECOND CONTROLLER DETECTED');
  assert.equal(shortPadId(undefined), 'controller');
});

test('a non-standard pad carries the mapping warning', () => {
  const model = padStatusModel({ pads: [pad(0, { id: 'DualSense', mapping: '' })] });
  assert.match(model.one.text, /^P1: DualSense\. WARNING: THE BROWSER REPORTS A NON-STANDARD MAPPING, SO THE BUTTONS MAY NOT MATCH$/);
});

test('two pads unjoined: P2 says a second controller is detected and how to join, with a warning when non-standard', () => {
  const model = padStatusModel({ pads: [pad(0), pad(1)] });
  assert.equal(model.one.text, 'P1: Pad 0');
  assert.equal(model.two.text, 'P2: SECOND CONTROLLER DETECTED. PRESS A BUTTON ON IT TO JOIN');
  const odd = padStatusModel({ pads: [pad(0), pad(1, { mapping: '' })] });
  assert.match(odd.two.text, /NON-STANDARD MAPPING/);
});

test('two pads joined: P2 shows its own pad, and P1 skips it even when it is first in the list', () => {
  const model = padStatusModel({ pads: [pad(0, { id: 'Second' }), pad(1, { id: 'First' })], seatTwoPad: 0 });
  assert.equal(model.one.text, 'P1: First');
  assert.equal(model.two.text, 'P2: Second');
  const gone = padStatusModel({ pads: [pad(1)], seatTwoPad: 0 });
  assert.equal(gone.two.text, 'P2: JOINED, BUT THE BROWSER NO LONGER LISTS ITS CONTROLLER');
});

test('pressed state follows the buttons of each seat pad', () => {
  const model = padStatusModel({ pads: [pad(0, { pressed: [3] }), pad(1)], seatTwoPad: 1 });
  assert.equal(model.one.pressed, true);
  assert.equal(model.two.pressed, false);
  assert.equal(padStatusModel({ pads: [pad(0), pad(1, { pressed: [0] })] }).two.pressed, true);
});

test('null holes in the pad list are skipped', () => {
  const model = padStatusModel({ pads: [null, pad(2), null, pad(3)] });
  assert.equal(model.one.text, 'P1: Pad 2');
  assert.equal(model.two.text, 'P2: SECOND CONTROLLER DETECTED. PRESS A BUTTON ON IT TO JOIN');
  assert.equal(padStatusModel({ pads: [null, null] }).one.pressed, false);
});

test('the rows take the seat colors, hide with the title and write the DOM only on a change', () => {
  const appended = [];
  const status = createPadStatus({ append: (element) => appended.push(element) }, { documentObject: fakeDocument() });
  const [one, two] = status.elements;
  assert.deepEqual(appended, [one, two]);
  assert.equal(one.style.color, SEAT_COLORS[0].css);
  assert.equal(two.style.color, SEAT_COLORS[1].css);
  const pads = [pad(0), pad(1)];
  status.update({ pads, seatTwoPad: null, visible: true });
  status.update({ pads, seatTwoPad: null, visible: true });
  assert.equal(one.writes, 1);
  assert.equal(two.writes, 1);
  assert.equal(one.hidden, false);
  assert.ok(!one.className.includes('pad-status-pressed'));
  status.update({ pads: [pad(0, { pressed: [0] }), pad(1)], seatTwoPad: null, visible: true });
  assert.equal(one.writes, 1);
  assert.ok(one.className.includes('pad-status-pressed'));
  status.update({ pads, seatTwoPad: null, visible: false });
  assert.equal(one.hidden, true);
  assert.ok(!one.className.includes('pad-status-pressed'));
});
