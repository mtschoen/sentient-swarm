// Player swarm flocking (player-swarm spike): the enemy Chaser's steering rules (steer.wgsl with the
// Chaser row of src/sim/species.js) ported to the CPU for the player's ships, rescaled to their size
// and speed; the controlled point anchors the seek targets and the leash. Every ship is its own agent; it never
// stops (speed floor) and turns within its acceleration budget, so paths are arcs.
//
// What makes the Chaser's tendrils, and is kept here: alignment (average neighbour velocity, weight
// above 1) outweighs seek, so ships follow the ships in front of them and queue into streams; the
// steering acceleration is capped at maximumTurn times maximumSpeed, so a stream cannot turn sharply
// and overshoots, loops and re-forms; seek brakes on arrival and fades to nothing inside the comfort
// radius, so near its target only alignment and wander carry a ship through; separation is short
// range and linear; cohesion fades as the neighbourhood fills and pressure pushes out of a crowd, so
// dense knots spread into ribbons instead of a ball.
//
// Desired velocity, as in steer.wgsl (weights times directions of length at most 1 times the ship's
// maximum speed, except alignment, which is a velocity):
//   seek toward the ship's roam group waypoint (arrival braking, comfort fade) * seek
// + average separation within SWARM_NEIGHBOR_RADIUS (linear falloff) * separation * maximumSpeed
// + average neighbour velocity within SWARM_NEIGHBOR_RADIUS * alignment
// + cohesion toward the average position within SWARM_COHESION_RADIUS, faded by
//   1 - neighbours / SWARM_COMFORT_NEIGHBORS (stands in for the coarse density gradient and fade)
// - pressure away from that centre, pressure * (neighbours / comfort - 1) up to 2, when crowded
//   (stands in for the coarse field pressure term);
// the coarse field's matrix and flee terms are dropped (no other species, no threat field here).
// Added for the player (not in the Chaser rules): roaming waypoints per slot group (below), a
// per-slot wander, the leash (weight (distance /
// home radius) squared toward the point: weak inside the home region, firm outside it), the attack
// bias along the aim while firing (strongest at the point, gone SWARM_ATTACK_REACH home radii out),
// catch-up (maximum speed and acceleration grow by SWARM_CATCH_UP per home radius beyond the first)
// and the speed floor. Steering = (desired - velocity) * SWARM_STEERING_RESPONSE, clamped to
// maximumTurn * maximumSpeed; speed clamped to [floor, maximumSpeed].
// Per-slot temperament (speed, turn, alignment, cohesion hold, wander, leash) comes from slotHash.
// Pure and allocation-free: no GPU, DOM, clock or random numbers; neighbours are an all-pairs loop
// with a squared-distance early-out (65536 pairs at 256 ships), averaged, never summed.

