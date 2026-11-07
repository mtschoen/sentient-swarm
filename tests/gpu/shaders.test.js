import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadShader, shaderUrl, substituteConstants, prependCommon } from '../../src/gpu/shaders.js';

const constants = {
  WORKGROUP_SIZE: 256,
  SPECIES_COUNT: 5,
  MAXIMUM_NEIGHBOR_SAMPLES: 32,
  COARSE_COLUMNS: 64,
  COARSE_ROWS: 36,
  COARSE_CHANNELS: 8,
};

test('substituteConstants replaces every token occurrence', () => {
  assert.equal(substituteConstants('a __X__ b __X__ __Y__', { X: 1, Y: 'two' }), 'a 1 b 1 two');
});

test('substituteConstants throws on a leftover token', () => {
  assert.throws(() => substituteConstants('__KNOWN__ __UNKNOWN__', { KNOWN: 1 }), /__UNKNOWN__/);
});

test('loadShader returns the text from the injected fetch function', async () => {
  const requested = [];
  const fetchFunction = async (url) => {
    requested.push(String(url));
    return { ok: true, text: async () => 'shader text' };
  };
  assert.equal(await loadShader('common', { fetchFunction }), 'shader text');
  assert.match(requested[0], /sim\/shaders\/common\.wgsl$/);
});

test('loadShader resolves the name against an injected baseUrl', async () => {
  const requested = [];
  const fetchFunction = async (url) => {
    requested.push(String(url));
    return { ok: true, text: async () => '' };
  };
  await loadShader('glyphs', { fetchFunction, baseUrl: new URL('http://host/src/render/shaders/') });
  assert.equal(requested[0], 'http://host/src/render/shaders/glyphs.wgsl');
});

test('shaderUrl keeps a slash-less base as the directory, as the Vite dev server rewrites it', () => {
  assert.equal(String(shaderUrl('glyphs', 'http://host/src/render/shaders')), 'http://host/src/render/shaders/glyphs.wgsl');
});

test('prependCommon puts the common header first', () => {
  const combined = prependCommon('body', 'header');
  assert.ok(combined.startsWith('header'));
  assert.ok(combined.endsWith('body'));
});

test('common.wgsl resolves fully with the standard constants', async () => {
  const text = await readFile(new URL('../../src/sim/shaders/common.wgsl', import.meta.url), 'utf8');
  const result = substituteConstants(text, constants);
  assert.ok(!result.includes('__'));
  assert.ok(result.includes('struct Agent'));
  assert.ok(result.includes('struct SimParams'));
});
