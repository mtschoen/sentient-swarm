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

// An unawaited server.stop() lets the script exit (or start the next check) before the child is
// gone, which is the same port leak as killing the child directly.
test('every server.stop() call site in the browser scripts is awaited', () => {
  const unawaited = [];
  let callSites = 0;
  for (const name of readdirSync(BROWSER_DIRECTORY)) {
    if (!/\.(mjs|js)$/.test(name) || name === 'server.mjs' || name === 'browser-launchers.test.js') continue;
    const lines = readFileSync(new URL(name, BROWSER_DIRECTORY), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!line.includes('server.stop()')) return;
      callSites += 1;
      if (!line.includes('await ') || line.indexOf('await ') > line.indexOf('server.stop()')) unawaited.push(`${name}:${index + 1}`);
    });
  }
  assert.ok(callSites > 0);
  assert.deepEqual(unawaited, []);
});
