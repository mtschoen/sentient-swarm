import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WeaponState, railTurretOffsets, MAXIMUM_SHOTS_PER_UPDATE } from '../../src/game/weapons.js';
import { WEAPON_TYPES, WEAPON_TYPE_NAMES, PROJECTILE_KINDS, RAIL_TURRET_SPACING_RADIANS, MAXIMUM_RAIL_TURRETS, WEAPON_HUES, PICKUP_TYPE_NAMES, PICKUP_HUES, PICKUP_SHAPE_CLOCK, DEFAULT_BASE_KILL_BUDGET, MAXIMUM_BASE_KILL_BUDGET, DEFAULT_BEAM_SWEEP_THRESHOLD_DEGREES, MAXIMUM_BEAM_SWEEP_THRESHOLD_DEGREES, BEAM_SWEEP_MINIMUM_REACH_SCALE } from '../../src/game/weaponTypes.js';

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
  assert.ok(Math.abs(Math.atan2(spawns[2].velocityY, spawns[2].velocityX) - WEAPON_TYPES.base.tiers[0].spreadRadians / 2) < 1e-9);
  assert.equal(spawns[0].x, 2);
  assert.equal(spawns[0].seed, 0.5);
});

test('collect arms a type, same type raises tier, different type drops one tier', () => {
  const weapons = makeWeapons();
  assert.deepEqual(weapons.collect('pulse'), { swapped: true, tier: 1, railTurrets: 0, railTier: 1 });
  assert.equal(weapons.armed, 'pulse');
  assert.equal(weapons.tier, 1);
  assert.equal(weapons.charge, 1);
  assert.deepEqual(weapons.collect('pulse'), { swapped: false, tier: 2, railTurrets: 0, railTier: 1 });
  weapons.collect('pulse');
  assert.equal(weapons.tier, 3);
  assert.deepEqual(weapons.collect('beam'), { swapped: true, tier: 2, railTurrets: 0, railTier: 1 });
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
  weapons.collect('sidewinders');
  const seconds = WEAPON_TYPES.sidewinders.tiers[0].chargeSeconds;
  const results = run(weapons, seconds + 1, aim);
  assert.equal(results.filter((result) => result.expired).length, 1);
  assert.equal(weapons.armed, 'base');
  assert.equal(weapons.tier, 1);
  assert.equal(weapons.charge, 0);
  assert.equal(weapons.isBase, true);
});

