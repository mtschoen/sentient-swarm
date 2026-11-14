// Player swarm fire: each shot is ONE ship firing ONE projectile (or the recipe's small pellet
// bundle) from its own position along its own heading. Pure: no GPU, DOM or clock; randomness is
// the injected random function.
// - What a shot is comes from the armed weapon's recipe (src/game/swarm-shots.js, by kind and tier);
//   how often the swarm fires comes from the rate law (src/game/swarm-fire-rate.js): an aggregate
//   that grows with the swarm size to a per-kind exponent, divided into a per-ship interval times a
//   per-slot jitter (0.8 to 1.2, rate-neutral over the swarm). WeaponState keeps the armed kind, tier, charge, expiry and cue cadence only.
// - While the player fires, a ship fires only when its heading lies within SWARM_FIRE_CONE_RADIANS of
//   the aim and its own cooldown has run out. The heading is where the ship points, which
//   src/game/swarm-facing.js turns off its course toward the aim within a limit, so shots come from
//   ships on any course once they have turned, in a spread around the aim.
// - Cooldowns are counted in the ship's own intervals, not seconds (1 = one whole interval of the
//   weapon armed now), so a change of interval while the trigger is held (another kind or tier, a
//   grown or shrunk swarm) rescales every wait at once: counted in seconds, a ship that had just
//   fired a pulse orb kept the pulse's wait of many seconds into the base gun, and the swarm fell
//   silent. They carry their remainder: a fired ship's cooldown grows by 1 instead of resetting, so
//   the measured aggregate matches the law whatever the step length. Each ship's first shot after
//   the trigger goes down is phased by slotHash over its interval, so shots are a continuous
//   drizzle. Ready ships are served in rotation so no slot starves.
//   MAXIMUM_SWARM_SPAWNS_PER_UPDATE is a backstop for a huge delta.
// - Rail turrets: each turret volley fires once from one ship in rotation, at full size, in the
//   turrets' own directions around the aim (the turrets belong to the swarm as a whole).
// - Beam: one beam from the swarm centroid along the aim (the projectile system has one beam slot).
import { MAXIMUM_SWARM_SHIPS } from '../sim/layout.js';
import { perShipInterval } from './swarm-fire-rate.js';
import { swarmShotRecipe } from './swarm-shots.js';
import { slotHash } from './swarm-flocking.js';

export const SWARM_FIRE_CONE_RADIANS = (35 * Math.PI) / 180;
export const MAXIMUM_SWARM_SPAWNS_PER_UPDATE = 512;
const COOLDOWN_JITTER = 0.4;

// The per-slot cooldown multiplier in [1 - jitter / 2, 1 + jitter / 2].
const COOLDOWN_FACTORS = Float64Array.from({ length: MAXIMUM_SWARM_SHIPS }, (_, slot) => 1 + COOLDOWN_JITTER * (slotHash(slot, 20) - 0.5));

export class SwarmFire {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.cooldowns = new Float64Array(MAXIMUM_SWARM_SHIPS);
    this.scheduled = new Uint8Array(MAXIMUM_SWARM_SHIPS);
    this.reset();
  }

  reset() {
    this.rotation = 0;
    this.cooldowns.fill(0);
    this.scheduled.fill(0);
  }

  // fire: WeaponState.update's result for origin (its turret spawns and beam pass through);
  // ships: PlayerSwarm.ships; centroid: its centroid.
  // control: { firing, aimX, aimY, deltaSeconds, kind, tier } (kind and tier are the weapon fired).
  // Returns { spawns, turretSpawns, beam }. No ships: nothing fires.
  distribute(fire, ships, origin, centroid, { firing, aimX, aimY, deltaSeconds, kind, tier }) {
    const result = { spawns: [], turretSpawns: [], beam: null };
    const count = ships.length;
    if (count === 0) return result;
    if (!firing) this.scheduled.fill(0);
    const recipe = firing ? swarmShotRecipe(kind, tier) : null;
    if (recipe !== null) this.fireShips(result.spawns, ships, Math.atan2(aimY, aimX), recipe, deltaSeconds);
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

  fireShips(spawns, ships, aimAngle, recipe, deltaSeconds) {
    const count = ships.length;
    // The jitter is rate-neutral: the intervals are scaled so the ships' rates still sum to the law.
    let inverseSum = 0;
    for (const ship of ships) inverseSum += 1 / COOLDOWN_FACTORS[ship.slot];
    const interval = (perShipInterval(recipe.baseShotsPerSecond, recipe.exponent, count) * inverseSum) / count;
    for (const ship of ships) {
      if (this.scheduled[ship.slot] === 1) {
        // This step's share of the ship's interval. A remainder is at most one step: a waiting
        // ship does not bank shots.
        const elapsed = deltaSeconds / (interval * COOLDOWN_FACTORS[ship.slot]);
        this.cooldowns[ship.slot] = Math.max(-elapsed, this.cooldowns[ship.slot] - elapsed);
        continue;
      }
      // Phase every ship that has not been scheduled since the trigger went down.
      this.scheduled[ship.slot] = 1;
      this.cooldowns[ship.slot] = slotHash(ship.slot, 21);
    }
    const start = this.rotation % count;
    let last = -1;
    for (let visited = 0; visited < count; visited += 1) {
      const index = (start + visited) % count;
      const ship = ships[index];
      if (this.cooldowns[ship.slot] > 0) continue;
      let offset = ship.heading - aimAngle;
      offset -= 2 * Math.PI * Math.round(offset / (2 * Math.PI));
      if (Math.abs(offset) > SWARM_FIRE_CONE_RADIANS) continue;
      if (spawns.length + recipe.pelletCount > MAXIMUM_SWARM_SPAWNS_PER_UPDATE) break;
      this.cooldowns[ship.slot] += 1;
      this.appendShot(spawns, ship, recipe);
      last = index;
    }
    if (last >= 0) this.rotation = (last + 1) % count;
  }

  // One ship shot: pelletCount projectiles in a fanRadians fan about the ship's heading, the whole
  // fan turned by one random jitter of at most jitterRadians either way.
  appendShot(spawns, ship, recipe) {
    const { pelletCount, fanRadians, jitterRadians, speed } = recipe;
    const heading = ship.heading + (this.random() * 2 - 1) * jitterRadians;
    for (let index = 0; index < pelletCount; index += 1) {
      const centered = index - (pelletCount - 1) / 2;
      const angle = pelletCount === 1 ? heading : heading + (centered / (pelletCount - 1)) * fanRadians;
      spawns.push({
        x: ship.x,
        y: ship.y,
        velocityX: Math.cos(angle) * speed,
        velocityY: Math.sin(angle) * speed,
        radius: recipe.radius,
        lifetime: recipe.lifetime,
        kind: recipe.kind,
        seed: this.random(),
        extra: recipe.extra,
      });
    }
  }
}
