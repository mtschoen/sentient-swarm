import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

function excludedGlobs() {
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const command = manifest.scripts.coverage;
  return [...command.matchAll(/--test-coverage-exclude="([^"]+)"/g)].map((match) => match[1]);
}

test('coverage exclusions name existing files', () => {
  const globs = excludedGlobs();
  assert.ok(globs.length > 0, 'the coverage script lists no --test-coverage-exclude globs');
  for (const glob of globs) {
    // Exclusions are plain paths today; a wildcard needs a real glob expansion here.
    assert.ok(!glob.includes('*'), `stale test: expand the wildcard exclusion ${glob}`);
    const path = fileURLToPath(new URL(glob, root));
    assert.ok(existsSync(path), `coverage exclusion matches no file (stale glob): ${glob}`);
  }
});
