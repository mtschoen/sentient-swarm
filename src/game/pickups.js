// Pickup director: rotates the offered pickup type (the weapons, then the time warp) and spawns
// pickups on milestones and the recovery guard.
import { PICKUP_TYPE_NAMES } from './weaponTypes.js';
import { WORLD_BOUNDS } from '../sim/layout.js';

const PLACEMENT_ATTEMPTS = 16;
const DENSITY_CANDIDATES = 8;
const TIME_EPSILON = 1e-9;

export class PickupDirector {
  constructor({
    rotationSeconds = 20,
    pitySeconds = 10,
    fadeSeconds = 10,
    minimumDistance = 3,
    maximumDistance = 5,
    bounds = WORLD_BOUNDS,
    random = Math.random,
  } = {}) {
    if (!(rotationSeconds > 0)) throw new Error(`rotationSeconds must be above 0, got ${rotationSeconds}`);
    this.rotationSeconds = rotationSeconds;
    this.pitySeconds = pitySeconds;
    this.fadeSeconds = fadeSeconds;
    this.minimumDistance = minimumDistance;
    this.maximumDistance = maximumDistance;
    this.bounds = bounds;
    this.random = random;
    this.reset();
  }

  // The playable rectangle changed (a canvas resize); pickups already placed stay where they are.
  setBounds(bounds) {
    this.bounds = bounds;
  }

  reset() {
    this.pickups = [];
    this.rotationIndex = 0;
    this.rotationTimer = 0;
    this.pityTimer = 0;
  }

  get offeredType() {
    return PICKUP_TYPE_NAMES[this.rotationIndex];
  }

  update(deltaSeconds, { playerX, playerY, onBaseGun, milestone, phasePlaying, densityAt = null }) {
    if (!phasePlaying) return;

    this.rotationTimer += deltaSeconds;
    while (this.rotationTimer >= this.rotationSeconds - TIME_EPSILON) {
      this.rotationTimer -= this.rotationSeconds;
      this.rotationIndex = (this.rotationIndex + 1) % PICKUP_TYPE_NAMES.length;
    }

    for (const pickup of this.pickups) {
      pickup.age += deltaSeconds;
      pickup.fade = Math.max(0, 1 - pickup.age / this.fadeSeconds);
    }
    this.pickups = this.pickups.filter((pickup) => pickup.age < this.fadeSeconds);

    if (onBaseGun) {
      this.pityTimer += deltaSeconds;
    } else {
      this.pityTimer = 0;
    }

    if (milestone || (onBaseGun && this.pityTimer >= this.pitySeconds - TIME_EPSILON)) {
      this.spawn(playerX, playerY, densityAt, { pity: !milestone });
      this.pityTimer = 0;
    }
  }

  // Rejection-samples points on the placement annulus (16 attempts). Without densityAt the first
  // in-arena point wins; with densityAt(x, y) the lowest-density of the first 8 in-arena points wins
  // (ties go to the earlier one). If every attempt lands outside the arena it steps minimumDistance toward the arena center.
  // A pity spawn (the base-gun recovery guard) always offers a weapon: on the time warp slot it
  // takes the next slot's type instead, leaving the rotation where it is.
  spawn(playerX, playerY, densityAt = null, { pity = false } = {}) {
    const wanted = densityAt === null ? 1 : DENSITY_CANDIDATES;
    const candidates = [];
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS && candidates.length < wanted; attempt += 1) {
      const angle = this.random() * Math.PI * 2;
      const distance = this.minimumDistance + this.random() * (this.maximumDistance - this.minimumDistance);
      const x = playerX + Math.cos(angle) * distance;
      const y = playerY + Math.sin(angle) * distance;
      if (x >= this.bounds.minX && x <= this.bounds.maxX && y >= this.bounds.minY && y <= this.bounds.maxY) candidates.push({ x, y });
    }
    let chosen = null;
    if (candidates.length > 0) {
      chosen = candidates[0];
      if (densityAt !== null) {
        let lowest = densityAt(chosen.x, chosen.y);
        for (const candidate of candidates.slice(1)) {
          const density = densityAt(candidate.x, candidate.y);
          if (density < lowest) {
            lowest = density;
            chosen = candidate;
          }
        }
      }
    }
    const placed = chosen ?? this.#fallbackPlacement(playerX, playerY);
    const type = pity && this.offeredType === 'timewarp'
      ? PICKUP_TYPE_NAMES[(this.rotationIndex + 1) % PICKUP_TYPE_NAMES.length]
      : this.offeredType;
    this.pickups.push({ x: placed.x, y: placed.y, type, age: 0, fade: 1 });
  }

  // Every attempt missed the arena: step minimumDistance from the player toward the arena center
  // (always inward, so a corner player keeps the minimum distance), then clamp for tiny arenas.
  #fallbackPlacement(playerX, playerY) {
    const towardX = (this.bounds.minX + this.bounds.maxX) / 2 - playerX;
    const towardY = (this.bounds.minY + this.bounds.maxY) / 2 - playerY;
    const length = Math.hypot(towardX, towardY);
    const directionX = length === 0 ? 1 : towardX / length;
    const directionY = length === 0 ? 0 : towardY / length;
    return {
      x: Math.min(this.bounds.maxX, Math.max(this.bounds.minX, playerX + directionX * this.minimumDistance)),
      y: Math.min(this.bounds.maxY, Math.max(this.bounds.minY, playerY + directionY * this.minimumDistance)),
    };
  }

  collect(playerX, playerY, radius = 0.35) {
    let nearestIndex = -1;
    let nearestDistance = radius;
    this.pickups.forEach((pickup, index) => {
      const distance = Math.hypot(pickup.x - playerX, pickup.y - playerY);
      if (distance <= nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    if (nearestIndex < 0) return null;
    const [collected] = this.pickups.splice(nearestIndex, 1);
    return collected.type;
  }
}
