// Player swarm fire (player-swarm spike): turns one WeaponState.update result, fired from the
// controlled point, into the swarm's shots. Pure: no GPU, DOM or clock.
// - Armed weapon spawns: each firing update a rotating subset of the alive ships fires a copy of the
//   volley from its own position along the same aim, with every projectile's radius times
//   SWARM_PROJECTILE_RADIUS_SCALE. The subset is SWARM_FIRING_SHARE of the ships (at least one),
//   capped at MAXIMUM_SWARM_SHOOTERS_PER_VOLLEY, taken in rotation so every ship takes turns. So
//   firepower grows with the swarm and then saturates: the starting 12 ships put out 3 half-size
//   copies (about 1.5 times the single ship's swept width), 64 or more put out 16 (about 8 times),
//   and a 256-ship swarm shoots no more than a 64-ship one. The worst live load is scatter III, 16
//   copies of 17 balls every 0.2 s for at most 3 s, about 4080 of the pool's 8192 slots; the
//   per-update ceiling MAXIMUM_SWARM_SPAWNS_PER_UPDATE (16 by 17 = 272 fits under it) is only a
//   backstop for a huge delta.
// - Rail turrets: each turret volley fires from one ship in the same rotation, at full size (the
//   turrets belong to the swarm as a whole, so their count does not multiply).
// - Beam: one beam from the swarm centroid (the projectile system has one beam slot).
export const SWARM_FIRING_SHARE = 0.25;
export const SWARM_PROJECTILE_RADIUS_SCALE = 0.5;
export const MAXIMUM_SWARM_SHOOTERS_PER_VOLLEY = 16;
export const MAXIMUM_SWARM_SPAWNS_PER_UPDATE = 512;

export class SwarmFire {
  constructor() {
    this.rotation = 0;
  }

  reset() {
    this.rotation = 0;
  }

  // fire: WeaponState.update's result for origin; ships: PlayerSwarm.ships; centroid: its centroid.
  // Returns { spawns, turretSpawns, beam }. No ships: nothing fires.
  distribute(fire, ships, origin, centroid) {
    const result = { spawns: [], turretSpawns: [], beam: null };
    const count = ships.length;
    if (count === 0) return result;
    if (fire.spawns.length > 0) {
      const firing = Math.min(MAXIMUM_SWARM_SHOOTERS_PER_VOLLEY, Math.max(1, Math.round(count * SWARM_FIRING_SHARE)));
      for (let index = 0; index < firing && result.spawns.length < MAXIMUM_SWARM_SPAWNS_PER_UPDATE; index += 1) {
        const ship = ships[(this.rotation + index) % count];
        for (const spawn of fire.spawns) {
          if (result.spawns.length === MAXIMUM_SWARM_SPAWNS_PER_UPDATE) break;
          result.spawns.push({
            ...spawn,
            x: spawn.x - origin.x + ship.x,
            y: spawn.y - origin.y + ship.y,
            radius: spawn.radius * SWARM_PROJECTILE_RADIUS_SCALE,
          });
        }
      }
      this.rotation = (this.rotation + firing) % count;
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
}
