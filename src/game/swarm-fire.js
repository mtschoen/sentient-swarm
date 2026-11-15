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
// - Rail turrets are gunner ships (gunnerIndex >= 0, marked by PlayerSwarm): GunnerFire
//   (src/game/gunner-fire.js) fires their needles from their own positions along their own
//   headings, whatever else is armed, including the beam. Gunners never fire the armed weapon: the
//   rate law's aggregate is still that of ALL the ships, so promoting gunners does not cut the main
//   weapon's firepower, but it is spread over the other ships only (all gunners: it is quiet).
// - Beam: one beam from the centroid of the non-gunner ships (the controlled point when there are
//   none) along the aim (the projectile system has one beam slot).
// - report describes the newest distribute for the fire log (src/game/fire-log.js): the ships, how
//   many of the non-gunners point inside the cone, how many of them are off cooldown, the ship shots
//   fired and the aggregate rate the law gives (0 while nothing is due to fire).
import { MAXIMUM_SWARM_SHIPS } from '../sim/layout.js';
import { perShipInterval } from './swarm-fire-rate.js';
import { swarmShotRecipe } from './swarm-shots.js';
import { slotHash } from './swarm-flocking.js';
import { GunnerFire } from './gunner-fire.js';

export const SWARM_FIRE_CONE_RADIANS = (35 * Math.PI) / 180;
export const MAXIMUM_SWARM_SPAWNS_PER_UPDATE = 512;
const COOLDOWN_JITTER = 0.4;

// The per-slot cooldown multiplier in [1 - jitter / 2, 1 + jitter / 2].
const COOLDOWN_FACTORS = Float64Array.from({ length: MAXIMUM_SWARM_SHIPS }, (_, slot) => 1 + COOLDOWN_JITTER * (slotHash(slot, 20) - 0.5));

// The mean position of the ships that are not gunners, or point when there are none.
function shooterCentroid(ships, point) {
  let sumX = 0;
  let sumY = 0;
  let shooters = 0;
  for (const ship of ships) {
    if (ship.gunnerIndex >= 0) continue;
    sumX += ship.x;
    sumY += ship.y;
    shooters += 1;
  }
  return shooters === 0 ? point : { x: sumX / shooters, y: sumY / shooters };
}

export class SwarmFire {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.gunnerFire = new GunnerFire({ random });
    this.cooldowns = new Float64Array(MAXIMUM_SWARM_SHIPS);
    this.scheduled = new Uint8Array(MAXIMUM_SWARM_SHIPS);
    this.report = { ships: 0, inCone: 0, ready: 0, fired: 0, shotsPerSecond: 0 };
    this.reset();
  }

  reset() {
    this.rotation = 0;
    this.gunnerFire.reset();
    this.cooldowns.fill(0);
    this.scheduled.fill(0);
  }

  // fire: WeaponState.update's result (its beam passes through; its turret spawns are not read, the
  // gunner ships fire them); ships: PlayerSwarm.ships; point: the controlled point (the beam's
  // origin when every ship is a gunner).
  // control: { firing, aimX, aimY, deltaSeconds, kind, tier, railTier } (kind and tier are the weapon
  // fired, railTier the gunners' needle tier).
  // Returns { spawns, turretSpawns, beam }. No ships: nothing fires.
  distribute(fire, ships, point, { firing, aimX, aimY, deltaSeconds, kind, tier, railTier = 1 }) {
    const result = { spawns: [], turretSpawns: [], beam: null };
    const count = ships.length;
    const report = this.report;
    report.ships = count;
    report.inCone = 0;
    report.ready = 0;
    report.fired = 0;
    report.shotsPerSecond = 0;
    if (count === 0) return result;
    if (!firing) this.scheduled.fill(0);
    const recipe = firing ? swarmShotRecipe(kind, tier) : null;
    if (recipe !== null) this.fireShips(result.spawns, ships, Math.atan2(aimY, aimX), recipe, deltaSeconds);
    result.turretSpawns = this.gunnerFire.fire(ships, { firing, aimX, aimY, deltaSeconds, railTier });
    if (fire.beam !== null) {
      const origin = shooterCentroid(ships, point);
      result.beam = { ...fire.beam, x: origin.x, y: origin.y };
    }
    return result;
  }

  fireShips(spawns, ships, aimAngle, recipe, deltaSeconds) {
    const count = ships.length;
    // The jitter is rate-neutral: the intervals are scaled so the shooters' rates still sum to the
    // law's aggregate for ALL the ships (count), which the gunners' share does not reduce.
    let inverseSum = 0;
    for (const ship of ships) if (ship.gunnerIndex < 0) inverseSum += 1 / COOLDOWN_FACTORS[ship.slot];
    const interval = (perShipInterval(recipe.baseShotsPerSecond, recipe.exponent, count) * inverseSum) / count;
    for (const ship of ships) {
      if (ship.gunnerIndex >= 0) {
        this.scheduled[ship.slot] = 0;
        continue;
      }
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
    const report = this.report;
    report.shotsPerSecond = inverseSum / interval;
    const start = this.rotation % count;
    let last = -1;
    for (let visited = 0; visited < count; visited += 1) {
      const index = (start + visited) % count;
      const ship = ships[index];
      if (ship.gunnerIndex >= 0) continue;
      const ready = this.cooldowns[ship.slot] <= 0;
      let offset = ship.heading - aimAngle;
      offset -= 2 * Math.PI * Math.round(offset / (2 * Math.PI));
      const inCone = Math.abs(offset) <= SWARM_FIRE_CONE_RADIANS;
      if (ready) report.ready += 1;
      if (inCone) report.inCone += 1;
      if (!ready || !inCone) continue;
      if (spawns.length + recipe.pelletCount > MAXIMUM_SWARM_SPAWNS_PER_UPDATE) break;
      this.cooldowns[ship.slot] += 1;
      this.appendShot(spawns, ship, recipe);
      report.fired += 1;
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
