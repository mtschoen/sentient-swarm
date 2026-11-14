// Player swarm flocking (player-swarm spike): the enemy Chaser's steering rules (steer.wgsl with the
// Chaser row of src/sim/species.js) ported to the CPU for the player's ships, rescaled to their size
// and speed; the controlled point anchors the seek targets and the leash. Every ship is its own agent; it never
// stops (speed floor) and turns within its acceleration budget, so paths are arcs.
//
// What is kept here: the steering acceleration is capped at maximumTurn times maximumSpeed, so a
// ship cannot turn sharply and overshoots, loops and re-forms; seek brakes on arrival and fades to
// nothing inside the comfort radius, so near its target only wander carries a ship through; separation is short
// range and linear; cohesion fades as the neighbourhood fills and pressure pushes out of a crowd, so
// dense knots spread into ribbons instead of a ball.
//
// Desired velocity, as in steer.wgsl (weights times directions of length at most 1 times the ship's
// maximum speed):
//   seek toward the ship's roam group waypoint (arrival braking, comfort fade) * seek
// + average separation within SWARM_NEIGHBOR_RADIUS (linear falloff) * separation * maximumSpeed
// + cohesion toward the average position within SWARM_COHESION_RADIUS, faded by
//   1 - neighbours / SWARM_COMFORT_NEIGHBORS (stands in for the coarse density gradient and fade)
// - pressure away from that centre, pressure * (neighbours / comfort - 1) up to 2, when crowded
//   (stands in for the coarse field pressure term);
// the coarse field's matrix and flee terms are dropped (no other species, no threat field here).
// The bee motion (src/game/swarm-motion.js) adds a harmonic well toward the point, a shrunk roaming
// reach, the carry and the buzz.
// Added for the player (not in the Chaser rules): roaming waypoints per slot group (below), a
// per-slot wander, the leash (weight (distance /
// home radius) squared toward the point: weak inside the home region, firm outside it), the attack
// bias along the aim while firing (strongest at the point, gone SWARM_ATTACK_REACH home radii out,
// swinging along and against the aim on each slot's own evenly staggered attack cycle),
// catch-up (maximum speed and acceleration grow by SWARM_CATCH_UP per home radius beyond the first)
// and the speed floor. Steering = (desired - velocity) * SWARM_STEERING_RESPONSE, clamped to
// maximumTurn * maximumSpeed; speed clamped to [floor, maximumSpeed].
// Per-slot temperament (speed, turn, cohesion hold, wander, leash) comes from slotHash;
// the attack cycle's phase from attackPhaseFor.
// Pure and allocation-free: no GPU, DOM, clock or random numbers; neighbours are an all-pairs loop
// with a squared-distance early-out (65536 pairs at 256 ships), averaged, never summed.

import { slotHash } from './swarm-hash.js';
import { BUZZ_SPEED_SHARE, SWARM_BUZZ, SWARM_ROAM_SCALE, SWARM_TIGHTNESS, TIGHTNESS_WELL_RATE, buzzDirection } from './swarm-motion.js';

export { slotHash };