// Chaser row: seek 0.6, cohesion 0.5, alignment 1.4, separation 0.9, maximumSpeed 4.5,
// maximumTurn 0.9, pressure 0.6, flee 0.4 (dropped); steer.wgsl: STEERING_RESPONSE 4,
// ARRIVAL_BRAKING 0.7, comfort radius 1, neighbour radius 0.1 (the default grid). Kept as is:
// seek, cohesion, separation, pressure, the response and the braking. Alignment is raised to 2.2
// (with the neighbour average capped at the ship's cruise speed): at 1.4 a 64 to 256 ship flock
// settled into a round disc instead of streams.
export const SWARM_SEEK = 0.6;
export const SWARM_COHESION = 0.5;
export const SWARM_ALIGNMENT = 2.2;
export const SWARM_SEPARATION = 0.9;
export const SWARM_PRESSURE = 0.6;
export const SWARM_STEERING_RESPONSE = 4;
export const SWARM_ARRIVAL_BRAKING = 0.7;
// Rescaled for the player ships: cruise speed (the Chaser runs at 4.5 across the whole arena), and
// maximumTurn raised so the turn radius at cruise (speed / maximumTurn) is about 0.37 units instead
// of the Chaser's 5: well under the home radius, so a ship can make passes through the flock's
// region rather than only circle it.
export const SWARM_CRUISE_SPEED = 2.2;
export const SWARM_MAXIMUM_TURN = 6;
// Separation and alignment range; cohesion and pressure look further (the coarse field's stand-in).
export const SWARM_NEIGHBOR_RADIUS = 0.3;
export const SWARM_COHESION_RADIUS = 0.8;
// Neighbours within the cohesion radius at which cohesion fades out and pressure starts.
export const SWARM_COMFORT_NEIGHBORS = 40;
const PRESSURE_MAXIMUM_MULTIPLE = 2;
// Player additions.
export const SWARM_WANDER = 0.35;
export const SWARM_LEASH = 0.8;
export const SWARM_ATTACK = 2.5;
export const SWARM_ATTACK_REACH = 2;
export const SWARM_CATCH_UP = 2.5;
export const SWARM_SPEED_FLOOR = 0.5;
// Roaming: the ships fall into SWARM_ROAM_GROUPS groups by slot; each group seeks its own waypoint,
// placed within SWARM_ROAM_REACH home radii of the point and moved every SWARM_ROAM_SECONDS (each
// group on its own phase), so sub-flocks stream across and past the point toward different spots
// instead of all orbiting one centre (seek straight at the point, as the Chaser does, makes a small
// flock mill around it in a ring).
export const SWARM_ROAM_GROUPS = 8;
export const SWARM_ROAM_REACH = 1.4;
export const SWARM_ROAM_SECONDS = 2.5;
// Radians per second a group's shuttle axis turns at most (either way).
export const SWARM_ROAM_AXIS_TURN = 0.2;
// Seek's comfort radius around a waypoint (the Chaser's is 1 around the ship).
export const SWARM_ROAM_COMFORT = 0.15;
// Home radius (also the leash's unit) for a 12-ship swarm, grown by
// max(1, sqrt(alive / 12) * SWARM_HOME_SPREAD).
export const SWARM_HOME_RADIUS = 0.75;
export const SWARM_HOME_SPREAD = 0.6;
// World units per second; the controlled point moves at 6.
export const SWARM_MAXIMUM_SPEED = 11;
const REFERENCE_SHIPS = 12;
const TWO_PI = Math.PI * 2;
const EPSILON = 1e-9;

