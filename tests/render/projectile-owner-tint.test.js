import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SEAT_COLORS } from '../../src/game/seat-colors.js';

const SHADER = readFileSync(new URL('../../src/render/shaders/projectiles.wgsl', import.meta.url), 'utf8');

// The WGSL spelling of a body color: whole numbers keep one decimal (1 is 1.0).
function wgslVector(body) {
  return `vec3f(${body.map((value) => (Number.isInteger(value) ? value.toFixed(1) : String(value))).join(', ')})`;
}

// The versus owner tint must stay the seat's swarm color, by fixed spelling.
test('the projectile owner tints equal the seat body colors', () => {
  assert.ok(SHADER.includes(`const SEAT_ONE_TINT: vec3f = ${wgslVector(SEAT_COLORS[0].body)};`));
  assert.ok(SHADER.includes(`const SEAT_TWO_TINT: vec3f = ${wgslVector(SEAT_COLORS[1].body)};`));
});

test('an unowned projectile keeps its color', () => {
  assert.ok(SHADER.includes('if (owner == NO_PROJECTILE_OWNER) {\n    return color;\n  }'));
  assert.ok(SHADER.includes('return vec4f(tintForOwner(color, input.owner), 0.0);'));
});