// Chaser row: seek 0.6, cohesion 0.5, alignment 1.4 (dropped), separation 0.9, maximumSpeed 4.5,
// maximumTurn 0.9, pressure 0.6, flee 0.4 (dropped); steer.wgsl: STEERING_RESPONSE 4,
// ARRIVAL_BRAKING 0.7, comfort radius 1, neighbour radius 0.1 (the default grid). Kept as is:
// seek, cohesion, separation, pressure, the response and the braking.
export const SWARM_SEEK = 0.6;
export const SWARM_COHESION = 0.5;
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
// Separation range; cohesion and pressure look further (the coarse field's stand-in).
export const SWARM_NEIGHBOR_RADIUS = 0.3;
export const SWARM_COHESION_RADIUS = 0.8;
// Neighbours within the cohesion radius at which cohesion fades out and pressure starts.
export const SWARM_COMFORT_NEIGHBORS = 40;
const PRESSURE_MAXIMUM_MULTIPLE = 2;
// Player additions.
export const SWARM_WANDER = 0.35;
export const SWARM_LEASH = 0.8;
// Raised from 2.5 with the attack cycle below: at 2.5 the cycle did not hold the ships to their turns.
export const SWARM_ATTACK = 4;
export const SWARM_ATTACK_REACH = 2;
// Attack runs take turns: the attack bias follows each ship's own cycle of SWARM_ATTACK_SECONDS
// (attackTurn), along the aim for half of it (the run) and against the aim for the other half (the
// way back), so the cycle paces the whole loop. The cycle's phase is evenly spaced over the slots
// (attackPhaseFor), so at any moment about the same share of the swarm is on its run and facing the
// aim, whatever the swarm's size; a steady bias ran the ships of a roam group in lockstep, so the
// ships facing the aim came and went together.
export const SWARM_ATTACK_SECONDS = 2;
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
// Bee motion (src/game/swarm-motion.js): a harmonic well toward the point, a shrunk roaming reach
// and a per-ship buzz velocity. Two parts act outside the steering, because everything inside it is smoothed by the steering
// response and the acceleration cap and, on the move, drowned by the chase of the point:
// - the carry (context carryX, carryY: the point's smoothed velocity, from PlayerSwarm) is the
//   velocity of the frame the ships flock in. A ship's velocityX and velocityY are its velocity in
//   that frame and its position moves by velocity plus carry, so the flock behaves around a moving
//   point as it does around a still one.
// - the buzz velocity is added to the movement directly, not to the desired velocity.
// The course is the direction of the whole movement (velocity plus carry plus buzz).
const buzzScratch = { x: 0, y: 0 };
const TWO_PI = Math.PI * 2;
const EPSILON = 1e-9;
const GOLDEN_FRACTION = (Math.sqrt(5) - 1) / 2;

// The per-slot temperament, from the slot index alone: some ships are quicker, wider ranging or
// keener followers than others.
export function temperamentFor(slot) {
  return {
    cruiseSpeed: SWARM_CRUISE_SPEED * (0.8 + 0.4 * slotHash(slot, 1)),
    maximumTurn: SWARM_MAXIMUM_TURN * (0.75 + 0.5 * slotHash(slot, 2)),
    flockHold: 0.5 + 1 * slotHash(slot, 4),
    wander: 0.5 + 1 * slotHash(slot, 5),
    wanderRateOne: 0.35 + 0.5 * slotHash(slot, 6),
    wanderRateTwo: 0.9 + 0.8 * slotHash(slot, 7),
    wanderPhaseOne: slotHash(slot, 8) * TWO_PI,
    wanderPhaseTwo: slotHash(slot, 9) * TWO_PI,
    leash: 0.7 + 0.6 * slotHash(slot, 10),
    slot,
    roamGroup: slot % SWARM_ROAM_GROUPS,
    attackPhase: attackPhaseFor(slot),
  };
}

// The slot's place in the attack cycle, in [0, 1): multiples of the golden ratio's fraction, so the
// first N slots are spread evenly over the cycle for every N and consecutive slots are far apart.
export function attackPhaseFor(slot) {
  const phase = slot * GOLDEN_FRACTION;
  return phase - Math.floor(phase);
}

// The share of the attack bias a ship with this phase feels at this time: 1 along the aim at the
// middle of its run, -1 (against the aim) at the middle of its way back.
export function attackTurn(time, phase) {
  return Math.cos(TWO_PI * (time / SWARM_ATTACK_SECONDS + phase));
}

// The home radius for this many alive ships.
export function homeRadiusFor(aliveCount) {
  return SWARM_HOME_RADIUS * Math.max(1, Math.sqrt(aliveCount / REFERENCE_SHIPS) * SWARM_HOME_SPREAD);
}

