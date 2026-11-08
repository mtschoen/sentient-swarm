// Pickup director: rotates the offered pickup type (the weapons, then the time warp) and spawns
// pickups on milestones and the recovery guard.
import { PICKUP_TYPE_NAMES } from './weaponTypes.js';
import { ARENA_WIDTH, ARENA_HEIGHT } from '../sim/layout.js';

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
    arenaWidth = ARENA_WIDTH,
    arenaHeight = ARENA_HEIGHT,
    random = Math.random,
  } = {}) {
    this.rotationSeconds = rotationSeconds;
    this.pitySeconds = pitySeconds;
    this.fadeSeconds = fadeSeconds;
    this.minimumDistance = minimumDistance;
    this.maximumDistance = maximumDistance;
    this.arenaWidth = arenaWidth;
    this.arenaHeight = arenaHeight;
    this.random = random;
    this.reset();
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
      this.spawn(playerX, playerY, densityAt);
      this.pityTimer = 0;
    }
  }

  // Rejection-samples points on the placement annulus (16 attempts). Without densityAt the first
  // in-arena point wins; with densityAt(x, y) the lowest-density of the first 8 in-arena points wins
  // (ties go to the earlier one). Clamps only if every attempt lands outside the arena.
  spawn(playerX, playerY, densityAt = null) {
    const wanted = densityAt === null ? 1 : DENSITY_CANDIDATES;
    const candidates = [];
    let x = playerX;
    let y = playerY;
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS && candidates.length < wanted; attempt += 1) {
      const angle = this.random() * Math.PI * 2;
      const distance = this.minimumDistance + this.random() * (this.maximumDistance - this.minimumDistance);
      x = playerX + Math.cos(angle) * distance;
      y = playerY + Math.sin(angle) * distance;
      if (x >= 0 && x <= this.arenaWidth && y >= 0 && y <= this.arenaHeight) candidates.push({ x, y });
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
    const placed = chosen ?? {
      x: Math.min(this.arenaWidth, Math.max(0, x)),
      y: Math.min(this.arenaHeight, Math.max(0, y)),
    };
    this.pickups.push({ x: placed.x, y: placed.y, type: this.offeredType, age: 0, fade: 1 });
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
