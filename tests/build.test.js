// Runs the production build into a temporary directory and checks that every WGSL file under
// src/ is emitted as an asset, so a static deploy can fetch each shader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function countWgslFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.wgsl')).length;
}

test('vite build emits one asset per WGSL file under src', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'murmuration-build-'));
  try {
    const viteEntry = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
    const result = spawnSync(
      process.execPath,
      [viteEntry, 'build', '--outDir', outputDirectory, '--emptyOutDir', '--logLevel', 'error'],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const sourceCount = await countWgslFiles(join(projectRoot, 'src'));
    assert.ok(sourceCount > 0);
    assert.equal(await countWgslFiles(outputDirectory), sourceCount);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
