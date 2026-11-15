import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnlineTitle, onlineTitleView } from '../../src/ui/online-title.js';
import { SEAT_COLORS } from '../../src/game/seat-colors.js';

test('onlineTitleView gives each side its labels', () => {
  const roundTripMilliseconds = 42;
  assert.deepEqual(onlineTitleView({ connected: false, role: null, roundTripMilliseconds, waitingFor: null }),
    { onlineLabel: 'ONLINE', statusLine: '', playLabel: 'Play', playEnabled: true, labEnabled: true });
  assert.deepEqual(onlineTitleView({ connected: true, role: 'host', roundTripMilliseconds, waitingFor: null }),
    { onlineLabel: 'DISCONNECT', statusLine: 'PLAYER 2 CONNECTED ONLINE (42 MS)', playLabel: 'Play', playEnabled: true, labEnabled: false });
  assert.deepEqual(onlineTitleView({ connected: true, role: 'host', roundTripMilliseconds, waitingFor: 1 }),
    { onlineLabel: 'DISCONNECT', statusLine: 'PLAYER 2 CONNECTED ONLINE (42 MS)', playLabel: 'WAITING FOR PLAYER 2 TO LOAD', playEnabled: false, labEnabled: false });
  assert.deepEqual(onlineTitleView({ connected: true, role: 'guest', roundTripMilliseconds, waitingFor: null }),
    { onlineLabel: 'DISCONNECT', statusLine: 'CONNECTED TO PLAYER 1 ONLINE (42 MS)', playLabel: 'WAITING FOR THE HOST TO START', playEnabled: false, labEnabled: false });
});

test('the status line is always laid out, in seat 2 color, and changes visibility and text only', () => {
  const made = [];
  const documentObject = { createElement: () => { const node = { style: {}, textContent: '', hidden: false, className: '' }; made.push(node); return node; } };
  const appended = [];
  const title = createOnlineTitle({ append: (node) => appended.push(node) }, { documentObject });
  assert.deepEqual(appended, [title.element]);
  assert.equal(title.element.className, 'online-status');
  assert.equal(title.element.style.color, SEAT_COLORS[1].css);
  title.update(onlineTitleView({ connected: true, role: 'host', roundTripMilliseconds: 42 }), { visible: true });
  assert.equal(title.element.textContent, 'PLAYER 2 CONNECTED ONLINE (42 MS)');
  assert.equal(title.element.style.visibility, 'visible');
  title.update(onlineTitleView({ connected: false, role: null }), { visible: false });
  assert.equal(title.element.style.visibility, 'hidden');
  assert.equal(title.element.hidden, false);
  assert.equal(made.length, 1);
});
