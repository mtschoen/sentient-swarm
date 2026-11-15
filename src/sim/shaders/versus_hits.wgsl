// Versus hits (stage 2): projectiles owned by one seat against the other seat's swarm ships, one
// thread per projectile slot, run after player_collide.wgsl in a step whose simulation has versus
// projectiles set (Simulation.setVersusProjectiles; never in solo or co-op). The ships are the
// contact pass's own uniform (the same buffer, written for this step), so a slot's alive state, its
// seat's armed bit and its hit bit mean what they mean there: the contact pass has already cleared
// the bits of dead and fresh slots this step.
//
// A projectile with an owner (flag bits 2 and 3, projectileOwner) tests the opposing seat's alive
// ships whose hit bit is clear, when that seat is armed. A ship is claimed by setting its hit bit
// with atomicOr on the persistent swarm hit mask: only the claim that saw the bit clear kills it,
// so two projectiles never kill one ship and a ship already hit (by an agent or a projectile, still
// waiting for the CPU to read it back) never absorbs a shot; a lost claim goes on to the next ship.
// The CPU kills a claimed ship exactly as one an agent touched (PlayerSwarm.applyHits). Each thread
// is the only writer of its own projectile, so stopping it needs no atomic. Per kind:
// - capsule kinds (bullet, scatter, rail, pulse orb, sidewinder): the segment from previousPosition
//   to position with reach radius + ship radius + HIT_MARGIN; the first ship claimed stops the
//   projectile (alive bit cleared): PvP shots never pierce, and an orb or a sidewinder that hits a
//   ship stops without a ring.
// - pulse ring: the band swept this step, [radius - band, radius] widened by the ship radius (the
//   collide pass's band), so a ship is in it once as the front passes; at most one ship per ring
//   per step, and the ring goes on.
// - beam (its seat's slot): the current ray from its origin, half width radius plus the ship
//   radius, out past the world (ships never leave it); on every BEAM_HIT_STEP_INTERVAL-th step only
//   it claims the hittable ship nearest its origin, so a beam kills at most 10 opposing ships a
//   second at 60 steps a second.
//
// Storage buffers: projectiles, stats = 2; uniforms: params, swarm.

struct SwarmShip {
  position: vec2f,
  // Bit 0 alive, bit 1 fresh (the slot's first uploaded step).
  state: u32,
  padding: u32,
}

struct Swarm {
  radius: f32,
  armedSeats: u32,
  paddingOne: u32,
  paddingTwo: u32,
  ships: array<SwarmShip, MAXIMUM_CONTACT_SLOTS>,
}

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<uniform> swarm: Swarm;
@group(0) @binding(2) var<storage, read_write> projectiles: array<Projectile>;
@group(0) @binding(3) var<storage, read_write> stats: array<atomic<u32>, STATS_WORD_COUNT>;

const MAXIMUM_CONTACT_SLOTS: u32 = __MAXIMUM_CONTACT_SLOTS__u;
const SHIP_ALIVE: u32 = 1u;
const HIT_MARGIN: f32 = 0.02;
// The collide pass's minimum ring band (projectiles_collide.wgsl).
const RING_MINIMUM_BAND: f32 = 0.08;
const BEAM_HIT_STEP_INTERVAL: u32 = 6u;
// Longer than the world's diagonal: the beam's ray reaches every ship.
const BEAM_RAY_LENGTH: f32 = 64.0;
const NO_SHIP: u32 = 0xffffffffu;

fn distanceToSegment(point: vec2f, start: vec2f, end: vec2f) -> f32 {
  let along = end - start;
  let lengthSquared = dot(along, along);
  var t = 0.0;
  if (lengthSquared > 0.0) {
    t = clamp(dot(point - start, along) / lengthSquared, 0.0, 1.0);
  }
  return distance(point, start + along * t);
}

fn hitWord(slot: u32) -> u32 {
  return STAT_SWARM_HIT_MASK + slot / 32u;
}

