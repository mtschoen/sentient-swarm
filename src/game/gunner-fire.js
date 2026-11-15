// Rail gunner fire: every ship marked as a gunner (gunnerIndex >= 0) fires its own rail needles
// from its own position along its own heading, one volley per rail interval while the player fires
// along a nonzero aim. Pure: no GPU, DOM or clock; time comes in as deltaSeconds and randomness is
// the injected random function.
// - Cooldowns are counted in intervals and carry their remainder (a fired gunner's cooldown grows
//   by 1), so the measured rate matches the interval whatever the step length. A waiting gunner
//   banks at most one step, and one update fires at most one volley per gunner, so a huge
//   deltaSeconds (a stalled tab) is one volley, not a backlog.
// - The first volley after fire goes down (or reset) is phased by slotHash over the interval, so
//   the gunners do not fire in lockstep.
import { MAXIMUM_SWARM_SHIPS } from '../sim/layout.js';
import { gunnerShotRecipe } from './swarm-shots.js';
import { slotHash } from './swarm-hash.js';

export class GunnerFire {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.cooldowns = new Float64Array(MAXIMUM_SWARM_SHIPS);
    this.scheduled = new Uint8Array(MAXIMUM_SWARM_SHIPS);
    this.reset();
  }

  reset() {
    this.cooldowns.fill(0);
    this.scheduled.fill(0);
  }

  // ships: PlayerSwarm.ships entries ({ slot, x, y, heading, gunnerIndex }). Returns the spawns.
  fire(ships, { firing, aimX, aimY, deltaSeconds, railTier = 1 }) {
    const spawns = [];
    if (!firing || Math.hypot(aimX, aimY) === 0) {
      this.scheduled.fill(0);
      return spawns;
    }
    const recipe = gunnerShotRecipe(railTier);
    const elapsed = deltaSeconds / recipe.intervalSeconds;
    for (const ship of ships) {
      if (ship.gunnerIndex < 0) continue;
      if (this.scheduled[ship.slot] === 0) {
        this.scheduled[ship.slot] = 1;
        this.cooldowns[ship.slot] = slotHash(ship.slot, 22);
        continue;
      }
      this.cooldowns[ship.slot] = Math.max(-elapsed, this.cooldowns[ship.slot] - elapsed);
      if (this.cooldowns[ship.slot] > 0) continue;
      this.cooldowns[ship.slot] += 1;
      this.appendVolley(spawns, ship, recipe);
    }
    return spawns;
  }

  appendVolley(spawns, ship, recipe) {
    const directionX = Math.cos(ship.heading);
    const directionY = Math.sin(ship.heading);
    for (let index = 0; index < recipe.needleCount; index += 1) {
      const offset = (index - (recipe.needleCount - 1) / 2) * recipe.parallelOffset;
      spawns.push({
        x: ship.x - directionY * offset,
        y: ship.y + directionX * offset,
        velocityX: directionX * recipe.speed,
        velocityY: directionY * recipe.speed,
        radius: recipe.radius,
        lifetime: recipe.lifetime,
        kind: recipe.kind,
        seed: this.random(),
        extra: recipe.extra,
      });
    }
  }
}
