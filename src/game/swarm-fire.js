// Player swarm fire (player-swarm spike): every swarm ship fires its own copy of the armed weapon's
// volley from its own position along its own heading. Pure: no GPU, DOM or clock.
// - The volley template is the newest volley WeaponState fired from the controlled point (so the
//   weapon keeps its tiers, charge and expiry), held in the aim's frame and rotated onto the ship's
//   heading, with every projectile's radius times SWARM_PROJECTILE_RADIUS_SCALE. A new weapon kind
//   waits for its first volley.
// - While the player fires, a ship fires only when its heading lies within SWARM_FIRE_CONE_RADIANS of
//   the aim and its own cooldown (the weapon's fire interval times SWARM_COOLDOWN_SCALE, with a
//   per-slot jitter and phase from slotHash) has run out, so shots come from the ships sweeping
//   through the aim on their attack runs, in a spread around it, staggered.
// - A global budget (a token bucket refilled at SWARM_MAXIMUM_VOLLEYS_PER_INTERVAL per fire interval,
//   holding at most SWARM_VOLLEY_BURST) bounds total firepower and pool use whatever the swarm size;
//   ready ships are served in rotation so no slot starves. MAXIMUM_SWARM_SPAWNS_PER_UPDATE is a
//   backstop for a huge delta.
// - Rail turrets: each turret volley fires once from one ship in rotation, at full size, in the
//   turrets' own directions around the aim (the turrets belong to the swarm as a whole).
// - Beam: one beam from the swarm centroid along the aim (the projectile system has one beam slot).
import { MAXIMUM_SWARM_SHIPS } from '../sim/layout.js';
import { slotHash } from './swarm-flocking.js';

export const SWARM_FIRE_CONE_RADIANS = (35 * Math.PI) / 180;
export const SWARM_PROJECTILE_RADIUS_SCALE = 0.25;
export const SWARM_COOLDOWN_SCALE = 1;
// About 12.8 volleys at 0.25 size per interval matches the 3.2 times the single ship's swept width
// that the round two swarm reached at 64 ships and above.
export const SWARM_MAXIMUM_VOLLEYS_PER_INTERVAL = 12.8;
export const SWARM_VOLLEY_BURST = 4;
export const MAXIMUM_SWARM_SPAWNS_PER_UPDATE = 512;
const COOLDOWN_JITTER = 0.4;

// The per-slot cooldown multiplier in [1 - jitter / 2, 1 + jitter / 2].
function cooldownFactor(slot) {
  return 1 + COOLDOWN_JITTER * (slotHash(slot, 20) - 0.5);
}

export class SwarmFire {
  constructor() {
    this.cooldowns = new Float64Array(MAXIMUM_SWARM_SHIPS);
    this.reset();
  }

  reset() {
    this.rotation = 0;
    this.tokens = 0;
    this.template = null;
    this.templateKind = null;
    // A per-slot phase: the first shots are staggered over one interval.
    for (let slot = 0; slot < MAXIMUM_SWARM_SHIPS; slot += 1) this.cooldowns[slot] = slotHash(slot, 21);
  }

  // The volley in the aim's frame: offsets and velocities along and across the aim.
  captureTemplate(spawns, origin, kind) {
    const centerAngle = averageAngle(spawns);
    const cosine = Math.cos(centerAngle);
    const sine = Math.sin(centerAngle);
    this.template = spawns.map((spawn) => {
      const offsetX = spawn.x - origin.x;
      const offsetY = spawn.y - origin.y;
      return {
        spawn,
        offsetAlong: offsetX * cosine + offsetY * sine,
        offsetAcross: -offsetX * sine + offsetY * cosine,
        velocityAlong: spawn.velocityX * cosine + spawn.velocityY * sine,
        velocityAcross: -spawn.velocityX * sine + spawn.velocityY * cosine,
      };
    });
    this.templateKind = kind;
  }

  // fire: WeaponState.update's result for origin; ships: PlayerSwarm.ships; centroid: its centroid.
  // control: { firing, aimX, aimY, fireInterval, deltaSeconds, kind } (kind is the weapon fired).
  // Returns { spawns, turretSpawns, beam }. No ships: nothing fires.
  distribute(fire, ships, origin, centroid, { firing, aimX, aimY, fireInterval, deltaSeconds, kind }) {
    const result = { spawns: [], turretSpawns: [], beam: null };
    for (let slot = 0; slot < MAXIMUM_SWARM_SHIPS; slot += 1) this.cooldowns[slot] = Math.max(0, this.cooldowns[slot] - deltaSeconds);
    const count = ships.length;
    if (count === 0) return result;
    if (kind !== this.templateKind) this.template = null;
    if (fire.spawns.length > 0) this.captureTemplate(fire.spawns, origin, kind);
    if (firing && fireInterval > 0 && this.template !== null) {
      this.tokens = Math.min(SWARM_VOLLEY_BURST, this.tokens + (SWARM_MAXIMUM_VOLLEYS_PER_INTERVAL * deltaSeconds) / fireInterval);
      this.fireShips(result.spawns, ships, Math.atan2(aimY, aimX), fireInterval);
    }
    if (fire.turretSpawns.length > 0) {
      const ship = ships[this.rotation % count];
      this.rotation = (this.rotation + 1) % count;
      for (const spawn of fire.turretSpawns) {
        result.turretSpawns.push({ ...spawn, x: spawn.x - origin.x + ship.x, y: spawn.y - origin.y + ship.y });
      }
    }
    if (fire.beam !== null) result.beam = { ...fire.beam, x: centroid.x, y: centroid.y };
    return result;
  }

  fireShips(spawns, ships, aimAngle, fireInterval) {
    const count = ships.length;
    const start = this.rotation % count;
    let last = -1;
    for (let visited = 0; visited < count && this.tokens >= 1; visited += 1) {
      const index = (start + visited) % count;
      const ship = ships[index];
      if (this.cooldowns[ship.slot] > 0) continue;
      let offset = ship.heading - aimAngle;
      offset -= 2 * Math.PI * Math.round(offset / (2 * Math.PI));
      if (Math.abs(offset) > SWARM_FIRE_CONE_RADIANS) continue;
      if (spawns.length + this.template.length > MAXIMUM_SWARM_SPAWNS_PER_UPDATE) break;
      this.tokens -= 1;
      this.cooldowns[ship.slot] = fireInterval * SWARM_COOLDOWN_SCALE * cooldownFactor(ship.slot);
      this.appendVolley(spawns, ship);
      last = index;
    }
    if (last >= 0) this.rotation = (last + 1) % count;
  }

  appendVolley(spawns, ship) {
    const cosine = Math.cos(ship.heading);
    const sine = Math.sin(ship.heading);
    for (const { spawn, offsetAlong, offsetAcross, velocityAlong, velocityAcross } of this.template) {
      spawns.push({
        ...spawn,
        x: ship.x + offsetAlong * cosine - offsetAcross * sine,
        y: ship.y + offsetAlong * sine + offsetAcross * cosine,
        velocityX: velocityAlong * cosine - velocityAcross * sine,
        velocityY: velocityAlong * sine + velocityAcross * cosine,
        radius: spawn.radius * SWARM_PROJECTILE_RADIUS_SCALE,
      });
    }
  }
}

// The direction of the volley's mean velocity (a fan's centre line).
function averageAngle(spawns) {
  let sumX = 0;
  let sumY = 0;
  for (const spawn of spawns) {
    sumX += spawn.velocityX;
    sumY += spawn.velocityY;
  }
  return Math.atan2(sumY, sumX);
}
