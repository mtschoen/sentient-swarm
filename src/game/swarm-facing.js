// Player swarm facing (player-swarm spike): where a swarm ship points, apart from where it flies.
// A ship's course is its velocity's direction (src/game/swarm-flocking.js); its heading, which it is
// drawn at and fires along (src/game/swarm-fire.js), may turn off the course toward the aim by up
// to SWARM_FACING_LIMIT_RADIANS while the player fires, so a ship flying across or away from the aim
// can still shoot at it. Pure: no GPU, DOM or clock.
//
// The mapping (facingFor) squeezes every course within the limit plus the firing part of the cone
// into the cone, in proportion: a ship flying along the aim points along it, a ship flying across
// it points part of the way out, so the swarm's shots keep a spread around the aim instead of all
// pointing one way. A course further off than that points the full limit toward the aim: at the
// shipped limit that is the cone's edge, at a lower limit it is outside the cone and the ship does
// not fire. Not firing, the heading is the course.
// The heading turns toward that direction at most SWARM_FACING_TURN_RADIANS_PER_SECOND, by the
// shorter way round (turnHeadingToward), so ships swing round instead of snapping.
import { SWARM_FIRE_CONE_RADIANS } from './swarm-fire.js';

// How far off its course a ship may point: 180 degrees less the fire cone, the least that lets a
// ship flying straight away from the aim point inside the cone, so at this value a ship on any
// course can fire once it has turned. Anything lower shuts out the courses nearest to straight away
// from the aim, which is every ship's course while the swarm chases a point retreating from the aim
// in a straight line: measured at the player speed, the share of ships inside the cone was 1 at
// 145 degrees and 0.2 to 0.4 at 140, 135, 120 and 90.
export const SWARM_FACING_LIMIT_RADIANS = Math.PI - SWARM_FIRE_CONE_RADIANS;
// The share of the fire cone the courses are squeezed into, under 1 so a ship at the edge of the
// mapping is inside the cone and not on its boundary.
export const SWARM_FACING_CONE_SHARE = 0.9;
// Three quarters of a revolution per second.
export const SWARM_FACING_TURN_RADIANS_PER_SECOND = 1.5 * Math.PI;

const TWO_PI = Math.PI * 2;

// The angle wrapped into (-PI, PI].
export function wrapAngle(angle) {
  const wrapped = angle - TWO_PI * Math.round(angle / TWO_PI);
  return wrapped <= -Math.PI ? wrapped + TWO_PI : wrapped;
}

// The direction a ship on this course wants to point while firing along aimAngle (radians).
export function facingFor(course, aimAngle, limit = SWARM_FACING_LIMIT_RADIANS) {
  const offCourse = wrapAngle(course - aimAngle);
  const spread = SWARM_FIRE_CONE_RADIANS * SWARM_FACING_CONE_SHARE;
  const magnitude = Math.abs(offCourse);
  if (magnitude <= limit + spread) return aimAngle + (offCourse * spread) / (limit + spread);
  return course - Math.sign(offCourse) * limit;
}

// heading turned toward desired by at most maximumStep radians, the shorter way round.
export function turnHeadingToward(heading, desired, maximumStep) {
  const difference = wrapAngle(desired - heading);
  if (Math.abs(difference) <= maximumStep) return desired;
  return heading + Math.sign(difference) * maximumStep;
}

// Turns every alive slot's heading for one step: toward facingFor its course while firing with an
// aim, toward its course otherwise.
export function faceStep(slots, deltaSeconds, { firing, aimX, aimY }) {
  const aiming = firing && (aimX !== 0 || aimY !== 0);
  const aimAngle = aiming ? Math.atan2(aimY, aimX) : 0;
  const maximumStep = SWARM_FACING_TURN_RADIANS_PER_SECOND * deltaSeconds;
  for (const ship of slots) {
    if (!ship.alive) continue;
    const desired = aiming ? facingFor(ship.course, aimAngle) : ship.course;
    ship.heading = turnHeadingToward(ship.heading, desired, maximumStep);
  }
}
