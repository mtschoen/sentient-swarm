import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WeaponState } from '../../src/game/weapons.js';
import { WEAPON_TYPES, WEAPON_TYPE_NAMES, PROJECTILE_KINDS } from '../../src/game/weaponTypes.js';

const STEP = 1 / 60;
const aim = { firing: true, aimX: 1, aimY: 0, x: 2, y: 3 };

function makeWeapons() {
  return new WeaponState({ random: () => 0.5 });
}

function run(weapons, seconds, input) {
  const results = [];
  const steps = Math.round(seconds / STEP);
  for (let index = 0; index < steps; index += 1) {
    results.push(weapons.update(STEP, input));
  }
  return results;
}

test('base gun fires 8 shots of 3 projectiles in one second', () => {
  const weapons = makeWeapons();
  const results = run(weapons, 1, aim);
  const shots = results.filter((result) => result.spawns.length > 0);
  assert.equal(shots.length, 8);
  for (const shot of shots) assert.equal(shot.spawns.length, 3);
  assert.equal(weapons.isBase, true);
  assert.equal(weapons.charge, 0);
});

test('fire rate is independent of frame rate', () => {
  const weapons = makeWeapons();
  let count = 0;
  for (let index = 0; index < 200; index += 1) count += weapons.update(0.005, aim).spawns.length;
  assert.equal(count, 8 * 3);
});

test('spread is centered on the aim direction and uses bullet kind', () => {
  const weapons = makeWeapons();
  const { spawns } = weapons.update(0.12, aim);
  assert.equal(spawns.length, 3);
  assert.equal(spawns[0].kind, PROJECTILE_KINDS.bullet);
  assert.ok(Math.abs(spawns[1].velocityY) < 1e-9);
  assert.ok(Math.abs(spawns[0].velocityY + spawns[2].velocityY) < 1e-9);
  assert.ok(Math.abs(Math.atan2(spawns[2].velocityY, spawns[2].velocityX) - 0.125) < 1e-9);
  assert.equal(spawns[0].x, 2);
  assert.equal(spawns[0].seed, 0.5);
});

test('collect arms a type, same type raises tier, different type drops one tier', () => {
  const weapons = makeWeapons();
  assert.deepEqual(weapons.collect('rail'), { swapped: true, tier: 1 });
  assert.equal(weapons.armed, 'rail');
  assert.equal(weapons.tier, 1);
  assert.equal(weapons.charge, 1);
  assert.deepEqual(weapons.collect('rail'), { swapped: false, tier: 2 });
  weapons.collect('rail');
  assert.equal(weapons.tier, 3);
  assert.deepEqual(weapons.collect('beam'), { swapped: true, tier: 2 });
  assert.equal(weapons.armed, 'beam');
  assert.equal(weapons.charge, 1);
});

test('same type at tier 3 stays tier 3 and refills', () => {
  const weapons = makeWeapons();
  weapons.collect('beam');
  weapons.collect('beam');
  weapons.collect('beam');
  run(weapons, 2, aim);
  assert.ok(weapons.charge < 1);
  assert.equal(weapons.collect('beam').tier, 3);
  assert.equal(weapons.tier, 3);
  assert.equal(weapons.charge, 1);
});

test('different type from tier 1 stays tier 1', () => {
  const weapons = makeWeapons();
  weapons.collect('scatter');
  assert.equal(weapons.collect('pulse').tier, 1);
});

test('charge drains only while firing', () => {
  const weapons = makeWeapons();
  weapons.collect('scatter');
  run(weapons, 1, { ...aim, firing: false });
  assert.equal(weapons.charge, 1);
  run(weapons, 1, aim);
  assert.ok(Math.abs(weapons.charge - (1 - 1 / WEAPON_TYPES.scatter.tiers[0].chargeSeconds)) < 1e-9);
});

test('expiry fires once and returns to the base gun', () => {
  const weapons = makeWeapons();
  weapons.collect('rail');
  const seconds = WEAPON_TYPES.rail.tiers[0].chargeSeconds;
  const results = run(weapons, seconds + 1, aim);
  assert.equal(results.filter((result) => result.expired).length, 1);
  assert.equal(weapons.armed, 'base');
  assert.equal(weapons.tier, 1);
  assert.equal(weapons.charge, 0);
  assert.equal(weapons.isBase, true);
});