test('collect before update in the expiry tick leaves the player armed', () => {
  const weapons = makeWeapons();
  weapons.collect('sidewinders');
  const seconds = WEAPON_TYPES.sidewinders.tiers[0].chargeSeconds;
  run(weapons, seconds - 0.05, aim);
  weapons.collect('sidewinders');
  const result = weapons.update(0.1, aim);
  assert.equal(result.expired, false);
  assert.equal(weapons.armed, 'sidewinders');
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
// readable tunnel and keep piercing; rail stays the thin fast contrast. Every table entry is pinned
// by exact value, so a tuning change is a deliberate edit here too.
const TIER_DEFAULTS = { fireInterval: 0, projectilesPerShot: 1, spreadRadians: 0, speed: 0, radius: 0.04, lifetime: 1, chargeSeconds: 0, extra: 0, parallelOffset: 0 };
const EXPECTED_TABLES = {
  base: {
    kind: PROJECTILE_KINDS.bullet,
    tiers: [1, 2, 3].map(() => ({ ...TIER_DEFAULTS, fireInterval: 0.12, projectilesPerShot: 3, spreadRadians: 0.35, speed: 10, radius: 0.2, lifetime: 3 })),
  },
  beam: {
    kind: PROJECTILE_KINDS.beam,
    tiers: [0.12, 0.2, 0.3].map((radius) => ({ ...TIER_DEFAULTS, chargeSeconds: 8, radius })),
  },
  scatter: {
    kind: PROJECTILE_KINDS.scatter,
    tiers: [9, 13, 17].map((projectilesPerShot) => ({ ...TIER_DEFAULTS, fireInterval: 0.2, spreadRadians: 1.2, speed: 10, radius: 0.2, lifetime: 3, chargeSeconds: 8, projectilesPerShot })),
  },
  rail: {
    kind: PROJECTILE_KINDS.rail,
    tiers: [1, 2, 3].map((projectilesPerShot) => ({ ...TIER_DEFAULTS, fireInterval: 0.3, speed: 40, radius: 0.05, lifetime: 0.6, chargeSeconds: 8, parallelOffset: 0.15, projectilesPerShot })),
  },
  pulse: {
    kind: PROJECTILE_KINDS.pulseOrb,
    tiers: [
      { projectilesPerShot: 1, spreadRadians: 0 },
      { projectilesPerShot: 2, spreadRadians: 0.3 },
      { projectilesPerShot: 3, spreadRadians: 0.5 },
    ].map((own) => ({ ...TIER_DEFAULTS, fireInterval: 0.5, speed: 6, radius: 0.12, lifetime: 1, chargeSeconds: 8, extra: 40, ...own })),
  },
  sidewinders: {
    kind: PROJECTILE_KINDS.sidewinder,
    tiers: [
      { projectilesPerShot: 2, spreadRadians: 0.4 },
      { projectilesPerShot: 4, spreadRadians: 0.8 },
      { projectilesPerShot: 6, spreadRadians: 1.2 },
    ].map((own) => ({ ...TIER_DEFAULTS, fireInterval: 0.25, speed: 9, radius: 0.05, lifetime: 2.5, chargeSeconds: 8, extra: 5, ...own })),
  },
};

test('every weapon table entry is pinned by exact value', () => {
  assert.deepEqual(Object.keys(WEAPON_TYPES), Object.keys(EXPECTED_TABLES));
  for (const [name, expected] of Object.entries(EXPECTED_TABLES)) {
    assert.equal(WEAPON_TYPES[name].kind, expected.kind, `${name} kind`);
    assert.equal(WEAPON_TYPES[name].tiers.length, 3, `${name} tier count`);
    expected.tiers.forEach((tier, index) => assert.deepEqual({ ...WEAPON_TYPES[name].tiers[index] }, tier, `${name} tier ${index + 1}`));
  }
});

test('the projectile kind numbers and the weapon hues are pinned by exact value', () => {
  assert.deepEqual({ ...PROJECTILE_KINDS }, { bullet: 0, scatter: 1, rail: 2, pulseOrb: 3, pulseRing: 4, sidewinder: 5, beam: 6 });
  assert.deepEqual({ ...WEAPON_HUES }, { base: 0.5, beam: 0.92, scatter: 0.07, rail: 0.6, pulse: 0.35, sidewinders: 0.78 });
  assert.deepEqual([...PICKUP_TYPE_NAMES], ['beam', 'scatter', 'rail', 'pulse', 'sidewinders', 'timewarp']);
  assert.deepEqual({ ...PICKUP_HUES }, { timewarp: 0.72 });
  assert.equal(PICKUP_SHAPE_CLOCK, 1);
});

test('the lab knob defaults and limits are pinned by exact value', () => {
  assert.deepEqual(
    [DEFAULT_BASE_KILL_BUDGET, MAXIMUM_BASE_KILL_BUDGET, DEFAULT_BEAM_SWEEP_THRESHOLD_DEGREES, MAXIMUM_BEAM_SWEEP_THRESHOLD_DEGREES, BEAM_SWEEP_MINIMUM_REACH_SCALE],
    [0, 64, 0, 90, 0.25],
  );
});

test('collect throws on an unknown type and on base, and leaves the state untouched', () => {
  const weapons = makeWeapons();
  weapons.collect('scatter');
  assert.throws(() => weapons.collect('laser'), /Unknown weapon type: laser/);
  assert.throws(() => weapons.collect('base'), /Unknown weapon type: base/);
  assert.throws(() => weapons.collect(undefined), /Unknown weapon type/);
  assert.deepEqual([weapons.armed, weapons.tier, weapons.charge], ['scatter', 1, 1]);
});

test('a beam drains over its eight charge seconds of firing, expires on the last frame and returns to base', () => {
  const weapons = makeWeapons();
  weapons.collect('beam');
  const MAXIMUM_FRAMES = 1000;
  let frames = 0;
  let result = null;
  while (frames < MAXIMUM_FRAMES) {
    result = weapons.update(STEP, aim);
    frames += 1;
    if (result.expired) break;
  }
  assert.equal(result.expired, true);
  assert.equal(frames, 480);
  assert.deepEqual([weapons.armed, weapons.tier, weapons.charge], ['base', 1, 0]);
  const after = weapons.update(STEP, aim);
  assert.equal(after.expired, false);
  assert.equal(after.beam, null);
});

test('a diagonal aim is normalized: the base volley keeps its speed and the beam its unit direction', () => {
  const weapons = makeWeapons();
  const diagonal = { firing: true, aimX: 3, aimY: 3, x: 2, y: 3 };
  const { spawns } = weapons.update(0.12, diagonal);
  assert.equal(spawns.length, 3);
  for (const spawn of spawns) assert.ok(Math.abs(Math.hypot(spawn.velocityX, spawn.velocityY) - 10) < 1e-9);
  const middle = spawns[1];
  assert.ok(Math.abs(middle.velocityX - 10 * Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(middle.velocityY - 10 * Math.SQRT1_2) < 1e-9);
  weapons.collect('beam');
  const { beam } = weapons.update(STEP, { ...diagonal, aimX: -5, aimY: 5 });
  assert.ok(Math.abs(beam.directionX + Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(beam.directionY - Math.SQRT1_2) < 1e-9);
});

test('swapping weapons mid-fire discards the half-built volley of the old weapon', () => {
  const weapons = makeWeapons();
  assert.equal(weapons.update(0.1, aim).spawns.length, 0);
  weapons.collect('scatter');
  // Kept, 0.1 + 0.19 would reach scatter's 0.2 s interval; discarded, it cannot.
  assert.equal(weapons.update(0.19, aim).spawns.length, 0);
  assert.equal(weapons.update(0.01, aim).spawns.length, 9);
});

test('swapping weapons mid-fire leaves the turrets accumulator alone', () => {
  const weapons = makeWeapons();
  weapons.collect('rail');
  assert.equal(weapons.update(0.2, aim).turretSpawns.length, 0);
  weapons.collect('scatter');
  assert.equal(weapons.update(0.1, aim).turretSpawns.length, 1);
});

// Owner ruling R29: rail pickups stack into rear-firing turrets that fan out from the back, 30
// degrees apart, until 12 cover every direction; later pickups raise the turrets' rail tier.
const DEGREES = Math.PI / 180;
const sortedDegrees = (radians) => radians.map((angle) => ((angle / DEGREES) % 360 + 360) % 360).sort((first, second) => first - second);
const collectRails = (weapons, count) => { for (let index = 0; index < count; index += 1) weapons.collect('rail'); };

test('the turret spacing is 30 degrees and the cap is 12', () => {
  assert.ok(Math.abs(RAIL_TURRET_SPACING_RADIANS - 30 * DEGREES) < 1e-12);
  assert.equal(MAXIMUM_RAIL_TURRETS, 12);
});

test('turret offsets from the aim fan out from the rear, 30 degrees apart', () => {
  const expectDegrees = (count, degrees) => {
    const actual = sortedDegrees(railTurretOffsets(count));
    assert.equal(actual.length, degrees.length, `${count} turrets`);
    actual.forEach((angle, index) => assert.ok(Math.abs(angle - degrees[index]) < 1e-9, `${count} turrets: ${actual} vs ${degrees}`));
  };
  expectDegrees(0, []);
  expectDegrees(1, [180]);
  expectDegrees(2, [165, 195]);
  expectDegrees(3, [150, 180, 210]);
  expectDegrees(12, Array.from({ length: 12 }, (_, index) => 15 + 30 * index));
});

test('a rail pickup adds a turret and leaves the armed weapon, tier and charge untouched', () => {
  const weapons = makeWeapons();
  weapons.collect('scatter');
  weapons.collect('scatter');
  run(weapons, 1, aim);
  const charge = weapons.charge;
  assert.deepEqual(weapons.collect('rail'), { swapped: false, tier: 2, railTurrets: 1, railTier: 1 });
  assert.deepEqual([weapons.armed, weapons.tier, weapons.charge, weapons.railTurrets], ['scatter', 2, charge, 1]);
  assert.equal(weapons.collect('rail').railTurrets, 2);
  assert.equal(weapons.isBase, false);
  const fresh = makeWeapons();
  fresh.collect('rail');
  assert.deepEqual([fresh.armed, fresh.tier, fresh.charge, fresh.isBase], ['base', 1, 0, true]);
});

test('the thirteenth rail pickup raises the turret tier and the count stays 12', () => {
  const weapons = makeWeapons();
  collectRails(weapons, 12);
  assert.deepEqual([weapons.railTurrets, weapons.railTier], [12, 1]);
  assert.deepEqual(weapons.collect('rail'), { swapped: false, tier: 1, railTurrets: 12, railTier: 2 });
  collectRails(weapons, 5);
  assert.deepEqual([weapons.railTurrets, weapons.railTier], [12, 3]);
});

test('turrets fire rail shots at the rail interval while firing and not while idle', () => {
  const weapons = makeWeapons();
  collectRails(weapons, 3);
  const idle = run(weapons, 1, { ...aim, firing: false });
  assert.ok(idle.every((result) => result.turretSpawns.length === 0));
  const results = run(weapons, 1.2, aim);
  const volleys = results.filter((result) => result.turretSpawns.length > 0);
  const values = WEAPON_TYPES.rail.tiers[0];
  assert.equal(volleys.length, Math.floor(1.2 / values.fireInterval + 1e-9));
  const [volley] = volleys;
  assert.equal(volley.turretSpawns.length, 3);
  for (const spawn of volley.turretSpawns) {
    assert.equal(spawn.kind, PROJECTILE_KINDS.rail);
    assert.deepEqual([spawn.x, spawn.y, spawn.radius, spawn.lifetime], [2, 3, values.radius, values.lifetime]);
    assert.ok(Math.abs(Math.hypot(spawn.velocityX, spawn.velocityY) - values.speed) < 1e-9);
  }
  // Aim along +x: the turrets point at 150, 180 and 210 degrees.
  assert.deepEqual(sortedDegrees(volley.turretSpawns.map((spawn) => Math.atan2(spawn.velocityY, spawn.velocityX))).map(Math.round), [150, 180, 210]);
});

test('turret directions rotate with the aim', () => {
  const weapons = makeWeapons();
  weapons.collect('rail');
  const [spawn] = weapons.update(1, { ...aim, aimX: 0, aimY: 1 }).turretSpawns;
  assert.ok(Math.abs(spawn.velocityX) < 1e-9);
  assert.ok(Math.abs(spawn.velocityY + WEAPON_TYPES.rail.tiers[0].speed) < 1e-9);
});

test('higher turret tiers fire parallel rails per turret', () => {
  const weapons = makeWeapons();
  collectRails(weapons, 13);
  const { turretSpawns } = weapons.update(WEAPON_TYPES.rail.tiers[1].fireInterval, aim);
  assert.equal(turretSpawns.length, 12 * WEAPON_TYPES.rail.tiers[1].projectilesPerShot);
});

test('a frame with weapon and turret shots returns both spawn sets, the beam included', () => {
  const weapons = makeWeapons();
  weapons.collect('rail');
  const result = weapons.update(0.3, aim);
  assert.equal(result.spawns.length, 2 * WEAPON_TYPES.base.tiers[0].projectilesPerShot);
  assert.ok(result.spawns.every((spawn) => spawn.kind === PROJECTILE_KINDS.bullet));
  assert.equal(result.turretSpawns.length, 1);
  weapons.collect('beam');
  const beamFrame = weapons.update(0.3, aim);
  assert.notEqual(beamFrame.beam, null);
  assert.equal(beamFrame.turretSpawns.length, 1);
});

test('dropAll clears the turrets and their tier; expiry keeps them', () => {
  const weapons = makeWeapons();
  collectRails(weapons, 14);
  weapons.collect('pulse');
  run(weapons, WEAPON_TYPES.pulse.tiers[0].chargeSeconds + 1, aim);
  assert.equal(weapons.armed, 'base');
  assert.deepEqual([weapons.railTurrets, weapons.railTier], [12, 3]);
  weapons.dropAll();
  assert.deepEqual([weapons.railTurrets, weapons.railTier], [0, 1]);
});

test('fire on a huge delta spawns at most MAXIMUM_SHOTS_PER_UPDATE volleys', () => {
  const weapons = makeWeapons();
  const result = weapons.update(1000, aim);
  assert.equal(result.spawns.length, MAXIMUM_SHOTS_PER_UPDATE * 3);
  assert.equal(weapons.accumulator < 0.12, true);
  const turreted = makeWeapons();
  turreted.collect('rail');
  const turretResult = turreted.update(1000, aim);
  assert.equal(turretResult.turretSpawns.length, MAXIMUM_SHOTS_PER_UPDATE);
});

test('the volley cap exceeds any real step so ordinary play is unchanged', () => {
  const weapons = makeWeapons();
  assert.equal(weapons.update(0.25, aim).spawns.length, 2 * 3);
  assert.equal(MAXIMUM_SHOTS_PER_UPDATE >= 8, true);
});

test('zero aim while firing resets the accumulator', () => {
  const weapons = makeWeapons();
  weapons.collect('rail');
  weapons.update(0.05, aim);
  assert.equal(weapons.accumulator > 0, true);
  weapons.update(0.05, { ...aim, aimX: 0, aimY: 0 });
  assert.equal(weapons.accumulator, 0);
  assert.equal(weapons.railAccumulator, 0);
});
