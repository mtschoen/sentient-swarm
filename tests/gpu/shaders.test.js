import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadShader, substituteConstants, prependCommon } from '../../src/gpu/shaders.js';
import { PROJECTILE_FLAG_ALIVE, PROJECTILE_FLAG_MISSILE_RING, SHADER_CONSTANTS } from '../../src/sim/layout.js';
import { PROJECTILE_KINDS } from '../../src/game/weaponTypes.js';

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

test('loadShader fetches an injected url instead of the sim shader directory', async () => {
  const requested = [];
  const fetchFunction = async (url) => {
    requested.push(String(url));
    return { ok: true, text: async () => '' };
  };
  await loadShader('glyphs', { fetchFunction, url: new URL('http://host/src/render/shaders/glyphs.wgsl') });
  assert.equal(requested[0], 'http://host/src/render/shaders/glyphs.wgsl');
});

test('prependCommon puts the common header first', () => {
  const combined = prependCommon('body', 'header');
  assert.ok(combined.startsWith('header'));
  assert.ok(combined.endsWith('body'));
});

test('common.wgsl resolves fully with the standard constants', async () => {
  const text = await readFile(new URL('../../src/sim/shaders/common.wgsl', import.meta.url), 'utf8');
  const result = substituteConstants(text, SHADER_CONSTANTS);
  assert.ok(!result.includes('__'));
  assert.ok(result.includes('struct Agent'));
  assert.ok(result.includes('struct SimParams'));
});

test('projectile kind constants substituted into WGSL equal PROJECTILE_KINDS', async () => {
  const read = (name) => readFile(new URL(`../../src/sim/shaders/${name}.wgsl`, import.meta.url), 'utf8');
  const commonSource = await read('common');
  const common = substituteConstants(commonSource, SHADER_CONSTANTS);
  const collide = prependCommon(substituteConstants(await read('projectiles_collide'), SHADER_CONSTANTS), common);
  const names = {
    bullet: 'PROJECTILE_KIND_BULLET',
    scatter: 'PROJECTILE_KIND_SCATTER',
    rail: 'PROJECTILE_KIND_RAIL',
    pulseOrb: 'PROJECTILE_KIND_PULSE_ORB',
    pulseRing: 'PROJECTILE_KIND_PULSE_RING',
    sidewinder: 'PROJECTILE_KIND_SIDEWINDER',
    beam: 'PROJECTILE_KIND_BEAM',
  };
  assert.deepEqual(Object.keys(names).sort(), Object.keys(PROJECTILE_KINDS).sort());
  for (const [kind, name] of Object.entries(names)) {
    assert.ok(commonSource.includes(`const ${name}: u32 = __${name}__u;`), `${name} is a substituted token`);
    assert.ok(collide.includes(`const ${name}: u32 = ${PROJECTILE_KINDS[kind]}u;`), `${name} = ${PROJECTILE_KINDS[kind]}`);
  }
  assert.ok(commonSource.includes('const PROJECTILE_FLAG_ALIVE: u32 = __PROJECTILE_FLAG_ALIVE__u;'));
  assert.ok(collide.includes(`const PROJECTILE_FLAG_ALIVE: u32 = ${PROJECTILE_FLAG_ALIVE}u;`));
  assert.equal(PROJECTILE_FLAG_MISSILE_RING, 2);
  assert.equal(SHADER_CONSTANTS.PROJECTILE_FLAG_MISSILE_RING, 2);
  assert.ok(commonSource.includes('const PROJECTILE_FLAG_MISSILE_RING: u32 = __PROJECTILE_FLAG_MISSILE_RING__u;'));
  assert.ok(collide.includes('const PROJECTILE_FLAG_MISSILE_RING: u32 = 2u;'));
  // Every kind test in the collide entry points compares against a named constant, never a number.
  const kindTests = collide.match(/\.kind\s*[!=]=\s*\w+/g);
  assert.ok(kindTests.length >= 4);
  for (const kindTest of kindTests) assert.match(kindTest, /[!=]=\s*PROJECTILE_KIND_[A-Z_]+$/);
});
