import test from 'node:test';
import assert from 'node:assert/strict';
import { gunnerShotRecipe } from '../../src/game/swarm-shots.js';
import { PROJECTILE_KINDS } from '../../src/game/weaponTypes.js';

test('gunnerShotRecipe follows the rail tiers', () => {
  for (const [railTier, needleCount] of [[1, 1], [2, 2], [3, 3]]) {
    const recipe = gunnerShotRecipe(railTier);
    assert.equal(recipe.needleCount, needleCount);
    assert.equal(recipe.intervalSeconds, 0.3);
    assert.equal(recipe.speed, 40);
    assert.equal(recipe.radius, 0.05);
    assert.equal(recipe.lifetime, 0.6);
    assert.equal(recipe.parallelOffset, 0.15);
    assert.equal(recipe.kind, PROJECTILE_KINDS.rail);
    assert.ok(Object.isFrozen(recipe));
  }
  assert.equal(gunnerShotRecipe(0).needleCount, 1);
  assert.equal(gunnerShotRecipe(9).needleCount, 3);
});
