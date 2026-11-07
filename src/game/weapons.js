import { WEAPON_TYPES } from './weaponTypes.js';

const MAXIMUM_TIER = 3;
const EXPIRY_EPSILON = 1e-9;

// Fire control: pure accumulator (no immediate first shot), charge drains only while firing.
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
    const swapped = this.armed !== typeName;
    if (swapped) {
      this.tier = Math.max(1, this.tier - 1);
      this.armed = typeName;
      this.accumulator = 0;
    } else {
      this.tier = Math.min(MAXIMUM_TIER, this.tier + 1);
    }
    this.charge = 1;
    return { swapped, tier: this.tier };
  }

  dropAll() {
    this.armed = 'base';
    this.tier = 1;
    this.charge = 0;
    this.accumulator = 0;
  }

  update(deltaSeconds, { firing, aimX, aimY, x, y }) {
    const result = { spawns: [], beam: null, expired: false };
    const definition = this.types[this.armed];
    const values = definition.tiers[this.tier - 1];
    if (!firing) {
      this.accumulator = 0;
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
        this.appendShot(result.spawns, definition.kind, values, { x, y, directionX, directionY });
      }
    }

    if (!this.isBase) {
      this.charge -= deltaSeconds / values.chargeSeconds;
      if (this.charge <= EXPIRY_EPSILON) {
        this.dropAll();
        result.expired = true;
      }
    }
    return result;
  }

  appendShot(spawns, kind, values, { x, y, directionX, directionY }) {
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