// Advances every alive slot by deltaSeconds. slots carry x, y, velocityX, velocityY, course plus a
// temperament; context: { targetX, targetY, firing, aimX, aimY (unit or zero), time, aliveCount,
// bounds, margin, carryX, carryY }. The course is the direction the ship moves in; where it
// points (its heading) is src/game/swarm-facing.js's.
export function flockStep(slots, deltaSeconds, { targetX, targetY, firing, aimX, aimY, time, aliveCount, bounds, margin, carryX = 0, carryY = 0 }) {
  const home = homeRadiusFor(aliveCount);
  const neighborSquared = SWARM_NEIGHBOR_RADIUS * SWARM_NEIGHBOR_RADIUS;
  const cohesionSquared = SWARM_COHESION_RADIUS * SWARM_COHESION_RADIUS;
  const attacking = firing && (aimX !== 0 || aimY !== 0);
  // The carry moves every ship here, before any ship steers, so each one sees its neighbours and the
  // point in the same frame (the point has already made this step's move).
  for (const ship of slots) {
    if (!ship.alive) continue;
    ship.x += carryX * deltaSeconds;
    ship.y += carryY * deltaSeconds;
  }
  for (const ship of slots) {
    if (!ship.alive) continue;
    let separationX = 0;
    let separationY = 0;
    let nearCount = 0;
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
    const roamRadius = (0.6 + 0.4 * slotHash(ship.roamGroup, 2000 + epoch)) * SWARM_ROAM_REACH * home * SWARM_ROAM_SCALE;
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
      // The harmonic well: desired speed grows linearly with the distance from the point.
      const well = Math.min(maximumSpeed, TIGHTNESS_WELL_RATE * SWARM_TIGHTNESS * distance);
      desiredX += (towardX / distance) * well;
      desiredY += (towardY / distance) * well;
    }
    if (nearCount > 0) {
      desiredX += (separationX / nearCount) * SWARM_SEPARATION * maximumSpeed;
      desiredY += (separationY / nearCount) * SWARM_SEPARATION * maximumSpeed;
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
    const ownCourse = Math.atan2(ship.velocityY, ship.velocityX);
    const swing = ship.wander * (0.7 * Math.sin(time * ship.wanderRateOne + ship.wanderPhaseOne) + 0.3 * Math.sin(time * ship.wanderRateTwo + ship.wanderPhaseTwo));
    desiredX += Math.cos(ownCourse + swing * 1.5) * SWARM_WANDER * maximumSpeed;
    desiredY += Math.sin(ownCourse + swing * 1.5) * SWARM_WANDER * maximumSpeed;
    if (attacking) {
      const proximity = Math.max(0, 1 - reach / SWARM_ATTACK_REACH) * attackTurn(time, ship.attackPhase);
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
      ship.velocityX = Math.cos(ownCourse) * floor;
      ship.velocityY = Math.sin(ownCourse) * floor;
      speed = floor;
    }
    const clamped = Math.min(maximumSpeed, Math.max(floor, speed));
    ship.velocityX *= clamped / speed;
    ship.velocityY *= clamped / speed;
    let movementX = ship.velocityX;
    let movementY = ship.velocityY;
    buzzDirection(ship.slot, time, buzzScratch);
    const buzz = SWARM_BUZZ * BUZZ_SPEED_SHARE * ship.cruiseSpeed;
    movementX += buzzScratch.x * buzz;
    movementY += buzzScratch.y * buzz;
    ship.course = Math.atan2(movementY + carryY, movementX + carryX);
    ship.x = clampTo(ship.x + movementX * deltaSeconds, bounds.minX + margin, bounds.maxX - margin);
    ship.y = clampTo(ship.y + movementY * deltaSeconds, bounds.minY + margin, bounds.maxY - margin);
  }
}

function smoothstep(edgeZero, edgeOne, value) {
  const fraction = clampTo((value - edgeZero) / (edgeOne - edgeZero), 0, 1);
  return fraction * fraction * (3 - 2 * fraction);
}

function clampTo(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
