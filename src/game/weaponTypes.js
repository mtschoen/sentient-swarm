// Weapon tables: one source for projectile kind numbers (shared with the GPU projectile code) and tier values.

export const PROJECTILE_KINDS = Object.freeze({
  bullet: 0,
  scatter: 1,
  rail: 2,
  pulseOrb: 3,
  pulseRing: 4,
  sidewinder: 5,
  beam: 6,
});

// Fixed neon palette, as hue (0 to 1) per weapon: the projectiles, the ship's charge ring and the
// pickups all read it. Keys are the WEAPON_TYPES names plus base.
export const WEAPON_HUES = Object.freeze({
  base: 0.5,
  beam: 0.92,
  scatter: 0.07,
  rail: 0.6,
  pulse: 0.35,
  sidewinders: 0.78,
});

export const WEAPON_TYPE_NAMES = Object.freeze(['beam', 'scatter', 'rail', 'pulse', 'sidewinders']);

// The pickup rotation (owner ruling R31): the weapons in their order, then the time warp, so a
// time warp is offered one slot in six. Its pickup is a cold white-violet clock (pickups.wgsl
// draws the clock when PICKUP_SHAPE_CLOCK is added to the hue slot).
export const PICKUP_TYPE_NAMES = Object.freeze([...WEAPON_TYPE_NAMES, 'timewarp']);
export const PICKUP_HUES = Object.freeze({ timewarp: 0.72 });
export const PICKUP_SHAPE_CLOCK = 1;

// Rail pickups are add-on turrets, not an armed weapon (owner ruling R29): each adds one turret,
// the turrets sit this far apart around the rear of the aim (and rotate with it), and past the cap
// (all 360 degrees covered) each further pickup raises the turrets' rail tier instead.
export const RAIL_TURRET_SPACING_RADIANS = Math.PI / 6;
export const MAXIMUM_RAIL_TURRETS = 12;

function tier(values) {
  return Object.freeze({
    fireInterval: 0,
    projectilesPerShot: 1,
    spreadRadians: 0,
    speed: 0,
    radius: 0.04,
    lifetime: 1,
    chargeSeconds: 0,
    extra: 0,
    parallelOffset: 0,
    ...values,
  });
}

function tiers(shared, perTier) {
  return Object.freeze(perTier.map((values) => tier({ ...shared, ...values })));
}

export const WEAPON_TYPES = Object.freeze({
  // Energy balls (owner rulings R19, R23): big, slow enough to read and lived out to the wall, so
  // every shot carves a tunnel the swarm cannot close at once; every kind pierces.
  base: Object.freeze({
    kind: PROJECTILE_KINDS.bullet,
    tiers: tiers(
      { fireInterval: 0.12, projectilesPerShot: 3, spreadRadians: 0.35, speed: 10, radius: 0.2, lifetime: 3 },
      [{}, {}, {}],
    ),
  }),
  beam: Object.freeze({
    kind: PROJECTILE_KINDS.beam,
    tiers: tiers({ fireInterval: 0, chargeSeconds: 8 }, [{ radius: 0.12 }, { radius: 0.2 }, { radius: 0.3 }]),
  }),
  // Scatter balls match the base gun's size and reach (owner ruling R32: a pickup is never a
  // power-down); the fan and the count are what the weapon adds.
  scatter: Object.freeze({
    kind: PROJECTILE_KINDS.scatter,
    tiers: tiers(
      { fireInterval: 0.2, spreadRadians: 1.2, speed: 10, radius: 0.2, lifetime: 3, chargeSeconds: 8 },
      [{ projectilesPerShot: 9 }, { projectilesPerShot: 13 }, { projectilesPerShot: 17 }],
    ),
  }),
  rail: Object.freeze({
    kind: PROJECTILE_KINDS.rail,
    tiers: tiers(
      { fireInterval: 0.3, speed: 40, radius: 0.05, lifetime: 0.6, chargeSeconds: 8, parallelOffset: 0.15 },
      [{ projectilesPerShot: 1 }, { projectilesPerShot: 2 }, { projectilesPerShot: 3 }],
    ),
  }),
  pulse: Object.freeze({
    kind: PROJECTILE_KINDS.pulseOrb,
    tiers: tiers(
      { fireInterval: 0.5, speed: 6, radius: 0.12, lifetime: 1, chargeSeconds: 8, extra: 40 },
      [
        { projectilesPerShot: 1 },
        { projectilesPerShot: 2, spreadRadians: 0.3 },
        { projectilesPerShot: 3, spreadRadians: 0.5 },
      ],
    ),
  }),
  sidewinders: Object.freeze({
    kind: PROJECTILE_KINDS.sidewinder,
    tiers: tiers(
      { fireInterval: 0.25, speed: 9, radius: 0.05, lifetime: 2.5, chargeSeconds: 8, extra: 5 },
      [
        { projectilesPerShot: 2, spreadRadians: 0.4 },
        { projectilesPerShot: 4, spreadRadians: 0.8 },
        { projectilesPerShot: 6, spreadRadians: 1.2 },
      ],
    ),
  }),
});

// Lab knobs, both off by default so the shipped game is unchanged (task C6b).
// Base gun kill budget (owner ruling R6): kills one base bullet may make before it dies; 0 is
// unlimited (every kind pierces). Enforced in projectiles_collide.wgsl through the bullet's extra.
export const DEFAULT_BASE_KILL_BUDGET = 0;
export const MAXIMUM_BASE_KILL_BUDGET = 64;
// Beam sweep budget (owner note R25, ruling P30): above this many degrees swept per step the
// beam's kill reach shrinks to threshold / swept of its length, never under the minimum scale;
// 0 is off.
export const DEFAULT_BEAM_SWEEP_THRESHOLD_DEGREES = 0;
export const MAXIMUM_BEAM_SWEEP_THRESHOLD_DEGREES = 90;
export const BEAM_SWEEP_MINIMUM_REACH_SCALE = 0.25;