test('collect before update in the expiry tick leaves the player armed', () => {
  const weapons = makeWeapons();
  weapons.collect('rail');
  const seconds = WEAPON_TYPES.rail.tiers[0].chargeSeconds;
  run(weapons, seconds - 0.05, aim);
  weapons.collect('rail');
  const result = weapons.update(0.1, aim);
  assert.equal(result.expired, false);
  assert.equal(weapons.armed, 'rail');
});

test('dropAll returns to base', () => {
  const weapons = makeWeapons();
  weapons.collect('pulse');
  weapons.dropAll();
  assert.equal(weapons.armed, 'base');
  assert.equal(weapons.tier, 1);
  assert.equal(weapons.charge, 0);
});

test('beam returns a beam request while firing and no spawns', () => {
  const weapons = makeWeapons();
  weapons.collect('beam');
  const idle = weapons.update(STEP, { ...aim, firing: false });
  assert.equal(idle.beam, null);
  const live = weapons.update(STEP, aim);
  assert.deepEqual(live.spawns, []);
  assert.deepEqual(live.beam, { x: 2, y: 3, directionX: 1, directionY: 0, halfWidth: 0.12 });
});

test('rail bolts are parallel, offset perpendicular and centered on the ship', () => {
  const weapons = makeWeapons();
  weapons.collect('rail');
  weapons.collect('rail');
  const { spawns } = weapons.update(1, aim);
  const shot = spawns.slice(0, 2);
  assert.equal(shot.length, 2);
  assert.ok(Math.abs(Math.abs(shot[0].y - 3) - 0.075) < 1e-9);
  assert.ok(Math.abs(shot[0].y + shot[1].y - 6) < 1e-9);
  assert.equal(shot[0].velocityX, 40);
  assert.equal(shot[0].kind, PROJECTILE_KINDS.rail);
});

test('type tables satisfy the brief', () => {
  assert.deepEqual(WEAPON_TYPE_NAMES, ['beam', 'scatter', 'rail', 'pulse', 'sidewinders']);
  for (const name of WEAPON_TYPE_NAMES) {
    assert.equal(WEAPON_TYPES[name].tiers.length, 3);
    for (const tier of WEAPON_TYPES[name].tiers) {
      assert.ok(tier.chargeSeconds >= 6 && tier.chargeSeconds <= 10);
    }
  }
  assert.deepEqual(WEAPON_TYPES.scatter.tiers.map((tier) => tier.projectilesPerShot), [9, 13, 17]);
  assert.equal(WEAPON_TYPES.sidewinders.kind, PROJECTILE_KINDS.sidewinder);
});

// Owner ruling R19 (Plan C task C0e): the base gun and scatter fire energy balls that carve a
// readable tunnel and keep piercing; rail stays the thin fast contrast; pulse and sidewinders keep
// their Plan B values.
test('energy ball tables: base and scatter orbs, rail thin and fast, pulse and sidewinders unchanged', () => {
  for (const tier of WEAPON_TYPES.base.tiers) {
    assert.deepEqual(
      { fireInterval: tier.fireInterval, projectilesPerShot: tier.projectilesPerShot, spreadRadians: tier.spreadRadians, speed: tier.speed, radius: tier.radius, lifetime: tier.lifetime },
      { fireInterval: 0.12, projectilesPerShot: 3, spreadRadians: 0.25, speed: 9, radius: 0.15, lifetime: 2 },
    );
    assert.ok(tier.radius >= 0.12 && tier.radius <= 0.18, `base ball radius ${tier.radius}`);
    assert.ok(tier.speed >= 8 && tier.speed <= 10, `base ball speed ${tier.speed}`);
  }
  for (const tier of WEAPON_TYPES.scatter.tiers) {
    assert.deepEqual({ speed: tier.speed, radius: tier.radius, lifetime: tier.lifetime }, { speed: 10, radius: 0.08, lifetime: 0.5 });
    assert.ok(tier.radius < WEAPON_TYPES.base.tiers[0].radius);
  }
  for (const tier of WEAPON_TYPES.rail.tiers) assert.deepEqual({ speed: tier.speed, radius: tier.radius }, { speed: 40, radius: 0.05 });
  for (const tier of WEAPON_TYPES.pulse.tiers) assert.deepEqual({ speed: tier.speed, radius: tier.radius, lifetime: tier.lifetime }, { speed: 6, radius: 0.12, lifetime: 1 });
  for (const tier of WEAPON_TYPES.sidewinders.tiers) assert.deepEqual({ speed: tier.speed, radius: tier.radius, lifetime: tier.lifetime }, { speed: 9, radius: 0.05, lifetime: 2.5 });
});
