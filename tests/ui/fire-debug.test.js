import test from 'node:test';
import assert from 'node:assert/strict';
import { createFireDebug } from '../../src/ui/fire-debug.js';

test('the overlay shows the log lines and rewrites its text only when they change', () => {
  let writes = 0;
  const element = {
    classes: [],
    classList: { add: (name) => element.classes.push(name) },
    set textContent(value) { writes += 1; element.text = value; },
  };
  const overlay = createFireDebug({ documentObject: { createElement: () => element } });
  assert.deepEqual(element.classes, ['fire-debug']);
  let lines = ['fire off', '1.0s SILENT 0.5s: 0 of 12 ships in the aim cone'];
  const log = { lines: () => lines };
  overlay.update(log);
  overlay.update(log);
  assert.equal(element.text, 'fire off\n1.0s SILENT 0.5s: 0 of 12 ships in the aim cone');
  assert.equal(writes, 1);
  lines = ['fire HELD'];
  overlay.update(log);
  assert.equal(writes, 2);
});
