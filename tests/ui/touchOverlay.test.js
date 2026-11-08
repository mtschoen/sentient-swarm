import test from 'node:test';
import assert from 'node:assert/strict';
import { withHaptics } from '../../src/ui/touchOverlay.js';

test('bomb and death vibrate for ten milliseconds and still reach the effects', () => {
  const calls = [];
  const effects = { bomb: () => calls.push('bomb'), death: () => calls.push('death'), kills: (count) => calls.push(`kills ${count}`) };
  const wrapped = withHaptics(effects, { vibrate: (milliseconds) => calls.push(`vibrate ${milliseconds}`) });
  wrapped.bomb();
  wrapped.death();
  wrapped.kills(3);
  assert.deepEqual(calls, ['vibrate 10', 'bomb', 'vibrate 10', 'death', 'kills 3']);
});

test('withHaptics works when vibrate is unavailable', () => {
  const calls = [];
  const wrapped = withHaptics({ bomb: () => calls.push('bomb') }, {});
  wrapped.bomb();
  assert.deepEqual(calls, ['bomb']);
});
