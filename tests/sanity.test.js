import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('package declares ES modules and no runtime dependencies', async () => {
  const packageDefinition = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageDefinition.type, 'module');
  assert.deepEqual(packageDefinition.dependencies ?? {}, {});
});
