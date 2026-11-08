import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const BROWSER_DIRECTORY = new URL('./', import.meta.url);

// A script that kills the server child directly does not wait for it to exit, so the port can stay
// held for the next check; server.stop() resolves once the child is gone.
test('browser scripts stop the server with server.stop(), never child.kill()', () => {
  const offenders = readdirSync(BROWSER_DIRECTORY)
    .filter((name) => /\.(mjs|js)$/.test(name) && name !== 'server.mjs' && name !== 'browser-launchers.test.js')
    .filter((name) => readFileSync(new URL(name, BROWSER_DIRECTORY), 'utf8').includes('child.kill('));
  assert.deepEqual(offenders, []);
});