fn hitBit(slot: u32) -> u32 {
  return 1u << (slot % 32u);
}

// Alive and not yet hit (a cheap read before the claim).
fn hittable(slot: u32) -> bool {
  return (swarm.ships[slot].state & SHIP_ALIVE) != 0u && (atomicLoad(&stats[hitWord(slot)]) & hitBit(slot)) == 0u;
}

// True when this call set the slot's hit bit (the ship is this projectile's kill).
fn claim(slot: u32) -> bool {
  let bit = hitBit(slot);
  return (atomicOr(&stats[hitWord(slot)], bit) & bit) == 0u;
}

// The first ship of [first, first + MAXIMUM_SWARM_SHIPS) within reach of the segment that this call
// claims, or NO_SHIP.
fn claimOnSegment(first: u32, start: vec2f, end: vec2f, reach: f32) -> u32 {
  for (var slot = first; slot < first + MAXIMUM_SWARM_SHIPS; slot = slot + 1u) {
    if (hittable(slot) && distanceToSegment(swarm.ships[slot].position, start, end) <= reach && claim(slot)) {
      return slot;
    }
  }
  return NO_SHIP;
}

fn claimInBand(first: u32, center: vec2f, inner: f32, outer: f32) {
  for (var slot = first; slot < first + MAXIMUM_SWARM_SHIPS; slot = slot + 1u) {
    if (hittable(slot)) {
      let separation = distance(swarm.ships[slot].position, center);
      if (separation >= inner - swarm.radius && separation <= outer + swarm.radius && claim(slot)) {
        return;
      }
    }
  }
}

// The hittable ship nearest the beam's origin within reach of its ray, claimed when it can be.
fn claimOnBeam(first: u32, origin: vec2f, direction: vec2f, reach: f32) {
  let end = origin + direction * BEAM_RAY_LENGTH;
  var nearest = NO_SHIP;
  var nearestAlong = BEAM_RAY_LENGTH;
  for (var slot = first; slot < first + MAXIMUM_SWARM_SHIPS; slot = slot + 1u) {
    if (hittable(slot)) {
      let position = swarm.ships[slot].position;
      let along = dot(position - origin, direction);
      if (distanceToSegment(position, origin, end) <= reach && along < nearestAlong) {
        nearest = slot;
        nearestAlong = along;
      }
    }
  }
  if (nearest != NO_SHIP) {
    _ = claim(nearest);
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let slot = globalId.x;
  if (slot >= arrayLength(&projectiles)) {
    return;
  }
  let projectile = projectiles[slot];
  let owner = projectileOwner(projectile.flags);
  if ((projectile.flags & PROJECTILE_FLAG_ALIVE) == 0u || owner == NO_PROJECTILE_OWNER) {
    return;
  }
  // Owner 1 is seat 0, whose shots hit seat 1, and the other way round.
  let targetSeat = 2u - owner;
  if (((swarm.armedSeats >> targetSeat) & 1u) == 0u) {
    return;
  }
  let first = targetSeat * MAXIMUM_SWARM_SHIPS;
  if (projectile.kind == PROJECTILE_KIND_BEAM) {
    if (params.frameSequence % BEAM_HIT_STEP_INTERVAL == 0u) {
      claimOnBeam(first, projectile.position, projectile.velocity, projectile.radius + swarm.radius);
    }
    return;
  }
  if (projectile.kind == PROJECTILE_KIND_PULSE_RING) {
    let band = max(RING_MINIMUM_BAND, projectile.extra * params.projectileDt);
    claimInBand(first, projectile.position, max(0.0, projectile.radius - band), projectile.radius);
    return;
  }
  let reach = projectile.radius + swarm.radius + HIT_MARGIN;
  if (claimOnSegment(first, projectile.previousPosition, projectile.position, reach) != NO_SHIP) {
    projectiles[slot].flags = projectile.flags & ~PROJECTILE_FLAG_ALIVE;
  }
}
