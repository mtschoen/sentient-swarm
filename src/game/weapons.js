import { MAXIMUM_RAIL_TURRETS, RAIL_TURRET_SPACING_RADIANS, WEAPON_TYPES } from './weaponTypes.js';

const MAXIMUM_TIER = 3;
const EXPIRY_EPSILON = 1e-9;
// Volleys one update may fire. Real steps fire at most a few (a quarter second is two base volleys),
// so this only bounds a huge deltaSeconds (a stalled tab) from looping for seconds.
export const MAXIMUM_SHOTS_PER_UPDATE = 8;

// Turret directions relative to the aim, in radians: centered on the rear (aim plus pi) and
// RAIL_TURRET_SPACING_RADIANS apart, so the set grows outward from the back (1 at 180 degrees,
// 2 at 165 and 195, 3 at 150, 180 and 210; 12 cover every direction).
export function railTurretOffsets(count) {
  return Array.from({ length: count }, (_, index) => Math.PI + (index - (count - 1) / 2) * RAIL_TURRET_SPACING_RADIANS);
}

// Fire control: pure accumulator (no immediate first shot), charge drains only while firing.
// The armed weapon (base, beam, scatter, pulse, sidewinders) swaps, tiers and expires; rail
// pickups instead add turrets (railTurrets, up to MAXIMUM_RAIL_TURRETS, then railTier): this class
// keeps only their count and tier, have no charge and are lost only by dropAll. The turrets are
// gunner ships whose fire is GunnerFire's (src/game/gunner-fire.js).
export class WeaponState {
  #held = null;

  constructor({ types = WEAPON_TYPES, random = Math.random } = {}) {
    this.types = types;
    this.random = random;
    this.dropAll();
  }

  get isBase() {
    return this.armed === 'base';
  }

  collect(typeName) {
    if (!this.types[typeName] || typeName === 'base') throw new Error(`Unknown weapon type: ${typeName}`);
    if (typeName === 'rail') {
      if (this.railTurrets < MAXIMUM_RAIL_TURRETS) this.railTurrets += 1;
      else this.railTier = Math.min(MAXIMUM_TIER, this.railTier + 1);
      return { swapped: false, tier: this.tier, railTurrets: this.railTurrets, railTier: this.railTier };
    }
    // Under beam time the normal swap and tier-up rules change the stashed loadout, not the beam.
    return this.#collectInto(this.#held ?? this, typeName);
  }

  // The swap and tier-up rule over any { armed, tier, charge } object (the state or the stash).
  #collectInto(loadout, typeName) {
    const swapped = loadout.armed !== typeName;
    if (swapped) {
      loadout.tier = Math.max(1, loadout.tier - 1);
      loadout.armed = typeName;
    } else {
      loadout.tier = Math.min(MAXIMUM_TIER, loadout.tier + 1);
    }
    loadout.charge = 1;
    if (swapped && loadout === this) this.accumulator = 0;
    return { swapped, tier: loadout.tier, railTurrets: this.railTurrets, railTier: this.railTier };
  }

  // Beam time: arm the beam at `tier` with a full charge that does not drain, stashing the loadout.
  beginBeamTime(tier) {
    if (this.#held !== null) return;
    this.#held = { armed: this.armed, tier: this.tier, charge: this.charge };
    this.armed = 'beam';
    this.tier = tier;
    this.charge = 1;
    this.accumulator = 0;
  }

  endBeamTime() {
    if (this.#held === null) return;
    ({ armed: this.armed, tier: this.tier, charge: this.charge } = this.#held);
    this.#held = null;
    this.accumulator = 0;
  }

  get beamTimeActive() {
    return this.#held !== null;
  }

  // Back to the base gun (charge expiry); the turrets stay.
  dropArmed() {
    this.armed = 'base';
    this.tier = 1;
    this.charge = 0;
    this.accumulator = 0;
  }

  // Death, a new run and quit to title: the base gun and no turrets.
  dropAll() {
    this.#held = null;
    this.dropArmed();
    this.railTurrets = 0;
    this.railTier = 1;
  }

  // spawns are the armed weapon's shots, fired while firing along a nonzero aim.
  update(deltaSeconds, { firing, aimX, aimY, x, y }) {
    const result = { spawns: [], beam: null, expired: false };
    const definition = this.types[this.armed];
    const values = definition.tiers[this.tier - 1];
    if (!firing) {
      this.accumulator = 0;
      return result;
    }
    const length = Math.hypot(aimX, aimY);
    if (length === 0) {
      this.accumulator = 0;
      return result;
    }
    const directionX = aimX / length;
    const directionY = aimY / length;

    if (values.fireInterval === 0) {
      result.beam = { x, y, directionX, directionY, halfWidth: values.radius };
    } else {
      this.accumulator += deltaSeconds;
      let volleys = 0;
      while (this.accumulator >= values.fireInterval) {
        if (volleys === MAXIMUM_SHOTS_PER_UPDATE) {
          this.accumulator = 0;
          break;
        }
        this.accumulator -= values.fireInterval;
        volleys += 1;
        this.#appendShot(result.spawns, definition.kind, values, { x, y, directionX, directionY });
      }
    }

    if (!this.isBase && this.#held === null) {
      this.charge -= deltaSeconds / values.chargeSeconds;
      if (this.charge <= EXPIRY_EPSILON) {
        this.dropArmed();
        result.expired = true;
      }
    }
    return result;
  }

  #appendShot(spawns, kind, values, { x, y, directionX, directionY }) {
    const count = values.projectilesPerShot;
    const baseAngle = Math.atan2(directionY, directionX);
    const perpendicularX = -directionY;
    const perpendicularY = directionX;
    for (let index = 0; index < count; index += 1) {
      const centered = index - (count - 1) / 2;
      const angle = count === 1 ? baseAngle : baseAngle + (centered / (count - 1)) * values.spreadRadians;
      const offset = centered * values.parallelOffset;
      spawns.push({
        x: x + perpendicularX * offset,
        y: y + perpendicularY * offset,
        velocityX: Math.cos(angle) * values.speed,
        velocityY: Math.sin(angle) * values.speed,
        radius: values.radius,
        lifetime: values.lifetime,
        kind,
        seed: this.random(),
        extra: values.extra,
      });
    }
  }
}
