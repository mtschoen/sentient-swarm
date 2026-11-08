import { MAXIMUM_RAIL_TURRETS, RAIL_TURRET_SPACING_RADIANS, WEAPON_TYPES } from './weaponTypes.js';

const MAXIMUM_TIER = 3;
const EXPIRY_EPSILON = 1e-9;

// Turret directions relative to the aim, in radians: centered on the rear (aim plus pi) and
// RAIL_TURRET_SPACING_RADIANS apart, so the set grows outward from the back (1 at 180 degrees,
// 2 at 165 and 195, 3 at 150, 180 and 210; 12 cover every direction).
export function railTurretOffsets(count) {
  return Array.from({ length: count }, (_, index) => Math.PI + (index - (count - 1) / 2) * RAIL_TURRET_SPACING_RADIANS);
}

// Fire control: pure accumulator (no immediate first shot), charge drains only while firing.
// The armed weapon (base, beam, scatter, pulse, sidewinders) swaps, tiers and expires; rail
// pickups instead add turrets (railTurrets, up to MAXIMUM_RAIL_TURRETS, then railTier), which fire
// rail shots alongside it on their own accumulator, have no charge and are lost only by dropAll.
export class WeaponState {
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
    const swapped = this.armed !== typeName;
    if (swapped) {
      this.tier = Math.max(1, this.tier - 1);
      this.armed = typeName;
      this.accumulator = 0;
    } else {
      this.tier = Math.min(MAXIMUM_TIER, this.tier + 1);
    }
    this.charge = 1;
    return { swapped, tier: this.tier, railTurrets: this.railTurrets, railTier: this.railTier };
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
    this.dropArmed();
    this.railTurrets = 0;
    this.railTier = 1;
    this.railAccumulator = 0;
  }

  // spawns are the armed weapon's shots and turretSpawns the turrets' rail shots, both fired
  // while firing along a nonzero aim.
  update(deltaSeconds, { firing, aimX, aimY, x, y }) {
    const result = { spawns: [], turretSpawns: [], beam: null, expired: false };
    const definition = this.types[this.armed];
    const values = definition.tiers[this.tier - 1];
    if (!firing) {
      this.accumulator = 0;
      this.railAccumulator = 0;
      return result;
    }
    const length = Math.hypot(aimX, aimY);
    if (length === 0) return result;
    const directionX = aimX / length;
    const directionY = aimY / length;

    if (values.fireInterval === 0) {
      result.beam = { x, y, directionX, directionY, halfWidth: values.radius };
    } else {
      this.accumulator += deltaSeconds;
      while (this.accumulator >= values.fireInterval) {
        this.accumulator -= values.fireInterval;
        this.#appendShot(result.spawns, definition.kind, values, { x, y, directionX, directionY });
      }
    }
    this.fireTurrets(deltaSeconds, result.turretSpawns, { x, y, directionX, directionY });

    if (!this.isBase) {
      this.charge -= deltaSeconds / values.chargeSeconds;
      if (this.charge <= EXPIRY_EPSILON) {
        this.dropArmed();
        result.expired = true;
      }
    }
    return result;
  }

  fireTurrets(deltaSeconds, spawns, { x, y, directionX, directionY }) {
    if (this.railTurrets === 0) return;
    const definition = this.types.rail;
    const values = definition.tiers[this.railTier - 1];
    const aimAngle = Math.atan2(directionY, directionX);
    this.railAccumulator += deltaSeconds;
    while (this.railAccumulator >= values.fireInterval) {
      this.railAccumulator -= values.fireInterval;
      for (const offset of railTurretOffsets(this.railTurrets)) {
        const angle = aimAngle + offset;
        this.#appendShot(spawns, definition.kind, values, { x, y, directionX: Math.cos(angle), directionY: Math.sin(angle) });
      }
    }
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