// A deterministic value in [0, 1) for a slot and a salt (an integer hash, no shared state).
export function slotHash(slot, salt) {
  let value = Math.imul(slot + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

// The per-slot temperament, from the slot index alone: some ships are quicker, wider ranging or
// keener followers than others.
export function temperamentFor(slot) {
  return {
    cruiseSpeed: SWARM_CRUISE_SPEED * (0.8 + 0.4 * slotHash(slot, 1)),
    maximumTurn: SWARM_MAXIMUM_TURN * (0.75 + 0.5 * slotHash(slot, 2)),
    alignmentScale: 0.8 + 0.4 * slotHash(slot, 3),
    flockHold: 0.5 + 1 * slotHash(slot, 4),
    wander: 0.5 + 1 * slotHash(slot, 5),
    wanderRateOne: 0.35 + 0.5 * slotHash(slot, 6),
    wanderRateTwo: 0.9 + 0.8 * slotHash(slot, 7),
    wanderPhaseOne: slotHash(slot, 8) * TWO_PI,
    wanderPhaseTwo: slotHash(slot, 9) * TWO_PI,
    leash: 0.7 + 0.6 * slotHash(slot, 10),
    roamGroup: slot % SWARM_ROAM_GROUPS,
  };
}

// The home radius for this many alive ships.
export function homeRadiusFor(aliveCount) {
  return SWARM_HOME_RADIUS * Math.max(1, Math.sqrt(aliveCount / REFERENCE_SHIPS) * SWARM_HOME_SPREAD);
}

// Advances every alive slot by deltaSeconds. slots carry x, y, velocityX, velocityY, heading plus a
// temperament; context: { targetX, targetY, firing, aimX, aimY (unit or zero), time, aliveCount,
// bounds, margin }. Heading follows the velocity.
export function flockStep(slots, deltaSeconds, { targetX, targetY, firing, aimX, aimY, time, aliveCount, bounds, margin }) {
  const home = homeRadiusFor(aliveCount);
  const neighborSquared = SWARM_NEIGHBOR_RADIUS * SWARM_NEIGHBOR_RADIUS;
  const cohesionSquared = SWARM_COHESION_RADIUS * SWARM_COHESION_RADIUS;
  const attacking = firing && (aimX !== 0 || aimY !== 0);
  // Velocities as of the start of the step, so alignment does not depend on slot order.
  for (const ship of slots) {
    if (!ship.alive) continue;
    ship.previousVelocityX = ship.velocityX;
    ship.previousVelocityY = ship.velocityY;
  }
  for (const ship of slots) {
    if (!ship.alive) continue;
    let separationX = 0;
    let separationY = 0;
    let alignmentX = 0;
    let alignmentY = 0;
    let nearCount = 0;
    let alignedCount = 0;
    let centerX = 0;
    let centerY = 0;
    let farCount = 0;
    for (const other of slots) {
      if (other === ship || !other.alive) continue;
      const offsetX = other.x - ship.x;
      const offsetY = other.y - ship.y;
      const distanceSquared = offsetX * offsetX + offsetY * offsetY;
      if (distanceSquared >= cohesionSquared || distanceSquared < EPSILON) continue;
      farCount += 1;
      centerX += offsetX;
      centerY += offsetY;
      if (distanceSquared >= neighborSquared) continue;
      const distance = Math.sqrt(distanceSquared);
      const falloff = (1 - distance / SWARM_NEIGHBOR_RADIUS) / distance;
      separationX -= offsetX * falloff;
      separationY -= offsetY * falloff;
      nearCount += 1;
      // Alignment only within the roam group, as steer.wgsl aligns only within a species: groups
      // cross through each other instead of locking into one shared mill.
      if (other.roamGroup === ship.roamGroup) {
        alignmentX += other.previousVelocityX;
        alignmentY += other.previousVelocityY;
        alignedCount += 1;
      }
    }
    const towardX = targetX - ship.x;
    const towardY = targetY - ship.y;
    const distance = Math.hypot(towardX, towardY);
    const reach = distance / home;
    // The group's current waypoint (an epoch index hashed into an angle and a radius).
    const epoch = Math.floor(time / SWARM_ROAM_SECONDS + slotHash(ship.roamGroup, 30));
    // Each group shuttles between the two ends of its own slowly turning axis, so it makes passes
    // through the point's region instead of circling it.
    const axis = slotHash(ship.roamGroup, 31) * TWO_PI + SWARM_ROAM_AXIS_TURN * (slotHash(ship.roamGroup, 32) * 2 - 1) * time;
    const roamAngle = axis + Math.PI * (epoch % 2) + 0.6 * (slotHash(ship.roamGroup, 1000 + epoch) - 0.5);
    const roamRadius = (0.6 + 0.4 * slotHash(ship.roamGroup, 2000 + epoch)) * SWARM_ROAM_REACH * home;
    const waypointX = targetX + Math.cos(roamAngle) * roamRadius - ship.x;
    const waypointY = targetY + Math.sin(roamAngle) * roamRadius - ship.y;
    const waypointDistance = Math.hypot(waypointX, waypointY);
    const excess = Math.max(0, reach - 1);
    const maximumSpeed = Math.min(SWARM_MAXIMUM_SPEED, ship.cruiseSpeed * (1 + SWARM_CATCH_UP * excess));
    const maximumAcceleration = ship.maximumTurn * maximumSpeed;
    let desiredX = 0;
    let desiredY = 0;
    if (waypointDistance > EPSILON) {
      // Seek (seekVelocity in steer.wgsl) toward the group's waypoint.
      const braking = SWARM_ARRIVAL_BRAKING * Math.sqrt(2 * maximumAcceleration * waypointDistance);
      const seek = Math.min(maximumSpeed, braking) * smoothstep(0, SWARM_ROAM_COMFORT, waypointDistance) * SWARM_SEEK;
      desiredX += (waypointX / waypointDistance) * seek;
      desiredY += (waypointY / waypointDistance) * seek;
    }
    if (distance > EPSILON) {
      // The leash toward the point itself.
      const seek = SWARM_LEASH * ship.leash * reach * reach * maximumSpeed;
      desiredX += (towardX / distance) * seek;
      desiredY += (towardY / distance) * seek;
    }
    if (nearCount > 0) {
      desiredX += (separationX / nearCount) * SWARM_SEPARATION * maximumSpeed;
      desiredY += (separationY / nearCount) * SWARM_SEPARATION * maximumSpeed;
    }
    if (alignedCount > 0) {
      // The average neighbour velocity, capped at this ship's cruise speed: the Chaser's maximum
      // speed is fixed, so its alignment above 1 saturates there; here the maximum grows with the
      // catch-up, and an uncapped average would feed on itself.
      const averageVelocityX = alignmentX / alignedCount;
      const averageVelocityY = alignmentY / alignedCount;
      const averageSpeed = Math.hypot(averageVelocityX, averageVelocityY);
      const alignment = SWARM_ALIGNMENT * ship.alignmentScale * Math.min(1, ship.cruiseSpeed / Math.max(averageSpeed, EPSILON));
      desiredX += averageVelocityX * alignment;
      desiredY += averageVelocityY * alignment;
    }
    if (farCount > 0) {
      const averageX = centerX / farCount;
      const averageY = centerY / farCount;
      const averageLength = Math.hypot(averageX, averageY);
      if (averageLength > EPSILON) {
        const crowd = farCount / SWARM_COMFORT_NEIGHBORS;
        const cohesion = SWARM_COHESION * ship.flockHold * Math.max(0, 1 - crowd);
        const pressure = Math.min(SWARM_PRESSURE * Math.max(0, crowd - 1), PRESSURE_MAXIMUM_MULTIPLE);
        const weight = (cohesion - pressure) * maximumSpeed * Math.min(1, averageLength / SWARM_COHESION_RADIUS) / averageLength;
        desiredX += averageX * weight;
        desiredY += averageY * weight;
      }
    }
    const swing = ship.wander * (0.7 * Math.sin(time * ship.wanderRateOne + ship.wanderPhaseOne) + 0.3 * Math.sin(time * ship.wanderRateTwo + ship.wanderPhaseTwo));
    desiredX += Math.cos(ship.heading + swing * 1.5) * SWARM_WANDER * maximumSpeed;
    desiredY += Math.sin(ship.heading + swing * 1.5) * SWARM_WANDER * maximumSpeed;
    if (attacking) {
      const proximity = Math.max(0, 1 - reach / SWARM_ATTACK_REACH);
      desiredX += aimX * SWARM_ATTACK * proximity * maximumSpeed;
      desiredY += aimY * SWARM_ATTACK * proximity * maximumSpeed;
    }
    let steeringX = (desiredX - ship.velocityX) * SWARM_STEERING_RESPONSE;
    let steeringY = (desiredY - ship.velocityY) * SWARM_STEERING_RESPONSE;
    const steeringLength = Math.hypot(steeringX, steeringY);
    if (steeringLength > maximumAcceleration) {
      steeringX *= maximumAcceleration / steeringLength;
      steeringY *= maximumAcceleration / steeringLength;
    }
    ship.velocityX += steeringX * deltaSeconds;
    ship.velocityY += steeringY * deltaSeconds;
    let speed = Math.hypot(ship.velocityX, ship.velocityY);
    const floor = SWARM_SPEED_FLOOR * ship.cruiseSpeed;
    if (speed < EPSILON) {
      ship.velocityX = Math.cos(ship.heading) * floor;
      ship.velocityY = Math.sin(ship.heading) * floor;
      speed = floor;
    }
    const clamped = Math.min(maximumSpeed, Math.max(floor, speed));
    ship.velocityX *= clamped / speed;
    ship.velocityY *= clamped / speed;
    ship.heading = Math.atan2(ship.velocityY, ship.velocityX);
    ship.x = clampTo(ship.x + ship.velocityX * deltaSeconds, bounds.minX + margin, bounds.maxX - margin);
    ship.y = clampTo(ship.y + ship.velocityY * deltaSeconds, bounds.minY + margin, bounds.maxY - margin);
  }
}

function smoothstep(edgeZero, edgeOne, value) {
  const fraction = clampTo((value - edgeZero) / (edgeOne - edgeZero), 0, 1);
  return fraction * fraction * (3 - 2 * fraction);
}

function clampTo(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
