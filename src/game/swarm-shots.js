// Per-kind swarm shot recipes: what ONE ship shot is for each armed weapon and tier, and the
// aggregate rate it is fired at (src/game/swarm-fire-rate.js). Speeds, kinds and the homing and
// density values come from WEAPON_TYPES; everything a swarm shot adds is stated here.
// The beam has no recipe (it fires from the centroid), nor does rail (turrets only).
import { WEAPON_TYPES } from './weaponTypes.js';

const DEGREES = Math.PI / 180;

// Base gun aggregate at the reference swarm: about 1.3 times the old single ship's swept width
// at ball radius 0.10.
export const BASE_SHOTS_PER_SECOND = 65;
export const BASE_EXPONENT = 0.4;
// Scatter fires at 1.6 times the base gun's aggregate, on the same exponent.
export const SCATTER_SHOTS_PER_SECOND = 1.6 * BASE_SHOTS_PER_SECOND;
export const SCATTER_EXPONENT = 0.4;
// Pulse and sidewinders are a fixed aggregate across the ships (their rings cost GPU time).
export const PULSE_SHOTS_PER_SECOND = Object.freeze([3.3, 5, 6.7]);
export const SIDEWINDER_SHOTS_PER_SECOND = Object.freeze([8, 16, 24]);
export const FIXED_AGGREGATE_EXPONENT = 0;
// Sidewinder homing (rad/s) by tier. The pulse ring's reach by tier is not here: the ring's growth
// is constants in projectiles_step.wgsl, so pulse tiers change the rate only.
export const SIDEWINDER_HOMING = Object.freeze([5, 7, 9]);

function recipe(weaponName, values) {
  const definition = WEAPON_TYPES[weaponName];
  return Object.freeze({
    kind: definition.kind,
    speed: definition.tiers[0].speed,
    extra: 0,
    pelletCount: 1,
    fanRadians: 0,
    jitterRadians: 0,
    exponent: FIXED_AGGREGATE_EXPONENT,
    ...values,
  });
}

const BASE_RECIPE = recipe('base', {
  baseShotsPerSecond: BASE_SHOTS_PER_SECOND,
  exponent: BASE_EXPONENT,
  radius: 0.1,
  lifetime: 2,
  jitterRadians: 2 * DEGREES,
});

const SCATTER_RECIPES = Object.freeze(
  [1, 2, 3].map((pelletCount, index) =>
    recipe('scatter', {
      baseShotsPerSecond: SCATTER_SHOTS_PER_SECOND,
      exponent: SCATTER_EXPONENT,
      radius: 0.07,
      lifetime: 1.2,
      pelletCount,
      fanRadians: 0.25,
      jitterRadians: [10, 16, 22][index] * DEGREES,
    }),
  ),
);

const PULSE_RECIPES = Object.freeze(
  PULSE_SHOTS_PER_SECOND.map((baseShotsPerSecond, index) =>
    recipe('pulse', {
      baseShotsPerSecond,
      radius: WEAPON_TYPES.pulse.tiers[index].radius,
      lifetime: WEAPON_TYPES.pulse.tiers[index].lifetime,
      extra: WEAPON_TYPES.pulse.tiers[index].extra,
    }),
  ),
);

const SIDEWINDER_RECIPES = Object.freeze(
  SIDEWINDER_SHOTS_PER_SECOND.map((baseShotsPerSecond, index) =>
    recipe('sidewinders', {
      baseShotsPerSecond,
      radius: WEAPON_TYPES.sidewinders.tiers[index].radius,
      lifetime: WEAPON_TYPES.sidewinders.tiers[index].lifetime,
      extra: SIDEWINDER_HOMING[index],
    }),
  ),
);

// The recipe for an armed weapon kind and tier (1 to 3), or null when the swarm does not fire it
// per ship (the beam).
export function swarmShotRecipe(kindName, tierNumber) {
  const index = Math.max(0, Math.min(2, tierNumber - 1));
  switch (kindName) {
    case 'base':
      return BASE_RECIPE;
    case 'scatter':
      return SCATTER_RECIPES[index];
    case 'pulse':
      return PULSE_RECIPES[index];
    case 'sidewinders':
      return SIDEWINDER_RECIPES[index];
    default:
      return null;
  }
}
