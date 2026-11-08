// Fixed-spelling checks over the workflow files. No YAML parser is available and none may be
// added (no new dependency), so these tests read lines and substrings, never parse YAML.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const workflowNames = readdirSync(workflowDirectory).filter((name) => name.endsWith('.yml'));

function lines(name) {
  return readFileSync(join(workflowDirectory, name), 'utf8').split('\n');
}

test('every action reference is pinned by full commit SHA with a version comment', () => {
  const pinned = /^\s*(- )?uses: [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/;
  let count = 0;
  for (const name of workflowNames) {
    for (const line of lines(name)) {
      if (!line.includes('uses:')) continue;
      count += 1;
      assert.match(line, pinned, `${name}: ${line.trim()}`);
    }
  }
  assert.ok(count > 0);
});

test('check.yml runs on every push and pull request with a read-only token', () => {
  const checkLines = lines('check.yml').map((line) => line.replace(/\r$/, ''));
  assert.ok(checkLines.includes('on:'));
  assert.ok(checkLines.includes('  push:'));
  assert.ok(checkLines.includes('  pull_request:'));
  assert.ok(checkLines.includes('permissions:'));
  assert.ok(checkLines.includes('  contents: read'));
  assert.ok(!checkLines.some((line) => line.includes('pull_request_target')));
});

test('browser.yml never runs for pull requests and keeps the guards', () => {
  const text = readFileSync(join(workflowDirectory, 'browser.yml'), 'utf8');
  assert.ok(!text.includes('pull_request'));
  assert.ok(text.includes('persist-credentials: false'));
  assert.ok(text.includes('contents: read'));
  assert.ok(text.includes("if: github.repository_owner == 'mtschoen'"));
});

test('pages.yml has a literal name and an expression run-name', () => {
  const pagesLines = lines('pages.yml').map((line) => line.replace(/\r$/, ''));
  assert.equal(pagesLines[0], 'name: Publish Pages');
  assert.equal(pagesLines[1], 'run-name: Publish ${{ github.event.repository.name }}');
});

test('every apt-get install refreshes the package index first on the same line', () => {
  let count = 0;
  for (const name of workflowNames) {
    for (const line of lines(name)) {
      const installAt = line.indexOf('apt-get install');
      if (installAt === -1) continue;
      count += 1;
      const updateAt = line.indexOf('apt-get update &&');
      assert.ok(updateAt !== -1 && updateAt < installAt, `${name}: ${line.trim()}`);
    }
  }
  assert.ok(count > 0);
});
